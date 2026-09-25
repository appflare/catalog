import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadAppflareSchema } from "./lib/appflare-schema.ts";
import { listApps, loadManifest } from "./lib/apps.ts";
import { catalogRepo, info, runMain, warn } from "./lib/cli.ts";
import { readFeatured } from "./lib/featured.ts";
import { createGhReleaseLookup } from "./lib/github-releases.ts";
import {
  buildIndexApps,
  finalizeIndex,
  previousRows,
  serializeIndex,
  statsUrl,
} from "./lib/index-builder.ts";
import { mediaReader } from "./lib/media.ts";
import { appsDir, catalogRoot, distDir, indexFile, resolveAppflareDir } from "./lib/paths.ts";
import { parseRevisionSignatures } from "./lib/revision.ts";
import { pagesBaseUrl } from "./lib/sandbox-entry.ts";
import { createVersionResolver, loadPackerVersioning } from "./lib/versions.ts";

const USAGE = `Usage: pnpm build-index [--releases-only] [--out <file>]

Validates every apps/<slug>/appflare.jsonc and writes index.json.
A sandbox or self-deploying tier entry is listed with a build block instead of
an artifact: its pin, the URL and sha256 of its catalog manifest as build-site
publishes it, and the size and time of a run in the sandbox Worker.
Each artifact tier app's version and digest come from dist/<slug>/manifest.json when it was
built from the current pin, otherwise from the GitHub Release <slug>@<version>
for the version the current pin packs to (via gh api), provided its manifest
has the same source.sha; otherwise the app is omitted with a warning.

  --releases-only   ignore dist/; fail if the release lookup fails (publish CI)
  --out <file>      output path (default: index.json)
  --revision-signatures <file>
                    signatures of revised catalog manifests (sign-revisions --out)

Every row carries the manifest's revision. When an artifact tier app's revision
is above the one its release was built with, the row also lists the revised
catalog manifest (its URL on the Pages site, sha256, key id and signature), which
build-site publishes at apps/<slug>/manifest.json. The signature comes from
--revision-signatures, or from the previous index while the bytes are the same.
A revision that changes anything but the form and copy, or that no signature
covers, is refused (fatal with --releases-only, else the app is omitted).

lastVerified carries over from the previous index while an app's version and
digest (manifestDigest for a sandbox or self-deploying entry) stay the same, and is null for a
new one.

Every row lists the app's categories and the Cloudflare services it uses:
worked out from the published artifact manifest (its Worker's bindings, queue
consumers, crons and Durable Object migrations, plus the catalog manifest packed
into it) for an artifact tier entry, from the catalog manifest's declarations
for a sandbox or self-deploying one.

A row with images lists them (apps/<slug>/icon.svg|icon.png, cover.png,
screenshots/*.png, each optional) by their Pages URL and sha256. The index carries
the sponsored items of featured.json (always written, even when empty) and the
URL of stats.json, which the stats workflow publishes next to it.
`;

runMain(async () => {
  const { values } = parseArgs({
    options: {
      "releases-only": { type: "boolean" },
      out: { type: "string" },
      "revision-signatures": { type: "string" },
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
    sandboxDefaults: schema.sandboxDefaults,
    mediaFor: mediaReader(appsDir, repo),
    services: schema.appServices,
    revisionProblem: schema.revisionProblem,
    ...(values["revision-signatures"] === undefined
      ? {}
      : {
          revisionSignatures: parseRevisionSignatures(
            JSON.parse(readFileSync(path.resolve(values["revision-signatures"]), "utf8")),
          ),
        }),
  });
  const index = finalizeIndex(apps, previous, new Date(), schema.indexJson, {
    featured: readFeatured(catalogRoot, repo, schema.featuredItem).items,
    stats: statsUrl(pagesBaseUrl(repo)),
  });
  writeFileSync(outPath, serializeIndex(index));
  info(`wrote ${outPath}: ${index.apps.length} of ${manifests.length} apps listed`);
  for (const app of index.apps) {
    const where =
      app.build === undefined
        ? `${app.slug}@${app.version} digest=${app.digest}${
            app.catalogManifest === undefined
              ? ""
              : ` revision ${app.revision}: revised catalog manifest sha256=${app.catalogManifest.sha256}`
          }`
        : `${app.slug}@${app.version} ${app.tier}: runs in the user's sandbox Worker at ${app.build.pin.slice(0, 12)}, manifestDigest=${app.build.manifestDigest}`;
    info(`${where} services=${app.services.join(",") || "(none)"}`);
  }
  return 0;
});
