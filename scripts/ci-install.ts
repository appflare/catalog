import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadAppflareSchema, parseOrThrow } from "./lib/appflare-schema.ts";
import {
  attachQueueConsumers,
  type CfRequest,
  type CiInstallPlan,
  ciWorkerName,
  cleanupCiInstall,
  createCfRequest,
  createQueues,
  createVectorizeIndexes,
  type HealthResult,
  healthUrl,
  planCiInstall,
  randomSecret,
  summaryLines,
  unpackArtifact,
  waitForHealth,
  workersSubdomain,
} from "./lib/ci-install.ts";
import { info, runMain } from "./lib/cli.ts";
import { packerEnv } from "./lib/pack-env.ts";
import { appflarePaths, resolveAppflareDir } from "./lib/paths.ts";
import type { ArtifactManifest } from "./lib/types.ts";

const USAGE = `Usage:
  node scripts/ci-install.ts deploy <artifactDir> --suffix <suffix>
  node scripts/ci-install.ts cleanup <artifactDir> --suffix <suffix>

The Worker is named ci-<slug>-<suffix> (for example ci-cut-pr12).

deploy   Unpacks the artifact (checking every file's sha256), removes anything
         left from an earlier run under the same name, writes a wrangler.json
         from manifest.json (bindings without ids, so wrangler provisions them;
         Vectorize indexes and queues are created first through the API, and
         each rate limit gets a random namespace id; vars as the manager sets
         them, JSON vars kept as JSON and {{workerUrl}} and {{workerName}}
         filled in for the CI Worker; a service binding to the app's own
         Worker aimed at the CI Worker, any other refused; no cron triggers,
         which the run summary notes), runs wrangler deploy --strict, attaches the recorded queue consumers through the API,
         applies D1 migrations, sets each catalog secret to a random value,
         and waits up to 60 s for
         https://<worker>.<subdomain>.workers.dev<healthPath> to answer
         (install.healthPath from the catalog manifest, else /). A failed
         deploy may still have uploaded the Worker; cleanup deletes it.
cleanup  Removes the Worker's queue consumers, deletes the Worker and every
         resource the deploy may have created, and fails unless all of them
         are gone.

Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, and APPFLARE_DIR (the
packer bundle, for @appflare/schema and wrangler). Runs only the artifact's
prebuilt output; nothing from the app's repository.
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

function wrangler(bin: string, cwd: string, args: string[], stdin?: string): void {
  const res = spawnSync(
    process.execPath,
    [bin, ...args, "--config", path.join(cwd, "wrangler.json")],
    {
      cwd,
      env: { ...packerEnv(process.env), CI: "1", WRANGLER_SEND_METRICS: "false" },
      input: stdin,
      stdio: [stdin === undefined ? "ignore" : "pipe", "inherit", "inherit"],
    },
  );
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

async function cleanup(request: CfRequest, plan: CiInstallPlan): Promise<void> {
  const problems = await cleanupCiInstall(request, plan);
  if (problems.length > 0) {
    throw new Error(
      `cleanup of ${plan.name} left things behind:\n${problems.map((p) => `- ${p}`).join("\n")}`,
    );
  }
  info(`removed ${plan.name} and ${plan.resources.length} resource(s)`);
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

/** Deploys the unpacked artifact as the plan's Worker and waits for it to answer. */
async function deployAndCheck(
  request: CfRequest,
  plan: CiInstallPlan,
  manifest: ArtifactManifest,
  zipPath: string,
  bin: string,
  work: string,
  subdomain: string,
): Promise<HealthResult> {
  unpackArtifact(manifest, zipPath, work);
  // A re-run reuses the name; start from a clean account.
  await cleanup(request, plan);
  // wrangler provisions KV, D1, and R2 from bindings without ids, but not
  // Vectorize indexes or named queues: those must exist before the deploy
  // binds them.
  await createVectorizeIndexes(request, plan);
  await createQueues(request, plan);
  writeFileSync(path.join(work, "wrangler.json"), `${JSON.stringify(plan.config, null, 2)}\n`);
  info(`deploying ${manifest.app}@${manifest.version} as ${plan.name}`);
  try {
    wrangler(bin, work, ["deploy", "--strict"]);
  } catch (err) {
    // wrangler uploads the script before it updates triggers, so a deploy
    // that fails there (a trigger configuration "only partially updated")
    // leaves the Worker in the account. The cleanup command deletes it by
    // name; CI runs it after every deploy, failed or not.
    throw new Error(
      `${message(err)}; ${plan.name} may already be uploaded, and the cleanup command deletes it`,
    );
  }
  // A consumer belongs to the script, so it can only point at a deployed Worker.
  await attachQueueConsumers(request, plan);
  for (const database of plan.d1Migrations) {
    wrangler(bin, work, ["d1", "migrations", "apply", database, "--remote"]);
  }
  for (const secret of plan.secrets) {
    wrangler(bin, work, ["secret", "put", secret, "--name", plan.name], randomSecret());
  }
  const url = healthUrl(plan.name, subdomain, plan.healthPath);
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
      timeoutMs: 60_000,
      intervalMs: 3_000,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      mode: plan.healthMode,
    },
  );
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

  if (command === "cleanup") {
    // Cleanup finds everything by name; var values do not matter here.
    await cleanup(request, planCiInstall(manifest, name));
    return 0;
  }
  if (command !== "deploy") {
    throw new Error(`unknown command "${command}"`);
  }
  // Var values may hold {{workerUrl}}, which needs the account's subdomain.
  const subdomain = await workersSubdomain(request);
  const plan = planCiInstall(manifest, name, { subdomain });

  const bin = wranglerBin(resolveAppflareDir());
  const work = mkdtempSync(path.join(tmpdir(), `ci-install-${plan.name}-`));
  try {
    const health = await deployAndCheck(request, plan, manifest, zipPath, bin, work, subdomain);
    summary(summaryLines(manifest, plan, health.ok, health.detail));
    return health.ok ? 0 : 1;
  } catch (err) {
    // The notes belong in the summary whatever went wrong; the cleanup step
    // removes whatever the failed deploy left behind.
    summary(summaryLines(manifest, plan, false, message(err).split("\n")[0] ?? ""));
    throw err;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
