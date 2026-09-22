import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the catalog repository root. */
export const catalogRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Directory holding one folder per app (`apps/<slug>/appflare.jsonc`). */
export const appsDir = path.join(catalogRoot, "apps");

/** Where `pack-app` writes artifacts by convention (`dist/<slug>/`). */
export const distDir = path.join(catalogRoot, "dist");

/** Committed copy of the catalog manifest JSON Schema. */
export const schemaFile = path.join(catalogRoot, "schema", "v1.json");

/** Generated catalog index, committed and published to GitHub Pages. */
export const indexFile = path.join(catalogRoot, "index.json");

/** Generated CODEOWNERS file. */
export const codeownersFile = path.join(catalogRoot, "CODEOWNERS");

/**
 * Directory with built `packages/schema` and `packages/pack`: a checkout of
 * `appflare/appflare` after `pnpm build`, or the packer bundle CI builds from
 * it (see `.github/actions/build-packer`). `APPFLARE_DIR` wins; the default is
 * a sibling checkout, `../appflare`.
 */
export function resolveAppflareDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.APPFLARE_DIR?.trim();
  return fromEnv ? path.resolve(catalogRoot, fromEnv) : path.resolve(catalogRoot, "..", "appflare");
}

/** Paths inside an appflare checkout that the catalog consumes. */
export function appflarePaths(appflareDir: string) {
  return {
    schemaDist: path.join(appflareDir, "packages", "schema", "dist", "index.js"),
    schemaJson: path.join(appflareDir, "packages", "schema", "json-schema", "v1.json"),
    packBin: path.join(appflareDir, "packages", "pack", "bin", "appflare-pack.js"),
    packDist: path.join(appflareDir, "packages", "pack", "dist", "cli.js"),
    packLib: path.join(appflareDir, "packages", "pack", "dist", "index.js"),
  };
}

/** True when the appflare checkout exists and its schema and pack builds are present. */
export function isAppflareBuilt(appflareDir: string): boolean {
  const p = appflarePaths(appflareDir);
  return (
    existsSync(p.schemaDist) &&
    existsSync(p.schemaJson) &&
    existsSync(p.packDist) &&
    existsSync(p.packLib)
  );
}

/** Throws an actionable error unless {@link isAppflareBuilt}. */
export function assertAppflareBuilt(appflareDir: string): void {
  if (!isAppflareBuilt(appflareDir)) {
    throw new Error(
      `no built appflare checkout at ${appflareDir}. Set APPFLARE_DIR to a checkout of ` +
        "appflare/appflare (at the SHA in .appflare-ref) and run `pnpm install && pnpm build` there.",
    );
  }
}
