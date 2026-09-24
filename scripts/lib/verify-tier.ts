import {
  type CfRequest,
  type CfResponse,
  catalogHealthMode,
  catalogHealthPath,
  healthUrl,
  type Probe,
  waitForHealth,
  workersSubdomain,
} from "./ci-install.ts";
import { verifiedDigest } from "./index-builder.ts";
import { SANDBOX_RUN_TIERS } from "./sandbox-entry.ts";
import type { CatalogManifest, IndexApp, IndexJson } from "./types.ts";

/**
 * The manual install check of entries CI never installs (`sandbox` and
 * `self-deploying` tiers), run by `verify-tier.yml` against a Workers Paid
 * account. CI cannot build such an entry itself: the build runs in the
 * account's sandbox Worker, which only a manager reaches. So a maintainer
 * installs the listed version with a manager in that account first, and this
 * check then confirms, before it records `lastVerified`:
 *
 * 1. the entry is listed in `index.json` at the version the maintainer
 *    installed;
 * 2. the account has the sandbox Worker (`appflare-sandbox`, the name
 *    `SANDBOX_WORKER_NAME` in `@appflare/schema`), so the install was
 *    built there;
 * 3. the app's Worker exists and passes the same health check as the other
 *    install checks, on its `install.healthPath` with its `install.healthMode`.
 *    For a `self-deploying` entry that is the first of
 *    `install.selfDeploying.workers`, named after the install's stage, so the
 *    maintainer passes its name, which must fit that template.
 *
 * It cannot tell which commit the running Worker was built from; the
 * maintainer's install is what vouches for that.
 */

export const SANDBOX_WORKER_NAME = "appflare-sandbox";

/** Tiers this check is for. Artifact tier entries are checked by nightly.yml. */
export const MANUAL_TIERS: readonly string[] = SANDBOX_RUN_TIERS;

/** One passing check, in the shape `record-verified` takes. */
export type TierVerification = Record<string, { version: string; digest: string; at: string }>;

/**
 * The index row a manual check of `slug` `version` is about, with the digest
 * `lastVerified` is recorded against. Throws with the reason when there is none.
 */
export function manualCheckRow(
  index: IndexJson,
  slug: string,
  version: string,
): { row: IndexApp; digest: string } {
  const row = index.apps.find((r) => r.slug === slug);
  if (!row) {
    throw new Error(`${slug} is not listed in index.json; only listed entries can be verified`);
  }
  if (!MANUAL_TIERS.includes(row.tier)) {
    throw new Error(
      `${slug} is a ${row.tier} tier entry; the nightly workflow installs and verifies it`,
    );
  }
  if (row.version !== version) {
    throw new Error(
      `index.json lists ${slug} ${row.version}, not ${version}; install ${row.version} with the ` +
        "manager in the paid account and run this again with that version",
    );
  }
  const digest = verifiedDigest(row);
  if (digest === null) {
    throw new Error(`the index row of ${slug} has neither a digest nor a build block`);
  }
  return { row, digest };
}

function describe(res: CfResponse): string {
  const errors = res.body?.errors?.map((e) => `${e.code} ${e.message}`).join("; ");
  return `HTTP ${res.status}${errors ? ` (${errors})` : ""}`;
}

/** Whether Worker `name` exists in the account. Throws on anything but a clear yes or no. */
export async function workerExists(request: CfRequest, name: string): Promise<boolean> {
  const res = await request("GET", `/workers/scripts/${encodeURIComponent(name)}/settings`);
  if (res.status === 200 && res.body?.success !== false) {
    return true;
  }
  if (res.status === 404) {
    return false;
  }
  throw new Error(`could not look up the Worker ${name}: ${describe(res)}`);
}

