import { type Parser, parseOrThrow } from "./appflare-schema.ts";
import { changedFields } from "./canonical.ts";
import type { ReleaseLookup } from "./github-releases.ts";
import { type PlannedArtifact, plannedArtifact } from "./manifest-plan.ts";
import type { ArtifactManifest, CatalogManifest } from "./types.ts";
import type { VersionResolver } from "./versions.ts";

/**
 * Which apps publish CI packs. For every catalog manifest, the version its
 * current pin packs to gives the tag `<slug>@<version>`:
 *
 * - no release (and no draft) with that tag: publish, with the plan entry the
 *   `sign` and `release` jobs hold the artifact to;
 * - a complete release whose embedded catalog manifest equals the current one:
 *   up to date, skip;
 * - a complete release with a different catalog manifest (a metadata-only edit
 *   under the same pin): error; the author must re-pin `source`;
 * - a draft, prerelease, or incomplete release: the lookup throws, naming it.
 *
 * Decided from the manifests and the releases alone, so re-running is
 * idempotent and a cancelled or skipped run loses nothing.
 */

export type PlanDecision =
  | { slug: string; tag: string; action: "publish"; planned: PlannedArtifact }
  | { slug: string; tag: string; action: "skip" }
  | { slug: string; tag: string; action: "error"; message: string };

/** Decides what publish does for one (schema-parsed) catalog manifest. */
export function decide(
  manifest: CatalogManifest,
  versions: VersionResolver,
  releases: ReleaseLookup,
  artifactManifest: Parser<ArtifactManifest>,
  keyId: string,
): PlanDecision {
  const slug = manifest.slug;
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
  const changed = changedFields(published.catalog, manifest);
  if (changed.length === 0) {
    return { slug, tag, action: "skip" };
  }
  return {
    slug,
    tag,
    action: "error",
    message:
      `apps/${slug}/appflare.jsonc changed (${changed.join(", ")}) but its pin still packs to ` +
      `${tag}, which is already released with the old manifest. Releases are immutable: ` +
      "re-pin `source` (a new source.sha, or a new tag in source.ref) to publish the change.",
  };
}
