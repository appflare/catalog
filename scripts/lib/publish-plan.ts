import { type Parser, parseOrThrow, type RevisionProblemOf } from "./appflare-schema.ts";
import { changedFields } from "./canonical.ts";
import type { ReleaseLookup } from "./github-releases.ts";
import { sha256Hex } from "./index-builder.ts";
import { type PlannedArtifact, plannedArtifact } from "./manifest-plan.ts";
import {
  type PlannedRevision,
  releasedCatalog,
  revisedManifestDigest,
  revisionOf,
} from "./revision.ts";
import type { ArtifactManifest, CatalogManifest, IndexApp, InstallTier } from "./types.ts";
import type { VersionResolver } from "./versions.ts";

/**
 * Which apps publish CI packs. Only `artifact` tier entries get a release:
 * a `sandbox` tier entry is built in the user's account from its pin, and a
 * `self-deploying` one's own installer runs in the user's account, so neither is packed, signed, or
 * released (`not-released`). For every artifact tier manifest, the version
 * its current pin packs to gives the tag `<slug>@<version>`:
 *
 * - no release (and no draft) with that tag: publish, with the plan entry the
 *   `sign` and `release` jobs hold the artifact to;
 * - a complete release whose embedded catalog manifest equals the current one:
 *   up to date, skip;
 * - a complete release built from another commit while the manifest sets
 *   `install.version`: error; the pin moved but `install.version` did not, and
 *   the version must change with the pin;
 * - a complete release with a different catalog manifest (a metadata-only edit
 *   under the same pin) and a `revision` above the release's: a revision
 *   (see `revision.ts`). Nothing is packed; `sign-revisions` signs the revised
 *   manifest, `build-index` lists it and the Pages site serves it. `revise`
 *   (with the bytes to sign) when the index does not publish that revision
 *   yet, `skip` when it publishes exactly these bytes, error when the revision
 *   changes what only a new build can change, goes down, or when its bytes
 *   changed since it was published (any change, `authors` included, needs the
 *   next revision: a signed revision never changes);
 * - a complete release with a different catalog manifest and no revision
 *   above the release's: error; the author must re-pin `source`, or raise
 *   `revision` when only the form and copy changed. Fields in
 *   {@link INDEX_ONLY_FIELDS} do not count: the index reads them from the
 *   current manifest, so they need no new release;
 * - a draft, prerelease, or incomplete release: the lookup throws, naming it.
 *
 * Decided from the manifests, the releases and the index being replaced
 * alone, so re-running is idempotent and a cancelled or skipped run loses
 * nothing.
 */

/**
 * Catalog manifest fields that change only what the index shows, never what an
 * artifact installs. The index is built from the current manifest, so an edit
 * to these alone is published by regenerating `index.json` and needs no new
 * release; releases packed after the edit carry the new value anyway.
 */
export const INDEX_ONLY_FIELDS: readonly string[] = ["authors"];

export type PlanDecision =
  | { slug: string; action: "not-released"; tier: InstallTier }
  | { slug: string; tag: string; action: "publish"; planned: PlannedArtifact }
  | { slug: string; tag: string; action: "revise"; planned: PlannedRevision }
  | { slug: string; tag: string; action: "skip"; revision?: number }
  | { slug: string; tag: string; action: "error"; message: string };

/** What decides a revision besides the release: the index being replaced. */
export interface RevisionContext {
  /** The entry's row in the index being replaced, if it has one. */
  previous: IndexApp | undefined;
  /** `revisedArtifactProblem` from `@appflare/schema`. */
  revisionProblem: RevisionProblemOf;
}

