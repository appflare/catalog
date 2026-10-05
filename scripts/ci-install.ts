import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  loadAppflareSchema,
  loadEntryWorkerHelpers,
  loadR2LifecycleHelpers,
  loadSeedHelpers,
  parseOrThrow,
} from "./lib/appflare-schema.ts";
import {
  analyticsEngineSkip,
  analyticsEngineState,
  appSecretValues,
  appSummaryLines,
  attachQueueConsumers,
  type CfRequest,
  CI_ACCOUNT_PLAN,
  type CiAppPlan,
  type CiEntryHelpers,
  type CiWorkerResult,
  ciAccountPlan,
  ciWorkerName,
  cleanupCiApp,
  createCfRequest,
  createHyperdriveConfigs,
  createKvNamespaces,
  createQueues,
  createVectorizeIndexes,
  DEPLOY_CONFIG,
  d1Steps,
  derivedVarValues,
  type HealthMode,
  type HealthResult,
  HYPERDRIVE_TEST_URL,
  healthProbes,
  hyperdriveSkip,
  isSeedStep,
  needsPackerSecrets,
  needsR2LifecycleHelpers,
  needsSeedHelpers,
  POST_DEPLOY_CONFIG,
  paidPlanSkip,
  planCiApp,
  postDeployConfig,
  runSeed,
  seedFunctions,
  seedValues,
  setR2LifecycleRules,
  skipNotice,
  skippedSummaryLines,
  unpackArtifact,
  waitForHealth,
  withHyperdriveIds,
  withKvIds,
  withVars,
  workersSubdomain,
} from "./lib/ci-install.ts";
import { info, runMain } from "./lib/cli.ts";
import { packerEnv } from "./lib/pack-env.ts";
import { loadPackerSecrets } from "./lib/packer-lib.ts";
import { appflarePaths, resolveAppflareDir } from "./lib/paths.ts";
import type { ArtifactManifest } from "./lib/types.ts";

