import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { type Parser, parseOrThrow } from "./appflare-schema.ts";
import { parseJsonc } from "./jsonc.ts";
import type { CatalogManifest } from "./types.ts";

/** The `$schema` every catalog manifest points at. */
export const MANIFEST_SCHEMA_URL = "https://appflare.github.io/catalog/schema/v1.json";

/** An app folder in the catalog: `apps/<slug>/appflare.jsonc`. */
export interface AppEntry {
  slug: string;
  dir: string;
  manifestPath: string;
}

/** Every `apps/<slug>/` that contains an `appflare.jsonc`, sorted by slug. */
export function listApps(appsDir: string): AppEntry[] {
  if (!existsSync(appsDir)) {
    return [];
  }
  return readdirSync(appsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(appsDir, d.name);
      return { slug: d.name, dir, manifestPath: path.join(dir, "appflare.jsonc") };
    })
    .filter((app) => existsSync(app.manifestPath))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Looks up one app by slug, with a clear error when it does not exist. */
export function findApp(appsDir: string, slug: string): AppEntry {
  const app = listApps(appsDir).find((a) => a.slug === slug);
  if (!app) {
    throw new Error(`no app "${slug}": expected ${path.join(appsDir, slug, "appflare.jsonc")}`);
  }
  return app;
}

/** Reads `appflare.jsonc` as JSONC, naming the file in any parse error. */
export function readManifestFile(manifestPath: string): unknown {
  try {
    return parseJsonc(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new Error(`${manifestPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Validates an app's manifest with the catalog manifest schema plus the catalog's
 * own layout rules: the slug matches the folder, `$schema` (when present) is the
 * published v1 URL, and at least one maintainer is listed (CODEOWNERS needs one).
 */
export function loadManifest(app: AppEntry, parser: Parser<CatalogManifest>): CatalogManifest {
  const label = path.relative(path.dirname(path.dirname(app.dir)), app.manifestPath);
  const manifest = parseOrThrow(parser, readManifestFile(app.manifestPath), label);
  const problems: string[] = [];
  if (manifest.slug !== app.slug) {
    problems.push(`- slug: "${manifest.slug}" must match its folder name "${app.slug}"`);
  }
  if (manifest.$schema !== undefined && manifest.$schema !== MANIFEST_SCHEMA_URL) {
    problems.push(`- $schema: must be ${MANIFEST_SCHEMA_URL}`);
  }
  if (manifest.maintainers.length === 0) {
    problems.push("- maintainers: list at least one GitHub user");
  }
  if (problems.length > 0) {
    throw new Error(`${label} is invalid:\n${problems.join("\n")}`);
  }
  return manifest;
}
