import { createHash, randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import type { EntryWorkerHelpers, SeedHelpers } from "./appflare-schema.ts";
import type {
  ArtifactBinding,
  ArtifactD1Binding,
  ArtifactFile,
  ArtifactManifest,
  ArtifactQueueConsumer,
  ArtifactWorker,
  CatalogD1Seed,
  HealthMode,
  Plan,
  QueueRef,
  R2LifecycleRule,
  VectorizeMetadataIndex,
  WorkflowSettings,
} from "./types.ts";

export type { HealthMode } from "./types.ts";

/**
 * Installs a packed artifact into the CI Cloudflare account with wrangler, to
 * check that it deploys and answers, then removes everything again.
 *
 * This is not the manager's install path. The manager creates each resource
 * through the API and records it; here `wrangler deploy` provisions the
 * resources from bindings without ids. Vectorize indexes, queues and
 * Hyperdrive configurations (pointed at the test database in
 * `HYPERDRIVE_TEST_URL`) are the
 * exceptions: wrangler cannot provision them, so the check creates each
 * through the API before the deploy, and attaches the artifact's queue
 * consumers through the API after it, as the manager does. All of them use the
 * same names, `<worker>-<binding, lowercased, "_" -> "-">`, so the CI Worker's
 * resources can be found and deleted by name afterwards without any records.
 *
 * What wrangler's config cannot say about a resource is set as the manager
 * sets it: a Vectorize index's metadata indexes
 * (`resources.vectorize[binding].metadataIndexes`) are created right after
 * the index, one `metadata_index/create` call each, and an R2 bucket's
 * lifecycle rules (`resources.r2[binding].lifecycle`) are merged into the
 * rules it has with the manager's own `mergeR2LifecycleRules` and put back.
 * wrangler creates the buckets during the deploy, so their rules are set
 * right after it, before any D1 SQL runs or any request reaches the app.
 *
 * D1 SQL runs as the manager runs it, once every Worker is deployed: each
 * database's migrations with `wrangler d1 migrations apply` (named and ordered
 * as the artifact records them), then its schema files in order with
 * `wrangler d1 execute --file`, unrecorded; then, for every database, its
 * post-deploy migrations with `wrangler d1 migrations apply` against a second
 * config whose `migrations_dir` is their folder, so they are recorded in
 * `d1_migrations` beside the others. A database with a baseline
 * (`resources.d1[binding].baseline`) instead runs it with `wrangler d1
 * execute --file`, then records every migration and post-deploy migration
 * of the version in `d1_migrations` without running them, as the manager
 * does on a new database. A database's seed
 * (`resources.d1[binding].seed`) runs last, or right after its migrations
 * when it says `beforeSchema`, through the D1 API rather than wrangler,
 * which cannot bind params (see {@link runSeed}). Seed-only secrets and vars
 * get values for the seeds and are never set on a Worker.
 *
 * A Worker of static assets only (no modules and no `mainModule`) is deployed as `wrangler deploy` deploys a config with `assets`
 * and no `main`: the config names no entry module, no module rules and no
 * bundling settings, and nothing is unpacked under `worker/`.
 *
 * `_redirects` and `_headers`, which the packer records as text in the assets
 * config, are written back as files at the root of the assets directory,
 * where wrangler reads them, and left out of the config's `assets` block.
 *
 * An app of several Workers (an artifact manifest with `workers`) is deployed as
 * the manager deploys it: every Worker, each after the Workers it binds to,
 * the primary one as `ci-<slug>-<suffix>` and every other one as
 * `ci-<slug>-<suffix>-<name>`. Resources belong to the app and are shared by
 * binding name, so they are named after the primary Worker whichever Worker
 * binds them. wrangler shares D1 databases and R2 buckets by the name the
 * config gives them (the second deploy finds the first one's), but has no
 * name to give a KV namespace and would create one per Worker, so for an app
 * of several Workers the check creates KV namespaces through the API too and
 * writes their ids into every Worker's config. A Worker the entry keeps off
 * workers.dev (`install.workers[].workersDev: false`) is deployed with
 * `workers_dev: false` and not probed, since nothing outside the app reaches it.
 */

export const WORKER_DIR = "worker";
export const ASSETS_DIR = "assets";
export const D1_DIR = "d1";
/** Where each D1 binding's schema files are unpacked: `<dir>/<binding>/<name>`. */
export const D1_SCHEMA_DIR = "d1-schema";
/** Where each D1 binding's post-deploy migrations are unpacked. */
export const D1_POST_DEPLOY_DIR = "d1-post-deploy";
/** Where each D1 baseline is unpacked, under `<binding>/<name>`. */
export const D1_BASELINE_DIR = "d1-baseline";
/** Where the SQL that records a baseline database's migrations is written, as `<binding>.sql`. */
export const D1_BASELINE_RECORD_DIR = "d1-baseline-record";
/** The config the post-deploy migrations are applied with (see {@link postDeployConfig}). */
export const POST_DEPLOY_CONFIG = "wrangler.post-deploy.json";
/** The config every Worker is deployed with. */
export const DEPLOY_CONFIG = "wrangler.json";

/**
 * Worker names: lowercase letters, digits, inner dashes, at most 58 characters,
 * so `<name>.<subdomain>.workers.dev` stays a valid DNS label and the derived
 * resource names stay within Cloudflare's limits.
 */
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/;

/** `ci-<slug>-<suffix>`, validated. */
export function ciWorkerName(slug: string, suffix: string): string {
  const name = `ci-${slug}-${suffix}`.toLowerCase();
  if (!WORKER_NAME.test(name)) {
    throw new Error(
      `"${name}" is not a usable Worker name (lowercase, digits, dashes, <= 58 chars)`,
    );
  }
  return name;
}

/** The name wrangler and the manager both give a provisioned resource. */
export function resourceName(workerName: string, bindingName: string): string {
  return `${workerName}-${bindingName.toLowerCase().replaceAll("_", "-")}`;
}

export type CiResourceType = "kv" | "d1" | "r2" | "workflow" | "vectorize" | "queue" | "hyperdrive";

export interface CiResource {
  type: CiResourceType;
  name: string;
  binding: string;
}

/** How a Vectorize index measures distance; fixed when the index is created. */
export type VectorizeMetric = "cosine" | "euclidean" | "dot-product";

/** A Vectorize index to create before the deploy, with the shape the artifact records. */
export interface CiVectorizeIndex {
  name: string;
  dimensions: number;
  metric: VectorizeMetric;
  /** The metadata indexes created right after it, in order; omitted when none are declared. */
  metadataIndexes?: VectorizeMetadataIndex[];
}

/** An R2 bucket the deploy creates, and the lifecycle rules set on it right after. */
export interface CiR2Lifecycle {
  bucket: string;
  binding: string;
  rules: R2LifecycleRule[];
}

/** The files at the root of the assets directory that configure it rather than being served. */
export const ASSET_RULE_FILES = ["_redirects", "_headers"] as const;

/** Vectorize's limits: index names up to 64 bytes, vectors up to 1536 dimensions. */
const VECTORIZE_MAX_NAME = 64;
const VECTORIZE_MAX_DIMENSIONS = 1536;
const VECTORIZE_METRICS: readonly string[] = ["cosine", "euclidean", "dot-product"];

/** Queue names allow 1-63 of `[a-z0-9-]`. */
const QUEUE_MAX_NAME = 63;

/**
 * Delivery settings of a queue consumer in the API's names and units
 * (wrangler's `max_batch_timeout` in seconds is `max_wait_time_ms` here).
 */
export interface QueueConsumerSettings {
  batch_size?: number;
  max_retries?: number;
  max_wait_time_ms?: number;
  max_concurrency?: number | null;
  retry_delay?: number;
}

/** A Worker consumer to attach after the deploy, by queue name. */
export interface CiQueueConsumer {
  queue: string;
  /** The dead-letter queue's name, or null for none. */
  deadLetterQueue: string | null;
  settings: QueueConsumerSettings;
}

/** The SQL the check runs against one D1 database once the Workers are deployed. */
export interface CiD1Database {
  /** The database's name, as the config gives it (`database_name`). */
  database: string;
  binding: string;
  /** Whether it has migrations, applied from `d1/<binding>/` by the deploy config. */
  migrations: boolean;
  /** Its schema files, relative to the work dir, in the order they run. */
  schema: string[];
  /** Its post-deploy migrations' names, applied from `d1-post-deploy/<binding>/`. */
  postDeploy: string[];
  /** The rows it gets once, at install (`resources.d1[binding].seed`); omitted when none. */
  seed?: CatalogD1Seed;
  /**
   * Its baseline (`resources.d1[binding].baseline`): the file, relative to
   * the work dir, and the names of every migration and post-deploy migration
   * the version ships, recorded in `d1_migrations` after it without running.
   * Omitted when it has none.
   */
  baseline?: { file: string; recorded: string[] };
}

export interface CiInstallPlan {
  name: string;
  /** The generated `wrangler.json`. */
  config: Record<string, unknown>;
  /** Everything the deploy may create besides the Worker, deleted afterwards. */
  resources: CiResource[];
  /**
   * The secrets the Worker gets, from the catalog manifest, by key (a
   * secret's `key`, else its name); each gets a random value, a new VAPID
   * private key when it is listed in `vapidPrivateKeys`, or a 32-byte key
   * when it is listed in `base64Keys`. The value is set on the Worker under
   * the secret's name ({@link secretNames}).
   */
  secrets: string[];
  /**
   * The name each secret is set under on the Worker, by key, for the
   * secrets (derived ones included) whose `key` is not their name. Two
   * Workers of an app may each read `CLIENT_ID` from secrets of different
   * keys, and so get values of their own, as the manager sets them.
   */
  secretNames: Record<string, string>;
  /**
   * Secrets that only a D1 seed reads (`seedOnly`): each gets a value as
   * `secrets` do, and is never set on the Worker, as the manager never sets it.
   */
  seedOnlySecrets: string[];
  /** The secrets with `generate: "vapid-private-key"`, as the install form generates them. */
  vapidPrivateKeys: string[];
  /** The secrets with `generate: "base64-key-32"`: 32 random bytes as padded base64. */
  base64Keys: string[];
  /**
   * The values of the vars that only a D1 seed reads (`seedOnly`): the
   * default, else a choice's first option, else {@link SEED_VAR_PLACEHOLDER}.
   * Never set on the Worker.
   */
  seedVars: Record<string, string>;
  /**
   * Whether the Worker answers on its workers.dev URL. False only for a
   * Worker of an app of several that the entry keeps off it
   * (`install.workers[].workersDev: false`): the check deploys it with
   * `workers_dev: false` and does not probe it.
   */
  workersDev: boolean;
  /**
   * Secrets the catalog manifest derives from another (`derive`): each gets
   * the value the manager would compute from its source's generated value.
   */
  derivedSecrets: CiDerivedSecret[];
  /**
   * Vars the catalog manifest derives from a secret (`derive`), such as a
   * VAPID public key: set in the config at deploy, once the secrets have
   * values ({@link derivedVarValues}).
   */
  derivedVars: CiDerivedSecret[];
  /** D1 databases with SQL to run once the Worker is deployed, in binding order. */
  d1: CiD1Database[];
  /** Vectorize indexes to create before the deploy (wrangler cannot provision them). */
  vectorizeIndexes: CiVectorizeIndex[];
  /** R2 buckets whose lifecycle rules are set once the deploy has created them. */
  r2Lifecycles: CiR2Lifecycle[];
  /**
   * Hyperdrive configurations to create before the deploy, from
   * `HYPERDRIVE_TEST_URL` (see {@link hyperdriveSkip}); their ids go into
   * the config with {@link withHyperdriveIds}.
   */
  hyperdriveConfigs: CiHyperdriveConfig[];
  /** Queues to create before the deploy (wrangler cannot provision them), by name. */
  queues: string[];
  /** Consumers to attach once the Worker is deployed. */
  queueConsumers: CiQueueConsumer[];
  /** What the check deploys but cannot exercise, for the run's summary. */
  notes: string[];
  /** The path the health check probes: the catalog's `install.health.path`. */
  probePath: string;
  /** How the health check reads the answer: the catalog's `install.health.mode`. */
  probeMode: HealthMode;
}

type WranglerRule =
  | "ESModule"
  | "CommonJS"
  | "Text"
  | "Data"
  | "CompiledWasm"
  | "PythonModule"
  | "PythonRequirement";

const RULE_TYPES: Record<string, WranglerRule> = {
  esm: "ESModule",
  commonjs: "CommonJS",
  text: "Text",
  data: "Data",
  "compiled-wasm": "CompiledWasm",
  python: "PythonModule",
  "python-requirement": "PythonRequirement",
};

function str(binding: ArtifactBinding, field: string): string {
  const value = binding[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`binding ${binding.name} (${binding.type}) has no ${field}`);
  }
  return value;
}

function optionalStr(binding: ArtifactBinding, field: string): Record<string, string> {
  const value = binding[field];
  return typeof value === "string" && value.length > 0 ? { [field]: value } : {};
}

/**
 * A secret or var the catalog manifest derives from a secret: `method`
 * applied to the value of the secret whose key is `from`.
 */
export interface CiDerivedSecret {
  name: string;
  /** A derived secret's `key`, when it is not its name. */
  key?: string;
  from: string;
  method: string;
}

/** The key a derived secret's value goes by: its `key`, else its name. */
export function derivedKey(derived: CiDerivedSecret): string {
  return derived.key ?? derived.name;
}

interface CatalogForms {
  /** The secrets the Worker gets, by key: every one but the derived and seed-only ones. */
  secrets: string[];
  /** The name a secret is set under, by key, where the two differ. */
  secretNames: Record<string, string>;
  /** Secrets, seed-only ones included, with `generate: "vapid-private-key"`. */
  vapidPrivateKeys: string[];
  /** Secrets, seed-only ones included, with `generate: "base64-key-32"`. */
  base64Keys: string[];
  /** Secrets that exist only for seeds (`seedOnly`): given a value, never set on the Worker. */
  seedOnlySecrets: string[];
  derivedSecrets: CiDerivedSecret[];
  derivedVars: CiDerivedSecret[];
  /** The vars the Worker gets: every one but the derived and seed-only ones. */
  vars: CatalogFormVar[];
  /** Vars that exist only for seeds (`seedOnly`): given a value, never set on the Worker. */
  seedOnlyVars: CatalogFormVar[];
}

interface CatalogFormVar {
  name: string;
  default?: string;
  /** The app cannot run without a value: the var does not set `optional: true`. */
  required: boolean;
  firstOption?: string;
}

/** Whether a catalog secret or var exists only for seeds (`seedOnly: true`). */
function seedOnly(item: unknown): boolean {
  return (item as { seedOnly?: unknown }).seedOnly === true;
}

/** The `derive` block of a catalog secret, when it has a usable one. */
function deriveOf(secret: unknown): { from: string; method: string } | null {
  const derive = (secret as { derive?: unknown }).derive as
    | { from?: unknown; method?: unknown }
    | undefined;
  if (derive === undefined || derive === null || typeof derive !== "object") return null;
  return typeof derive.from === "string" && typeof derive.method === "string"
    ? { from: derive.from, method: derive.method }
    : null;
}

/**
 * The key a catalog secret goes by: its `key`, else its name. Managers from
 * 0.4.0 store, generate, derive and seed by it, and set the value on the
 * Worker under the name.
 */
function secretKeyOf(secret: unknown, name: string): string {
  const key = (secret as { key?: unknown }).key;
  return typeof key === "string" && key.length > 0 ? key : name;
}

