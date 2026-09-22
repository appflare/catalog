import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadAppflareSchema, parseOrThrow } from "./lib/appflare-schema.ts";
import { findApp, loadManifest } from "./lib/apps.ts";
import { info, runMain } from "./lib/cli.ts";
import { sha256Hex } from "./lib/index-builder.ts";
import { clearArtifactDir } from "./lib/out-dir.ts";
import { packerEnv, SIGNING_KEY_ENV, SIGNING_KEY_ID } from "./lib/pack-env.ts";
import { appflarePaths, appsDir, catalogRoot, resolveAppflareDir } from "./lib/paths.ts";
import { createVersionResolver, loadPackerVersioning } from "./lib/versions.ts";

const USAGE = `Usage: pnpm pack-app <slug> [--out <dir>] [--key-id <id>]

Clones the app's repo at source.sha into a temp dir, builds the artifact with
appflare-pack (dependencies installed with --ignore-scripts), and checks it
with appflare-pack verify --hashes-only. Never signs and never sees a secret.
APPFLARE_DIR points at a built appflare checkout or packer bundle.

  --out <dir>      output directory (default: dist/<slug>)
  --key-id <id>    record this key id in manifest.json, producing an unsigned
                   intermediate for \`appflare-pack sign\` (publish CI uses
                   ${SIGNING_KEY_ID}); without it the artifact is keyId "unsigned"

Sign an intermediate afterwards, in a step that runs no app code:
  node $APPFLARE_DIR/packages/pack/bin/appflare-pack.js sign <dir> \\
    --sign-key-env ${SIGNING_KEY_ENV} --key-id ${SIGNING_KEY_ID}
`;

const childEnv = { ...packerEnv(process.env), GIT_TERMINAL_PROMPT: "0" };

function run(cmd: string, args: string[], cwd?: string): number {
  const res = spawnSync(cmd, args, { cwd, env: childEnv, stdio: ["ignore", "inherit", "inherit"] });
  if (res.error) {
    throw new Error(`failed to run ${cmd}: ${res.error.message}`);
  }
  return res.status ?? 1;
}

function mustRun(cmd: string, args: string[], cwd?: string): void {
  const status = run(cmd, args, cwd);
  if (status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with ${status}`);
  }
}

/** Clones `repo` without blobs and checks out exactly `sha`. */
function checkoutPinned(repo: string, sha: string, dir: string): void {
  const url = `https://github.com/${repo}.git`;
  info(`cloning ${url} (blob:none) at ${sha}`);
  mustRun("git", ["clone", "--quiet", "--filter=blob:none", "--no-checkout", url, dir]);
  if (run("git", ["checkout", "--quiet", "--detach", sha], dir) !== 0) {
    // The pin is not reachable from a branch or tag; fetch it directly.
    mustRun("git", ["fetch", "--quiet", "--filter=blob:none", "origin", sha], dir);
    mustRun("git", ["checkout", "--quiet", "--detach", sha], dir);
  }
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" });
  if (head.stdout.trim() !== sha) {
    throw new Error(`checkout is at ${head.stdout.trim()}, expected ${sha}`);
  }
}

runMain(async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      "key-id": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const slug = positionals[0];
  if (!slug || positionals.length > 1) {
    process.stderr.write(`error: expected exactly one <slug>\n\n${USAGE}`);
    return 1;
  }

  const appflareDir = resolveAppflareDir();
  const schema = await loadAppflareSchema(appflareDir);
  const versions = createVersionResolver(await loadPackerVersioning(appflareDir));
  const app = findApp(appsDir, slug);
  const manifest = loadManifest(app, schema.catalogManifest);
  const expectedVersion = versions.versionOf(manifest);
  const outDir = path.resolve(catalogRoot, values.out ?? path.join("dist", slug));
  const packBin = appflarePaths(appflareDir).packBin;
  clearArtifactDir(outDir);

  const tmp = mkdtempSync(path.join(tmpdir(), `appflare-pack-${slug}-`));
  try {
    const checkout = path.join(tmp, "checkout");
    checkoutPinned(manifest.repo, manifest.source.sha, checkout);
    const packArgs = [packBin, checkout, "--manifest", app.manifestPath, "--out", outDir];
    if (values["key-id"]) {
      packArgs.push("--key-id", values["key-id"]);
    }
    info(`packing ${slug}@${expectedVersion} with appflare-pack (no signing key present)`);
    mustRun(process.execPath, packArgs);
    if (run(process.execPath, [packBin, "verify", outDir, "--hashes-only"]) !== 0) {
      // Never leave an artifact that failed verification where build-index or
      // a later CI step could pick it up.
      clearArtifactDir(outDir);
      throw new Error(`appflare-pack verify --hashes-only failed for ${outDir}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const manifestPath = path.join(outDir, "manifest.json");
  const manifestBytes = readFileSync(manifestPath);
  const artifact = parseOrThrow(
    schema.artifactManifest,
    JSON.parse(manifestBytes.toString("utf8")),
    manifestPath,
  );
  if (artifact.version !== expectedVersion) {
    clearArtifactDir(outDir);
    throw new Error(
      `packed version ${artifact.version} differs from the planned ${expectedVersion}; ` +
        "publish would look for the wrong release tag",
    );
  }
  const zipPath = path.join(outDir, `${slug}-${artifact.version}.zip`);
  const migrations = Object.values(artifact.d1Migrations).reduce((n, l) => n + l.length, 0);
  process.stdout.write(
    [
      `${slug}@${artifact.version} (keyId=${artifact.keyId}, not signed)`,
      `  source:     ${artifact.source.repo}@${artifact.source.sha} (${artifact.source.ref})`,
      `  modules:    ${artifact.worker.modules.length}`,
      `  assets:     ${artifact.assets.files.length}`,
      `  migrations: ${migrations}`,
      `  zip:        ${zipPath} (${statSync(zipPath).size} bytes)`,
      `  digest:     ${sha256Hex(manifestBytes)} (sha256 of manifest.json)`,
      "",
    ].join("\n"),
  );
  return 0;
});
