import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { type AppServicesOf, type Parser, parseOrThrow } from "./appflare-schema.ts";
import { indexAuthors } from "./authors.ts";
import {
  IncompleteReleaseError,
  type ReleaseArtifact,
  type ReleaseLookup,
} from "./github-releases.ts";
import { runsInSandbox, type SandboxDefaults, sandboxBuild } from "./sandbox-entry.ts";
import type {
  ArtifactManifest,
  CatalogManifest,
  FeaturedItem,
  IndexApp,
  IndexArtifacts,
  IndexJson,
  IndexMedia,
} from "./types.ts";
import type { VersionResolver } from "./versions.ts";

/**
 * Builds the catalog index. Every row lists the app's `authors` from the
 * current manifest, or the owner of its repository (`authors.ts`), its
 * `categories`, and the Cloudflare `services` it uses (see `rowFacts`), so a
 * manager can show all three without reading a manifest. Otherwise
 * rows depend on the entry's `install.tier`:
 *
 * - `sandbox` and `self-deploying`: no artifact. The row's `version` is what
 *   the current pin packs to, and its `build` block names the pin and the
 *   entry's catalog manifest as published on GitHub Pages (see
 *   `sandbox-entry.ts`), with the sha256 of those bytes, the build command
 *   when there is one, and the run's size and time with the schema's
 *   defaults filled in. The user's manager builds the pin in its sandbox
 *   Worker (`sandbox`), or runs the app's own installer there
 *   (`self-deploying`).
 * - `artifact`: as below.
 *
 * Where an `artifact` tier app's `version` and `digest` come from:
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
  /** What `install.sandbox` defaults to, from `@appflare/schema`. */
  sandboxDefaults: SandboxDefaults;
  /** The entry's images (see `media.ts`); rows get no `media` block without it. */
  mediaFor?: (manifest: CatalogManifest) => IndexMedia | undefined;
  /** `appServices` from `@appflare/schema`, which works out each row's `services`. */
  services: AppServicesOf;
}

