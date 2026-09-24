import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadAppflareSchema, parseOrThrow } from "./lib/appflare-schema.ts";
import { findApp, loadManifest } from "./lib/apps.ts";
import { createCfRequest } from "./lib/ci-install.ts";
import { info, runMain } from "./lib/cli.ts";
import { appsDir, indexFile, resolveAppflareDir } from "./lib/paths.ts";
import { runManualCheck } from "./lib/verify-tier.ts";

const USAGE = `Usage: pnpm -s verify-tier <slug> --version <version> --out <checks.json> [--worker <name>]

The manual install check of a sandbox or self-deploying tier entry, which CI
never installs. Install <slug> <version> with an Appflare manager in a Workers
Paid account that has sandbox builds enabled first. This then checks that the
index lists that version, that the account has the appflare-sandbox Worker,
and that the app's Worker (the manifest's workerName, or --worker) passes the
health check, and writes the passing check for record-verified to <checks.json>.
A self-deploying entry's Worker is named after the install's stage, so it
needs --worker: the first of install.selfDeploying.workers with {{stage}}
replaced by the stage the manager's app page shows for the install.

Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID of that account (Workers
Scripts read), and APPFLARE_DIR.
`;

runMain(async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      version: { type: "string" },
      worker: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [slug] = positionals;
  if (values.help || !slug || !values.version || !values.out) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 1;
  }
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!token || !accountId) {
    throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set");
  }
  const schema = await loadAppflareSchema(resolveAppflareDir());
  const index = parseOrThrow(
    schema.indexJson,
    JSON.parse(readFileSync(indexFile, "utf8")),
    "index.json",
  );
  const manifest = loadManifest(findApp(appsDir, slug), schema.catalogManifest);
  const verified = await runManualCheck({
    index,
    slug,
    version: values.version.trim(),
    manifest,
    ...(values.worker?.trim() ? { worker: values.worker.trim() } : {}),
    request: createCfRequest(token, accountId),
    probe: async (url) => {
      try {
        const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
        return { status: res.status, body: await res.text() };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: info,
  });
  const out = path.resolve(values.out);
  writeFileSync(out, `${JSON.stringify(verified, null, 2)}\n`);
  info(`passed; wrote ${out}`);
  return 0;
});