/** The first value of a `type: "select"` var's options, if it has any. */
function firstOption(v: { type?: unknown; options?: unknown }): Record<string, string> {
  if (v.type !== "select" || !Array.isArray(v.options)) return {};
  const value = (v.options[0] as { value?: unknown } | undefined)?.value;
  return typeof value === "string" ? { firstOption: value } : {};
}

/**
 * Secret names and var defaults from the catalog manifest embedded in the
 * artifact. Optional secrets are set too, so the check covers the app with
 * every feature its secrets turn on. A derived secret or var (`derive`) is
 * listed apart, with its source: it is computed, never random. So is a
 * seed-only one (`seedOnly`), which only a D1 seed reads: the manager never
 * sets it on the Worker, so neither does the check.
 */
export function catalogForms(catalog: unknown): CatalogForms {
  const c = (catalog ?? {}) as { secrets?: unknown; vars?: unknown };
  const secrets: string[] = [];
  const secretNames: Record<string, string> = {};
  const vapidPrivateKeys: string[] = [];
  const base64Keys: string[] = [];
  const seedOnlySecrets: string[] = [];
  const derivedSecrets: CiDerivedSecret[] = [];
  for (const s of Array.isArray(c.secrets) ? c.secrets : []) {
    const name = (s as { name?: unknown }).name;
    if (typeof name !== "string") continue;
    const key = secretKeyOf(s, name);
    if (key !== name) secretNames[key] = name;
    const derive = deriveOf(s);
    if (derive !== null) {
      derivedSecrets.push({ name, ...(key === name ? {} : { key }), ...derive });
      continue;
    }
    (seedOnly(s) ? seedOnlySecrets : secrets).push(key);
    const generate = (s as { generate?: unknown }).generate;
    if (generate === "vapid-private-key") vapidPrivateKeys.push(key);
    if (generate === "base64-key-32") base64Keys.push(key);
  }
  const derivedVars: CiDerivedSecret[] = [];
  for (const v of Array.isArray(c.vars) ? c.vars : []) {
    const name = (v as { name?: unknown }).name;
    const derive = typeof name === "string" ? deriveOf(v) : null;
    if (typeof name === "string" && derive !== null) derivedVars.push({ name, ...derive });
  }
  const derivedVarNames = new Set(derivedVars.map((v) => v.name));
  const formVars: Array<CatalogFormVar & { seedOnly: boolean }> = Array.isArray(c.vars)
    ? c.vars
        .map(
          (v) =>
            v as {
              name?: unknown;
              default?: unknown;
              optional?: unknown;
              type?: unknown;
              options?: unknown;
            },
        )
        .filter(
          (
            v,
          ): v is {
            name: string;
            default?: unknown;
            optional?: unknown;
            type?: unknown;
            options?: unknown;
          } => typeof v.name === "string" && !derivedVarNames.has(v.name),
        )
        .map((v) => ({
          name: v.name,
          ...(typeof v.default === "string" ? { default: v.default } : {}),
          // A var needs a value unless it says it is optional.
          required: v.optional !== true,
          ...firstOption(v),
          seedOnly: seedOnly(v),
        }))
    : [];
  const formVar = ({ seedOnly: _seedOnly, ...v }: CatalogFormVar & { seedOnly: boolean }) => v;
  return {
    secrets,
    secretNames,
    vapidPrivateKeys,
    base64Keys,
    seedOnlySecrets,
    derivedSecrets,
    derivedVars,
    vars: formVars.filter((v) => !v.seedOnly).map(formVar),
    seedOnlyVars: formVars.filter((v) => v.seedOnly).map(formVar),
  };
}

/**
 * The index a `vectorize` binding needs, named `resource`. The artifact
 * records the shape from the catalog manifest's `resources.vectorize`; throws
 * when it is missing or outside Vectorize's limits, or when the name is too long.
 */
function vectorizeIndex(binding: ArtifactBinding, resource: string): CiVectorizeIndex {
  const { dimensions, metric } = binding;
  if (
    typeof dimensions !== "number" ||
    !Number.isInteger(dimensions) ||
    dimensions < 1 ||
    dimensions > VECTORIZE_MAX_DIMENSIONS
  ) {
    throw new Error(
      `vectorize binding ${binding.name} records no usable dimensions (1-${VECTORIZE_MAX_DIMENSIONS})`,
    );
  }
  if (typeof metric !== "string" || !VECTORIZE_METRICS.includes(metric)) {
    throw new Error(
      `vectorize binding ${binding.name} records no usable metric (${VECTORIZE_METRICS.join(", ")})`,
    );
  }
  if (resource.length > VECTORIZE_MAX_NAME) {
    throw new Error(
      `the Vectorize index name "${resource}" is longer than ${VECTORIZE_MAX_NAME} characters; use a shorter suffix`,
    );
  }
  const metadataIndexes = metadataIndexesOf(binding);
  return {
    name: resource,
    dimensions,
    metric: metric as VectorizeMetric,
    ...(metadataIndexes === undefined ? {} : { metadataIndexes }),
  };
}

const METADATA_TYPES: readonly string[] = ["string", "number", "boolean"];

/**
 * The metadata indexes a `vectorize` binding records, or
 * undefined when it has none. The artifact schema has checked them; this
 * only refuses a shape the check could not use.
 */
function metadataIndexesOf(binding: ArtifactBinding): VectorizeMetadataIndex[] | undefined {
  const value = binding.metadataIndexes;
  if (value === undefined) return undefined;
  const ok =
    Array.isArray(value) &&
    value.every(
      (m: unknown) =>
        typeof (m as { propertyName?: unknown } | null)?.propertyName === "string" &&
        METADATA_TYPES.includes(String((m as { type?: unknown }).type)),
    );
  if (!ok) {
    throw new Error(`vectorize binding ${binding.name} records unusable metadata indexes`);
  }
  // Checked above: each has a string propertyName and a known type.
  return (value as VectorizeMetadataIndex[]).map((m) => ({
    propertyName: m.propertyName,
    type: m.type,
  }));
}

/**
 * The lifecycle rules an `r2_bucket` binding records, or
 * undefined when it has none. The artifact schema has checked them.
 */
function lifecycleOf(binding: ArtifactBinding): R2LifecycleRule[] | undefined {
  const value = binding.lifecycle;
  if (value === undefined) return undefined;
  const ok =
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((r: unknown) => typeof (r as { id?: unknown } | null)?.id === "string");
  if (!ok) {
    throw new Error(`r2_bucket binding ${binding.name} records unusable lifecycle rules`);
  }
  // Checked above: a list of rules with ids; the schema checked the rest.
  return value as R2LifecycleRule[];
}

/** Same rule as the catalog schema: a URL path starting with `/`, without query or fragment. */
const HEALTH_PATH = /^\/[^\s?#]*$/;

/**
 * The path to probe, from `install.health.path` in the catalog manifest
 * embedded in the artifact; `/` when it is absent, as the manager does.
 * Throws for a value the schema would reject, rather than probing somewhere
 * else.
 */
export function catalogHealthPath(catalog: unknown): string {
  const path = catalogHealth(catalog)?.path;
  if (path === undefined) {
    return "/";
  }
  if (typeof path !== "string" || !HEALTH_PATH.test(path)) {
    throw new Error(`install.health.path ${JSON.stringify(path)} is not a URL path`);
  }
  return path;
}

/**
 * The mode from `install.health.mode` in the catalog manifest embedded in the
 * artifact; `no-server-errors` when it is absent, as the schema defaults it.
 * Throws for a value the manager would not accept, rather than checking by
 * another rule.
 */
export function catalogHealthMode(catalog: unknown): HealthMode {
  const mode = catalogHealth(catalog)?.mode;
  if (mode === undefined) {
    return "no-server-errors";
  }
  if (mode !== "no-server-errors" && mode !== "any-response") {
    throw new Error(
      `install.health.mode ${JSON.stringify(mode)} is not "no-server-errors" or "any-response"`,
    );
  }
  return mode;
}

/** `install.health` of a catalog manifest, read loosely; undefined when it has none. */
function catalogHealth(catalog: unknown): { path?: unknown; mode?: unknown } | undefined {
  const health = (catalog as { install?: { health?: unknown } } | null)?.install?.health;
  return health !== null && typeof health === "object" ? health : undefined;
}

/** The URL the health check probes for Worker `name` in the account's workers.dev subdomain. */
export function healthUrl(name: string, subdomain: string, probePath: string): string {
  return `https://${name}.${subdomain}.workers.dev${probePath}`;
}

/** The largest rate limit namespace id the check assigns: 2^31-1, as the manager does. */
const MAX_NAMESPACE_ID = 2_147_483_647;

/**
 * A random rate limit namespace id, 1 to 2^31-1, as the decimal string
 * wrangler expects. Cloudflare shares a namespace's counters across every
 * Worker in the account that binds the same id, so each run gets its own
 * rather than the id the app's author wrote.
 */
export function randomNamespaceId(): string {
  return String((randomBytes(4).readUInt32BE(0) % MAX_NAMESPACE_ID) + 1);
}

/** The periods, in seconds, a rate limit may count over. */
const RATE_LIMIT_PERIODS: readonly number[] = [10, 60];

/** The `simple` settings of a `ratelimit` binding; throws when they are missing or unusable. */
function rateLimitSimple(binding: ArtifactBinding): { limit: number; period: number } {
  const simple = binding.simple as { limit?: unknown; period?: unknown } | null | undefined;
  const limit = simple?.limit;
  const period = simple?.period;
  if (
    typeof limit !== "number" ||
    typeof period !== "number" ||
    !RATE_LIMIT_PERIODS.includes(period)
  ) {
    throw new Error(
      `ratelimit binding ${binding.name} records no usable simple.limit and simple.period (10 or 60)`,
    );
  }
  return { limit, period };
}

/** The restriction fields of a `send_email` binding, in wrangler's names. */
const SEND_EMAIL_RESTRICTIONS = [
  "destination_address",
  "allowed_destination_addresses",
  "allowed_sender_addresses",
] as const;

/**
 * A `send_email` binding as recorded. Deploying one needs no zone and no
 * verified address; only sending does (to verified destination addresses, from
 * a domain onboarded to Email Service), and the check never sends. Returns a
 * note when the binding restricts its addresses, since those restrictions can
 * only be exercised in an account that verified the addresses.
 */
function sendEmailBinding(binding: ArtifactBinding): {
  config: Record<string, unknown>;
  note: string | null;
} {
  const config: Record<string, unknown> = { name: binding.name };
  const restricted: string[] = [];
  for (const field of SEND_EMAIL_RESTRICTIONS) {
    if (binding[field] !== undefined) {
      config[field] = binding[field];
      restricted.push(field);
    }
  }
  return {
    config,
    note:
      restricted.length === 0
        ? null
        : `send_email binding ${binding.name} is deployed with its ${restricted.join(", ")} as recorded; ` +
          "sending is not exercised, since it needs those addresses verified in the installing account",
  };
}

/**
 * What an artifact records as the target of a service binding to the app's
 * own Worker. The packer writes it in place of the Worker's name, since an
 * install may run under another name, and the manager puts the install's name
 * back when it uploads.
 */
export const SELF_SERVICE = "self";

const SELF_SERVICE_FIELDS: readonly string[] = ["type", "name", "service", "entrypoint", "props"];

/**
 * What planning one Worker of an app of several needs besides its own view of
 * the manifest (see {@link planCiApp}).
 */
export interface EntryPlanContext {
  /** The primary CI Worker's name: resources and `{{workerName}}` are the app's, named after it. */
  installName: string;
  /** Each Worker's name within the entry to its CI Worker name. */
  scriptNames: Readonly<Record<string, string>>;
  /** The binding names of every Worker of the app. */
  bindingNames: ReadonlySet<string>;
  /** The queue producer bindings of every Worker: a consumer may name another Worker's queue. */
  queueBindings: ReadonlySet<string>;
  /** `entryWorkerRefName` from `@appflare/schema`: the entry Worker `{{workerName:<name>}}` names. */
  refName: (value: unknown) => string | null;
  /** Fills in the per-Worker placeholders, such as `{{workerUrl:<name>}}` (`renderEntryWorkerPlaceholders`). */
  render: (text: string) => string;
}

/** The CI Worker a binding's `{{workerName:<ref>}}` names; throws when the entry has no such Worker. */
function entryTarget(entry: EntryPlanContext, ref: string, binding: ArtifactBinding): string {
  const target = Object.hasOwn(entry.scriptNames, ref) ? entry.scriptNames[ref] : undefined;
  if (target === undefined) {
    throw new Error(
      `binding ${binding.name} (${binding.type}) names the Worker "${ref}", which the entry does not have`,
    );
  }
  return target;
}

/**
 * A service binding as wrangler's config writes it, aimed at Worker `name`:
 * the only service binding an artifact may hold is one to the app's own
 * Worker, `{ type: "service", name, service: "self", entrypoint?, props? }`
 * and nothing more, as the manager holds it (or, in an app of several
 * Workers, the same aimed at another Worker of the entry). Every other
 * service binding throws, since it would let the app call another Worker in
 * the account. `props` must be a JSON object; `fill` fills its placeholders
 * in, as the manager fills them in before it uploads them as wrangler does.
 *
 * wrangler deploys a Worker that binds to itself on its first deploy (it
 * accepts a binding to the Worker the deploy creates), so the CI Worker needs
 * no earlier upload for this.
 */
function selfServiceBinding(
  binding: ArtifactBinding,
  name: string,
  fill: (value: JsonValue) => JsonValue,
  entry?: EntryPlanContext,
): Record<string, unknown> {
  const extra = Object.keys(binding).filter((key) => !SELF_SERVICE_FIELDS.includes(key));
  const { service, entrypoint, props } = binding;
  const entrypointOk =
    entrypoint === undefined || (typeof entrypoint === "string" && entrypoint.length > 0);
  const propsOk = props === undefined || isJsonObject(props);
  const rest = {
    ...(typeof entrypoint === "string" ? { entrypoint } : {}),
    ...(props === undefined || !propsOk ? {} : { props: fill(props as JsonValue) }),
  };
  // Another Worker of the app's own entry, recorded as `{{workerName:<name>}}`.
  const ref = entry?.refName(service) ?? null;
  if (ref !== null && entry !== undefined && entrypointOk && propsOk && extra.length === 0) {
    return { binding: binding.name, service: entryTarget(entry, ref, binding), ...rest };
  }
  if (service !== SELF_SERVICE || !entrypointOk || !propsOk || extra.length > 0) {
    const target = typeof service === "string" ? `the Worker "${service}"` : "no Worker";
    const why =
      service !== SELF_SERVICE
        ? `points at ${target}`
        : !entrypointOk
          ? "records an entrypoint that is not a name"
          : !propsOk
            ? "records props that are not a JSON object"
            : `also sets ${extra.join(", ")}`;
    throw new Error(
      `service binding ${binding.name} ${why}; an app may bind only to its own Worker ` +
        `(recorded as service "${SELF_SERVICE}", with nothing but an optional entrypoint and props)`,
    );
  }
  return { binding: binding.name, service: name, ...rest };
}

/** Whether `value` is a JSON object (not an array or null), as service binding `props` must be. */
function isJsonObject(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

/** A queue name for `resource`; throws when it is longer than Cloudflare allows. */
function queueName(resource: string): string {
  if (resource.length > QUEUE_MAX_NAME) {
    throw new Error(
      `the queue name "${resource}" is longer than ${QUEUE_MAX_NAME} characters; use a shorter suffix`,
    );
  }
  return resource;
}

/**
 * The settings the artifact records for the Workflow of `binding`
 * (`worker.workflowSettings`), as keys of its `workflows[]` entry; empty when
 * it records none. wrangler sends each one the config sets in the
 * `PUT /workflows/{name}` that creates the Workflow after the upload, the
 * call the manager makes with the same settings, so the check's Workflow
 * gets the app's step limit, concurrency, schedules and retention. The
 * schema records settings only for a binding of the Worker that defines the
 * Workflow, the one place wrangler accepts them. A schedule needs Workers
 * Paid, which the schema has the entry declare, so a free CI account skips
 * such an entry (see {@link paidPlanSkip}).
 */
export function workflowSettingsOf(
  worker: Pick<ArtifactWorker, "workflowSettings">,
  binding: string,
): WorkflowSettings {
  const recorded = worker.workflowSettings ?? {};
  if (!Object.hasOwn(recorded, binding)) return {};
  const { limits, concurrency, schedules, default_retention } = recorded[binding] ?? {};
  return {
    ...(limits === undefined ? {} : { limits }),
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(schedules === undefined ? {} : { schedules: [...schedules] }),
    ...(default_retention === undefined ? {} : { default_retention }),
  };
}

/** Wrangler's consumer settings in the API's names and units (seconds become ms), as the manager sends them. */
export function consumerSettings(consumer: ArtifactQueueConsumer): QueueConsumerSettings {
  const settings: QueueConsumerSettings = {};
  if (consumer.max_batch_size !== undefined) settings.batch_size = consumer.max_batch_size;
  if (consumer.max_retries !== undefined) settings.max_retries = consumer.max_retries;
  if (consumer.max_batch_timeout !== undefined) {
    settings.max_wait_time_ms = Math.round(consumer.max_batch_timeout * 1000);
  }
  if (consumer.max_concurrency !== undefined) settings.max_concurrency = consumer.max_concurrency;
  if (consumer.retry_delay !== undefined) settings.retry_delay = consumer.retry_delay;
  return settings;
}

/**
 * The note for an artifact's cron triggers, which the check does not set: it
 * proves the Worker deploys and answers, and a schedule adds nothing to that.
 * Cron triggers also count against a limit for the whole account (5 on the
 * Workers Free plan) that every Worker there and every check running in
 * parallel would share, so setting them could fail an unrelated check. Null
 * when the artifact declares none.
 */
export function cronNote(crons: readonly string[]): string | null {
  if (crons.length === 0) {
    return null;
  }
  const count = crons.length === 1 ? "1 cron trigger" : `${crons.length} cron triggers`;
  return (
    `the artifact declares ${count} (${crons.map((c) => `\`${c}\``).join(", ")}); ` +
    "not set on the CI Worker, so scheduled runs are not exercised"
  );
}

/** Placeholder for a required var without a default; the check only needs the Worker to start. */
export const REQUIRED_VAR_PLACEHOLDER = "ci";

/** What a seed-only var without a default gets, such as the first admin's user name. */
export const SEED_VAR_PLACEHOLDER = "ci-admin";

/**
 * What the manager fills in for the address placeholders (`{{appUrl}}`,
 * `{{appHostname}}`, `{{workerUrl}}`, `{{workerHostname}}`), `{{workerName}}`
 * and `{{accountId}}` in var values: the wrangler config's own vars
 * (strings, and strings inside JSON values) and the catalog's var defaults.
 */
export interface PlaceholderValues {
  /** `https://<worker>.<subdomain>.workers.dev`; null keeps `{{workerUrl}}` as written. */
  workerUrl: string | null;
  /**
   * The address the app is served at. The install check gives no app a custom
   * domain, so it is `workerUrl`; null keeps `{{appUrl}}` as written.
   */
  appUrl: string | null;
  workerName: string;
  /** The account's id; absent or null keeps `{{accountId}}` as written. */
  accountId?: string | null;
  /**
   * What `{{accessTeamDomain}}`, `{{accessTeamName}}`, `{{accessAud}}` and
   * `{{accessCertsUrl}}` become. Null fills all four in empty, as the manager
   * does for an app it does not protect with Cloudflare Access; absent keeps
   * them as written.
   */
  access?: { teamDomain: string; teamName: string; aud: string; certsUrl: string } | null;
}

