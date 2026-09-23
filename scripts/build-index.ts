import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadAppflareSchema } from "./lib/appflare-schema.ts";
import { listApps, loadManifest } from "./lib/apps.ts";
import { catalogRepo, info, runMain, warn } from "./lib/cli.ts";
import { createGhReleaseLookup } from "./lib/github-releases.ts";
import { buildIndexApps, finalizeIndex, serializeIndex } from "./lib/index-builder.ts";
import { appsDir, distDir, indexFile, resolveAppflareDir } from "./lib/paths.ts";
import type { IndexApp } from "./lib/types.ts";
import { createVersionResolver, loadPackerVersioning } from "./lib/versions.ts";

const USAGE = `Usage: pnpm build-index [--releases-only] [--out <file>]

Validates every apps/<slug>/appflare.jsonc and writes index.json.
Each app's version and digest come from dist/<slug>/manifest.json when it was
built from the current pin, otherwise from the GitHub Release <slug>@<version>
for the version the current pin packs to (via gh api), provided its manifest
has the same source.sha; otherwise the app is omitted with a warning.

  --releases-only   ignore dist/; fail if the release lookup fails (publish CI)
  --out <file>      output path (default: index.json)

lastVerified carries over from the previous index while an app's version and
digest stay the same, and is null for a new artifact.
`;

/** Rows of the index being replaced; none if it is missing or unreadable. */
function previousRows(text: string | null): IndexApp[] {
  if (text === null) {
    return [];
  }
  try {
    const apps = (JSON.parse(text) as { apps?: unknown }).apps;
    return Array.isArray(apps) ? (apps as IndexApp[]) : [];
  } catch {
    return [];
  }
}

runMain(async () => {
  const { values } = parseArgs({
    options: {
      "releases-only": { type: "boolean" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const releasesOnly = values["releases-only"] === true;
  const outPath = values.out ? path.resolve(values.out) : indexFile;

  const appflareDir = resolveAppflareDir();
  const schema = await loadAppflareSchema(appflareDir);
  const versions = createVersionResolver(await loadPackerVersioning(appflareDir));
  const manifests = listApps(appsDir).map((app) => loadManifest(app, schema.catalogManifest));
  const repo = catalogRepo();
  const previous = existsSync(outPath) ? readFileSync(outPath, "utf8") : null;

  const apps = buildIndexApps(manifests, {
    repo,
    distDir: releasesOnly ? null : distDir,
    releases: createGhReleaseLookup(repo),
    versions,
    strictReleases: releasesOnly,
    artifactManifest: schema.artifactManifest,
    warn,
    previousApps: previousRows(previous),
  });
  const index = finalizeIndex(apps, previous, new Date(), schema.indexJson);
  writeFileSync(outPath, serializeIndex(index));
  info(`wrote ${outPath}: ${index.apps.length} of ${manifests.length} apps listed`);
  for (const app of index.apps) {
    info(`${app.slug}@${app.version} digest=${app.digest}`);
  }
  return 0;
});