/** Where an app's listed version came from. */
export interface ResolvedArtifact {
  version: string;
  digest: string;
  from: "local" | "release";
  /** The artifact manifest behind `digest`, as the schema parsed it. */
  manifest: ArtifactManifest;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Release-asset URLs for one app version. */
export function artifactUrls(repo: string, slug: string, version: string): IndexArtifacts {
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
        return { version: local.version, digest: sha256Hex(bytes), from: "local", manifest: local };
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
      return {
        version,
        digest: sha256Hex(release.manifestBytes),
        from: "release",
        manifest: published,
      };
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
 * The digest that identifies what a row installs, which `lastVerified` is
 * about: the artifact manifest's `digest`, or for a `sandbox` or
 * `self-deploying` tier row the published catalog manifest's
 * `build.manifestDigest`. Null for neither.
 */
export function verifiedDigest(row: Pick<IndexApp, "digest" | "build">): string | null {
  return row.digest ?? row.build?.manifestDigest ?? null;
}

/**
 * `lastVerified` for a rebuilt row: carried over from the previous index row
 * while what it installs (version and {@link verifiedDigest}) is the same,
 * null for a new one. Only a passing install check sets it
 * (scripts/record-verified.ts).
 */
export function lastVerifiedFor(
  slug: string,
  artifact: { version: string; digest: string },
  previous: readonly IndexApp[],
): string | null {
  const before = previous.find((row) => row.slug === slug);
  return before && before.version === artifact.version && verifiedDigest(before) === artifact.digest
    ? before.lastVerified
    : null;
}

/** One index row from a catalog manifest and its resolved artifact. */
export function toIndexApp(
  manifest: CatalogManifest,
  artifact: ResolvedArtifact,
  options: Pick<IndexBuildOptions, "repo" | "services" | "mediaFor">,
  lastVerified: string | null = null,
): IndexApp {
  return {
    slug: manifest.slug,
    name: manifest.name,
    summary: manifest.summary,
    version: artifact.version,
    artifacts: artifactUrls(options.repo, manifest.slug, artifact.version),
    digest: artifact.digest,
    tier: manifest.install.tier,
    plan: manifest.plan,
    requires: [...manifest.requires],
    lastVerified,
    authors: indexAuthors(manifest),
    maintainers: [...manifest.maintainers],
    ...mediaBlock(manifest, options),
    ...rowFacts(manifest, artifact.manifest, options.services),
  };
}

/**
 * A row's `services`, `keyValueDurableObjects` (only when true) and
 * `categories`. For an artifact tier entry the services come from the
 * published artifact manifest: its Worker (bindings, queue consumers, crons,
 * Durable Object migrations) and the catalog manifest packed into it
 * (`requires`, `install.emailRouting`, token permissions), with the current
 * manifest's `requires` added as the row lists them. A `sandbox` or
 * `self-deploying` entry has no Worker until it runs, so its services are
 * what its catalog manifest declares. The manager falls back to the same
 * `appServices` call on the same inputs, so both agree.
 */
export function rowFacts(
  manifest: CatalogManifest,
  artifact: ArtifactManifest | null,
  services: AppServicesOf,
): Pick<IndexApp, "services" | "keyValueDurableObjects" | "categories"> {
  // Parsed by the real artifact manifest schema, so a full catalog manifest.
  const catalog = artifact === null ? manifest : (artifact.catalog as CatalogManifest);
  const found = services(
    { ...catalog, requires: [...new Set([...manifest.requires, ...catalog.requires])] },
    artifact?.worker ?? null,
  );
  return {
    services: [...found.ids],
    ...(found.keyValueDurableObjects ? { keyValueDurableObjects: true as const } : {}),
    categories: [...manifest.categories],
  };
}

/**
 * The index row of an entry that runs in the sandbox Worker (`sandbox` or
 * `self-deploying` tier), or null (with a warning) when the version its pin
 * packs to cannot be worked out and `strictReleases` is off.
 */
export function toSandboxIndexApp(
  manifest: CatalogManifest,
  options: IndexBuildOptions,
): IndexApp | null {
  let version: string;
  try {
    version = options.versions.versionOf(manifest);
  } catch (err) {
    if (options.strictReleases) {
      throw err;
    }
    options.warn(
      `${manifest.slug}: omitted: could not work out the version of the current pin: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
  const build = sandboxBuild(manifest, options.repo, options.sandboxDefaults);
  return {
    slug: manifest.slug,
    name: manifest.name,
    summary: manifest.summary,
    version,
    tier: manifest.install.tier,
    plan: manifest.plan,
    requires: [...manifest.requires],
    lastVerified: lastVerifiedFor(
      manifest.slug,
      { version, digest: build.manifestDigest },
      options.previousApps ?? [],
    ),
    authors: indexAuthors(manifest),
    maintainers: [...manifest.maintainers],
    build,
    ...mediaBlock(manifest, options),
    ...rowFacts(manifest, null, options.services),
  };
}

function mediaBlock(
  manifest: CatalogManifest,
  options: Pick<IndexBuildOptions, "mediaFor">,
): { media?: IndexMedia } {
  const media = options.mediaFor?.(manifest);
  return media === undefined ? {} : { media };
}

/** Index rows for every listable manifest, in slug order (see this module's header). */
export function buildIndexApps(
  manifests: readonly CatalogManifest[],
  options: IndexBuildOptions,
): IndexApp[] {
  const state = { releasesDisabled: false };
  const rows: IndexApp[] = [];
  for (const manifest of [...manifests].sort((a, b) => a.slug.localeCompare(b.slug))) {
    if (runsInSandbox(manifest.install.tier)) {
      const row = toSandboxIndexApp(manifest, options);
      if (row) {
        rows.push(row);
      }
      continue;
    }
    const artifact = resolveArtifact(manifest, options, state);
    if (artifact) {
      const verifiedAt = lastVerifiedFor(manifest.slug, artifact, options.previousApps ?? []);
      rows.push(toIndexApp(manifest, artifact, options, verifiedAt));
    }
  }
  return rows;
}

/** What `index.json` carries besides its rows. */
export interface IndexExtras {
  /** The sponsored slot, from `featured.json`; written even when empty. */
  featured: FeaturedItem[];
  /** URL of `stats.json` on the Pages site. */
  stats?: string;
}

/**
 * Wraps rows into `index.json` and validates it. `generatedAt` is kept from the
 * previous file when the rows, featured items and stats URL are unchanged, so
 * regenerating is idempotent and publish CI only commits real changes.
 */
export function finalizeIndex(
  apps: IndexApp[],
  previousText: string | null,
  now: Date,
  parser: Parser<IndexJson>,
  extras: IndexExtras = { featured: [] },
): IndexJson {
  const body = {
    apps,
    featured: extras.featured,
    ...(extras.stats === undefined ? {} : { stats: extras.stats }),
  };
  let generatedAt = now.toISOString();
  if (previousText !== null) {
    try {
      const { generatedAt: before, ...rest } = JSON.parse(previousText) as Partial<IndexJson>;
      if (typeof before === "string" && JSON.stringify(rest) === JSON.stringify(body)) {
        generatedAt = before;
      }
    } catch {
      // An unreadable previous index is simply replaced.
    }
  }
  return parseOrThrow(parser, { generatedAt, ...body }, "generated index.json");
}

/** The URL `stats.json` is published at, next to `index.json`. */
export function statsUrl(pagesBase: string): string {
  return `${pagesBase}stats.json`;
}

/** Serialized form written to disk. */
export function serializeIndex(index: IndexJson): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}
