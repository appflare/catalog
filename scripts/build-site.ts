import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadAppflareSchema, parseOrThrow } from "./lib/appflare-schema.ts";
import { findApp, loadManifest } from "./lib/apps.ts";
import { catalogRepo, info, runMain } from "./lib/cli.ts";
import { appsDir, indexFile, resolveAppflareDir, schemaFile } from "./lib/paths.ts";
import { publishedManifestFor, publishedManifestPath } from "./lib/sandbox-entry.ts";

const USAGE = `Usage: pnpm -s build-site --out <dir> [--index index.json]

Assembles the GitHub Pages site in <dir> (emptied first):
  index.json                  the catalog index, byte for byte
  schema/v1.json              the catalog manifest JSON Schema
  apps/<slug>/manifest.json   the catalog manifest of each row with a build
                              block (sandbox and self-deploying tiers),
                              written as build-index hashed it
Fails when such a row's URL, pin, or manifestDigest does not match its
current apps/<slug>/appflare.jsonc. Needs APPFLARE_DIR.
`;

runMain(async () => {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      index: { type: "string" },
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
    if (row.build === undefined) {
      continue;
    }
    const manifest = loadManifest(findApp(appsDir, row.slug), schema.catalogManifest);
    files.push({
      rel: publishedManifestPath(row.slug),
      bytes: publishedManifestFor(row, manifest, repo),
    });
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
  info(
    `site in ${outDir}: index.json, schema/v1.json, ${files.length} published catalog manifest(s)`,
  );
  return 0;
});