export interface ManualCheckOptions {
  index: IndexJson;
  slug: string;
  version: string;
  /** The entry's catalog manifest, schema-parsed. */
  manifest: CatalogManifest;
  /**
   * The Worker the maintainer installed; the manifest's `install.workerName`
   * when omitted. Required for a `self-deploying` entry (see {@link checkedWorker}).
   */
  worker?: string;
  request: CfRequest;
  probe: (url: string) => Promise<Probe>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
  timeoutMs?: number;
}

/** A stage as the manager names one: lowercase letters, digits and dashes, 1 to 24. */
const STAGE_PATTERN = "[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?";

/**
 * Whether `name` is `template` with some stage in place of `{{stage}}`. With
 * `others`, also that it fits none of them: `open-seo-{{stage}}` alone
 * accepts the audit Worker `open-seo-x-audit` as stage `x-audit`, so the
 * entry's other Worker templates are passed to rule that out.
 */
export function fitsWorkerTemplate(
  template: string,
  name: string,
  others: readonly string[] = [],
): boolean {
  if (others.some((other) => fitsWorkerTemplate(other, name))) {
    return false;
  }
  const [before = "", after = ""] = template.split("{{stage}}");
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${literal(before)}${STAGE_PATTERN}${literal(after)}$`).test(name);
}

/**
 * The Worker whose health the check probes: `worker` when given, else the
 * manifest's `install.workerName`. A `self-deploying` entry's Worker is named
 * after the install's stage, which only the maintainer's manager knows, so it
 * needs `worker`, and `worker` must fit the entry's first Worker template.
 */
export function checkedWorker(manifest: CatalogManifest, worker: string | undefined): string {
  const [template, ...others] = manifest.install.selfDeploying?.workers ?? [];
  if (manifest.install.tier !== "self-deploying" || template === undefined) {
    return worker ?? manifest.install.workerName;
  }
  if (worker === undefined) {
    throw new Error(
      `${manifest.slug} names its Worker after each install's stage (${template}); pass that ` +
        "name with the stage the manager's app page shows for the install",
    );
  }
  if (!fitsWorkerTemplate(template, worker, others)) {
    throw new Error(
      `${worker} is not the Worker that serves ${manifest.slug}; its installer names that one ` +
        `${template}${others.length > 0 ? `, not ${others.join(" or ")}` : ""}`,
    );
  }
  return worker;
}

/** Runs the manual check. Resolves with the verification to record; throws when it fails. */
export async function runManualCheck(options: ManualCheckOptions): Promise<TierVerification> {
  const { row, digest } = manualCheckRow(options.index, options.slug, options.version);
  const worker = checkedWorker(options.manifest, options.worker);
  if (!(await workerExists(options.request, SANDBOX_WORKER_NAME))) {
    throw new Error(
      `this account has no ${SANDBOX_WORKER_NAME} Worker. Verifying a ${row.tier} tier entry ` +
        "needs a Workers Paid account with sandbox builds enabled (`npx @appflare/cli sandbox " +
        "enable`) and the app installed with its manager; nothing was recorded",
    );
  }
  options.log(`${SANDBOX_WORKER_NAME} is present`);
  if (!(await workerExists(options.request, worker))) {
    throw new Error(
      `this account has no Worker named ${worker}. Install ${options.slug} ${row.version} with ` +
        "the manager first, or pass the Worker name it was installed under",
    );
  }
  const subdomain = await workersSubdomain(options.request);
  const url = healthUrl(worker, subdomain, catalogHealthPath(options.manifest));
  options.log(`waiting for ${url}`);
  const health = await waitForHealth(() => options.probe(url), {
    timeoutMs: options.timeoutMs ?? 60_000,
    intervalMs: 3_000,
    sleep: options.sleep,
    now: options.now,
    mode: catalogHealthMode(options.manifest),
  });
  if (!health.ok) {
    throw new Error(`${worker} failed the health check: ${health.detail}`);
  }
  options.log(`${worker} answered: ${health.detail}`);
  return {
    [options.slug]: {
      version: row.version,
      digest,
      at: new Date(options.now()).toISOString(),
    },
  };
}
