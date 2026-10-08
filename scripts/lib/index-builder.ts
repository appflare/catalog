import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  type AppServicesOf,
  type IndexRequiresOf,
  oneWorkerFacts,
  type Parser,
  parseOrThrow,
  type RevisionProblemOf,
  type WorkerFactsOf,
} from "./appflare-schema.ts";
import { indexAuthors } from "./authors.ts";
import {
  IncompleteReleaseError,
  type ReleaseArtifact,
  type ReleaseLookup,
} from "./github-releases.ts";
import {
  type RevisionSignatures,
  revisionOf,
  revisionSignatureLookup,
  rowRevision,
} from "./revision.ts";
import { runsInSandbox, type SandboxDefaults, sandboxBuild } from "./sandbox-entry.ts";
import type {
  AccessOffer,
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
 * `tagline` (and `features` and `alternativeTo` when it lists them, see
 * `pageFacts`), `categories`, `license` (and `licenseNote` when it has one),
 * its `revision`, and the Cloudflare `services` it uses (see `rowFacts`), so a
 * manager can show them without reading a manifest, and `addedAt`, when the
 * entry first appeared in the catalog (`added-at.ts`). Otherwise rows depend
 * on the entry's `install.tier`:
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
 * Where an `artifact` tier app's `version` and `artifacts.digest` come from:
 *
 * 1. A local artifact at `<distDir>/<slug>/manifest.json` (written by
 *    `pack-app`), when present and built from the manifest's current pin
 *    (`app` equals the slug and the embedded catalog manifest's `source.sha`
 *    equals `source.sha` in `appflare.jsonc`). A local artifact for another
 *    pin is ignored with a warning.
 * 2. Otherwise the GitHub Release tagged `<slug>@<version>`, where `<version>` is
 *    what the CURRENT pin packs to (the packer's own `deriveVersion`), provided
 *    it carries the three assets and its `manifest.json` names the same app,
 *    version, and pin. Never "the most recent release": a pin whose
 *    release does not exist yet is not listed with an older artifact.
 * 3. Otherwise the app is omitted, with a warning.
 *
 * `artifacts.digest` is always the sha256 hex of the exact `manifest.json` bytes.
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
  /** What `install.container` defaults to, from `@appflare/schema`. */
  sandboxDefaults: SandboxDefaults;
  /** The entry's images (see `media.ts`); rows get no `media` block without it. */
  mediaFor?: (manifest: CatalogManifest) => IndexMedia | undefined;
  /**
   * When each entry first appeared in the catalog, by slug (see
   * `added-at.ts`). An entry missing from it gets {@link builtAt}.
   */
  addedAt?: ReadonlyMap<string, string>;
  /**
   * When this index is built, in ISO 8601: the `addedAt` of an entry whose
   * first commit is unknown, such as one that is not committed yet.
   */
  builtAt: string;
  /** `appServices` from `@appflare/schema`, which works out each row's `services`. */
  services: AppServicesOf;
  /**
   * `indexRequires` from `@appflare/schema`: each row's `requires`, the
   * entry's own followed by the manager features it needs.
   */
  indexRequires: IndexRequiresOf;
  /**
   * `combinedWorkerFacts` from `@appflare/schema` (the schema's
   * `appWorkerFacts`): what `services` reads of an artifact, every Worker of
   * an app of several together. Omitted, an artifact of several Workers is
   * refused.
   */
  workerFacts?: WorkerFactsOf;
  /**
   * `revisedArtifactProblem` from `@appflare/schema`, which decides whether an
   * artifact tier row may list its manifest as a revision of its release.
   */
  revisionProblem: RevisionProblemOf;
  /**
   * Signatures `sign-revisions` made in this run, by slug. A revised row
   * otherwise keeps the signature of its previous row while its bytes are the
   * same, and without either it is refused (see `rowRevision`).
   */
  revisionSignatures?: RevisionSignatures;
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

/** Release-asset URLs for one app version, with the sha256 of its `manifest.json`. */
export function artifactUrls(
  repo: string,
  slug: string,
  version: string,
  digest: string,
): IndexArtifacts {
  const base = `https://github.com/${repo}/releases/download/${slug}@${version}`;
  return {
    zip: `${base}/${slug}-${version}.zip`,
    manifest: `${base}/manifest.json`,
    sig: `${base}/manifest.sig`,
    digest,
  };
}

/** The commit an artifact was built from: its embedded catalog manifest's pin. */
function artifactPin(artifact: ArtifactManifest): string {
  return artifact.catalog.source.sha;
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
      if (local.app === slug && artifactPin(local) === manifest.source.sha) {
        if (local.keyId === "unsigned") {
          options.warn(
            `${slug}: listing the local UNSIGNED artifact ${local.version} from ${localPath}; ` +
              "the manager rejects unsigned artifacts and its release may not exist yet",
          );
        }
        return { version: local.version, digest: sha256Hex(bytes), from: "local", manifest: local };
      }
      options.warn(
        `${slug}: ignoring ${localPath}: built from ${local.app}@${artifactPin(local)}, ` +
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
        artifactPin(published) !== manifest.source.sha
      ) {
        options.warn(
          `${slug}: omitted: ${label} describes ${published.app}@${published.version} from ` +
            `${artifactPin(published)}, not the current pin ${manifest.source.sha}`,
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
 * about: the artifact manifest's (`artifacts.digest`), or for a `sandbox` or
 * `self-deploying` tier row the published catalog manifest's
 * `build.manifestDigest`. Null for neither.
 */
export function verifiedDigest(row: Pick<IndexApp, "artifacts" | "build">): string | null {
  return row.artifacts?.digest ?? row.build?.manifestDigest ?? null;
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

/**
 * One index row from a catalog manifest and its resolved artifact. The row
 * carries the manifest's `revision`, and lists it as the revised catalog
 * manifest of the release when its revision is above the release's (see
 * `revision.ts`); throws when that revision changes what only a new build can.
 * The digest, and so `lastVerified`, stay the release's: a revision does not
 * change the Worker the install check ran.
 */
export function toIndexApp(
  manifest: CatalogManifest,
  artifact: ResolvedArtifact,
  options: Pick<
    IndexBuildOptions,
    | "repo"
    | "services"
    | "indexRequires"
    | "workerFacts"
    | "mediaFor"
    | "addedAt"
    | "builtAt"
    | "revisionProblem"
    | "revisionSignatures"
    | "previousApps"
  >,
  lastVerified: string | null = null,
): IndexApp {
  const revision = rowRevision(
    manifest,
    artifact.manifest,
    options.repo,
    options.revisionProblem,
    revisionSignatureLookup(options.revisionSignatures ?? {}, options.previousApps ?? []),
  );
  const requires = options.indexRequires(manifest);
  return {
    slug: manifest.slug,
    repo: manifest.upstreamRepo ?? manifest.repo,
    name: manifest.name,
    summary: manifest.summary,
    tagline: manifest.tagline,
    ...pageFacts(manifest),
    ...addedAtOf(manifest, options),
    version: artifact.version,
    artifacts: artifactUrls(options.repo, manifest.slug, artifact.version, artifact.digest),
    tier: manifest.install.tier,
    plan: manifest.plan,
    requires,
    lastVerified,
    authors: indexAuthors(manifest),
    maintainers: [...manifest.maintainers],
    ...mediaBlock(manifest, options),
    ...rowFacts(manifest, artifact.manifest, requires, options.services, options.workerFacts),
    ...revision,
    ...accessOfferBlock(manifest),
  };
}

/**
 * The index row's `accessOffer` for a catalog manifest (the current one, which
 * is the revised one when the entry has a revision): its `access.mode`, or
 * `"offered"` without one; undefined for a self-deploying entry, which cannot
 * be protected. The same rule as `indexAccessOffer()` in `@appflare/schema`;
 * a test checks the two agree whenever a built appflare checkout is available.
 */
export function indexAccessOffer(
  manifest: Pick<CatalogManifest, "access"> & { install: Pick<CatalogManifest["install"], "tier"> },
): AccessOffer | undefined {
  return manifest.install.tier === "self-deploying"
    ? undefined
    : (manifest.access?.mode ?? "offered");
}

function accessOfferBlock(manifest: CatalogManifest): { accessOffer?: AccessOffer } {
  const offer = indexAccessOffer(manifest);
  return offer === undefined ? {} : { accessOffer: offer };
}

/**
 * A row's `services`, `keyValueDurableObjects` (only when true),
 * `categories`, `license`, and `licenseNote` when the current catalog
 * manifest has one. `licenseNote`, like the row's `tagline` and `authors`, is
 * index-only (`INDEX_ONLY_CATALOG_FIELDS` in `@appflare/schema`): an edit to
 * it publishes with the next index and no release. For an artifact tier entry the services come from the
 * published artifact manifest: its Workers (bindings, queue consumers, crons,
 * Durable Object migrations of every Worker of the app together, from
 * `workerFacts`) and the catalog manifest packed into it
 * (`requires`, `install.emailRouting`, token permissions), with the row's
 * `requires` (`indexRequires` of the current manifest) added. A `sandbox` or
 * `self-deploying` entry has no Worker until it runs, so its services are
 * what its catalog manifest declares. The manager falls back to the same
 * `appServices` call on the same inputs, so both agree.
 */
export function rowFacts(
  manifest: CatalogManifest,
  artifact: ArtifactManifest | null,
  requires: readonly string[],
  services: AppServicesOf,
  workerFacts: WorkerFactsOf = oneWorkerFacts,
): Pick<
  IndexApp,
  "services" | "keyValueDurableObjects" | "categories" | "license" | "licenseNote"
> {
  const catalog = artifact === null ? manifest : artifact.catalog;
  const found = services(
    { ...catalog, requires: [...new Set([...requires, ...catalog.requires])] },
    artifact === null ? null : workerFacts(artifact),
  );
  return {
    services: [...found.ids],
    ...(found.keyValueDurableObjects ? { keyValueDurableObjects: true as const } : {}),
    categories: [...manifest.categories],
    license: manifest.license,
    ...(manifest.licenseNote === undefined ? {} : { licenseNote: manifest.licenseNote }),
  };
}

/**
 * A row's `features` and `alternativeTo`, each only when the current catalog
 * manifest lists it. Like `tagline`, both are index-only
 * (`INDEX_ONLY_CATALOG_FIELDS` in `@appflare/schema`): the app's page reads
 * them from the row, so an edit publishes with the next index and no release.
 */
export function pageFacts(
  manifest: Pick<CatalogManifest, "features" | "alternativeTo">,
): Pick<IndexApp, "features" | "alternativeTo"> {
  return {
    ...(manifest.features === undefined ? {} : { features: [...manifest.features] }),
    ...(manifest.alternativeTo === undefined ? {} : { alternativeTo: [...manifest.alternativeTo] }),
  };
}

/** A row's `addedAt`: the entry's first commit, else when the index is built. */
function addedAtOf(
  manifest: CatalogManifest,
  options: Pick<IndexBuildOptions, "addedAt" | "builtAt">,
): { addedAt: string } {
  return { addedAt: options.addedAt?.get(manifest.slug) ?? options.builtAt };
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
  const requires = options.indexRequires(manifest);
  return {
    slug: manifest.slug,
    repo: manifest.upstreamRepo ?? manifest.repo,
    name: manifest.name,
    summary: manifest.summary,
    tagline: manifest.tagline,
    ...pageFacts(manifest),
    ...addedAtOf(manifest, options),
    version,
    tier: manifest.install.tier,
    plan: manifest.plan,
    requires,
    lastVerified: lastVerifiedFor(
      manifest.slug,
      { version, digest: build.manifestDigest },
      options.previousApps ?? [],
    ),
    authors: indexAuthors(manifest),
    maintainers: [...manifest.maintainers],
    build,
    ...mediaBlock(manifest, options),
    ...rowFacts(manifest, null, requires, options.services),
    // No release to revise: every edit publishes the current manifest in `build`.
    revision: revisionOf(manifest),
    ...accessOfferBlock(manifest),
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
      let row: IndexApp;
      try {
        row = toIndexApp(manifest, artifact, options, verifiedAt);
      } catch (err) {
        if (options.strictReleases) {
          throw err;
        }
        options.warn(
          `${manifest.slug}: omitted: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      rows.push(row);
    }
  }
  return rows;
}

/** Rows of the index being replaced; none if it is missing or unreadable. */
export function previousRows(text: string | null): IndexApp[] {
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
