import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  formatIssues,
  loadAppflareSchema,
  type Parser,
  parseOrThrow,
} from "./lib/appflare-schema.ts";
import { findApp, loadManifest } from "./lib/apps.ts";
import { catalogRepo, info, runMain, warn } from "./lib/cli.ts";
import { publishedFeaturedFor, readFeatured } from "./lib/featured.ts";
import { publishedMediaFor, readAppMedia } from "./lib/media.ts";
import { appsDir, catalogRoot, indexFile, resolveAppflareDir, schemaFile } from "./lib/paths.ts";
import { revisedManifestFor } from "./lib/revision.ts";
import { pagesBaseUrl, publishedManifestFor, publishedManifestPath } from "./lib/sandbox-entry.ts";

const USAGE = `Usage: pnpm -s build-site --out <dir> [--index index.json] [--stats <file> | --live-stats]

Assembles the GitHub Pages site in <dir> (emptied first):
  index.json                  the catalog index, byte for byte
  schema/v1.json              the catalog manifest JSON Schema
  apps/<slug>/manifest.json   the catalog manifest of each row with a build
                              block (sandbox and self-deploying tiers) or a
                              revised catalog manifest (artifact tier rows
                              whose revision is above their release's),
                              written as build-index hashed it; a revised one
                              also gets manifest.json.sig, its signature, which
                              must verify with the keys in @appflare/schema
  apps/<slug>/<image>         each row's icon, cover and screenshots
  featured/<id>.png           each featured item's image
  stats.json                  from --stats or --live-stats, when valid

Fails when a row's build block, revised catalog manifest or images, or a featured item's image, do not
match the current files (rebuild index.json first). Missing or invalid stats
are left out with a warning, so the popularity numbers can never block a
publish. Needs APPFLARE_DIR.

  --stats <file>   the stats.json to publish
  --live-stats     publish the stats.json currently live on the catalog's Pages
                   site; publish and nightly use it so a rebuild never removes
                   the numbers the stats workflow maintains
`;

runMain(async () => {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      index: { type: "string" },
      stats: { type: "string" },
      "live-stats": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || !values.out) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 1;
  }
  const outDir = path.resolve(values.out);
  const indexPath = values.index ? path.resolve(values.index) : indexFile;
  const schema = await loadAppflareSchema(resolveAppflareDir());
  const indexBytes = readFileSync(indexPath);
  const index = parseOrThrow(schema.indexJson, JSON.parse(indexBytes.toString("utf8")), indexPath);
  const repo = catalogRepo();

  const files: { rel: string; bytes: Buffer }[] = [];
  for (const row of index.apps) {
    const app = findApp(appsDir, row.slug);
    if (row.build !== undefined) {
      const manifest = loadManifest(app, schema.catalogManifest);
      files.push({
        rel: publishedManifestPath(row.slug),
        bytes: publishedManifestFor(row, manifest, repo),
      });
    } else if (row.catalogManifest !== undefined) {
      const manifest = loadManifest(app, schema.catalogManifest);
      // Checked against the row and its signature against the embedded keys first.
      const revised = await revisedManifestFor(row, manifest, repo, {
        verifySignature: schema.verifySignature,
        keys: schema.signingKeys,
      });
      files.push(
        { rel: publishedManifestPath(row.slug), bytes: revised.bytes },
        {
          rel: `${publishedManifestPath(row.slug)}.sig`,
          bytes: Buffer.from(`${revised.signature}\n`),
        },
      );
    }
    files.push(...publishedMediaFor(row, readAppMedia(app.dir, row.slug, row.name, repo)));
  }
  files.push(
    ...publishedFeaturedFor(index.featured, readFeatured(catalogRoot, repo, schema.featuredItem)),
  );

  let stats: Buffer | null = null;
  if (values.stats !== undefined) {
    const statsPath = path.resolve(values.stats);
    if (existsSync(statsPath)) {
      stats = checkedStats(readFileSync(statsPath), statsPath, schema.catalogStats);
    } else {
      warn(`${statsPath} does not exist; publishing without stats.json`);
    }
  } else if (values["live-stats"] === true) {
    const url = `${pagesBaseUrl(repo)}stats.json`;
    const live = await fetchLive(url);
    stats = live === null ? null : checkedStats(live, url, schema.catalogStats);
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(path.join(outDir, "schema"), { recursive: true });
  writeFileSync(path.join(outDir, "index.json"), indexBytes);
  copyFileSync(schemaFile, path.join(outDir, "schema", "v1.json"));
  for (const file of files) {
    const target = path.join(outDir, file.rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.bytes);
    info(`wrote ${path.relative(process.cwd(), target)}`);
  }
  if (stats !== null) {
    writeFileSync(path.join(outDir, "stats.json"), stats);
  }
  info(
    `site in ${outDir}: index.json, schema/v1.json, ${files.length} other file(s)${stats === null ? "" : ", stats.json"}`,
  );
  return 0;
});

/** The bytes at `url`, or null (with a warning) when they cannot be fetched. */
async function fetchLive(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) {
      warn(`${url} answered HTTP ${response.status}; publishing without stats.json`);
      return null;
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (err) {
    warn(`could not fetch ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** `bytes` when they are a valid stats.json; otherwise null, with a warning. */
function checkedStats(bytes: Buffer, statsPath: string, parser: Parser<unknown>): Buffer | null {
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    warn(`${statsPath} is not JSON; publishing without stats.json`);
    return null;
  }
  const result = parser.safeParse(json);
  if (!result.success) {
    warn(
      `${statsPath} is not a valid stats.json; publishing without it:\n${formatIssues(result.error.issues)}`,
    );
    return null;
  }
  return bytes;
}
