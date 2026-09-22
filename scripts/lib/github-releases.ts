import { execFileSync } from "node:child_process";
import { z } from "zod";

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

/** Thrown by a {@link GhRunner} when gh reports HTTP 404. */
export class GhNotFoundError extends Error {}

/** Runs `gh` and returns stdout. Throws with gh's stderr (which never holds the token). */
export type GhRunner = (args: string[]) => Buffer;

export const runGh: GhRunner = (args) => {
  try {
    return execFileSync("gh", args, {
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
    if (e.code === "ENOENT") {
      throw new Error("the GitHub CLI (gh) is not installed");
    }
    const stderr = e.stderr?.toString("utf8").trim() ?? "";
    if (/HTTP 404/.test(stderr)) {
      throw new GhNotFoundError(`gh ${args.slice(0, 2).join(" ")}: ${stderr}`);
    }
    throw new Error(`gh ${args.slice(0, 2).join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
};

/**
 * Release lookup backed by read-only `gh api` calls. Only a 404 for the tag
 * itself means "absent", and only after the repository is confirmed reachable
 * (a 404 for the repository is an error) and no draft uses the tag. Drafts are
 * visible only to tokens with write access; the release job re-checks with one.
 */
export function createGhReleaseLookup(repo: string, run: GhRunner = runGh): ReleaseLookup {
  let repoChecked = false;
  let drafts: GitHubRelease[] | null = null;
  const assertRepo = () => {
    if (repoChecked) {
      return;
    }
    try {
      run(["api", `repos/${repo}`, "--jq", ".full_name"]);
    } catch (err) {
      if (err instanceof GhNotFoundError) {
        throw new Error(`repository ${repo} was not found or the token cannot read it`);
      }
      throw err;
    }
    repoChecked = true;
  };
  const listDrafts = (): GitHubRelease[] => {
    if (drafts === null) {
      const out = run([
        "api",
        "--paginate",
        `repos/${repo}/releases?per_page=100`,
        "--jq",
        `.[] | select(.draft) | ${RELEASE_JQ} | @json`,
      ]).toString("utf8");
      drafts = out
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => releaseSchema.parse(JSON.parse(l)));
    }
    return drafts;
  };
  return {
    byTag(tag) {
      assertRepo();
      let release: GitHubRelease;
      try {
        const out = run([
          "api",
          `repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
          "--jq",
          RELEASE_JQ,
        ]);
        release = releaseSchema.parse(JSON.parse(out.toString("utf8")));
      } catch (err) {
        if (!(err instanceof GhNotFoundError)) {
          throw err;
        }
        const draft = listDrafts().find((d) => d.tag_name === tag);
        if (draft) {
          manifestAssetId(draft); // throws IncompleteReleaseError naming the draft
        }
        return null;
      }
      const assetId = manifestAssetId(release);
      const manifestBytes = run([
        "api",
        "-H",
        "Accept: application/octet-stream",
        `repos/${repo}/releases/assets/${assetId}`,
      ]);
      return { tag, manifestBytes };
    },
  };
}
