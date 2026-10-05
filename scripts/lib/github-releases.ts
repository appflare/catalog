import { z } from "zod";
import { GhNotFoundError, type GhRunner, runGh } from "./gh-api.ts";

/** One app version's release, as found on GitHub. */
export interface ReleaseArtifact {
  /** Release tag, `<slug>@<version>`. */
  tag: string;
  /** Exact bytes of the release's `manifest.json` asset. */
  manifestBytes: Buffer;
}

/** Looks up the release for an exact tag. */
export interface ReleaseLookup {
  /**
   * The complete, published release tagged `tag`, or null when no release (and
   * no draft) uses the tag. Throws {@link IncompleteReleaseError} for a draft,
   * a prerelease, or a release missing any of the three assets, and a plain
   * error when the lookup itself fails (including a missing repository).
   */
  byTag(tag: string): ReleaseArtifact | null;
}

/** A release exists for the tag but is not a complete, published artifact release. */
export class IncompleteReleaseError extends Error {}

const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  html_url: z.string(),
  assets: z.array(z.object({ id: z.number(), name: z.string() })),
});
export type GitHubRelease = z.infer<typeof releaseSchema>;
const RELEASE_JQ = "{tag_name, draft, prerelease, html_url, assets: [.assets[] | {id, name}]}";

/** Release asset names for one app version. */
export function releaseAssetNames(slug: string, version: string): string[] {
  return [`${slug}-${version}.zip`, "manifest.json", "manifest.sig"];
}

/** Splits `<slug>@<version>`. */
export function parseTag(tag: string): { slug: string; version: string } {
  const at = tag.indexOf("@");
  if (at <= 0 || at === tag.length - 1) {
    throw new Error(`"${tag}" is not a <slug>@<version> tag`);
  }
  return { slug: tag.slice(0, at), version: tag.slice(at + 1) };
}

/**
 * The id of the release's `manifest.json` asset. Throws
 * {@link IncompleteReleaseError}, naming the release, when it is a draft, a
 * prerelease, or lacks any of the three artifact assets.
 */
export function manifestAssetId(release: GitHubRelease): number {
  const problems: string[] = [];
  if (release.draft) {
    problems.push("is a draft");
  }
  if (release.prerelease) {
    problems.push("is a prerelease");
  }
  const { slug, version } = parseTag(release.tag_name);
  const names = new Set(release.assets.map((a) => a.name));
  const missing = releaseAssetNames(slug, version).filter((n) => !names.has(n));
  if (missing.length > 0) {
    problems.push(`is missing ${missing.join(", ")}`);
  }
  const id = release.assets.find((a) => a.name === "manifest.json")?.id;
  if (problems.length > 0 || id === undefined) {
    throw new IncompleteReleaseError(
      `release ${release.tag_name} (${release.html_url}) ${problems.join(" and ")}; ` +
        "fix or delete it by hand, then re-run",
    );
  }
  return id;
}

/**
 * Release lookup backed by read-only GitHub API calls. The repository's
 * releases (drafts included, which only a token with write access sees) are
 * listed once, 100 per page, and answer every tag they hold; a tag the listing
 * lacks (a release created after it was taken) is asked for by name, and only
 * a 404 for it means "absent", once the repository is confirmed reachable (a
 * 404 for the repository is an error). The release job re-checks drafts with a
 * token that can see them. A failed listing fails every later lookup with the
 * same error rather than listing again, so an outage costs one set of retries.
 */
export function createGhReleaseLookup(repo: string, run: GhRunner = runGh): ReleaseLookup {
  let listing: Map<string, GitHubRelease> | Error | null = null;
  const listed = (): Map<string, GitHubRelease> => {
    if (listing === null) {
      try {
        run({ path: `repos/${repo}`, jq: ".full_name" });
        const lines = run({
          path: `repos/${repo}/releases?per_page=100`,
          paginate: true,
          jq: `.[] | ${RELEASE_JQ} | @json`,
        })
          .toString("utf8")
          .split("\n")
          .filter((l) => l.trim());
        const byTag = new Map<string, GitHubRelease>();
        for (const line of lines) {
          const release = releaseSchema.parse(JSON.parse(line));
          const seen = byTag.get(release.tag_name);
          // A published release wins over a draft that names the same tag.
          if (seen === undefined || (seen.draft && !release.draft)) {
            byTag.set(release.tag_name, release);
          }
        }
        listing = byTag;
      } catch (err) {
        listing =
          err instanceof GhNotFoundError
            ? new Error(`repository ${repo} was not found or the token cannot read it`)
            : new Error(`listing the releases of ${repo}: ${message(err)}`, { cause: err });
      }
    }
    if (listing instanceof Error) {
      throw listing;
    }
    return listing;
  };
  return {
    byTag(tag) {
      let release = listed().get(tag);
      if (release === undefined) {
        try {
          const out = run({
            path: `repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
            jq: RELEASE_JQ,
          });
          release = releaseSchema.parse(JSON.parse(out.toString("utf8")));
        } catch (err) {
          if (err instanceof GhNotFoundError) {
            return null;
          }
          throw new Error(`looking up release ${tag}: ${message(err)}`, { cause: err });
        }
      }
      const assetId = manifestAssetId(release);
      try {
        const manifestBytes = run({
          path: `repos/${repo}/releases/assets/${assetId}`,
          accept: "application/octet-stream",
        });
        return { tag, manifestBytes };
      } catch (err) {
        throw new Error(`downloading manifest.json of release ${tag}: ${message(err)}`, {
          cause: err,
        });
      }
    },
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