const USAGE = `Usage:
  node scripts/ci-install.ts deploy <artifactDir> --suffix <suffix>
  node scripts/ci-install.ts cleanup <artifactDir> --suffix <suffix>

The Worker is named ci-<slug>-<suffix> (for example ci-cut-pr12).

deploy   Unpacks the artifact (checking every file's sha256), removes anything
         left from an earlier run under the same name, writes a wrangler.json
         from manifest.json (bindings without ids, so wrangler provisions them,
         and the Worker's exports, cache block and Worker Loaders as recorded;
         Vectorize indexes and queues are created first through the API, and
         each rate limit gets a random namespace id; vars as the manager sets
         them, JSON vars kept as JSON and {{appUrl}}, {{workerUrl}}, their
         hostnames, {{workerName}} and {{accountId}} filled in for the CI
         Worker, which is served at its workers.dev URL; a service binding to the app's own
         Worker aimed at the CI Worker, any other refused; no cron triggers,
         which the run summary notes), runs wrangler deploy --strict, attaches the recorded queue consumers through the API,
         runs each D1 database's SQL as the manager does (its migrations
         with wrangler d1 migrations apply, named as the artifact records
         them; then its schema files in order with wrangler d1 execute
         --file; then its post-deploy migrations with wrangler d1
         migrations apply against wrangler.post-deploy.json, whose
         migrations_dir is their folder, so d1_migrations records them;
         a database with a baseline instead runs the baseline with wrangler
         d1 execute --file, then records every migration and post-deploy
         migration in d1_migrations without running them;
         then each seed through the D1 API, one /query call per statement
         with its values as params, where it says beforeSchema before the
         schema files instead; each statement must add at least one row),
         sets each catalog secret to a random value
         (a new VAPID private key for generate: "vapid-private-key", 32
         random bytes as base64 for generate: "base64-key-32", and a
         derived one to the value the manager computes from its source's; a
         derived var, such as a VAPID public key, goes into the config;
         seed-only secrets and vars get values for the seed and are never
         set on a Worker),
         and waits up to 60 s for
         https://<worker>.<subdomain>.workers.dev<path> to answer
         (install.health.path from the catalog manifest, else /; read as
         install.health.mode says). A failed
         deploy may still have uploaded the Worker; cleanup deletes it.

         A Worker of static assets only (no modules and no main module)
         is deployed with its assets and compatibility settings
         alone: the config names no main, and no module rules. _redirects
         and _headers, which the artifact records as text in its assets
         config, are written as files at the root of the assets directory.

         Resource settings are applied as the manager applies them: each
         Vectorize index's metadata indexes are created through the API
         right after the index, and each R2 bucket's lifecycle rules are
         merged into the bucket's own (keeping Cloudflare's default rule for
         unfinished multipart uploads) and put back through the API once
         the deploy has created the bucket.

         An app of several Workers (install.workers) is deployed Worker by
         Worker, each after the Workers it binds to: the primary one as
         ci-<slug>-<suffix>, every other one as ci-<slug>-<suffix>-<name>.
         Resources are shared by binding name (KV namespaces created through
         the API first, so every Worker binds the same one); bindings and
         {{workerUrl:<name>}}/{{workerName:<name>}} naming another Worker
         point at its CI Worker; each secret and var goes to the Workers the
         catalog manifest names, a shared secret with one value; each D1
         database's SQL runs once. After the primary's health check, every other
         Worker must answer at / within 30 s, except one the entry keeps off
         workers.dev (workersDev: false), which is deployed with workers_dev
         off and not probed.

         When a Worker binds an Analytics Engine dataset and the account has
         Analytics Engine off, nothing is deployed: the run summary says
         "skipped: Analytics Engine not enabled" and the command succeeds.
         A Worker that binds Hyperdrive gets a Hyperdrive configuration
         created through the API from HYPERDRIVE_TEST_URL, a connection string
         to a throwaway test database of the protocol the catalog manifest
         declares; without it (or with one of another protocol) nothing is
         deployed, the run summary says why, and the command succeeds.

         An entry whose catalog manifest says plan "paid" is not deployed
         when CI_ACCOUNT_PLAN is free (the default when it is unset or
         empty): it may use what the free plan refuses at upload, such as a
         CPU limit. The command prints a GitHub Actions notice naming the
         app, the run summary says why, the step output skipped is set to
         paid-plan, and the command succeeds.
cleanup  Removes the queue consumers of every Worker, deletes every Worker
         and every resource the deploy may have created, and fails unless
         all of them are gone.

Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, CI_ACCOUNT_PLAN set to paid
when the account is on Workers Paid, and APPFLARE_DIR (the packer bundle, for
@appflare/schema and wrangler). Runs only the artifact's prebuilt output;
nothing from the app's repository.
`;

function credentials(): { token: string; accountId: string } {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!token || !accountId) {
    throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set");
  }
  return { token, accountId };
}

