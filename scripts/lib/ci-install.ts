import { createHash, randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  ArtifactBinding,
  ArtifactFile,
  ArtifactManifest,
  ArtifactQueueConsumer,
  QueueRef,
} from "./types.ts";

/**
 * Installs a packed artifact into the CI Cloudflare account with wrangler, to
 * check that it deploys and answers, then removes everything again.
 *
 * This is not the manager's install path. The manager creates each resource
 * through the API and records it; here `wrangler deploy` provisions the
 * resources from bindings without ids. Vectorize indexes and queues are the
 * exceptions: wrangler cannot provision them, so the check creates each
 * through the API before the deploy, and attaches the artifact's queue
 * consumers through the API after it, as the manager does. All of them use the
 * same names, `<worker>-<binding, lowercased, "_" -> "-">`, so the CI Worker's
 * resources can be found and deleted by name afterwards without any records.
 */

export const WORKER_DIR = "worker";
export const ASSETS_DIR = "assets";
export const D1_DIR = "d1";

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

export type CiResourceType = "kv" | "d1" | "r2" | "workflow" | "vectorize" | "queue";

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
}

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

export interface CiInstallPlan {
  name: string;
  /** The generated `wrangler.json`. */
  config: Record<string, unknown>;
  /** Everything the deploy may create besides the Worker, deleted afterwards. */
  resources: CiResource[];
  /** Secret names from the catalog manifest; each gets a random value. */
  secrets: string[];
  /** D1 databases with migrations to apply, by database name. */
  d1Migrations: string[];
  /** Vectorize indexes to create before the deploy (wrangler cannot provision them). */
  vectorizeIndexes: CiVectorizeIndex[];
  /** Queues to create before the deploy (wrangler cannot provision them), by name. */
  queues: string[];
  /** Consumers to attach once the Worker is deployed. */
  queueConsumers: CiQueueConsumer[];
  /** What the check deploys but cannot exercise, for the run's summary. */
  notes: string[];
  /** The path the health check probes: the catalog's `install.healthPath`, else `/`. */
  healthPath: string;
  /** How the health check reads the answer: the catalog's `install.healthMode`, else `default`. */
  healthMode: HealthMode;
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

interface CatalogForms {
  secrets: string[];
  vars: { name: string; default?: string; required: boolean }[];
}

/** Secret names and var defaults from the catalog manifest embedded in the artifact. */
export function catalogForms(catalog: unknown): CatalogForms {
  const c = (catalog ?? {}) as { secrets?: unknown; vars?: unknown };
  const secrets = Array.isArray(c.secrets)
    ? c.secrets
        .map((s) => (s as { name?: unknown }).name)
        .filter((n): n is string => typeof n === "string")
    : [];
  const vars = Array.isArray(c.vars)
    ? c.vars
        .map((v) => v as { name?: unknown; default?: unknown; required?: unknown })
        .filter(
          (v): v is { name: string; default?: unknown; required?: unknown } =>
            typeof v.name === "string",
        )
        .map((v) => ({
          name: v.name,
          ...(typeof v.default === "string" ? { default: v.default } : {}),
          required: v.required === true,
        }))
    : [];
  return { secrets, vars };
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
  return { name: resource, dimensions, metric: metric as VectorizeMetric };
}

/** Same rule as the catalog schema: a URL path starting with `/`, without query or fragment. */
const HEALTH_PATH = /^\/[^\s?#]*$/;

/**
 * The path to probe, from `install.healthPath` in the catalog manifest embedded
 * in the artifact; `/` when it is absent, as the manager does. Throws for a
 * value the schema would reject, rather than probing somewhere else.
 */
export function catalogHealthPath(catalog: unknown): string {
  const install = (catalog as { install?: { healthPath?: unknown } } | null)?.install;
  const healthPath = install?.healthPath;
  if (healthPath === undefined) {
    return "/";
  }
  if (typeof healthPath !== "string" || !HEALTH_PATH.test(healthPath)) {
    throw new Error(`install.healthPath ${JSON.stringify(healthPath)} is not a URL path`);
  }
  return healthPath;
}

/**
 * How the health check reads the Worker's answer, the manager's rule:
 * `default` fails a persistent 5xx; `status-only` (apps whose every route sits
 * behind Cloudflare Access or their own sign-in) counts any answer of the
 * Worker itself as healthy, a 5xx of its own included.
 */
export type HealthMode = "default" | "status-only";

/**
 * The mode from `install.healthMode` in the catalog manifest embedded in the
 * artifact; `default` when it is absent. Read loosely, since the schema this
 * repository validates against may not know the field yet. Throws for a value
 * the manager would not accept, rather than checking by another rule.
 */
export function catalogHealthMode(catalog: unknown): HealthMode {
  const install = (catalog as { install?: { healthMode?: unknown } } | null)?.install;
  const mode = install?.healthMode;
  if (mode === undefined) {
    return "default";
  }
  if (mode !== "default" && mode !== "status-only") {
    throw new Error(`install.healthMode ${JSON.stringify(mode)} is not "default" or "status-only"`);
  }
  return mode;
}

/** The URL the health check probes for Worker `name` in the account's workers.dev subdomain. */
export function healthUrl(name: string, subdomain: string, healthPath: string): string {
  return `https://${name}.${subdomain}.workers.dev${healthPath}`;
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

const SELF_SERVICE_FIELDS: readonly string[] = ["type", "name", "service", "entrypoint"];

/**
 * A service binding as wrangler's config writes it, aimed at Worker `name`:
 * the only service binding an artifact may hold is one to the app's own
 * Worker, `{ type: "service", name, service: "self", entrypoint? }` and
 * nothing more, as the manager holds it. Every other service binding throws,
 * since it would let the app call another Worker in the account.
 *
 * wrangler deploys a Worker that binds to itself on its first deploy (it
 * accepts a binding to the Worker the deploy creates), so the CI Worker needs
 * no earlier upload for this.
 */
function selfServiceBinding(binding: ArtifactBinding, name: string): Record<string, string> {
  const extra = Object.keys(binding).filter((key) => !SELF_SERVICE_FIELDS.includes(key));
  const { service, entrypoint } = binding;
  const entrypointOk =
    entrypoint === undefined || (typeof entrypoint === "string" && entrypoint.length > 0);
  if (service !== SELF_SERVICE || !entrypointOk || extra.length > 0) {
    const target = typeof service === "string" ? `the Worker "${service}"` : "no Worker";
    const why =
      service !== SELF_SERVICE
        ? `points at ${target}`
        : !entrypointOk
          ? "records an entrypoint that is not a name"
          : `also sets ${extra.join(", ")}`;
    throw new Error(
      `service binding ${binding.name} ${why}; an app may bind only to its own Worker ` +
        `(recorded as service "${SELF_SERVICE}", with nothing but an optional entrypoint)`,
    );
  }
  return {
    binding: binding.name,
    service: name,
    ...(typeof entrypoint === "string" ? { entrypoint } : {}),
  };
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

/**
 * What the manager fills in for `{{workerUrl}}` and `{{workerName}}` in var
 * values: the wrangler config's own vars (strings, and strings inside JSON
 * values) and the catalog's var defaults.
 */
export interface PlaceholderValues {
  /** `https://<worker>.<subdomain>.workers.dev`; null keeps `{{workerUrl}}` as written. */
  workerUrl: string | null;
  workerName: string;
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
const PLACEHOLDER_PATTERN = /\{\{\s*(workerUrl|workerName)\s*\}\}/g;

/** `text` with `{{workerUrl}}` and `{{workerName}}` filled in, as the manager does. */
export function renderPlaceholders(text: string, values: PlaceholderValues): string {
  return text.replace(PLACEHOLDER_PATTERN, (match, key: string) => {
    if (key === "workerName") return values.workerName;
    return values.workerUrl ?? match;
  });
}

/** `value` with placeholders filled in inside every string it holds (keys excepted). */
export function renderJsonPlaceholders(value: JsonValue, values: PlaceholderValues): JsonValue {
  if (typeof value === "string") return renderPlaceholders(value, values);
  if (Array.isArray(value)) return value.map((item) => renderJsonPlaceholders(item, values));
  if (value !== null && typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) {
      // Plain assignment of `__proto__` would set the prototype instead.
      Object.defineProperty(out, key, {
        value: renderJsonPlaceholders(item, values),
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
 * `{{workerName}}` and `{{workerUrl}}` are filled in with `name` and its
 * workers.dev URL in `subdomain` (kept as written when `subdomain` is not
 * given, which only a plan for cleanup should do).
 *
 * The artifact's cron triggers are left out of the config and recorded as a
 * note (see {@link cronNote}); cleanup never depends on them.
 */
export function planCiInstall(
  manifest: ArtifactManifest,
  name: string,
  options: { namespaceId?: () => string; subdomain?: string } = {},
): CiInstallPlan {
  const { worker } = manifest;
  const namespaceId = options.namespaceId ?? randomNamespaceId;
  const placeholders: PlaceholderValues = {
    workerName: name,
    workerUrl: options.subdomain === undefined ? null : healthUrl(name, options.subdomain, ""),
  };
  const resources: CiResource[] = [];
  const kv: Record<string, string>[] = [];
  const d1: Record<string, string>[] = [];
  const r2: Record<string, string>[] = [];
  const durableObjects: Record<string, string>[] = [];
  const workflows: Record<string, string>[] = [];
  const analytics: Record<string, string>[] = [];
  const vectorize: Record<string, string>[] = [];
  const vectorizeIndexes: CiVectorizeIndex[] = [];
  const producers: Record<string, unknown>[] = [];
  const queues: string[] = [];
  const ratelimits: Record<string, unknown>[] = [];
  const sendEmail: Record<string, unknown>[] = [];
  const services: Record<string, string>[] = [];
  const notes: string[] = [];
  const singles: Record<string, { binding: string }> = {};
  const vars: Record<string, JsonValue> = {};
  const jsonVars = new Set<string>();
  const d1Migrations: string[] = [];

  for (const binding of worker.bindings) {
    const resource = resourceName(name, binding.name);
    switch (binding.type) {
      case "kv_namespace":
        // No name field: wrangler titles it `<worker>-<binding>` itself.
        kv.push({ binding: binding.name });
        resources.push({ type: "kv", name: resource, binding: binding.name });
        break;
      case "d1": {
        const migrations = manifest.d1Migrations[binding.name] ?? [];
        d1.push({
          binding: binding.name,
          database_name: resource,
          ...(migrations.length > 0 ? { migrations_dir: `${D1_DIR}/${binding.name}` } : {}),
        });
        resources.push({ type: "d1", name: resource, binding: binding.name });
        if (migrations.length > 0) {
          d1Migrations.push(resource);
        }
        break;
      }
      case "r2_bucket":
        r2.push({ binding: binding.name, bucket_name: resource });
        resources.push({ type: "r2", name: resource, binding: binding.name });
        break;
      case "durable_object_namespace":
        durableObjects.push({
          name: binding.name,
          class_name: str(binding, "class_name"),
          ...optionalStr(binding, "script_name"),
        });
        break;
      case "workflow":
        // Workflow names are account-wide; a per-install name keeps CI runs apart.
        workflows.push({
          binding: binding.name,
          name: resource,
          class_name: str(binding, "class_name"),
          ...optionalStr(binding, "script_name"),
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
          namespace_id: namespaceId(),
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
        // Aimed at the CI Worker itself, as the manager aims it at the install's Worker.
        services.push(selfServiceBinding(binding, name));
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
      default:
        // TODO: Hyperdrive and mTLS certificates need resources this check
        // does not create and clean up yet.
        throw new Error(
          `the CI install check cannot create a ${binding.type} binding (${binding.name}) yet`,
        );
    }
  }

  const queueConsumers = planQueueConsumers(worker, name, resources, queues);
  const crons = cronNote(worker.crons);
  if (crons !== null) {
    notes.push(crons);
  }

  const forms = catalogForms(manifest.catalog);
  for (const v of forms.vars) {
    if (v.default !== undefined) {
      vars[v.name] = jsonVars.has(v.name) ? jsonDefault(v.name, v.default) : v.default;
    } else if (v.required && vars[v.name] === undefined) {
      vars[v.name] = REQUIRED_VAR_PLACEHOLDER;
    }
  }
  for (const [varName, value] of Object.entries(vars)) {
    vars[varName] = renderJsonPlaceholders(value, placeholders);
  }

  const rules = new Map<WranglerRule, string[]>();
  for (const module of worker.modules) {
    const rule = RULE_TYPES[module.type];
    if (!rule) {
      throw new Error(`module ${module.name} has an unknown type ${module.type}`);
    }
    rules.set(rule, [...(rules.get(rule) ?? []), module.name]);
  }

  const hasAssets = manifest.assets.files.length > 0 || manifest.assets.binding !== null;
  const config: Record<string, unknown> = {
    name,
    main: `${WORKER_DIR}/${worker.mainModule}`,
    compatibility_date: worker.compatibilityDate,
    compatibility_flags: [...worker.compatibilityFlags],
    // The modules are wrangler's own build output; upload them unchanged.
    no_bundle: true,
    find_additional_modules: true,
    base_dir: WORKER_DIR,
    rules: [...rules].map(([type, globs]) => ({ type, globs })),
    workers_dev: true,
    preview_urls: false,
    send_metrics: false,
    ...(hasAssets
      ? {
          assets: {
            ...manifest.assets.config,
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
    // Consumers are attached through the API after the deploy, as the manager does.
    ...(producers.length > 0 ? { queues: { producers } } : {}),
    ...(ratelimits.length > 0 ? { ratelimits } : {}),
    ...(sendEmail.length > 0 ? { send_email: sendEmail } : {}),
    ...(services.length > 0 ? { services } : {}),
    ...singles,
    ...(Object.keys(vars).length > 0 ? { vars } : {}),
    // No `triggers`: without it wrangler leaves the Worker's schedules alone
    // (a fresh Worker has none), so the deploy makes no cron trigger call at all.
    ...(worker.observability ? { observability: { ...worker.observability } } : {}),
    ...(worker.migrations.length > 0
      ? { migrations: worker.migrations.map((m) => ({ ...m })) }
      : {}),
    ...(worker.placement ? { placement: { ...worker.placement } } : {}),
    ...(worker.limits ? { limits: { ...worker.limits } } : {}),
  };
  return {
    name,
    config,
    resources,
    secrets: forms.secrets,
    d1Migrations,
    vectorizeIndexes,
    queues,
    queueConsumers,
    notes,
    healthPath: catalogHealthPath(manifest.catalog),
    healthMode: catalogHealthMode(manifest.catalog),
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
 */
function planQueueConsumers(
  worker: ArtifactManifest["worker"],
  name: string,
  resources: CiResource[],
  queues: string[],
): CiQueueConsumer[] {
  const queueBindings = new Set(
    worker.bindings.filter((b) => b.type === "queue").map((b) => b.name),
  );
  const bindingNames = new Set(worker.bindings.map((b) => b.name));
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
 * Writes the Worker modules to `<outDir>/worker/`, the assets to
 * `<outDir>/assets/`, and D1 migrations to `<outDir>/d1/<binding>/`, reading
 * each as its byte range of the STORE zip and checking size and sha256 before
 * anything is written.
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
    for (const [binding, files] of Object.entries(manifest.d1Migrations)) {
      for (const f of files) {
        writes.push({
          target: safeJoin(path.join(outDir, D1_DIR), `${binding}/${f.name}`),
          data: read(f),
        });
      }
    }
  } finally {
    closeSync(fd);
  }
  mkdirSync(path.join(outDir, WORKER_DIR), { recursive: true });
  mkdirSync(path.join(outDir, ASSETS_DIR), { recursive: true });
  for (const { target, data } of writes) {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
}

/** A random secret value; never printed. */
export function randomSecret(): string {
  return randomBytes(24).toString("base64url");
}

// ---------------------------------------------------------------------------
// Health check

export type Probe = { status: number; body: string } | { error: string };

/**
 * Whether a probe settles the check or should be retried. Under `status-only`
 * any answer of the Worker itself settles it, a 5xx included; Cloudflare's own
 * error pages (`error code: <n>`) are not the Worker's answer.
 */
export function classifyProbe(
  probe: Probe,
  mode: HealthMode = "default",
): "ok" | "retry" | "soft-404" {
  if ("error" in probe) {
    return "retry";
  }
  if (probe.status === 404) {
    // 1042: the edge refused the request (e.g. the route is not live yet).
    // Any other 404 may still be the workers.dev route propagating.
    return probe.body.includes("error code: 1042") ? "retry" : "soft-404";
  }
  if (mode === "status-only" && !/^error code: \d+/.test(probe.body.trimStart())) {
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
 * Under `status-only` a 5xx of the Worker's own passes too.
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
    case "d1": {
      const res = await request(
        "GET",
        `/d1/database?name=${encodeURIComponent(resource.name)}&per_page=100`,
      );
      if (res.status !== 200 || !Array.isArray(res.body?.result)) {
        throw new Error(`listing D1 databases failed: ${describe(res)}`);
      }
      const hit = (res.body.result as { uuid: string; name: string }[]).find(
        (db) => db.name === resource.name,
      );
      return hit?.uuid ?? null;
    }
    case "vectorize": {
      // One page lists every index (an account has at most 50,000).
      const res = await request("GET", "/vectorize/v2/indexes");
      if (res.status !== 200 || !Array.isArray(res.body?.result)) {
        throw new Error(`listing Vectorize indexes failed: ${describe(res)}`);
      }
      const hit = (res.body.result as { name?: unknown }[]).find((i) => i.name === resource.name);
      return hit ? resource.name : null;
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
  }
}

/** Whether a v4 create call went through (Cloudflare answers 200 or 201). */
function created(res: CfResponse): boolean {
  return res.status >= 200 && res.status < 300 && res.body?.success === true;
}

/**
 * Creates each Vectorize index in the plan with
 * `POST /vectorize/v2/indexes` and `{ name, config: { dimensions, metric } }`.
 * Run after the cleanup of an earlier run, so every name is free; an index
 * that already exists is an error rather than something to reuse.
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
 * Removes the Worker's consumer from each of the plan's queues that still
 * exists, so neither the Worker nor the queue is held by it. The API names
 * the Worker in `script_name`, `script`, or `service`, depending on the
 * consumer's age; any of them counts. Returns every problem.
 */
async function removeQueueConsumers(request: CfRequest, plan: CiInstallPlan): Promise<string[]> {
  const problems: string[] = [];
  for (const resource of plan.resources) {
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
          [c.script_name, c.script, c.service].includes(plan.name),
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
  const problems = await removeQueueConsumers(request, plan);
  const script = `/workers/scripts/${encodeURIComponent(plan.name)}`;
  const del = await request("DELETE", `${script}?force=true`);
  if (del.status !== 200 && del.status !== 404) {
    problems.push(`Worker ${plan.name}: delete failed: ${describe(del)}`);
  }
  for (const resource of plan.resources) {
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
  const gone = await request("GET", `${script}/settings`);
  if (gone.status !== 404) {
    problems.push(`Worker ${plan.name} still exists (${describe(gone)})`);
  }
  for (const resource of plan.resources) {
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
