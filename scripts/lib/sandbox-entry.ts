import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.ts";
import type { CatalogManifest, IndexBuild, SandboxInstanceType } from "./types.ts";

/**
 * What the catalog publishes for a `sandbox` tier entry. Catalog CI builds no
 * artifact for it; the user's manager asks its sandbox Worker to build the
 * pinned commit instead. For that the manager needs the entry's catalog
 * manifest, which the catalog publishes on GitHub Pages next to `index.json`
 * at `apps/<slug>/manifest.json`. The index row's `build` block points at it
 * and carries the sha256 of its exact bytes, which the manager checks before
 * it trusts the file.
 */

/** Defaults `@appflare/schema` fills in when `install.sandbox` omits a field. */
export interface SandboxDefaults {
  expectedMinutes: number;
  instanceType: SandboxInstanceType;
}

/** The GitHub Pages root of catalog repository `owner/name`, with a trailing slash. */
export function pagesBaseUrl(repo: string): string {
  const [owner = "", name = ""] = repo.split("/");
  const host = `${owner.toLowerCase()}.github.io`;
  // A repository named <owner>.github.io is served at the root of that host.
  return name.toLowerCase() === host ? `https://${host}/` : `https://${host}/${name}/`;
}

/** Where the entry's catalog manifest sits in the Pages site. */
export function publishedManifestPath(slug: string): string {
  return `apps/${slug}/manifest.json`;
}

/** The absolute URL of the entry's published catalog manifest. */
export function publishedManifestUrl(repo: string, slug: string): string {
  return `${pagesBaseUrl(repo)}${publishedManifestPath(slug)}`;
}

/**
 * The bytes published for a catalog manifest: the schema-parsed manifest
 * (defaults filled in, unknown keys dropped) as JSON with keys sorted at
 * every level, two-space indented, with a final newline. The same manifest
 * always gives the same bytes, so the digest in `index.json` can be computed
 * before the site is assembled and checked again when it is.
 */
export function publishedManifestBytes(manifest: CatalogManifest): Buffer {
  return Buffer.from(`${JSON.stringify(canonicalize(manifest), null, 2)}\n`);
}

/** The `build` block of a sandbox tier entry's index row. */
export function sandboxBuild(
  manifest: CatalogManifest,
  repo: string,
  defaults: SandboxDefaults,
): IndexBuild {
  const bytes = publishedManifestBytes(manifest);
  const { buildCommand, sandbox } = manifest.install;
  return {
    pin: manifest.source.sha,
    manifest: publishedManifestUrl(repo, manifest.slug),
    manifestDigest: createHash("sha256").update(bytes).digest("hex"),
    ...(buildCommand === undefined ? {} : { buildCommand }),
    expectedMinutes: sandbox?.expectedMinutes ?? defaults.expectedMinutes,
    instanceType: sandbox?.instanceType ?? defaults.instanceType,
  };
}

/**
 * The bytes to publish at a sandbox row's `build.manifest`, from the entry's
 * current catalog manifest. Throws when they are not what the row promises
 * (another URL, pin, or digest): `index.json` was built from another version
 * of `appflare.jsonc`, and publishing would make every install of the entry
 * fail the manager's digest check. Rebuild the index first.
 */
export function publishedManifestFor(
  row: { slug: string; build?: IndexBuild },
  manifest: CatalogManifest,
  repo: string,
): Buffer {
  const { build } = row;
  if (build === undefined) {
    throw new Error(`${row.slug}: the index row has no build block`);
  }
  const url = publishedManifestUrl(repo, row.slug);
  if (build.manifest !== url) {
    throw new Error(`${row.slug}: index.json points at ${build.manifest}, the site serves ${url}`);
  }
  if (build.pin !== manifest.source.sha) {
    throw new Error(
      `${row.slug}: index.json pins ${build.pin}, apps/${row.slug}/appflare.jsonc ${manifest.source.sha}; rebuild index.json`,
    );
  }
  const bytes = publishedManifestBytes(manifest);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== build.manifestDigest) {
    throw new Error(
      `${row.slug}: apps/${row.slug}/appflare.jsonc publishes as sha256 ${digest}, but index.json ` +
        `lists ${build.manifestDigest}; rebuild index.json from the same manifests`,
    );
  }
  return bytes;
}
