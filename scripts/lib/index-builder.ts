import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { type Parser, parseOrThrow } from "./appflare-schema.ts";
import {
  IncompleteReleaseError,
  type ReleaseArtifact,
  type ReleaseLookup,
} from "./github-releases.ts";
import type { ArtifactManifest, CatalogManifest, IndexApp, IndexJson } from "./types.ts";
import type { VersionResolver } from "./versions.ts";

/**
 * Builds the catalog index. Where each app's `version` and `digest`
 * come from:
 *
 * 1. A local artifact at `<distDir>/<slug>/manifest.json` (written by
 *    `pack-app`), when present and built from the manifest's current pin
 *    (`app` equals the slug and `source.sha` equals `source.sha` in
 *    `appflare.jsonc`). A local artifact for another pin is ignored with a warning.
 * 2. Otherwise the GitHub Release tagged `<slug>@<version>`, where `<version>` is
 *    what the CURRENT pin packs to (the packer's own `deriveVersion`), provided
 *    it carries the three assets and its `manifest.json` names the same app,
 *    version, and `source.sha`. Never "the most recent release": a pin whose
 *    release does not exist yet is not listed with an older artifact.
 * 3. Otherwise the app is omitted, with a warning.
 *
 * `digest` is always the sha256 hex of the exact `manifest.json` bytes.
 * Publish CI passes `distDir: null` so every digest is over bytes actually on a
 * release.
 */

export interface IndexBuildOptions {
  /** Catalog repository `owner/name` that hosts the releases. */
  repo: string;
  /** Local artifacts directory, or null to use releases only. */
  distDir: string | null;
  /** Release lookup, or null when none is available (no `gh`). */
  releases: ReleaseLookup | null;
  /** The version each manifest's current pin packs to. */
  versions: VersionResolver;
  /**
   * When true, a failing release lookup or version derivation (gh or git
   * unavailable, network) is fatal; otherwise it warns and the app is omitted.
   */
  strictReleases: boolean;
  artifactManifest: Parser<ArtifactManifest>;
  warn: (message: string) => void;
  /** Rows of the index being replaced, to carry `lastVerified` forward. */
  previousApps?: readonly IndexApp[];
}

