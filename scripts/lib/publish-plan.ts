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
 * - a complete release built from another commit while the manifest sets
 *   `install.version`: error; the pin moved but `install.version` did not, and
 *   the version must change with the pin;
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
      (installVersion === undefined
        ? "re-pin `source` (a new source.sha, or a new tag in source.ref) to publish the change."
        : "this entry's version comes from install.version, so bump it (and re-pin `source` " +
          "if the app changed) to publish the change."),
  };
}
