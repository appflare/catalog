import { parseArgs } from "node:util";
import { loadAppflareSchema } from "./lib/appflare-schema.ts";
import { findApp, listApps, loadManifest } from "./lib/apps.ts";
import { catalogRepo, info, runMain } from "./lib/cli.ts";
import { FEATURED_FILE, readFeatured } from "./lib/featured.ts";
import { readAppMedia } from "./lib/media.ts";
import { appsDir, catalogRoot, resolveAppflareDir } from "./lib/paths.ts";
import { tierProblems } from "./lib/tier-rules.ts";

const USAGE = `Usage: pnpm validate [<slug>...]

Validates apps/<slug>/appflare.jsonc (every app when no slug is given) with the
catalog manifest schema from @appflare/schema (APPFLARE_DIR), the catalog's
layout rules, and its tier rules: a sandbox tier entry must set plan "paid" and
declare install.buildCommand; a self-deploying entry must set plan "paid",
describe its installer in install.selfDeploying, and list tokenPermissions;
and entries CI does not install (sandbox, self-deploying) must not set
bump.autoMerge.

It also checks each entry's images, all of them optional: at most one square
icon (icon.svg or icon.png), a 1200x630 cover.png, and screenshots/*.png.
SVGs may not script or load anything, and MEDIA.md must name every image on
a line that links the upstream file it comes from. Without slugs,
featured.json and featured/ are checked too.
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
  const repo = catalogRepo();
  const all = listApps(appsDir);
  const apps = positionals.length > 0 ? positionals.map((s) => findApp(appsDir, s)) : all;
  const failures: string[] = [];
  for (const app of apps) {
    try {
      const manifest = loadManifest(app, schema.catalogManifest);
      const problems = [
        ...tierProblems(manifest),
        ...readAppMedia(app.dir, manifest.slug, manifest.name, repo).problems.map((p) => `- ${p}`),
      ];
      if (problems.length > 0) {
        throw new Error(`apps/${app.slug} is invalid:\n${problems.join("\n")}`);
      }
      info(`${manifest.slug}: ok (${manifest.repo}@${manifest.source.sha.slice(0, 7)})`);
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (positionals.length === 0) {
    try {
      const { items } = readFeatured(catalogRoot, repo, schema.featuredItem);
      const slugs = new Set(all.map((a) => a.slug));
      const unknown = items.filter((i) => i.slug !== undefined && !slugs.has(i.slug));
      if (unknown.length > 0) {
        throw new Error(
          unknown
            .map((i) => `${FEATURED_FILE}: ${i.id} promotes "${i.slug}", which is not in apps/`)
            .join("\n"),
        );
      }
      info(`${FEATURED_FILE}: ok (${items.length} item(s))`);
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
  return 0;
});
