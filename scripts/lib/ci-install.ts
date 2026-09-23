import { createHash, randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ArtifactBinding, ArtifactFile, ArtifactManifest } from "./types.ts";

/**
 * Installs a packed artifact into the CI Cloudflare account with wrangler, to
 * check that it deploys and answers, then removes everything again.
 *
 * This is not the manager's install path. The manager creates each resource
 * through the API and records it; here `wrangler deploy` provisions the
 * resources from bindings without ids. Both use the same names,
 * `<worker>-<binding, lowercased, "_" -> "-">`, so the CI Worker's resources can
 * be found and deleted by name afterwards without any records.
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

export type CiResourceType = "kv" | "d1" | "r2" | "workflow";

export interface CiResource {
  type: CiResourceType;
  name: string;
  binding: string;
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
  /** The path the health check probes: the catalog's `install.healthPath`, else `/`. */
  healthPath: string;
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

/** The URL the health check probes for Worker `name` in the account's workers.dev subdomain. */
export function healthUrl(name: string, subdomain: string, healthPath: string): string {
  return `https://${name}.${subdomain}.workers.dev${healthPath}`;
}

/** Placeholder for a required var without a default; the check only needs the Worker to start. */
export const REQUIRED_VAR_PLACEHOLDER = "ci";

/**
 * Plans the CI install of `manifest` as Worker `name`: the wrangler config
 * (bindings without ids, so wrangler provisions them under
 * {@link resourceName}), the resources to clean up, and the secrets to set.
 * Throws for a binding kind this check cannot create or clean up yet, instead
 * of deploying a Worker with a binding missing.
 */
export function planCiInstall(manifest: ArtifactManifest, name: string): CiInstallPlan {
  const { worker } = manifest;
  const resources: CiResource[] = [];
  const kv: Record<string, string>[] = [];
  const d1: Record<string, string>[] = [];
  const r2: Record<string, string>[] = [];
  const durableObjects: Record<string, string>[] = [];
  const workflows: Record<string, string>[] = [];
  const analytics: Record<string, string>[] = [];
  const singles: Record<string, { binding: string }> = {};
  const vars: Record<string, unknown> = {};
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
      case "analytics_engine":
        analytics.push({ binding: binding.name, ...optionalStr(binding, "dataset") });
        break;
      case "ai":
      case "browser":
      case "version_metadata":
        singles[binding.type] = { binding: binding.name };
        break;
      case "plain_text":
        vars[binding.name] = str(binding, "text");
        break;
      case "json":
        vars[binding.name] = binding.json;
        break;
      case "assets":
        break;
      default:
        // TODO: queues, Vectorize, Hyperdrive, service bindings, mTLS and email
        // need resources or peers this check does not create and clean up yet.
        throw new Error(
          `the CI install check cannot create a ${binding.type} binding (${binding.name}) yet`,
        );
    }
  }

  const forms = catalogForms(manifest.catalog);
  for (const v of forms.vars) {
    if (v.default !== undefined) {
      vars[v.name] = v.default;
    } else if (v.required && vars[v.name] === undefined) {
      vars[v.name] = REQUIRED_VAR_PLACEHOLDER;
    }
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
    ...singles,
    ...(Object.keys(vars).length > 0 ? { vars } : {}),
    triggers: { crons: [...worker.crons] },
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
    healthPath: catalogHealthPath(manifest.catalog),
  };
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

/** Whether a probe settles the check or should be retried. */
export function classifyProbe(probe: Probe): "ok" | "retry" | "soft-404" {
  if ("error" in probe) {
    return "retry";
  }
  if (probe.status >= 500) {
    return "retry";
  }
  if (probe.status === 404) {
    // 1042: the edge refused the request (e.g. the route is not live yet).
    // Any other 404 may still be the workers.dev route propagating.
    return probe.body.includes("error code: 1042") ? "retry" : "soft-404";
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
 */
export async function waitForHealth(
  probe: () => Promise<Probe>,
  options: {
    timeoutMs: number;
    intervalMs: number;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
  },
): Promise<HealthResult> {
  const deadline = options.now() + options.timeoutMs;
  let last: Probe = { error: "not checked" };
  for (;;) {
    last = await probe();
    const verdict = classifyProbe(last);
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

export type CfRequest = (method: string, path: string) => Promise<CfResponse>;

/** A minimal client for `https://api.cloudflare.com/client/v4/accounts/<id>`. */
export function createCfRequest(
  token: string,
  accountId: string,
  fetchFn: typeof fetch = fetch,
): CfRequest {
  return async (method, apiPath) => {
    const res = await fetchFn(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}${apiPath}`,
      {
        method,
        headers: { authorization: `Bearer ${token}` },
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

/** Finds a resource's id by name; null when it does not exist. */
async function findResource(request: CfRequest, resource: CiResource): Promise<string | null> {
  switch (resource.type) {
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
  }
}

/**
 * Deletes the CI Worker (with `force=true`, like `wrangler delete --force`, so
 * Durable Object and other bindings do not block it) and every resource in
 * the plan, then checks that each is gone. Missing things are fine (the deploy
 * may have failed before creating them). Returns every problem; empty means
 * the account is clean.
 */
export async function cleanupCiInstall(request: CfRequest, plan: CiInstallPlan): Promise<string[]> {
  const problems: string[] = [];
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
