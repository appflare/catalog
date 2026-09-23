import { parseArgs } from "node:util";
import { loadAppflareSchema } from "./lib/appflare-schema.ts";
import { findApp, listApps, loadManifest } from "./lib/apps.ts";
import { info, runMain } from "./lib/cli.ts";
import { appsDir, resolveAppflareDir } from "./lib/paths.ts";
import { tierProblems } from "./lib/tier-rules.ts";

const USAGE = `Usage: pnpm validate [<slug>...]

Validates apps/<slug>/appflare.jsonc (every app when no slug is given) with the
catalog manifest schema from @appflare/schema (APPFLARE_DIR), the catalog's
layout rules, and its tier rules: a sandbox tier entry must set plan "paid" and
declare install.buildCommand, and entries CI does not install (sandbox,
self-deploying) must not set bump.autoMerge.
`;

runMain(async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" } },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const schema = await loadAppflareSchema(resolveAppflareDir());
  const apps =
    positionals.length > 0 ? positionals.map((s) => findApp(appsDir, s)) : listApps(appsDir);
  const failures: string[] = [];
  for (const app of apps) {
    try {
      const manifest = loadManifest(app, schema.catalogManifest);
      const problems = tierProblems(manifest);
      if (problems.length > 0) {
        throw new Error(`apps/${app.slug}/appflare.jsonc is invalid:\n${problems.join("\n")}`);
      }
      info(`${manifest.slug}: ok (${manifest.repo}@${manifest.source.sha.slice(0, 7)})`);
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
  return 0;
});