/** wrangler's bin from the packer bundle's own dependencies. */
function wranglerBin(appflareDir: string): string {
  const packPkg = path.join(
    path.dirname(path.dirname(appflarePaths(appflareDir).packDist)),
    "package.json",
  );
  const require = createRequire(packPkg);
  const pkgPath = require.resolve("wrangler/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.wrangler;
  if (!rel) {
    throw new Error("could not find the wrangler bin in the packer bundle");
  }
  return path.join(path.dirname(pkgPath), rel);
}

function wrangler(
  bin: string,
  cwd: string,
  args: string[],
  stdin?: string,
  config: string = DEPLOY_CONFIG,
): void {
  const res = spawnSync(process.execPath, [bin, ...args, "--config", path.join(cwd, config)], {
    cwd,
    env: { ...packerEnv(process.env), CI: "1", WRANGLER_SEND_METRICS: "false" },
    input: stdin,
    stdio: [stdin === undefined ? "ignore" : "pipe", "inherit", "inherit"],
  });
  if (res.error || res.status !== 0) {
    // args never contain secret values; those go through stdin.
    throw new Error(
      `wrangler ${args.join(" ")} failed${res.error ? `: ${res.error.message}` : ` (exit ${res.status})`}`,
    );
  }
}

async function loadArtifact(dir: string): Promise<{ manifest: ArtifactManifest; zipPath: string }> {
  const schema = await loadAppflareSchema(resolveAppflareDir());
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = parseOrThrow(
    schema.artifactManifest,
    JSON.parse(readFileSync(manifestPath, "utf8")),
    manifestPath,
  );
  const zipPath = path.join(dir, `${manifest.app}-${manifest.version}.zip`);
  if (!existsSync(zipPath)) {
    throw new Error(`${zipPath} is missing`);
  }
  return { manifest, zipPath };
}

async function cleanup(request: CfRequest, app: CiAppPlan): Promise<void> {
  const problems = await cleanupCiApp(request, app);
  if (problems.length > 0) {
    throw new Error(
      `cleanup of ${app.name} left things behind:\n${problems.map((p) => `- ${p}`).join("\n")}`,
    );
  }
  const workers = app.workers.map((w) => w.plan.name).join(", ");
  info(`removed ${workers} and ${app.resources.length} resource(s)`);
}

/** The functions for an app of several Workers, loaded only for one. */
async function entryHelpers(manifest: ArtifactManifest): Promise<CiEntryHelpers | undefined> {
  return manifest.workers !== undefined ? loadEntryWorkerHelpers(resolveAppflareDir()) : undefined;
}

function summary(lines: string[]): void {
  const text = lines.map((line) => `${line}\n`).join("");
  process.stdout.write(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Polls `url` until it answers (see `waitForHealth`) for up to `timeoutMs`. */
function probe(url: string, timeoutMs: number, mode: HealthMode): Promise<HealthResult> {
  info(`waiting for ${url}`);
  return waitForHealth(
    async () => {
      try {
        const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
        return { status: res.status, body: await res.text() };
      } catch (err) {
        return { error: message(err) };
      }
    },
    {
      timeoutMs,
      intervalMs: 3_000,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      mode,
    },
  );
}

/** Where each Worker is unpacked and deployed from: `work` itself for an app of one Worker. */
function workDirs(app: CiAppPlan, work: string): string[] {
  return app.workers.length === 1
    ? [work]
    : app.workers.map((w, i) => path.join(work, `${i}-${w.entryName ?? "worker"}`));
}

interface CheckOutcome {
  ok: boolean;
  detail: string;
  results: CiWorkerResult[];
}

/**
 * Deploys every Worker of the unpacked artifact in the plan's order and waits
 * for them to answer: the primary one at its health path, every other one at
 * `/` (see `OTHER_WORKER_PROBE`).
 */
async function deployAndCheck(
  request: CfRequest,
  app: CiAppPlan,
  zipPath: string,
  bin: string,
  work: string,
  subdomain: string,
  /** The test database's URL, for the Hyperdrive configurations; never printed. */
  testDatabase: string | undefined,
): Promise<CheckOutcome> {
  const dirs = workDirs(app, work);
  app.workers.forEach((w, i) => {
    unpackArtifact(w.manifest, zipPath, dirs[i] as string);
  });
  const dirOf = (name: string): string => {
    const i = app.workers.findIndex((w) => w.plan.name === name);
    if (i < 0) throw new Error(`the plan has no Worker ${name}`);
    return dirs[i] as string;
  };
  // A re-run reuses the names; start from a clean account.
  await cleanup(request, app);
  // wrangler provisions KV, D1, and R2 from bindings without ids, but not
  // Vectorize indexes or named queues: those must exist before the deploy
  // binds them. So must the KV namespaces Workers of one app share.
  await createVectorizeIndexes(request, app);
  await createQueues(request, app);
  const kvIds = await createKvNamespaces(request, app);
  // Hyperdrive configurations too, each pointed at the test database.
  const hyperdriveIds =
    app.hyperdriveConfigs.length > 0 && testDatabase !== undefined
      ? await createHyperdriveConfigs(request, app, testDatabase)
      : {};
  // Secret values come first: a derived var (a VAPID public key) is computed
  // from one and goes into the config the deploy uploads.
  const packer = needsPackerSecrets(app)
    ? await loadPackerSecrets(resolveAppflareDir())
    : { deriveSecretValue: null, generateVapidPrivateKey: null };
  const values = appSecretValues(app, packer);
  // Loaded before any deploy, so a manager build without it fails before
  // any Worker is uploaded.
  const lifecycle = needsR2LifecycleHelpers(app)
    ? await loadR2LifecycleHelpers(resolveAppflareDir())
    : null;
  const configs: Record<string, unknown>[] = [];
  for (const [i, w] of app.workers.entries()) {
    const dir = dirs[i] as string;
    const withKv = app.kvNamespaces.length > 0 ? withKvIds(w.plan.config, kvIds) : w.plan.config;
    const withHyperdrive =
      w.plan.hyperdriveConfigs.length > 0 ? withHyperdriveIds(withKv, hyperdriveIds) : withKv;
    const config = withVars(
      withHyperdrive,
      derivedVarValues(w.plan, values, packer.deriveSecretValue),
    );
    configs.push(config);
    writeFileSync(path.join(dir, DEPLOY_CONFIG), `${JSON.stringify(config, null, 2)}\n`);
    const postDeploy = postDeployConfig(config, w.plan.d1);
    if (postDeploy !== null) {
      writeFileSync(path.join(dir, POST_DEPLOY_CONFIG), `${JSON.stringify(postDeploy, null, 2)}\n`);
    }
    info(`deploying ${w.manifest.app}@${w.manifest.version} as ${w.plan.name}`);
    try {
      wrangler(bin, dir, ["deploy", "--strict"]);
    } catch (err) {
      // wrangler uploads the script before it updates triggers, so a deploy
      // that fails there (a trigger configuration "only partially updated")
      // leaves the Worker in the account. The cleanup command deletes it by
      // name; CI runs it after every deploy, failed or not.
      throw new Error(
        `${message(err)}; ${w.plan.name} may already be uploaded, and the cleanup command deletes it`,
      );
    }
  }
  // wrangler created the R2 buckets during the deploys; their lifecycle
  // rules go on now, before any SQL runs or any request reaches the app.
  if (lifecycle !== null) {
    await setR2LifecycleRules(request, app, lifecycle.mergeR2LifecycleRules);
    for (const b of app.r2Lifecycles) {
      info(`set ${b.rules.length} lifecycle rule(s) on R2 bucket ${b.bucket} (${b.binding})`);
    }
  }
  // A consumer belongs to the script, so it can only point at a deployed Worker.
  for (const w of app.workers) {
    await attachQueueConsumers(request, w.plan);
  }
  // Seeds bind values only the D1 API takes as params; loaded only for them.
  const seeds = needsSeedHelpers(app)
    ? seedFunctions(await loadSeedHelpers(resolveAppflareDir()))
    : null;
  const seedInput = seedValues(
    app.workers.map((w, i) => ({ ...w, config: configs[i] as Record<string, unknown> })),
    values,
  );
  for (const step of d1Steps(app.d1)) {
    if (!isSeedStep(step)) {
      const dir = dirOf(step.worker);
      if (step.write !== undefined) {
        const target = path.join(dir, step.write.file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, step.write.text);
      }
      wrangler(bin, dir, step.args, undefined, step.config);
    } else if (seeds === null) {
      throw new Error(`${step.database} has a seed, and no seed functions were loaded`);
    } else {
      const count = await runSeed(request, step, seedInput, seeds);
      info(`seeded ${step.database} (${step.binding}): ${count} statement(s), each adding its row`);
    }
  }
  for (const [i, w] of app.workers.entries()) {
    for (const secret of [...w.plan.secrets, ...w.plan.derivedSecrets.map((s) => s.name)]) {
      const value = values.get(secret);
      if (value === undefined) {
        throw new Error(`the check has no value for the secret ${secret}`);
      }
      wrangler(bin, dirs[i] as string, ["secret", "put", secret, "--name", w.plan.name], value);
    }
  }
  const results: CiWorkerResult[] = [];
  for (const check of healthProbes(app, subdomain)) {
    results.push({
      worker: check.worker,
      health:
        "skipped" in check ? check.skipped : await probe(check.url, check.timeoutMs, app.probeMode),
    });
  }
  const failed = results.filter((r) => !r.health.ok);
  if (app.workers.length === 1) {
    const only = results[0]?.health ?? { ok: false, detail: "not checked" };
    return { ok: only.ok, detail: only.detail, results };
  }
  return {
    ok: failed.length === 0,
    detail:
      failed.length === 0
        ? "every Worker answered"
        : `${failed.map((r) => r.worker.plan.name).join(", ")} did not answer`,
    results,
  };
}

runMain(async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { suffix: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  const [command, dir] = positionals;
  if (values.help || !command || !dir || !values.suffix) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 1;
  }
  const { token, accountId } = credentials();
  const request = createCfRequest(token, accountId);
  const { manifest, zipPath } = await loadArtifact(path.resolve(dir));
  const name = ciWorkerName(manifest.app, values.suffix);

  const helpers = await entryHelpers(manifest);
  if (command === "cleanup") {
    // Cleanup finds everything by name; var values do not matter here.
    await cleanup(request, planCiApp(manifest, name, { ...(helpers ? { helpers } : {}) }));
    return 0;
  }
  if (command !== "deploy") {
    throw new Error(`unknown command "${command}"`);
  }
  // A Workers Paid entry may use what a free account refuses at upload (a CPU
  // limit, say), so on a free CI account its deploy says nothing about the app.
  const paidOnly = paidPlanSkip(manifest.catalog, ciAccountPlan(process.env[CI_ACCOUNT_PLAN]));
  if (paidOnly !== null) {
    process.stdout.write(`${skipNotice(manifest, paidOnly)}\n`);
    summary(skippedSummaryLines(manifest, name, paidOnly));
    // The nightly run records no verification for an app it did not deploy.
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, "skipped=paid-plan\n");
    }
    return 0;
  }
  // Var values may hold {{workerUrl}}, which needs the account's subdomain.
  const subdomain = await workersSubdomain(request);
  const app = planCiApp(manifest, name, {
    subdomain,
    accountId,
    ...(helpers ? { helpers } : {}),
  });
  // Cloudflare refuses every deploy that binds a dataset while Analytics
  // Engine is off on the account; that says nothing about the app.
  const skip = await analyticsEngineSkip(
    app.workers.map((w) => w.plan),
    () => analyticsEngineState(token, accountId),
  );
  if (skip !== null) {
    summary(skippedSummaryLines(manifest, app.name, skip));
    return 0;
  }
  // A Hyperdrive binding needs a database; the CI account has none of the
  // app's own, only the test database the secret names, when it is set.
  const testDatabase = process.env[HYPERDRIVE_TEST_URL];
  const noDatabase = hyperdriveSkip(app, testDatabase);
  if (noDatabase !== null) {
    summary(skippedSummaryLines(manifest, app.name, noDatabase));
    return 0;
  }

  const bin = wranglerBin(resolveAppflareDir());
  const work = mkdtempSync(path.join(tmpdir(), `ci-install-${app.name}-`));
  try {
    const outcome = await deployAndCheck(request, app, zipPath, bin, work, subdomain, testDatabase);
    summary(appSummaryLines(manifest, app, outcome.ok, outcome.detail, outcome.results));
    return outcome.ok ? 0 : 1;
  } catch (err) {
    // The notes belong in the summary whatever went wrong; the cleanup step
    // removes whatever the failed deploy left behind.
    summary(appSummaryLines(manifest, app, false, message(err).split("\n")[0] ?? ""));
    throw err;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
