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
  type CfRequest,
  type CiInstallPlan,
  ciWorkerName,
  cleanupCiInstall,
  createCfRequest,
  healthUrl,
  planCiInstall,
  randomSecret,
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
         from manifest.json (bindings without ids, so wrangler provisions them),
         runs wrangler deploy --strict, applies D1 migrations, sets each catalog
         secret to a random value, and waits up to 60 s for
         https://<worker>.<subdomain>.workers.dev<healthPath> to answer
         (install.healthPath from the catalog manifest, else /).
cleanup  Deletes the Worker and every resource the deploy may have created,
         and fails unless all of them are gone.

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

function summary(line: string): void {
  process.stdout.write(`${line}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  }
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
  const plan = planCiInstall(manifest, ciWorkerName(manifest.app, values.suffix));

  if (command === "cleanup") {
    await cleanup(request, plan);
    return 0;
  }
  if (command !== "deploy") {
    throw new Error(`unknown command "${command}"`);
  }

  const bin = wranglerBin(resolveAppflareDir());
  const work = mkdtempSync(path.join(tmpdir(), `ci-install-${plan.name}-`));
  try {
    unpackArtifact(manifest, zipPath, work);
    // A re-run reuses the name; start from a clean account.
    await cleanup(request, plan);
    writeFileSync(path.join(work, "wrangler.json"), `${JSON.stringify(plan.config, null, 2)}\n`);
    info(`deploying ${manifest.app}@${manifest.version} as ${plan.name}`);
    wrangler(bin, work, ["deploy", "--strict"]);
    for (const database of plan.d1Migrations) {
      wrangler(bin, work, ["d1", "migrations", "apply", database, "--remote"]);
    }
    for (const secret of plan.secrets) {
      wrangler(bin, work, ["secret", "put", secret, "--name", plan.name], randomSecret());
    }
    const url = healthUrl(plan.name, await workersSubdomain(request), plan.healthPath);
    info(`waiting for ${url}`);
    const health = await waitForHealth(
      async () => {
        try {
          const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
          return { status: res.status, body: await res.text() };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
      {
        timeoutMs: 60_000,
        intervalMs: 3_000,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: () => Date.now(),
      },
    );
    summary(
      `${health.ok ? "PASS" : "FAIL"} ${manifest.app}@${manifest.version} as ${plan.name}: ${health.detail}`,
    );
    return health.ok ? 0 : 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