/** Where an app's listed version came from. */
export interface ResolvedArtifact {
  version: string;
  digest: string;
  from: "local" | "release";
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Release-asset URLs for one app version. */
export function artifactUrls(repo: string, slug: string, version: string): IndexApp["artifacts"] {
  const base = `https://github.com/${repo}/releases/download/${slug}@${version}`;
  return {
    zip: `${base}/${slug}-${version}.zip`,
    manifest: `${base}/manifest.json`,
    sig: `${base}/manifest.sig`,
  };
}

function parseArtifactManifest(
  bytes: Buffer,
  parser: Parser<ArtifactManifest>,
  label: string,
): ArtifactManifest {
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch (err) {
    throw new Error(`${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseOrThrow(parser, json, label);
}

/** Resolves an app's listed artifact per the rule in this module's header. */
export function resolveArtifact(
  manifest: CatalogManifest,
  options: IndexBuildOptions,
  state: { releasesDisabled: boolean },
): ResolvedArtifact | null {
  const { slug } = manifest;
  if (options.distDir) {
    const localPath = path.join(options.distDir, slug, "manifest.json");
    if (existsSync(localPath)) {
      const bytes = readFileSync(localPath);
      const local = parseArtifactManifest(bytes, options.artifactManifest, localPath);
      if (local.app === slug && local.source.sha === manifest.source.sha) {
        if (local.keyId === "unsigned") {
          options.warn(
            `${slug}: listing the local UNSIGNED artifact ${local.version} from ${localPath}; ` +
              "the manager rejects unsigned artifacts and its release may not exist yet",
          );
        }
        return { version: local.version, digest: sha256Hex(bytes), from: "local" };
      }
      options.warn(
        `${slug}: ignoring ${localPath}: built from ${local.app}@${local.source.sha}, ` +
          `not the current pin ${manifest.source.sha}`,
      );
    }
  }

  if (options.releases && !state.releasesDisabled) {
    let tag: string | null = null;
    let release: ReleaseArtifact | null = null;
    try {
      tag = `${slug}@${options.versions.versionOf(manifest)}`;
      release = options.releases.byTag(tag);
    } catch (err) {
      if (options.strictReleases) {
        throw err;
      }
      if (err instanceof IncompleteReleaseError) {
        options.warn(`${slug}: omitted: ${err.message}`);
        return null;
      }
      state.releasesDisabled = true;
      options.warn(
        `release lookup unavailable, continuing with local artifacts only: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (tag && release) {
      const version = tag.slice(slug.length + 1);
      const label = `release ${tag} manifest.json`;
      const published = parseArtifactManifest(
        release.manifestBytes,
        options.artifactManifest,
        label,
      );
      if (
        published.app !== slug ||
        published.version !== version ||
        published.source.sha !== manifest.source.sha
      ) {
        options.warn(
          `${slug}: omitted: ${label} describes ${published.app}@${published.version} from ` +
            `${published.source.sha}, not the current pin ${manifest.source.sha}`,
        );
        return null;
      }
      return { version, digest: sha256Hex(release.manifestBytes), from: "release" };
    }
    if (tag && !state.releasesDisabled) {
      options.warn(`${slug}: no release ${tag} for the current pin; omitted from index.json`);
      return null;
    }
  }

  options.warn(`${slug}: no local artifact and no release lookup; omitted from index.json`);
  return null;
}

/**
 * `lastVerified` for a rebuilt row: carried over from the previous index row
 * while the artifact (version and digest) is the same, null for a new one.
 * Only the nightly install check sets it (scripts/record-verified.ts).
 */
export function lastVerifiedFor(
  slug: string,
  artifact: { version: string; digest: string },
  previous: readonly IndexApp[],
): string | null {
  const before = previous.find((row) => row.slug === slug);
  return before && before.version === artifact.version && before.digest === artifact.digest
    ? before.lastVerified
    : null;
}

/** One index row from a catalog manifest and its resolved artifact. */
export function toIndexApp(
  manifest: CatalogManifest,
  artifact: ResolvedArtifact,
  repo: string,
  lastVerified: string | null = null,
): IndexApp {
  return {
    slug: manifest.slug,
    name: manifest.name,
    summary: manifest.summary,
    version: artifact.version,
    artifacts: artifactUrls(repo, manifest.slug, artifact.version),
    digest: artifact.digest,
    tier: manifest.install.tier,
    plan: manifest.plan,
    requires: [...manifest.requires],
    lastVerified,
    maintainers: [...manifest.maintainers],
  };
}

/** Index rows for every manifest that has a resolvable artifact, in slug order. */
export function buildIndexApps(
  manifests: readonly CatalogManifest[],
  options: IndexBuildOptions,
): IndexApp[] {
  const state = { releasesDisabled: false };
  const rows: IndexApp[] = [];
  for (const manifest of [...manifests].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const artifact = resolveArtifact(manifest, options, state);
    if (artifact) {
      const verifiedAt = lastVerifiedFor(manifest.slug, artifact, options.previousApps ?? []);
      rows.push(toIndexApp(manifest, artifact, options.repo, verifiedAt));
    }
  }
  return rows;
}

/**
 * Wraps rows into `index.json` and validates it. `generatedAt` is kept from the
 * previous file when the rows are unchanged, so regenerating is idempotent and
 * publish CI only commits real changes.
 */
export function finalizeIndex(
  apps: IndexApp[],
  previousText: string | null,
  now: Date,
  parser: Parser<IndexJson>,
): IndexJson {
  let generatedAt = now.toISOString();
  if (previousText !== null) {
    try {
      const previous = JSON.parse(previousText) as Partial<IndexJson>;
      if (
        typeof previous.generatedAt === "string" &&
        JSON.stringify(previous.apps) === JSON.stringify(apps)
      ) {
        generatedAt = previous.generatedAt;
      }
    } catch {
      // An unreadable previous index is simply replaced.
    }
  }
  return parseOrThrow(parser, { generatedAt, apps }, "generated index.json");
}

/** Serialized form written to disk. */
export function serializeIndex(index: IndexJson): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}