/** Decides what publish does for one (schema-parsed) catalog manifest. */
export async function decide(
  manifest: CatalogManifest,
  versions: VersionResolver,
  releases: ReleaseLookup,
  artifactManifest: Parser<ArtifactManifest>,
  keyId: string,
  revisions: RevisionContext,
): Promise<PlanDecision> {
  const slug = manifest.slug;
  if (manifest.install.tier !== "artifact") {
    return { slug, action: "not-released", tier: manifest.install.tier };
  }
  const version = versions.versionOf(manifest);
  const tag = `${slug}@${version}`;
  const release = releases.byTag(tag);
  if (!release) {
    return { slug, tag, action: "publish", planned: plannedArtifact(manifest, version, keyId) };
  }
  const label = `release ${tag} manifest.json`;
  const published = parseOrThrow(
    artifactManifest,
    JSON.parse(release.manifestBytes.toString("utf8")),
    label,
  );
  const installVersion = manifest.install.version;
  if (installVersion !== undefined && published.source.sha !== manifest.source.sha) {
    return {
      slug,
      tag,
      action: "error",
      message:
        `apps/${slug}/appflare.jsonc pins ${manifest.source.ref}@${manifest.source.sha.slice(0, 7)}, ` +
        `but install.version is still ${installVersion}, and ${tag} is already released from ` +
        `${published.source.ref}@${published.source.sha.slice(0, 7)}. Releases are immutable: ` +
        "bump install.version to the app's version at the new pin.",
    };
  }
  const released = releasedCatalog(published);
  const baseRevision = revisionOf(released);
  const revision = revisionOf(manifest);
  // The revision index.json publishes for this release now.
  const { previous } = revisions;
  const listed = Math.max(
    baseRevision,
    previous !== undefined &&
      previous.version === version &&
      previous.digest === sha256Hex(release.manifestBytes)
      ? revisionOf(previous)
      : baseRevision,
  );
  if (revision < listed) {
    return {
      slug,
      tag,
      action: "error",
      message:
        `apps/${slug}/appflare.jsonc is revision ${revision}, but ${tag} is already published at ` +
        `revision ${listed}. Revisions only go up: keep revision ${listed}, or set it to ` +
        `${listed + 1} to publish a change.`,
    };
  }
  if (revision > baseRevision) {
    return decideRevision(manifest, published, tag, listed, revisions);
  }
  const changed = changedFields(released, manifest).filter(
    (field) => !INDEX_ONLY_FIELDS.includes(field),
  );
  if (changed.length === 0) {
    return { slug, tag, action: "skip" };
  }
  const next = baseRevision + 1;
  const revisionBlocker = revisions.revisionProblem(published, { ...manifest, revision: next });
  return {
    slug,
    tag,
    action: "error",
    message:
      `apps/${slug}/appflare.jsonc changed (${changed.join(", ")}) but its pin still packs to ` +
      `${tag}, which is already released with the old manifest. Releases are immutable: ` +
      (installVersion === undefined
        ? "re-pin `source` (a new source.sha, or a new tag in source.ref) to publish the change"
        : "this entry's version comes from install.version, so bump it (and re-pin `source` " +
          "if the app changed) to publish the change") +
      (revisionBlocker === null
        ? `, or bump revision to ${next}: only the form and copy changed, so no new build is needed.`
        : `. Bumping revision cannot publish it: ${revisionBlocker}.`),
  };
}

/**
 * A manifest whose `revision` is above the one `published` was built with,
 * and not below `listed`, the one the index publishes now: whether that
 * revision is new, already published, or not allowed.
 */
function decideRevision(
  manifest: CatalogManifest,
  published: ArtifactManifest,
  tag: string,
  listed: number,
  revisions: RevisionContext,
): PlanDecision {
  const slug = manifest.slug;
  const revision = revisionOf(manifest);
  const error = (message: string): PlanDecision => ({ slug, tag, action: "error", message });
  const problem = revisions.revisionProblem(published, manifest);
  if (problem !== null) {
    return error(
      `apps/${slug}/appflare.jsonc raises revision to ${revision}, but ${problem}. ` +
        "Re-pin `source` (a new source.sha, or a new tag in source.ref) to publish a new build.",
    );
  }
  const { previous } = revisions;
  const sha256 = revisedManifestDigest(manifest);
  if (revision > listed || previous?.catalogManifest === undefined) {
    return {
      slug,
      tag,
      action: "revise",
      planned: { version: published.version, revision, sha256, keyId: published.keyId },
    };
  }
  if (previous.catalogManifest.sha256 === sha256) {
    return { slug, tag, action: "skip", revision };
  }
  // A published revision is signed as it is; managers refuse other bytes
  // under the same revision, so any change needs the next one.
  return error(
    `apps/${slug}/appflare.jsonc changed since revision ${revision} of ${tag} was published ` +
      `(sha256 ${previous.catalogManifest.sha256}, now ${sha256}). A published revision never ` +
      `changes: set revision to ${revision + 1} to publish the change.`,
  );
}