/** A JSON value: what a `json` var holds. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// The manager's rules, from @appflare/schema: whitespace inside the braces is
// allowed, and anything else in double braces is left as written. A test
// checks these copies against the schema package's own functions.
const PLACEHOLDER_PATTERN =
  /\{\{\s*(appUrl|appHostname|workerUrl|workerHostname|workerName|accountId|accessTeamDomain|accessTeamName|accessAud|accessCertsUrl)\s*\}\}/g;

/** The hostname of an https:// URL. */
function hostnameOf(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, "").replace(/[/?#].*$/, "");
}

/**
 * `text` with the address placeholders, `{{workerName}}`, `{{accountId}}` and
 * the Cloudflare Access ones filled in, as the manager does.
 * `{{wildcardHostname}}` is kept as written: the install check gives no app a
 * wildcard domain.
 */
export function renderPlaceholders(text: string, values: PlaceholderValues): string {
  return text.replace(PLACEHOLDER_PATTERN, (match, key: string) => {
    switch (key) {
      case "workerName":
        return values.workerName;
      case "accountId":
        return values.accountId ?? match;
      case "accessTeamDomain":
        return values.access === undefined ? match : (values.access?.teamDomain ?? "");
      case "accessTeamName":
        return values.access === undefined ? match : (values.access?.teamName ?? "");
      case "accessAud":
        return values.access === undefined ? match : (values.access?.aud ?? "");
      case "accessCertsUrl":
        return values.access === undefined ? match : (values.access?.certsUrl ?? "");
      case "appUrl":
        return values.appUrl ?? match;
      case "appHostname":
        return values.appUrl === null ? match : hostnameOf(values.appUrl);
      case "workerHostname":
        return values.workerUrl === null ? match : hostnameOf(values.workerUrl);
      default:
        return values.workerUrl ?? match;
    }
  });
}

/**
 * `value` with placeholders filled in inside every string it holds, object
 * keys included, as managers from 0.4.0 fill them in.
 */
export function renderJsonPlaceholders(value: JsonValue, values: PlaceholderValues): JsonValue {
  return mapJsonText(value, (text) => renderPlaceholders(text, values));
}

/** `value` with `fn` applied to every string it holds and to every object key. */
export function mapJsonText(value: JsonValue, fn: (text: string) => string): JsonValue {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapJsonText(item, fn));
  if (value !== null && typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) {
      // Plain assignment of `__proto__` would set the prototype instead.
      Object.defineProperty(out, fn(key), {
        value: mapJsonText(item, fn),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

/**
 * `value` with `fn` applied to every string it holds (keys excepted), as the
 * manager fills in the per-Worker placeholders.
 */
export function mapJsonStrings(value: JsonValue, fn: (text: string) => string): JsonValue {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapJsonStrings(item, fn));
  if (value !== null && typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) {
      // Plain assignment of `__proto__` would set the prototype instead.
      Object.defineProperty(out, key, {
        value: mapJsonStrings(item, fn),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

/**
 * The catalog default of the `json` var `name`, parsed. The packer refuses an
 * artifact whose default is not JSON; this refuses one that got through
 * anyway rather than deploying the Worker with its JSON text as a string.
 */
function jsonDefault(name: string, text: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch (error) {
    throw new Error(
      `the catalog default of the var ${name} is not valid JSON (${error instanceof Error ? error.message : String(error)}), ` +
        `but the wrangler config gives ${name} a value that is not a string`,
    );
  }
}

/**
 * Plans the CI install of `manifest` as Worker `name`: the wrangler config
 * (bindings without ids, so wrangler provisions them under
 * {@link resourceName}), the resources to clean up, and the secrets to set.
 * Throws for a binding kind this check cannot create or clean up yet, instead
 * of deploying a Worker with a binding missing, and for any service binding
 * but one to the app's own Worker, which it aims at `name`.
 *
 * Vars follow the manager: a catalog default overrides the wrangler config's
 * value, a `json` var's default is parsed and stays JSON, and
 * `{{workerName}}`, `{{workerUrl}}` and `{{accountId}}` are filled in with
 * `name`, its workers.dev URL in `subdomain`, and `accountId` (each kept as
 * written when not given, which only a plan for cleanup should do).
 *
 * The artifact's cron triggers are left out of the config and recorded as a
 * note (see {@link cronNote}); cleanup never depends on them.
 *
 * With `entry`, `manifest` is one Worker's view of an app of several
 * (`workerManifest`) and `name` that Worker's CI name: resources and
 * `{{workerName}}`/`{{workerUrl}}` are the app's (`entry.installName`),
 * bindings that name another Worker of the entry point at its CI Worker, and
 * vars get `{{workerUrl:<name>}}`/`{{workerName:<name>}}` filled in.
 */
export function planCiInstall(
  manifest: ArtifactManifest,
  name: string,
  options: {
    /** A rate limit namespace id for the binding; random by default. */
    namespaceId?: (binding: string) => string;
    subdomain?: string;
    accountId?: string;
    entry?: EntryPlanContext;
    /** False for a Worker the entry keeps off workers.dev; true by default. */
    workersDev?: boolean;
  } = {},
): CiInstallPlan {
  const { worker } = manifest;
  const { entry } = options;
  const namespaceId = options.namespaceId ?? randomNamespaceId;
  const appName = entry?.installName ?? name;
  const appUrl = options.subdomain === undefined ? null : healthUrl(appName, options.subdomain, "");
  const placeholders: PlaceholderValues = {
    workerName: appName,
    workerUrl: appUrl,
    appUrl,
    accountId: options.accountId ?? null,
    // The CI account has no Zero Trust organization, and the check deploys
    // the app unprotected, so the Access placeholders are empty, as the
    // manager fills them in for an app it does not protect.
    access: null,
  };
  // A JSON value (a var's, or a service binding's props) filled in as the
  // manager fills it in: the placeholders, keys included, then the
  // per-Worker ones in its strings.
  const fillJson = (value: JsonValue): JsonValue => {
    const rendered = renderJsonPlaceholders(value, placeholders);
    return entry === undefined ? rendered : mapJsonStrings(rendered, entry.render);
  };
  const resources: CiResource[] = [];
  const kv: Record<string, string>[] = [];
  const d1: Record<string, string>[] = [];
  const r2: Record<string, string>[] = [];
  const durableObjects: Record<string, string>[] = [];
  const workflows: Record<string, unknown>[] = [];
  const analytics: Record<string, string>[] = [];
  const vectorize: Record<string, string>[] = [];
  const vectorizeIndexes: CiVectorizeIndex[] = [];
  const r2Lifecycles: CiR2Lifecycle[] = [];
  const hyperdrive: Record<string, string>[] = [];
  const hyperdriveConfigs: CiHyperdriveConfig[] = [];
  const producers: Record<string, unknown>[] = [];
  const queues: string[] = [];
  const ratelimits: Record<string, unknown>[] = [];
  const sendEmail: Record<string, unknown>[] = [];
  const services: Record<string, unknown>[] = [];
  const workerLoaders: Record<string, string>[] = [];
  const notes: string[] = [];
  const singles: Record<string, { binding: string }> = {};
  const vars: Record<string, JsonValue> = {};
  const jsonVars = new Set<string>();
  const d1Databases: CiD1Database[] = [];

  for (const binding of worker.bindings) {
    const resource = resourceName(appName, binding.name);
    switch (binding.type) {
      case "kv_namespace":
        // No name field: wrangler titles it `<worker>-<binding>` itself.
        kv.push({ binding: binding.name });
        resources.push({ type: "kv", name: resource, binding: binding.name });
        break;
      case "d1": {
        const files = d1FilesOf(manifest, binding.name);
        const seed = d1SeedOf(manifest.catalog, binding.name);
        d1.push({
          binding: binding.name,
          database_name: resource,
          ...migrationsLayout(
            `${D1_DIR}/${binding.name}`,
            files.migrations.map((f) => f.name),
          ),
        });
        resources.push({ type: "d1", name: resource, binding: binding.name });
        const baseline = files.baseline;
        const database: CiD1Database = {
          database: resource,
          binding: binding.name,
          migrations: files.migrations.length > 0,
          schema: files.schema.map((f) => `${D1_SCHEMA_DIR}/${binding.name}/${f.name}`),
          postDeploy: files.postDeploy.map((f) => f.name),
          ...(seed === null ? {} : { seed }),
          ...(baseline === undefined
            ? {}
            : {
                baseline: {
                  file: `${D1_BASELINE_DIR}/${binding.name}/${baseline.name}`,
                  recorded: [...files.migrations, ...files.postDeploy].map((f) => f.name),
                },
              }),
        };
        if (
          database.migrations ||
          database.schema.length > 0 ||
          database.postDeploy.length > 0 ||
          seed !== null ||
          baseline !== undefined
        ) {
          d1Databases.push(database);
        }
        break;
      }
      case "r2_bucket": {
        r2.push({ binding: binding.name, bucket_name: resource });
        resources.push({ type: "r2", name: resource, binding: binding.name });
        const rules = lifecycleOf(binding);
        if (rules !== undefined) {
          r2Lifecycles.push({ bucket: resource, binding: binding.name, rules });
        }
        break;
      }
      case "durable_object_namespace": {
        // A class in another Worker of the entry: that Worker's CI name.
        const ref = entry?.refName(binding.script_name) ?? null;
        durableObjects.push({
          name: binding.name,
          class_name: str(binding, "class_name"),
          ...(ref !== null && entry !== undefined
            ? { script_name: entryTarget(entry, ref, binding) }
            : optionalStr(binding, "script_name")),
        });
        break;
      }
      case "workflow":
        // Workflow names are account-wide; a per-install name keeps CI runs apart.
        workflows.push({
          binding: binding.name,
          name: resource,
          class_name: str(binding, "class_name"),
          ...optionalStr(binding, "script_name"),
          ...workflowSettingsOf(worker, binding.name),
        });
        resources.push({ type: "workflow", name: resource, binding: binding.name });
        break;
      case "vectorize":
        // Created through the API before the deploy; the binding names it.
        vectorizeIndexes.push(vectorizeIndex(binding, resource));
        vectorize.push({ binding: binding.name, index_name: resource });
        resources.push({ type: "vectorize", name: resource, binding: binding.name });
        break;
      case "queue": {
        // Created through the API before the deploy; the producer names it.
        const queue = queueName(resource);
        const delay = binding.delivery_delay;
        producers.push({
          binding: binding.name,
          queue,
          ...(typeof delay === "number" ? { delivery_delay: delay } : {}),
        });
        queues.push(queue);
        resources.push({ type: "queue", name: queue, binding: binding.name });
        break;
      }
      case "ratelimit":
        ratelimits.push({
          name: binding.name,
          namespace_id: namespaceId(binding.name),
          simple: rateLimitSimple(binding),
        });
        break;
      case "send_email": {
        const mail = sendEmailBinding(binding);
        sendEmail.push(mail.config);
        if (mail.note !== null) {
          notes.push(mail.note);
        }
        break;
      }
      case "service":
        // Aimed at the CI Worker itself, as the manager aims it at the install's
        // Worker, or at the CI Worker of the entry Worker it names.
        services.push(selfServiceBinding(binding, name, fillJson, entry));
        break;
      case "worker_loader":
        // `{ binding }` is all wrangler's `worker_loaders` takes. Workers Paid only.
        workerLoaders.push({ binding: binding.name });
        break;
      case "analytics_engine":
        analytics.push({ binding: binding.name, ...optionalStr(binding, "dataset") });
        break;
      case "ai":
      case "browser":
      case "images":
      case "version_metadata":
        singles[binding.type] = { binding: binding.name };
        break;
      case "plain_text":
        // An empty var is a value too (upstream configs use "" for "unset").
        if (typeof binding.text !== "string") {
          throw new Error(`binding ${binding.name} (plain_text) has no text`);
        }
        vars[binding.name] = binding.text;
        break;
      case "json":
        // A non-string wrangler var: it stays JSON, not its JSON text.
        if (!Object.hasOwn(binding, "json")) {
          throw new Error(`binding ${binding.name} (json) has no json value`);
        }
        vars[binding.name] = binding.json as JsonValue;
        jsonVars.add(binding.name);
        break;
      case "assets":
        break;
      case "hyperdrive":
        // Created through the API from HYPERDRIVE_TEST_URL before the deploy
        // (wrangler cannot provision one); its id is filled in then.
        hyperdrive.push({ binding: binding.name, id: "" });
        hyperdriveConfigs.push({
          name: resource,
          binding: binding.name,
          protocol: declaredProtocol(manifest.catalog, binding.name),
        });
        resources.push({ type: "hyperdrive", name: resource, binding: binding.name });
        break;
      default:
        // TODO: mTLS certificates need resources this check
        // does not create and clean up yet.
        throw new Error(
          `the CI install check cannot create a ${binding.type} binding (${binding.name}) yet`,
        );
    }
  }

  const queueConsumers = planQueueConsumers(worker, appName, resources, queues, entry);
  const crons = cronNote(worker.crons);
  if (crons !== null) {
    notes.push(crons);
  }

  const forms = catalogForms(manifest.catalog);
  for (const v of forms.vars) {
    if (v.default !== undefined) {
      vars[v.name] = jsonVars.has(v.name) ? jsonDefault(v.name, v.default) : v.default;
    } else if (v.required && vars[v.name] === undefined) {
      // A required choice without a default gets its first option, the only
      // kind of value the app accepts for it.
      vars[v.name] =
        v.firstOption === undefined
          ? REQUIRED_VAR_PLACEHOLDER
          : jsonVars.has(v.name)
            ? jsonDefault(v.name, v.firstOption)
            : v.firstOption;
    }
  }
  for (const [varName, value] of Object.entries(vars)) {
    vars[varName] = fillJson(value);
  }
  // Seed-only vars stay out of the config: only the seed statements read them.
  const seedVars: Record<string, string> = {};
  for (const v of forms.seedOnlyVars) {
    const rendered = renderPlaceholders(
      v.default ?? v.firstOption ?? SEED_VAR_PLACEHOLDER,
      placeholders,
    );
    seedVars[v.name] = entry === undefined ? rendered : entry.render(rendered);
  }
  const workersDev = options.workersDev ?? true;

  const rules = new Map<WranglerRule, string[]>();
  for (const module of worker.modules) {
    const rule = RULE_TYPES[module.type];
    if (!rule) {
      throw new Error(`module ${module.name} has an unknown type ${module.type}`);
    }
    rules.set(rule, [...(rules.get(rule) ?? []), module.name]);
  }

  const hasAssets = manifest.assets.files.length > 0 || manifest.assets.binding !== null;
  // Files wrangler reads from the assets directory, not keys of its config.
  const { _redirects, _headers, ...assetsConfig } = manifest.assets.config;
  // A Worker of static assets only: wrangler uploads it without a module.
  const assetsOnly = worker.mainModule === undefined;
  if (assetsOnly) {
    if (worker.modules.length > 0) {
      throw new Error(`the Worker ${worker.name} has modules but no main module`);
    }
    notes.push("static assets only: deployed without Worker code");
  }
  const config: Record<string, unknown> = {
    name,
    ...(assetsOnly
      ? {}
      : {
          main: `${WORKER_DIR}/${worker.mainModule}`,
        }),
    compatibility_date: worker.compatibilityDate,
    compatibility_flags: [...worker.compatibilityFlags],
    // The modules are wrangler's own build output; upload them unchanged.
    ...(assetsOnly
      ? {}
      : {
          no_bundle: true,
          find_additional_modules: true,
          base_dir: WORKER_DIR,
          rules: [...rules].map(([type, globs]) => ({ type, globs })),
        }),
    // Off for a Worker the entry keeps off workers.dev, as the manager keeps it.
    workers_dev: workersDev,
    preview_urls: false,
    send_metrics: false,
    ...(hasAssets
      ? {
          assets: {
            ...assetsConfig,
            directory: ASSETS_DIR,
            ...(manifest.assets.binding ? { binding: manifest.assets.binding } : {}),
          },
        }
      : {}),
    ...(kv.length > 0 ? { kv_namespaces: kv } : {}),
    ...(d1.length > 0 ? { d1_databases: d1 } : {}),
    ...(r2.length > 0 ? { r2_buckets: r2 } : {}),
    ...(durableObjects.length > 0 ? { durable_objects: { bindings: durableObjects } } : {}),
    ...(workflows.length > 0 ? { workflows } : {}),
    ...(analytics.length > 0 ? { analytics_engine_datasets: analytics } : {}),
    ...(vectorize.length > 0 ? { vectorize } : {}),
    ...(hyperdrive.length > 0 ? { hyperdrive } : {}),
    // Consumers are attached through the API after the deploy, as the manager does.
    ...(producers.length > 0 ? { queues: { producers } } : {}),
    ...(ratelimits.length > 0 ? { ratelimits } : {}),
    ...(sendEmail.length > 0 ? { send_email: sendEmail } : {}),
    ...(services.length > 0 ? { services } : {}),
    ...(workerLoaders.length > 0 ? { worker_loaders: workerLoaders } : {}),
    ...singles,
    ...(Object.keys(vars).length > 0 ? { vars } : {}),
    // No `triggers`: without it wrangler leaves the Worker's schedules alone
    // (a fresh Worker has none), so the deploy makes no cron trigger call at all.
    ...(worker.observability ? { observability: { ...worker.observability } } : {}),
    ...(worker.migrations.length > 0
      ? { migrations: worker.migrations.map((m) => ({ ...m })) }
      : {}),
    // Recorded as the app's config declared them. With a Durable Object
    // export, wrangler uploads the exports and no migrations, as the manager does.
    ...(worker.exports !== undefined && Object.keys(worker.exports).length > 0
      ? { exports: structuredClone(worker.exports) }
      : {}),
    // wrangler's `cache` block, uploaded as the script's `cache_options`.
    ...(worker.cacheOptions !== undefined ? { cache: { ...worker.cacheOptions } } : {}),
    ...(worker.placement ? { placement: { ...worker.placement } } : {}),
    ...(worker.limits ? { limits: { ...worker.limits } } : {}),
  };
  return {
    name,
    config,
    resources,
    secrets: forms.secrets,
    secretNames: forms.secretNames,
    seedOnlySecrets: forms.seedOnlySecrets,
    vapidPrivateKeys: forms.vapidPrivateKeys,
    base64Keys: forms.base64Keys,
    seedVars,
    workersDev,
    derivedSecrets: forms.derivedSecrets,
    derivedVars: forms.derivedVars,
    d1: d1Databases,
    vectorizeIndexes,
    r2Lifecycles,
    hyperdriveConfigs,
    queues,
    queueConsumers,
    notes,
    probePath: catalogHealthPath(manifest.catalog),
    probeMode: catalogHealthMode(manifest.catalog),
  };
}

/**
 * The Worker's queue consumers by queue name. A queue named by its producer
 * binding is that binding's queue; one named by its upstream name (typically
 * a dead-letter queue) gets a queue of its own, `<worker>-<name>`, added to
 * `queues` and `resources` so it is created and deleted like the others.
 * Throws for a consumer the manager would refuse: a binding reference to no
 * queue binding, an upstream name that collides with a binding's resource, or
 * a queue consumed twice.
 *
 * In an app of several Workers (`entry`) a queue is the app's: a consumer may
 * name another Worker's producer binding, and upstream names may not collide
 * with any Worker's binding.
 */
function planQueueConsumers(
  worker: ArtifactManifest["worker"],
  name: string,
  resources: CiResource[],
  queues: string[],
  entry?: EntryPlanContext,
): CiQueueConsumer[] {
  const queueBindings =
    entry?.queueBindings ??
    new Set(worker.bindings.filter((b) => b.type === "queue").map((b) => b.name));
  const bindingNames = entry?.bindingNames ?? new Set(worker.bindings.map((b) => b.name));
  const bound = new Set(resources.map((r) => r.name));
  const queueOf = (ref: QueueRef): string => {
    if ("binding" in ref) {
      if (!queueBindings.has(ref.binding)) {
        throw new Error(
          `a queue consumer names the queue binding ${ref.binding}, but the Worker has no queue binding by that name`,
        );
      }
      return resourceName(name, ref.binding);
    }
    const queue = queueName(resourceName(name, ref.name));
    if (bindingNames.has(ref.name) || bound.has(queue)) {
      throw new Error(
        `the queue "${ref.name}" would share its name with a binding's resource (${queue})`,
      );
    }
    if (!queues.includes(queue)) {
      queues.push(queue);
      resources.push({ type: "queue", name: queue, binding: ref.name });
    }
    return queue;
  };
  const consumers: CiQueueConsumer[] = [];
  for (const consumer of worker.queueConsumers ?? []) {
    const queue = queueOf(consumer.queue);
    if (consumers.some((c) => c.queue === queue)) {
      throw new Error(`the queue ${queue} has more than one consumer`);
    }
    consumers.push({
      queue,
      deadLetterQueue:
        consumer.dead_letter_queue === undefined ? null : queueOf(consumer.dead_letter_queue),
      settings: consumerSettings(consumer),
    });
  }
  return consumers;
}

/**
 * The run summary's lines for one check: `PASS` or `FAIL` with the artifact,
 * the CI Worker, and `detail`, then one line per note of the plan. Written for
 * a failed deploy too, so the notes are there whatever the outcome.
 */
export function summaryLines(
  manifest: Pick<ArtifactManifest, "app" | "version">,
  plan: Pick<CiInstallPlan, "name" | "notes">,
  ok: boolean,
  detail: string,
): string[] {
  return [
    `${ok ? "PASS" : "FAIL"} ${manifest.app}@${manifest.version} as ${plan.name}: ${detail}`,
    ...plan.notes.map((note) => `- note: ${note}`),
  ];
}

// ---------------------------------------------------------------------------
// Apps of several Workers

/** One Worker of the app as the check deploys it. */
export interface CiAppWorker {
  /** Its name within the entry (`install.workers[].name`); null for an app of one Worker. */
  entryName: string | null;
  primary: boolean;
  /** Its plan: CI Worker name, wrangler config, secrets and queue consumers. */
  plan: CiInstallPlan;
  /** The manifest as this Worker sees it (`workerManifest`): its files are unpacked from it. */
  manifest: ArtifactManifest;
}

/**
 * The CI install of a whole app: every Worker in deploy order, and what they
 * share. An app of one Worker is one Worker whose plan is
 * {@link planCiInstall}'s, deployed exactly as before.
 */
/** A D1 database of the app and the Worker whose work dir its SQL runs from. */
export type CiAppD1Database = CiD1Database & { worker: string };

export interface CiAppPlan {
  /** The primary CI Worker's name, `ci-<slug>-<suffix>`. */
  name: string;
  /** Every Worker, each after the Workers it binds to (`appWorkersInDeployOrder`). */
  workers: CiAppWorker[];
  /** Everything the deploys may create besides the Workers, each once. */
  resources: CiResource[];
  vectorizeIndexes: CiVectorizeIndex[];
  /** R2 buckets with lifecycle rules, each once. */
  r2Lifecycles: CiR2Lifecycle[];
  /** Hyperdrive configurations the Workers bind, each once. */
  hyperdriveConfigs: CiHyperdriveConfig[];
  queues: string[];
  /**
   * KV namespaces the check creates through the API before the deploys and
   * writes into every Worker's config by id (see {@link withKvIds}): empty for
   * an app of one Worker, whose deploy provisions its own.
   */
  kvNamespaces: CiResource[];
  /**
   * D1 databases with SQL to run, each once, from the work dir of the Worker
   * named (the first in deploy order that binds it).
   */
  d1: CiAppD1Database[];
  probePath: string;
  probeMode: HealthMode;
}

/** A Worker name is a DNS label on workers.dev: at most 63 characters. */
const MAX_SCRIPT_NAME = 63;

/**
 * The `@appflare/schema` functions {@link planCiApp} needs for an app of
 * several Workers (see `loadEntryWorkerHelpers`).
 */
export type CiEntryHelpers = Pick<
  EntryWorkerHelpers,
  | "appWorkersInDeployOrder"
  | "workerManifest"
  | "entryScriptName"
  | "entryWorkerRefName"
  | "renderEntryWorkerPlaceholders"
>;

/**
 * Plans the CI install of every Worker of `manifest` under the install name
 * `name`, as the manager installs them: in `appWorkersInDeployOrder`'s order,
 * each Worker planned from its own view of the manifest (`workerManifest`:
 * its bindings, assets, and the secrets and vars that go to it) under
 * `entryScriptName`, with resources shared by binding name. A rate limit
 * binding gets one namespace id for every Worker that binds it. Needs
 * `helpers` for an artifact of several Workers.
 */
export function planCiApp(
  manifest: ArtifactManifest,
  name: string,
  options: {
    namespaceId?: (binding: string) => string;
    subdomain?: string;
    accountId?: string;
    helpers?: CiEntryHelpers;
  } = {},
): CiAppPlan {
  const { helpers, ...planOptions } = options;
  if (manifest.workers === undefined) {
    const plan = planCiInstall(manifest, name, planOptions);
    return {
      name,
      workers: [{ entryName: null, primary: true, plan, manifest }],
      resources: plan.resources,
      vectorizeIndexes: plan.vectorizeIndexes,
      r2Lifecycles: plan.r2Lifecycles,
      hyperdriveConfigs: plan.hyperdriveConfigs,
      queues: plan.queues,
      kvNamespaces: [],
      d1: plan.d1.map((database) => ({ ...database, worker: name })),
      probePath: plan.probePath,
      probeMode: plan.probeMode,
    };
  }
  if (helpers === undefined) {
    throw new Error(
      `${manifest.app}@${manifest.version} has several Workers; planning it needs @appflare/schema's functions for them`,
    );
  }
  const ordered = helpers.appWorkersInDeployOrder(manifest);
  const scriptNames: Record<string, string> = {};
  const entryNames: string[] = [];
  for (const w of ordered) {
    if (w.name === null) {
      throw new Error(`a Worker of ${manifest.app}@${manifest.version} has no name in the entry`);
    }
    const scriptName = helpers.entryScriptName(name, w.name, w.primary);
    if (scriptName.length > MAX_SCRIPT_NAME) {
      throw new Error(
        `the CI Worker name "${scriptName}" is longer than ${MAX_SCRIPT_NAME} characters; use a shorter suffix`,
      );
    }
    scriptNames[w.name] = scriptName;
    entryNames.push(w.name);
  }
  // A Worker kept off workers.dev has no URL; the schema refuses a
  // `{{workerUrl:<name>}}` of one, so null never reaches a var.
  const onWorkersDev = new Map(ordered.map((w) => [w.name, w.primary || w.workersDev !== false]));
  const placeholders = Object.fromEntries(
    Object.entries(scriptNames).map(([entryName, scriptName]) => {
      const url =
        options.subdomain === undefined || onWorkersDev.get(entryName) === false
          ? null
          : healthUrl(scriptName, options.subdomain, "");
      // No custom domains in the install check: each Worker is served at its workers.dev URL.
      return [entryName, { workerName: scriptName, workerUrl: url, appUrl: url }];
    }),
  );
  const bindings = ordered.flatMap((w) => w.worker.bindings);
  const entry: EntryPlanContext = {
    installName: name,
    scriptNames,
    bindingNames: new Set(bindings.map((b) => b.name)),
    queueBindings: new Set(bindings.filter((b) => b.type === "queue").map((b) => b.name)),
    refName: helpers.entryWorkerRefName,
    render: (text) => helpers.renderEntryWorkerPlaceholders(text, placeholders),
  };
  // Bindings of one name share one resource; a rate limit shares its counters.
  const namespaceIds = new Map<string, string>();
  const namespaceId = (binding: string): string => {
    const id = namespaceIds.get(binding) ?? (options.namespaceId ?? randomNamespaceId)(binding);
    namespaceIds.set(binding, id);
    return id;
  };
  const workers: CiAppWorker[] = ordered.map((w, i) => {
    const view = helpers.workerManifest(manifest, w);
    const entryName = entryNames[i] as string;
    const plan = planCiInstall(view, scriptNames[entryName] as string, {
      ...planOptions,
      namespaceId,
      entry,
      workersDev: onWorkersDev.get(entryName) !== false,
    });
    return {
      entryName,
      primary: w.primary,
      plan: { ...plan, notes: plan.notes.map((note) => `Worker ${entryName}: ${note}`) },
      manifest: view,
    };
  });
  const consumed = new Map<string, string>();
  for (const w of workers) {
    for (const consumer of w.plan.queueConsumers) {
      const other = consumed.get(consumer.queue);
      if (other !== undefined) {
        throw new Error(
          `the queue ${consumer.queue} is consumed by both ${other} and ${w.plan.name}; a queue has one consumer`,
        );
      }
      consumed.set(consumer.queue, w.plan.name);
    }
  }
  const plans = workers.map((w) => w.plan);
  const resources = uniqueBy(
    plans.flatMap((p) => p.resources),
    (r) => `${r.type}:${r.name}`,
  );
  const d1 = uniqueBy(
    plans.flatMap((p) => p.d1.map((database) => ({ ...database, worker: p.name }))),
    (m) => m.database,
  );
  const primary = workers.find((w) => w.primary)?.plan ?? plans[0];
  return {
    name,
    workers,
    resources,
    vectorizeIndexes: uniqueBy(
      plans.flatMap((p) => p.vectorizeIndexes),
      (v) => v.name,
    ),
    r2Lifecycles: uniqueBy(
      plans.flatMap((p) => p.r2Lifecycles),
      (b) => b.bucket,
    ),
    hyperdriveConfigs: uniqueBy(
      plans.flatMap((p) => p.hyperdriveConfigs),
      (h) => h.name,
    ),
    queues: [...new Set(plans.flatMap((p) => p.queues))],
    kvNamespaces: resources.filter((r) => r.type === "kv"),
    d1,
    probePath: primary?.probePath ?? "/",
    probeMode: primary?.probeMode ?? "no-server-errors",
  };
}

/** `items` without later ones whose key an earlier one has. */
function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** `config` with each KV binding given the id of the namespace created for it. */
export function withKvIds(
  config: Record<string, unknown>,
  ids: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const kv = config.kv_namespaces as Record<string, string>[] | undefined;
  if (kv === undefined) return config;
  return {
    ...config,
    kv_namespaces: kv.map((ns) => {
      const id = Object.hasOwn(ids, ns.binding as string) ? ids[ns.binding as string] : undefined;
      if (id === undefined) {
        throw new Error(`no KV namespace was created for the binding ${ns.binding}`);
      }
      return { ...ns, id };
    }),
  };
}

/**
 * Creates each KV namespace an app of several Workers shares, with
 * `POST /storage/kv/namespaces` and `{ title }`, and returns their ids by
 * binding name. Run after the cleanup of an earlier run, like the queues.
 */
export async function createKvNamespaces(
  request: CfRequest,
  app: Pick<CiAppPlan, "kvNamespaces">,
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const ns of app.kvNamespaces) {
    const res = await request("POST", "/storage/kv/namespaces", { title: ns.name });
    const id = (res.body?.result as { id?: unknown } | undefined)?.id;
    if (!created(res) || typeof id !== "string") {
      throw new Error(`creating KV namespace ${ns.name} failed: ${describe(res)}`);
    }
    ids[ns.binding] = id;
  }
  return ids;
}

/**
 * The packer's functions for secret values, computed as the manager computes
 * them; each null when the app needs none (see {@link needsPackerSecrets}).
 */
export interface CiSecretFunctions {
  deriveSecretValue: ((method: string, value: string) => string) | null;
  generateVapidPrivateKey: (() => string) | null;
}

/** Whether any Worker of the app has a secret or var only the packer's functions can fill in. */
export function needsPackerSecrets(app: Pick<CiAppPlan, "workers">): boolean {
  return app.workers.some(
    (w) =>
      w.plan.vapidPrivateKeys.length > 0 ||
      w.plan.derivedSecrets.length > 0 ||
      w.plan.derivedVars.length > 0,
  );
}

/** `derive.method` applied to the value of the secret keyed `derive.from`, refused when either is missing. */
function derivedValue(
  derived: CiDerivedSecret,
  values: ReadonlyMap<string, string>,
  derive: CiSecretFunctions["deriveSecretValue"],
): string {
  const source = values.get(derived.from);
  if (source === undefined) {
    throw new Error(`${derived.name} derives from ${derived.from}, which the check did not set`);
  }
  if (derive === null) {
    throw new Error(`${derived.name} is derived, and no derivation was loaded`);
  }
  return derive(derived.method, source);
}

/**
 * The value of every secret any Worker of the app gets, and of every
 * seed-only secret, by key (a secret's `key`, else its name; see
 * {@link CiInstallPlan.secrets}), so secrets of one name and different keys
 * each get their own: a random one (32 characters) for each, a new
 * VAPID private key for a `generate: "vapid-private-key"` secret, 32 random
 * bytes as padded base64 for a `generate: "base64-key-32"` one, and for a
 * derived secret the value `derive` computes from its source's. A secret
 * that goes to several Workers has one value for all of them, as the install
 * form gives it one. Never printed.
 */
export function appSecretValues(
  app: Pick<CiAppPlan, "workers">,
  fns: CiSecretFunctions,
  random: () => string = randomSecret,
): Map<string, string> {
  const values = new Map<string, string>();
  for (const w of app.workers) {
    const vapid = new Set(w.plan.vapidPrivateKeys);
    const base64 = new Set(w.plan.base64Keys);
    for (const secret of [...w.plan.secrets, ...w.plan.seedOnlySecrets]) {
      if (values.has(secret)) continue;
      if (base64.has(secret)) {
        values.set(secret, randomBase64Key32());
      } else if (!vapid.has(secret)) {
        values.set(secret, random());
      } else if (fns.generateVapidPrivateKey === null) {
        throw new Error(`${secret} is a VAPID private key, and no generator was loaded`);
      } else {
        values.set(secret, fns.generateVapidPrivateKey());
      }
    }
  }
  for (const w of app.workers) {
    for (const secret of w.plan.derivedSecrets) {
      const key = derivedKey(secret);
      if (!values.has(key)) {
        values.set(key, derivedValue(secret, values, fns.deriveSecretValue));
      }
    }
  }
  return values;
}

/**
 * The derived vars of one Worker (a VAPID public key, say), computed from the
 * secret values {@link appSecretValues} chose, as the manager sets them.
 */
export function derivedVarValues(
  plan: Pick<CiInstallPlan, "derivedVars">,
  secrets: ReadonlyMap<string, string>,
  derive: CiSecretFunctions["deriveSecretValue"],
): Record<string, string> {
  return Object.fromEntries(
    plan.derivedVars.map((v) => [v.name, derivedValue(v, secrets, derive)] as const),
  );
}

/**
 * The secrets to set on one Worker: each secret it gets (derived ones
 * included) under the name the Worker reads, with the value of its key.
 * Throws, naming no value, when one has none.
 */
export function workerSecretValues(
  plan: Pick<CiInstallPlan, "secrets" | "derivedSecrets" | "secretNames">,
  values: ReadonlyMap<string, string>,
): Array<{ name: string; value: string }> {
  return [...plan.secrets, ...plan.derivedSecrets.map(derivedKey)].map((key) => {
    const value = values.get(key);
    if (value === undefined) {
      throw new Error(`the check has no value for the secret ${key}`);
    }
    return {
      name: Object.hasOwn(plan.secretNames, key) ? (plan.secretNames[key] as string) : key,
      value,
    };
  });
}

/** `config` with `vars` added to its own vars; unchanged when there are none. */
export function withVars(
  config: Record<string, unknown>,
  vars: Record<string, string>,
): Record<string, unknown> {
  if (Object.keys(vars).length === 0) return config;
  const own = (config.vars ?? {}) as Record<string, unknown>;
  return { ...config, vars: { ...own, ...vars } };
}

/**
 * How the check probes a Worker of the app other than the primary one: its
 * root, until it answers, by the entry's health mode. Such a Worker has no
 * health path of its own, and the manager checks only the primary, but an
 * app whose other Worker does not run is broken all the same (the primary
 * calls it through a binding, or sends people to its address). So no answer,
 * only Cloudflare's own error pages (1042, 1101), or under `default` a
 * persistent 5xx fails the check; any other answer, a 404 included, passes.
 * It runs after the primary's check, so its route has had time to go live.
 */
export const OTHER_WORKER_PROBE = { path: "/", timeoutMs: 30_000 } as const;

/** How long the primary Worker has to answer at its health path. */
export const PRIMARY_PROBE_TIMEOUT_MS = 60_000;

/** What the summary says of a Worker the entry keeps off workers.dev. */
export const NOT_ON_WORKERS_DEV = "not probed: kept off workers.dev";

/** One Worker's health check: a URL to poll, or why it has none. */
export type CiHealthProbe<W> =
  | { worker: W; url: string; timeoutMs: number }
  | { worker: W; skipped: HealthResult };

/**
 * The health checks of the app, in order: the primary Worker at its health
 * path, then every other Worker at {@link OTHER_WORKER_PROBE}'s path. A
 * Worker the entry keeps off workers.dev has no URL to probe: the check,
 * like the manager, reaches it only through the other Workers' bindings, so
 * it is skipped and counts as passing.
 */
export function healthProbes<
  W extends { primary: boolean; plan: Pick<CiInstallPlan, "name" | "workersDev"> },
>(app: { workers: readonly W[]; probePath: string }, subdomain: string): CiHealthProbe<W>[] {
  const primary = app.workers.filter((w) => w.primary);
  const others = app.workers.filter((w) => !w.primary);
  return [
    ...primary.map((worker) => ({
      worker,
      url: healthUrl(worker.plan.name, subdomain, app.probePath),
      timeoutMs: PRIMARY_PROBE_TIMEOUT_MS,
    })),
    ...others.map((worker) =>
      worker.plan.workersDev
        ? {
            worker,
            url: healthUrl(worker.plan.name, subdomain, OTHER_WORKER_PROBE.path),
            timeoutMs: OTHER_WORKER_PROBE.timeoutMs,
          }
        : { worker, skipped: { ok: true, detail: NOT_ON_WORKERS_DEV } },
    ),
  ];
}

/** What the check found for one Worker of the app. */
export interface CiWorkerResult {
  worker: Pick<CiAppWorker, "entryName" | "primary"> & { plan: Pick<CiInstallPlan, "name"> };
  health: HealthResult;
}

/**
 * The run summary's lines for the whole app. An app of one Worker gets
 * {@link summaryLines} with its health check's detail. An app of several
 * gets a result line, one line per Worker naming it with what it answered
 * (when the check got that far), then every Worker's notes.
 */
export function appSummaryLines(
  manifest: Pick<ArtifactManifest, "app" | "version">,
  app: Pick<CiAppPlan, "name"> & {
    workers: (Pick<CiAppWorker, "entryName" | "primary"> & {
      plan: Pick<CiInstallPlan, "name" | "notes">;
    })[];
  },
  ok: boolean,
  detail: string,
  results: readonly CiWorkerResult[] = [],
): string[] {
  const [only] = app.workers;
  if (app.workers.length === 1 && only !== undefined) {
    return summaryLines(manifest, only.plan, ok, detail);
  }
  return [
    `${ok ? "PASS" : "FAIL"} ${manifest.app}@${manifest.version} as ${app.name} (${app.workers.length} Workers): ${detail}`,
    ...app.workers.map((w) => {
      const result = results.find((r) => r.worker.plan.name === w.plan.name);
      const label = `- Worker ${w.entryName}${w.primary ? " (primary)" : ""} as ${w.plan.name}`;
      return result === undefined
        ? `${label}: not checked`
        : `${label}: ${result.health.ok ? "" : "FAIL "}${result.health.detail}`;
    }),
    ...app.workers.flatMap((w) => w.plan.notes.map((note) => `- note: ${note}`)),
  ];
}

/** Resolves a manifest path under `root`, refusing anything that could escape it. */
export function safeJoin(root: string, relative: string): string {
  const segments = relative.split("/");
  if (
    relative.length === 0 ||
    relative.includes("\\") ||
    relative.includes("\0") ||
    segments.some((s) => s === "" || s === "." || s === "..")
  ) {
    throw new Error(`unsafe path in the artifact manifest: ${JSON.stringify(relative)}`);
  }
  return path.join(root, ...segments);
}

/**
 * Writes the Worker modules to `<outDir>/worker/` (a Worker of static assets
 * only has none, and gets no such folder), the assets to `<outDir>/assets/`,
 * and each D1 binding's migrations, schema files, post-deploy migrations and
 * baseline to `<outDir>/d1/<binding>/`, `<outDir>/d1-schema/<binding>/`,
 * `<outDir>/d1-post-deploy/<binding>/` and `<outDir>/d1-baseline/<binding>/`,
 * each under its name, reading each as its byte range of the STORE zip and
 * checking size and sha256 before anything is written. `_redirects` and
 * `_headers`, recorded as text in the assets config, are written at the root
 * of `<outDir>/assets/`, where wrangler reads them.
 */
export function unpackArtifact(manifest: ArtifactManifest, zipPath: string, outDir: string): void {
  const zipSize = statSync(zipPath).size;
  const fd = openSync(zipPath, "r");
  const writes: { target: string; data: Buffer }[] = [];
  try {
    const read = (entry: ArtifactFile): Buffer => {
      if (entry.offset + entry.size > zipSize) {
        throw new Error(`${entry.path} lies outside the zip`);
      }
      const data = Buffer.alloc(entry.size);
      const got = entry.size === 0 ? 0 : readSync(fd, data, 0, entry.size, entry.offset);
      if (got !== entry.size) {
        throw new Error(`short read for ${entry.path}`);
      }
      if (createHash("sha256").update(data).digest("hex") !== entry.sha256) {
        throw new Error(`sha256 mismatch for ${entry.path}`);
      }
      return data;
    };
    for (const m of manifest.worker.modules) {
      writes.push({ target: safeJoin(path.join(outDir, WORKER_DIR), m.name), data: read(m) });
    }
    for (const a of manifest.assets.files) {
      if (!a.route.startsWith("/")) {
        throw new Error(`asset route ${JSON.stringify(a.route)} does not start with /`);
      }
      writes.push({
        target: safeJoin(path.join(outDir, ASSETS_DIR), a.route.slice(1)),
        data: read(a),
      });
    }
    for (const name of ASSET_RULE_FILES) {
      const text = manifest.assets.config[name];
      if (typeof text === "string") {
        writes.push({ target: path.join(outDir, ASSETS_DIR, name), data: Buffer.from(text) });
      }
    }
    for (const [binding, sql] of Object.entries(manifest.d1)) {
      const lists = [
        [D1_DIR, sql.migrations],
        [D1_SCHEMA_DIR, sql.schema],
        [D1_POST_DEPLOY_DIR, sql.postDeploy],
        [D1_BASELINE_DIR, sql.baseline === undefined ? [] : [sql.baseline]],
      ] as const;
      for (const [dir, files] of lists) {
        for (const f of files) {
          writes.push({
            target: safeJoin(path.join(outDir, dir), `${binding}/${f.name}`),
            data: read(f),
          });
        }
      }
    }
  } finally {
    closeSync(fd);
  }
  if (manifest.worker.modules.length > 0) {
    mkdirSync(path.join(outDir, WORKER_DIR), { recursive: true });
  }
  mkdirSync(path.join(outDir, ASSETS_DIR), { recursive: true });
  for (const { target, data } of writes) {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
}

/** A random secret value, 32 characters of base64url; never printed. */
export function randomSecret(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * A `generate: "base64-key-32"` value: 32 random bytes as padded base64 (44
 * characters), the form the install form generates. Never printed.
 */
export function randomBase64Key32(): string {
  return randomBytes(32).toString("base64");
}

// ---------------------------------------------------------------------------
// D1

/** One D1 binding's migrations, schema files, post-deploy migrations and baseline, as the artifact records them. */
function d1FilesOf(manifest: ArtifactManifest, binding: string): ArtifactD1Binding {
  const sql = Object.hasOwn(manifest.d1, binding) ? manifest.d1[binding] : undefined;
  return sql ?? { migrations: [], schema: [], postDeploy: [] };
}

/**
 * One D1 binding's seed (`resources.d1[binding].seed`) from the catalog
 * manifest embedded in the artifact, or null when it has none. The schema
 * parsed the catalog manifest, so a seed found here has its full shape.
 */
function d1SeedOf(catalog: unknown, binding: string): CatalogD1Seed | null {
  const d1 = (catalog as { resources?: { d1?: unknown } } | null)?.resources?.d1;
  if (d1 === null || typeof d1 !== "object" || !Object.hasOwn(d1, binding)) return null;
  const seed = (d1 as Record<string, { seed?: unknown } | undefined>)[binding]?.seed;
  return seed === undefined || seed === null ? null : (seed as CatalogD1Seed);
}

/**
 * The `migrations_dir`, and `migrations_pattern` when it is needed, that make
 * `wrangler d1 migrations apply` find exactly the migrations `names` unpacked
 * under `dir`, under those names. wrangler's default pattern, `<dir>/*.sql`,
 * finds only `.sql` files directly in the folder. A migration named by a path
 * (`20240101_init/migration.sql`, from a migrations glob or an upstream
 * `migrations_pattern`) needs `<dir>/**`, every file under the folder, which
 * holds only what the artifact records. wrangler names each file by its path
 * from `dir` and sorts them as the packer does, so `d1_migrations` records
 * the artifact's names in the artifact's order.
 */
export function migrationsLayout(
  dir: string,
  names: readonly string[],
): { migrations_dir?: string; migrations_pattern?: string } {
  if (names.length === 0) return {};
  const flat = names.every((n) => !n.includes("/") && !n.startsWith(".") && n.endsWith(".sql"));
  return flat ? { migrations_dir: dir } : { migrations_dir: dir, migrations_pattern: `${dir}/**` };
}

/**
 * The config the post-deploy migrations are applied with: the deploy config
 * with each such database's `migrations_dir` pointed at
 * `d1-post-deploy/<binding>`, so `wrangler d1 migrations apply` runs the ones
 * `d1_migrations` does not record yet and records them beside the others, as
 * the manager does. Null when no database has any.
 */
export function postDeployConfig(
  config: Record<string, unknown>,
  databases: readonly CiD1Database[],
): Record<string, unknown> | null {
  const post = new Map(databases.filter(appliesPostDeploy).map((d) => [d.binding, d.postDeploy]));
  if (post.size === 0) return null;
  const entries = Array.isArray(config.d1_databases)
    ? (config.d1_databases as Record<string, unknown>[])
    : [];
  return {
    ...config,
    d1_databases: entries.map((entry) => {
      const names = typeof entry.binding === "string" ? post.get(entry.binding) : undefined;
      if (names === undefined) return entry;
      const { migrations_dir: _dir, migrations_pattern: _pattern, ...rest } = entry;
      return { ...rest, ...migrationsLayout(`${D1_POST_DEPLOY_DIR}/${entry.binding}`, names) };
    }),
  };
}

/**
 * Whether a database's post-deploy migrations run with `wrangler d1
 * migrations apply`: it has some, and no baseline, after which they are
 * recorded without running.
 */
function appliesPostDeploy(d: CiD1Database): boolean {
  return d.postDeploy.length > 0 && d.baseline === undefined;
}

/**
 * The SQL that records `names` in `d1_migrations` as applied, without
 * running them: the table as `wrangler d1 migrations apply` creates it
 * (verbatim from wrangler 4, as the manager has it), then one row per name.
 * Names already recorded stay.
 */
export function recordMigrationsSql(names: readonly string[]): string {
  const rows = names.map((name) => `('${name.replace(/'/g, "''")}')`).join(",\n");
  return `CREATE TABLE IF NOT EXISTS "d1_migrations"(
\t\tid         INTEGER PRIMARY KEY AUTOINCREMENT,
\t\tname       TEXT UNIQUE,
\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT OR IGNORE INTO "d1_migrations" (name)
values ${rows};
`;
}

/**
 * One wrangler command of the D1 steps: its arguments, the config, the
 * Worker whose work dir it runs in, and a file to write there first (the
 * SQL that records a baseline database's migrations), relative to it.
 */
export interface CiWranglerStep {
  worker: string;
  config: string;
  args: string[];
  write?: { file: string; text: string };
}

/** One database's seed, run through the D1 API (see {@link runSeed}). */
export interface CiSeedStep {
  worker: string;
  database: string;
  binding: string;
  seed: CatalogD1Seed;
}

export type CiD1Step = CiWranglerStep | CiSeedStep;

/** Whether a D1 step is a seed rather than a wrangler command. */
export function isSeedStep(step: CiD1Step): step is CiSeedStep {
  return "seed" in step;
}

/**
 * The steps that run the app's D1 SQL once every Worker is deployed, in the
 * manager's order: for each database its migrations (or, with a baseline,
 * the baseline and then the rows that record every migration and
 * post-deploy migration as applied, none of which then runs), then its seed
 * when it says `beforeSchema`, then its schema files one by one (unrecorded;
 * the packer accepts only files that are safe to run again); then every
 * database's post-deploy migrations; then every other seed.
 */
export function d1Steps(databases: readonly CiAppD1Database[]): CiD1Step[] {
  const steps: CiD1Step[] = [];
  const seedStep = (d: CiAppD1Database, seed: CatalogD1Seed): CiSeedStep => ({
    worker: d.worker,
    database: d.database,
    binding: d.binding,
    seed,
  });
  for (const d of databases) {
    if (d.baseline !== undefined) {
      steps.push({
        worker: d.worker,
        config: DEPLOY_CONFIG,
        args: ["d1", "execute", d.database, "--remote", "--yes", "--file", d.baseline.file],
      });
      if (d.baseline.recorded.length > 0) {
        const file = `${D1_BASELINE_RECORD_DIR}/${d.binding}.sql`;
        steps.push({
          worker: d.worker,
          config: DEPLOY_CONFIG,
          args: ["d1", "execute", d.database, "--remote", "--yes", "--file", file],
          write: { file, text: recordMigrationsSql(d.baseline.recorded) },
        });
      }
    } else if (d.migrations) {
      steps.push({
        worker: d.worker,
        config: DEPLOY_CONFIG,
        args: ["d1", "migrations", "apply", d.database, "--remote"],
      });
    }
    if (d.seed?.beforeSchema === true) steps.push(seedStep(d, d.seed));
    for (const file of d.schema) {
      steps.push({
        worker: d.worker,
        config: DEPLOY_CONFIG,
        args: ["d1", "execute", d.database, "--remote", "--yes", "--file", file],
      });
    }
  }
  for (const d of databases.filter(appliesPostDeploy)) {
    steps.push({
      worker: d.worker,
      config: POST_DEPLOY_CONFIG,
      args: ["d1", "migrations", "apply", d.database, "--remote"],
    });
  }
  for (const d of databases) {
    if (d.seed !== undefined && d.seed.beforeSchema !== true) steps.push(seedStep(d, d.seed));
  }
  return steps;
}

// ---------------------------------------------------------------------------
// D1 seeds

/** The bcrypt cost of a seed hash that names none, as the manager's seed step uses. */
export const SEED_BCRYPT_DEFAULT_COST = 10;

/** The values a seed's params and hashes read, by name. Never printed. */
export interface CiSeedValues {
  vars: Record<string, string>;
  secrets: Record<string, string>;
}

/** Whether any database of the app has a seed. */
export function needsSeedHelpers(app: { d1: ReadonlyArray<Pick<CiD1Database, "seed">> }): boolean {
  return app.d1.some((d) => d.seed !== undefined);
}

/**
 * What the app's seeds read: every secret value the check chose (seed-only
 * ones included), and every var as the Workers get it from `configs` (the
 * configs they are deployed with, derived vars included; a JSON var as its
 * JSON text), plus each plan's seed-only vars. The primary Worker's value of
 * a var comes first. Never printed.
 */
export function seedValues(
  workers: ReadonlyArray<{
    primary: boolean;
    plan: Pick<CiInstallPlan, "seedVars">;
    config: Record<string, unknown>;
  }>,
  secrets: ReadonlyMap<string, string>,
): CiSeedValues {
  const vars = new Map<string, string>();
  const ordered = [...workers.filter((w) => w.primary), ...workers.filter((w) => !w.primary)];
  for (const w of ordered) {
    const own = (w.config.vars ?? {}) as Record<string, unknown>;
    for (const [name, value] of [...Object.entries(own), ...Object.entries(w.plan.seedVars)]) {
      if (vars.has(name) || value === undefined) continue;
      vars.set(name, typeof value === "string" ? value : JSON.stringify(value));
    }
  }
  return { vars: Object.fromEntries(vars), secrets: Object.fromEntries(secrets) };
}

/** How the check hashes and binds a seed (see `loadSeedHelpers`), and bcrypt. */
export interface CiSeedFunctions extends SeedHelpers {
  /** A `$2b$` bcrypt hash of `value` at `cost`, with a fresh salt. */
  bcryptHash(value: string, cost: number): string;
}

/** `helpers` with bcryptjs's `hashSync`, the bcrypt the manager hashes seeds with. */
export function seedFunctions(helpers: SeedHelpers): CiSeedFunctions {
  return {
    pbkdf2SeedHash: helpers.pbkdf2SeedHash,
    seedStatementProblems: helpers.seedStatementProblems,
    seedStatementParams: helpers.seedStatementParams,
    bcryptInputProblem: helpers.bcryptInputProblem,
    bcryptHash: (value, cost) => bcrypt.hashSync(value, cost),
  };
}

/** Every hash of `seed`, each computed once for the run, so a hash and its salt match. */
async function seedHashValues(
  seed: CatalogD1Seed,
  secrets: Readonly<Record<string, string>>,
  fns: CiSeedFunctions,
): Promise<Record<string, { hash: string; salt?: string }>> {
  const out = new Map<string, { hash: string; salt?: string }>();
  for (const [id, hash] of Object.entries(seed.hashes ?? {})) {
    const value = Object.hasOwn(secrets, hash.from) ? secrets[hash.from] : undefined;
    if (value === undefined || value.length === 0) {
      throw new Error(`the seed's hash "${id}" is of ${hash.from}, which the check did not set`);
    }
    if (hash.method === "pbkdf2-sha256") {
      out.set(id, await fns.pbkdf2SeedHash(hash, value));
    } else {
      const problem = fns.bcryptInputProblem(
        `The source of the hash "${id}" (${hash.from})`,
        value,
      );
      if (problem !== null) throw new Error(problem);
      out.set(id, { hash: fns.bcryptHash(value, hash.cost ?? SEED_BCRYPT_DEFAULT_COST) });
    }
  }
  return Object.fromEntries(out);
}

/** The rows a D1 `/query` result says its statement changed, or null when it does not say. */
function queryChanges(res: CfResponse): number | null {
  const first = Array.isArray(res.body?.result) ? (res.body.result[0] as unknown) : undefined;
  const changes = (first as { meta?: { changes?: unknown } } | undefined)?.meta?.changes;
  return typeof changes === "number" ? changes : null;
}

/**
 * Runs one database's seed as the manager's seed step does: every statement
 * checked again with `seedStatementProblems`, the hashes derived once, then
 * each statement as its own `POST /d1/database/{uuid}/query` with
 * `{ sql, params }`, so no value is ever part of the SQL. wrangler's
 * `d1 execute` cannot bind params, hence the API. The database is fresh, so
 * each statement must add at least one row (`meta.changes >= 1`); a
 * statement that adds none (a schema file already inserted the row) fails
 * the check. D1 counts the rows a trigger writes too, so a statement on a
 * table with an `AFTER INSERT` trigger may report more, which the manager
 * accepts as well. Errors name the statement and D1's message, never a value.
 * Returns the number of statements run.
 */
export async function runSeed(
  request: CfRequest,
  step: Pick<CiSeedStep, "database" | "seed">,
  values: CiSeedValues,
  fns: CiSeedFunctions,
): Promise<number> {
  const { statements } = step.seed;
  statements.forEach((statement, i) => {
    const problems = fns.seedStatementProblems(statement.sql, statement.params.length);
    if (problems.length > 0) {
      throw new Error(`seed statement ${i + 1} cannot run: ${problems.join("; ")}`);
    }
  });
  const hashes = await seedHashValues(step.seed, values.secrets, fns);
  const id = await findD1Database(request, step.database);
  if (id === null) {
    throw new Error(`the database ${step.database} does not exist, so it cannot be seeded`);
  }
  for (const [i, statement] of statements.entries()) {
    const subject = `seed statement ${i + 1} of ${statements.length} on ${step.database}`;
    let params: string[];
    try {
      params = fns.seedStatementParams(statement, { ...values, hashes });
    } catch (error) {
      throw new Error(`${subject}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const res = await request("POST", `/d1/database/${encodeURIComponent(id)}/query`, {
      sql: statement.sql,
      params,
    });
    if (!created(res)) {
      throw new Error(`${subject} failed: ${describe(res)}`);
    }
    const changes = queryChanges(res);
    if (changes === null || changes < 1) {
      throw new Error(
        `${subject} added ${changes ?? "an unknown number of"} rows; on a fresh database each ` +
          "statement adds its row, so something else already wrote it",
      );
    }
  }
  return statements.length;
}

// ---------------------------------------------------------------------------
// Health check

export type Probe = { status: number; body: string } | { error: string };

/**
 * Whether a probe settles the check or should be retried. Under `any-response`
 * any answer of the Worker itself settles it, a 5xx included; Cloudflare's own
 * error pages (`error code: <n>`) are not the Worker's answer.
 */
export function classifyProbe(
  probe: Probe,
  mode: HealthMode = "no-server-errors",
): "ok" | "retry" | "soft-404" {
  if ("error" in probe) {
    return "retry";
  }
  if (probe.status === 404) {
    // 1042: the edge refused the request (e.g. the route is not live yet).
    // Any other 404 may still be the workers.dev route propagating.
    return probe.body.includes("error code: 1042") ? "retry" : "soft-404";
  }
  if (mode === "any-response" && !/^error code: \d+/.test(probe.body.trimStart())) {
    return "ok";
  }
  if (probe.status >= 500) {
    return "retry";
  }
  return "ok";
}

export interface HealthResult {
  ok: boolean;
  detail: string;
}

/**
 * Polls `url` until it answers something other than a 5xx or a 404, for up to
 * `timeoutMs`. A plain 404 that persists to the deadline passes (an app without
 * a health path may serve 404 at `/`); a 1042, a 5xx, or no answer fails.
 * Under `any-response` a 5xx of the Worker's own passes too.
 */
export async function waitForHealth(
  probe: () => Promise<Probe>,
  options: {
    timeoutMs: number;
    intervalMs: number;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    mode?: HealthMode;
  },
): Promise<HealthResult> {
  const deadline = options.now() + options.timeoutMs;
  let last: Probe = { error: "not checked" };
  for (;;) {
    last = await probe();
    const verdict = classifyProbe(last, options.mode);
    if (verdict === "ok") {
      return { ok: true, detail: `HTTP ${(last as { status: number }).status}` };
    }
    if (options.now() + options.intervalMs > deadline) {
      if (verdict === "soft-404") {
        return {
          ok: true,
          detail: "HTTP 404 throughout (served by the app, or the route never went live)",
        };
      }
      const detail =
        "error" in last ? last.error : `HTTP ${last.status}: ${last.body.slice(0, 200).trim()}`;
      return { ok: false, detail };
    }
    await options.sleep(options.intervalMs);
  }
}

// ---------------------------------------------------------------------------
// Cloudflare API (cleanup and the workers.dev subdomain)

export interface CfResponse {
  status: number;
  body: {
    success?: boolean;
    result?: unknown;
    result_info?: { cursor?: string; is_truncated?: boolean } | null;
    errors?: { code: number; message: string }[];
  } | null;
}

/** One API call; `body`, when given, is sent as JSON. */
export type CfRequest = (method: string, path: string, body?: unknown) => Promise<CfResponse>;

/** A minimal client for `https://api.cloudflare.com/client/v4/accounts/<id>`. */
export function createCfRequest(
  token: string,
  accountId: string,
  fetchFn: typeof fetch = fetch,
): CfRequest {
  return async (method, apiPath, json) => {
    const res = await fetchFn(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}${apiPath}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(json === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      },
    );
    let body: CfResponse["body"] = null;
    try {
      body = (await res.json()) as CfResponse["body"];
    } catch {
      body = null;
    }
    return { status: res.status, body };
  };
}

function describe(res: CfResponse): string {
  const errors = res.body?.errors?.map((e) => `${e.code} ${e.message}`).join("; ");
  return `HTTP ${res.status}${errors ? ` (${errors})` : ""}`;
}

/** The account's `<subdomain>` in `<worker>.<subdomain>.workers.dev`. */
export async function workersSubdomain(request: CfRequest): Promise<string> {
  const res = await request("GET", "/workers/subdomain");
  const sub = (res.body?.result as { subdomain?: unknown } | undefined)?.subdomain;
  if (res.status !== 200 || typeof sub !== "string" || sub.length === 0) {
    throw new Error(`could not read the workers.dev subdomain: ${describe(res)}`);
  }
  return sub;
}

/**
 * A queue's id by name; null when it does not exist. Filters by name like
 * wrangler's own lookup (`GET /queues?page=1&name=<name>`), then matches the
 * name exactly.
 */
async function findQueueId(request: CfRequest, queue: string): Promise<string | null> {
  const res = await request("GET", `/queues?page=1&name=${encodeURIComponent(queue)}`);
  if (res.status !== 200 || !Array.isArray(res.body?.result)) {
    throw new Error(`listing queues failed: ${describe(res)}`);
  }
  const hit = (res.body.result as { queue_id?: unknown; queue_name?: unknown }[]).find(
    (q) => q.queue_name === queue,
  );
  return typeof hit?.queue_id === "string" ? hit.queue_id : null;
}

/** A D1 database's uuid by name; null when it does not exist. */
async function findD1Database(request: CfRequest, name: string): Promise<string | null> {
  const res = await request("GET", `/d1/database?name=${encodeURIComponent(name)}&per_page=100`);
  if (res.status !== 200 || !Array.isArray(res.body?.result)) {
    throw new Error(`listing D1 databases failed: ${describe(res)}`);
  }
  const hit = (res.body.result as { uuid: string; name: string }[]).find((db) => db.name === name);
  return hit?.uuid ?? null;
}

/** Finds a resource's id by name; null when it does not exist. */
async function findResource(request: CfRequest, resource: CiResource): Promise<string | null> {
  switch (resource.type) {
    case "queue":
      return findQueueId(request, resource.name);
    case "kv": {
      for (let page = 1; page <= 50; page++) {
        const res = await request("GET", `/storage/kv/namespaces?per_page=100&page=${page}`);
        if (res.status !== 200 || !Array.isArray(res.body?.result)) {
          throw new Error(`listing KV namespaces failed: ${describe(res)}`);
        }
        const list = res.body.result as { id: string; title: string }[];
        const hit = list.find((ns) => ns.title === resource.name);
        if (hit) {
          return hit.id;
        }
        if (list.length < 100) {
          return null;
        }
      }
      throw new Error("too many KV namespaces to search");
    }
    case "d1":
      return findD1Database(request, resource.name);
    case "vectorize": {
      // One page lists every index (an account has at most 50,000).
      const res = await request("GET", "/vectorize/v2/indexes");
      if (res.status !== 200 || !Array.isArray(res.body?.result)) {
        throw new Error(`listing Vectorize indexes failed: ${describe(res)}`);
      }
      const hit = (res.body.result as { name?: unknown }[]).find((i) => i.name === resource.name);
      return hit ? resource.name : null;
    }
    case "hyperdrive": {
      for (let page = 1; page <= 50; page++) {
        const res = await request("GET", `/hyperdrive/configs?per_page=100&page=${page}`);
        if (res.status !== 200 || !Array.isArray(res.body?.result)) {
          throw new Error(`listing Hyperdrive configurations failed: ${describe(res)}`);
        }
        const list = res.body.result as { id?: unknown; name?: unknown }[];
        const hit = list.find((c) => c.name === resource.name);
        if (hit !== undefined && typeof hit.id === "string") {
          return hit.id;
        }
        if (list.length < 100) {
          return null;
        }
      }
      throw new Error("too many Hyperdrive configurations to search");
    }
    case "r2":
    case "workflow": {
      const base = resource.type === "r2" ? "/r2/buckets/" : "/workflows/";
      const res = await request("GET", `${base}${encodeURIComponent(resource.name)}`);
      if (res.status === 404) {
        return null;
      }
      if (res.status !== 200) {
        throw new Error(`looking up ${resource.type} ${resource.name} failed: ${describe(res)}`);
      }
      return resource.name;
    }
  }
}

/** Rounds of list-and-delete before giving up (up to 100k objects). */
const R2_MAX_ROUNDS = 100;

/** One path segment per key segment, so keys with "/" keep their structure. */
function objectPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

/**
 * Deletes every object in an R2 bucket, since a bucket must be empty to be
 * deleted. Each round lists the first page (up to 1000 keys) and deletes it;
 * listing from the start again means no cursor survives a changing bucket.
 * Stops when a listing comes back empty, or fails after
 * {@link R2_MAX_ROUNDS} rounds.
 */
export async function emptyR2Bucket(request: CfRequest, bucket: string): Promise<void> {
  const base = `/r2/buckets/${encodeURIComponent(bucket)}/objects`;
  for (let round = 0; round < R2_MAX_ROUNDS; round++) {
    const res = await request("GET", `${base}?per_page=1000`);
    if (res.status !== 200 || !Array.isArray(res.body?.result)) {
      throw new Error(`listing objects in ${bucket} failed: ${describe(res)}`);
    }
    const keys = (res.body.result as { key?: unknown }[])
      .map((o) => o.key)
      .filter((k): k is string => typeof k === "string");
    if (keys.length === 0) {
      return;
    }
    for (const key of keys) {
      const del = await request("DELETE", `${base}/${objectPath(key)}`);
      if (del.status !== 200 && del.status !== 404) {
        throw new Error(`deleting ${key} from ${bucket} failed: ${describe(del)}`);
      }
    }
  }
  throw new Error(`${bucket} still has objects after ${R2_MAX_ROUNDS} rounds of deletes`);
}

function deletePath(resource: CiResource, id: string): string {
  switch (resource.type) {
    case "kv":
      return `/storage/kv/namespaces/${id}`;
    case "d1":
      return `/d1/database/${id}`;
    case "r2":
      return `/r2/buckets/${encodeURIComponent(id)}`;
    case "workflow":
      return `/workflows/${encodeURIComponent(id)}`;
    case "vectorize":
      return `/vectorize/v2/indexes/${encodeURIComponent(id)}`;
    case "queue":
      return `/queues/${encodeURIComponent(id)}`;
    case "hyperdrive":
      return `/hyperdrive/configs/${encodeURIComponent(id)}`;
  }
}

/** Whether a v4 create call went through (Cloudflare answers 200 or 201). */
function created(res: CfResponse): boolean {
  return res.status >= 200 && res.status < 300 && res.body?.success === true;
}

/**
 * Creates each Vectorize index in the plan with
 * `POST /vectorize/v2/indexes` and `{ name, config: { dimensions, metric } }`,
 * then its metadata indexes, as the manager does right after it creates the
 * index: `POST /vectorize/v2/indexes/{name}/metadata_index/create` with
 * `{ propertyName, indexType }` for each, which is what `wrangler vectorize
 * create-metadata-index` sends. Run after the cleanup of an earlier run, so
 * every name is free; an index that already exists is an error rather than
 * something to reuse.
 */
export async function createVectorizeIndexes(
  request: CfRequest,
  plan: Pick<CiInstallPlan, "vectorizeIndexes">,
): Promise<void> {
  for (const index of plan.vectorizeIndexes) {
    const res = await request("POST", "/vectorize/v2/indexes", {
      name: index.name,
      config: { dimensions: index.dimensions, metric: index.metric },
    });
    // Cloudflare answers 201 Created for a new index; the v4 envelope's
    // `success` is what says the create went through.
    if (!created(res)) {
      throw new Error(`creating Vectorize index ${index.name} failed: ${describe(res)}`);
    }
    for (const metadata of index.metadataIndexes ?? []) {
      const made = await request(
        "POST",
        `/vectorize/v2/indexes/${encodeURIComponent(index.name)}/metadata_index/create`,
        { propertyName: metadata.propertyName, indexType: metadata.type },
      );
      if (!created(made)) {
        throw new Error(
          `creating the metadata index on "${metadata.propertyName}" of Vectorize index ${index.name} failed: ${describe(made)}`,
        );
      }
    }
  }
}

/** Whether the app declares R2 lifecycle rules, and so needs `mergeR2LifecycleRules`. */
export function needsR2LifecycleHelpers(app: Pick<CiAppPlan, "r2Lifecycles">): boolean {
  return app.r2Lifecycles.length > 0;
}

/**
 * Sets each planned bucket's lifecycle rules as the manager does once it has
 * created the bucket: reads the rules the bucket has
 * (`GET /r2/buckets/{name}/lifecycle`; a new bucket has Cloudflare's default
 * rule for unfinished multipart uploads), merges the declared ones in with
 * `merge` (`mergeR2LifecycleRules` from `@appflare/schema`), and puts the
 * result back (`PUT /r2/buckets/{name}/lifecycle` with `{ rules }`, which
 * replaces every rule). Run once the deploy has created the buckets.
 */
export async function setR2LifecycleRules(
  request: CfRequest,
  plan: Pick<CiAppPlan, "r2Lifecycles">,
  merge: (existing: readonly unknown[], declared: readonly R2LifecycleRule[]) => unknown[],
): Promise<void> {
  for (const { bucket, rules } of plan.r2Lifecycles) {
    const lifecyclePath = `/r2/buckets/${encodeURIComponent(bucket)}/lifecycle`;
    const current = await request("GET", lifecyclePath);
    if (current.status !== 200 || current.body?.success !== true) {
      throw new Error(
        `reading the lifecycle rules of R2 bucket ${bucket} failed: ${describe(current)}`,
      );
    }
    const existing = (current.body.result as { rules?: unknown } | null)?.rules;
    const put = await request("PUT", lifecyclePath, {
      rules: merge(Array.isArray(existing) ? existing : [], rules),
    });
    if (!created(put)) {
      throw new Error(
        `setting the lifecycle rules of R2 bucket ${bucket} failed: ${describe(put)}`,
      );
    }
  }
}

/**
 * Creates each queue in the plan with `POST /queues` and `{ queue_name }`,
 * dead-letter queues included. Like the Vectorize indexes, run after the
 * cleanup of an earlier run, so a queue that already exists is an error.
 */
export async function createQueues(
  request: CfRequest,
  plan: Pick<CiInstallPlan, "queues">,
): Promise<void> {
  for (const queue of plan.queues) {
    const res = await request("POST", "/queues", { queue_name: queue });
    if (!created(res)) {
      throw new Error(`creating queue ${queue} failed: ${describe(res)}`);
    }
  }
}

/**
 * Points each queue the plan consumes at the deployed Worker, as the manager
 * does after its script upload: `POST /queues/{queue_id}/consumers` with
 * `{ type: "worker", script_name, settings, dead_letter_queue }`, where the
 * dead-letter queue is named, not addressed by id.
 */
export async function attachQueueConsumers(
  request: CfRequest,
  plan: Pick<CiInstallPlan, "name" | "queueConsumers">,
): Promise<void> {
  for (const consumer of plan.queueConsumers) {
    const queueId = await findQueueId(request, consumer.queue);
    if (queueId === null) {
      throw new Error(`the queue ${consumer.queue} does not exist, so no consumer can be attached`);
    }
    const res = await request("POST", `/queues/${encodeURIComponent(queueId)}/consumers`, {
      type: "worker",
      script_name: plan.name,
      ...(consumer.deadLetterQueue === null ? {} : { dead_letter_queue: consumer.deadLetterQueue }),
      ...(Object.keys(consumer.settings).length > 0 ? { settings: consumer.settings } : {}),
    });
    if (!created(res)) {
      throw new Error(`attaching a consumer to queue ${consumer.queue} failed: ${describe(res)}`);
    }
  }
}

/** A consumer as `GET /queues/{id}/consumers` lists it (the fields read here). */
interface ListedConsumer {
  consumer_id?: unknown;
  type?: unknown;
  script_name?: unknown;
  script?: unknown;
  service?: unknown;
}

/**
 * Removes the consumers of the Workers `names` from each of the queues in
 * `resources` that still exists, so neither a Worker nor the queue is held by
 * them. The API names the Worker in `script_name`, `script`, or `service`,
 * depending on the consumer's age; any of them counts. Returns every problem.
 */
async function removeQueueConsumers(
  request: CfRequest,
  names: readonly string[],
  resources: readonly CiResource[],
): Promise<string[]> {
  const problems: string[] = [];
  for (const resource of resources) {
    if (resource.type !== "queue") {
      continue;
    }
    try {
      const queueId = await findQueueId(request, resource.name);
      if (queueId === null) {
        continue;
      }
      const base = `/queues/${encodeURIComponent(queueId)}/consumers`;
      const list = await request("GET", base);
      if (list.status !== 200 || !Array.isArray(list.body?.result)) {
        throw new Error(`listing consumers failed: ${describe(list)}`);
      }
      const ours = (list.body.result as ListedConsumer[]).filter(
        (c) =>
          (c.type === undefined || c.type === "worker") &&
          typeof c.consumer_id === "string" &&
          [c.script_name, c.script, c.service].some(
            (n) => typeof n === "string" && names.includes(n),
          ),
      );
      for (const consumer of ours) {
        const del = await request(
          "DELETE",
          `${base}/${encodeURIComponent(String(consumer.consumer_id))}`,
        );
        if (del.status !== 200 && del.status !== 404) {
          problems.push(`consumer of queue ${resource.name}: delete failed: ${describe(del)}`);
        }
      }
    } catch (err) {
      problems.push(
        `consumer of queue ${resource.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return problems;
}

/**
 * Removes the Worker's queue consumers, then deletes the CI Worker (with
 * `force=true`, like `wrangler delete --force`, so Durable Object and other
 * bindings do not block it) and every resource in the plan, then checks that
 * each is gone (a queue that is gone takes its consumers with it). Missing
 * things are fine (the deploy may have failed before creating them). Returns
 * every problem; empty means the account is clean.
 */
export async function cleanupCiInstall(request: CfRequest, plan: CiInstallPlan): Promise<string[]> {
  return cleanupWorkers(request, [plan.name], plan.resources);
}

/**
 * {@link cleanupCiInstall} for a whole app: the consumers of every Worker,
 * then every Worker (the primary included, the one deployed last deleted
 * first, so no Worker goes while another still binds to it), then every
 * shared resource, and checks that all of them are gone.
 */
export async function cleanupCiApp(
  request: CfRequest,
  app: Pick<CiAppPlan, "resources"> & { workers: { plan: Pick<CiInstallPlan, "name"> }[] },
): Promise<string[]> {
  return cleanupWorkers(request, app.workers.map((w) => w.plan.name).reverse(), app.resources);
}

async function cleanupWorkers(
  request: CfRequest,
  names: readonly string[],
  resources: readonly CiResource[],
): Promise<string[]> {
  const problems = await removeQueueConsumers(request, names, resources);
  const scriptPath = (name: string) => `/workers/scripts/${encodeURIComponent(name)}`;
  for (const name of names) {
    const del = await request("DELETE", `${scriptPath(name)}?force=true`);
    if (del.status !== 200 && del.status !== 404) {
      problems.push(`Worker ${name}: delete failed: ${describe(del)}`);
    }
  }
  for (const resource of resources) {
    try {
      const id = await findResource(request, resource);
      if (id === null) {
        continue;
      }
      if (resource.type === "r2") {
        await emptyR2Bucket(request, id);
      }
      const res = await request("DELETE", deletePath(resource, id));
      if (res.status !== 200 && res.status !== 404) {
        problems.push(`${resource.type} ${resource.name}: delete failed: ${describe(res)}`);
      }
    } catch (err) {
      problems.push(
        `${resource.type} ${resource.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // Confirm, rather than trust the delete responses.
  for (const name of names) {
    const gone = await request("GET", `${scriptPath(name)}/settings`);
    if (gone.status !== 404) {
      problems.push(`Worker ${name} still exists (${describe(gone)})`);
    }
  }
  for (const resource of resources) {
    try {
      if ((await findResource(request, resource)) !== null) {
        problems.push(`${resource.type} ${resource.name} still exists`);
      }
    } catch (err) {
      problems.push(
        `${resource.type} ${resource.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return [...new Set(problems)];
}

// ---------------------------------------------------------------------------
// Skipped deploys

/**
 * Why the check deploys nothing for an app, as the step output `skipped`
 * names it: the entry needs Workers Paid and the CI account is on the free
 * plan ({@link paidPlanSkip}), a Worker binds an Analytics Engine dataset and
 * the account has Analytics Engine off ({@link analyticsEngineSkip}), or a
 * Worker binds Hyperdrive and there is no test database for it
 * ({@link hyperdriveSkip}). None of them is the app's fault, so the command
 * succeeds.
 */
export type CiSkipKind = "paid-plan" | "analytics-engine" | "hyperdrive";

/** A deploy the check skips: its kind, and the run summary's words for it. */
export interface CiSkip {
  readonly kind: CiSkipKind;
  /** One of the fixed skip reasons, which hold no value from the account or a secret. */
  readonly reason: string;
}

/** What a skipped deploy reports; see {@link skipReport}. */
export interface CiSkipReport {
  /** A GitHub Actions notice, so the skip shows on the run's page and never passes silently. */
  notice: string;
  /** The run summary's SKIP line. */
  summary: string[];
  /** `key=value` lines for `$GITHUB_OUTPUT`: `skipped` (the kind) and `skip-reason`. */
  outputs: string[];
}

/**
 * Everything a skipped deploy reports, built in one place so that no skip can
 * leave any of it out. The nightly run records a verification for every app
 * whose deploy step succeeded without setting `skipped`, so a skip that left
 * it unset would date an install check that never ran.
 */
export function skipReport(
  manifest: Pick<ArtifactManifest, "app" | "version">,
  name: string,
  skip: CiSkip,
): CiSkipReport {
  // A workflow command, a summary line and an output value are one line each.
  const reason = skip.reason.replace(/\s*[\r\n]+\s*/g, " ");
  const app = `${manifest.app}@${manifest.version}`;
  return {
    notice: `::notice title=Install check skipped::${app}: ${reason}`,
    summary: [`SKIP ${app} as ${name}: ${reason}`],
    outputs: [`skipped=${skip.kind}`, `skip-reason=${reason}`],
  };
}

// ---------------------------------------------------------------------------
// Analytics Engine

/**
 * Whether Analytics Engine is on for the CI account. It is off on an account
 * until someone opens its page in the dashboard once, and until then
 * Cloudflare refuses every deploy of a Worker that binds a dataset (code
 * 10089, `workers.api.error.no_access_to_analytics_engine`).
 */
export type AnalyticsEngineState = "enabled" | "not-enabled" | "unknown";

/** The skip for a deploy the account cannot take. */
export const ANALYTICS_ENGINE_SKIP: CiSkip = {
  kind: "analytics-engine",
  reason: "skipped: Analytics Engine not enabled",
};

/** Whether any of the Worker configs binds an Analytics Engine dataset. */
export function needsAnalyticsEngine(plans: ReadonlyArray<Pick<CiInstallPlan, "config">>): boolean {
  return plans.some((plan) => {
    const datasets = plan.config.analytics_engine_datasets;
    return Array.isArray(datasets) && datasets.length > 0;
  });
}

/**
 * Reads the state with the SQL API's `SHOW TABLES` (changes nothing): an
 * answer means on; the SQL service's own plain-text 403 ("Authorization
 * error") means never turned on. A JSON refusal is the API refusing the
 * token, and anything else is not a clear answer, so both are `unknown` and
 * the deploy goes ahead (and fails loudly if Analytics Engine is off).
 */
export async function analyticsEngineState(
  token: string,
  accountId: string,
  fetchFn: typeof fetch = fetch,
): Promise<AnalyticsEngineState> {
  let res: Response;
  try {
    res = await fetchFn(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
        body: "SHOW TABLES",
      },
    );
  } catch {
    return "unknown";
  }
  if (res.ok) return "enabled";
  if (res.status !== 403) return "unknown";
  const text = await res.text().catch(() => "");
  try {
    JSON.parse(text);
    return "unknown";
  } catch {
    return "not-enabled";
  }
}

/**
 * {@link ANALYTICS_ENGINE_SKIP} when the Workers bind a dataset and the
 * account has Analytics Engine off, else null. `state` is read only when a
 * Worker needs it.
 */
export async function analyticsEngineSkip(
  plans: ReadonlyArray<Pick<CiInstallPlan, "config">>,
  state: () => Promise<AnalyticsEngineState>,
): Promise<CiSkip | null> {
  if (!needsAnalyticsEngine(plans)) return null;
  return (await state()) === "not-enabled" ? ANALYTICS_ENGINE_SKIP : null;
}

// ---------------------------------------------------------------------------
// Workers plan

/**
 * The environment variable (a repository variable in CI) naming the CI
 * account's Workers plan, `free` or `paid`; unset or empty means `free`.
 * Cloudflare offers no cheap read of an account's plan to a token scoped to
 * Workers, so the workflow says which plan the account is on.
 */
export const CI_ACCOUNT_PLAN = "CI_ACCOUNT_PLAN";

/** The CI account's plan from {@link CI_ACCOUNT_PLAN}; throws for any other value. */
export function ciAccountPlan(value: string | undefined): Plan {
  const plan = value?.trim() ?? "";
  if (plan === "") return "free";
  if (plan === "free" || plan === "paid") return plan;
  throw new Error(`${CI_ACCOUNT_PLAN} ${JSON.stringify(plan)} is not "free" or "paid"`);
}

/** The skip for an entry that needs Workers Paid on a free CI account. */
export const PAID_PLAN_SKIP: CiSkip = {
  kind: "paid-plan",
  reason: `skipped: the entry needs Workers Paid and ${CI_ACCOUNT_PLAN} is free`,
};

/**
 * Why the check skips an app on this account's plan, or null when it can run:
 * an entry whose catalog manifest says `plan: "paid"` may use what the free
 * plan refuses at upload (a `limits.cpu_ms`, Containers, a Worker Loader), so
 * its deploy on a free account says nothing about the app. Read loosely from
 * the catalog manifest embedded in the artifact, which the schema has checked.
 */
export function paidPlanSkip(catalog: unknown, accountPlan: Plan): CiSkip | null {
  const plan = (catalog as { plan?: unknown } | null)?.plan;
  return plan === "paid" && accountPlan === "free" ? PAID_PLAN_SKIP : null;
}

// ---------------------------------------------------------------------------
// Hyperdrive

/**
 * The database protocol behind a Hyperdrive binding. An app with a database
 * outside Cloudflare declares each binding under `resources.hyperdrive` in its
 * catalog manifest, with the database it speaks; the manager asks the admin
 * for its connection string. The CI account has no database of the app's own,
 * so the check connects the Workers to a throwaway test database instead.
 */
export type HyperdriveProtocol = "postgres" | "mysql";

/** A Hyperdrive configuration to create before the deploy, named like any resource. */
export interface CiHyperdriveConfig {
  name: string;
  binding: string;
  protocol: HyperdriveProtocol;
}

/** The environment variable (a repository secret in CI) naming the test database. */
export const HYPERDRIVE_TEST_URL = "HYPERDRIVE_TEST_URL";

/** The skip for a Hyperdrive app the check has no database for. */
export const HYPERDRIVE_SKIP: CiSkip = {
  kind: "hyperdrive",
  reason: `skipped: Hyperdrive binding and no ${HYPERDRIVE_TEST_URL}`,
};

const PROTOCOL_NAMES: Record<HyperdriveProtocol, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
};

const PROTOCOL_SCHEMES: Record<HyperdriveProtocol, readonly string[]> = {
  postgres: ["postgres", "postgresql"],
  mysql: ["mysql"],
};

const DEFAULT_PORTS: Record<HyperdriveProtocol, number> = { postgres: 5432, mysql: 3306 };

/**
 * The protocol the catalog manifest declares for a binding, from
 * `resources.hyperdrive`, which is keyed by the binding's name
 * (`{ "POSTGRES": { "protocol": "postgres" } }`); PostgreSQL when it says none.
 */
export function declaredProtocol(catalog: unknown, binding: string): HyperdriveProtocol {
  const declared = (catalog as { resources?: { hyperdrive?: unknown } } | null)?.resources
    ?.hyperdrive;
  if (typeof declared !== "object" || declared === null || !Object.hasOwn(declared, binding)) {
    return "postgres";
  }
  const entry = (declared as Record<string, unknown>)[binding];
  return (entry as { protocol?: unknown } | null)?.protocol === "mysql" ? "mysql" : "postgres";
}

/** The origin `POST /hyperdrive/configs` takes for a database on the public internet. */
export interface HyperdriveOrigin {
  scheme: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

/**
 * `url` as a Hyperdrive origin for `protocol`, or the reason it cannot be
 * one. The reason never repeats any part of the URL: it holds a password.
 */
export function testDatabaseOrigin(
  url: string,
  protocol: HyperdriveProtocol,
): { ok: true; origin: HyperdriveOrigin } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { ok: false, reason: `${HYPERDRIVE_TEST_URL} is not a URL` };
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (!PROTOCOL_SCHEMES[protocol].includes(scheme)) {
    return {
      ok: false,
      reason: `${HYPERDRIVE_TEST_URL} is not a ${PROTOCOL_NAMES[protocol]} database`,
    };
  }
  let user: string;
  let password: string;
  let database: string;
  try {
    user = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
    database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    return { ok: false, reason: `${HYPERDRIVE_TEST_URL} has a malformed %-escape` };
  }
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  if (host === "" || user === "" || password === "" || database === "" || database.includes("/")) {
    return {
      ok: false,
      reason: `${HYPERDRIVE_TEST_URL} needs a host, user, password and database`,
    };
  }
  const port = parsed.port === "" ? DEFAULT_PORTS[protocol] : Number(parsed.port);
  return { ok: true, origin: { scheme, host, port, database, user, password } };
}

/**
 * Why the check skips an app with Hyperdrive bindings, or null when it can
 * run: without `testUrl` (the `HYPERDRIVE_TEST_URL` secret is not set) there
 * is no database to connect them to, and a test database of the wrong
 * protocol cannot stand in for the app's. The app is not at fault, so the
 * command succeeds with a SKIP line, as for Analytics Engine.
 */
export function hyperdriveSkip(
  app: Pick<CiAppPlan, "hyperdriveConfigs">,
  testUrl: string | undefined,
): CiSkip | null {
  if (app.hyperdriveConfigs.length === 0) return null;
  if (testUrl === undefined || testUrl.trim() === "") return HYPERDRIVE_SKIP;
  for (const config of app.hyperdriveConfigs) {
    const origin = testDatabaseOrigin(testUrl, config.protocol);
    if (!origin.ok) return { kind: "hyperdrive", reason: `skipped: ${origin.reason}` };
  }
  return null;
}

/**
 * Creates each Hyperdrive configuration the app binds with
 * `POST /hyperdrive/configs` and `{ name, origin }`, all pointing at the test
 * database, and returns their ids by binding name. Run after the cleanup of
 * an earlier run, so every name is free. Cloudflare connects to the database
 * before it answers, so an unreachable test database fails here.
 */
export async function createHyperdriveConfigs(
  request: CfRequest,
  app: Pick<CiAppPlan, "hyperdriveConfigs">,
  testUrl: string,
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const config of app.hyperdriveConfigs) {
    const origin = testDatabaseOrigin(testUrl, config.protocol);
    if (!origin.ok) throw new Error(origin.reason);
    const res = await request("POST", "/hyperdrive/configs", {
      name: config.name,
      origin: origin.origin,
    });
    const id = (res.body?.result as { id?: unknown } | undefined)?.id;
    if (!created(res) || typeof id !== "string") {
      throw new Error(`creating Hyperdrive configuration ${config.name} failed: ${describe(res)}`);
    }
    ids[config.binding] = id;
  }
  return ids;
}

/** `config` with each Hyperdrive binding given the id of the configuration created for it. */
export function withHyperdriveIds(
  config: Record<string, unknown>,
  ids: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const bindings = config.hyperdrive as Record<string, string>[] | undefined;
  if (bindings === undefined) return config;
  return {
    ...config,
    hyperdrive: bindings.map((h) => {
      const binding = h.binding as string;
      const id = Object.hasOwn(ids, binding) ? ids[binding] : undefined;
      if (id === undefined) {
        throw new Error(`no Hyperdrive configuration was created for the binding ${binding}`);
      }
      return { ...h, id };
    }),
  };
}
