import { z } from "zod";
import { type GhRunner, runGh } from "./github-releases.ts";

/**
 * Where an app's upstream is now, for the bump workflow. A repository with
 * stable semver tags is tracked by its newest tag (ordered by semver, not by
 * date, so a patch to an old line never outranks a newer release);
 * prerelease tags are ignored. A repository without them is tracked by its
 * default branch's head commit, with `ref` set to the branch name.
 */

export interface UpstreamTarget {
  ref: string;
  sha: string;
  kind: "tag" | "branch";
}

export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
}

/** Whether `ref` is a semver prerelease tag such as `v2.0.0-rc.1`. */
export function isPrereleaseTag(ref: string): boolean {
  return /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-[0-9A-Za-z.-]+(?:\+[0-9A-Za-z.-]+)?$/.test(
    ref,
  );
}

/**
 * Parses a stable release tag (`1.2.3` or `v1.2.3`, build metadata allowed);
 * null for anything else, including prereleases (`1.2.3-rc.1`).
 */
export function parseStableTag(tag: string): SemverParts | null {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/.exec(tag);
  if (!match) {
    return null;
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareSemver(a: SemverParts, b: SemverParts): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export interface UpstreamTag {
  name: string;
  sha: string;
}

/** The newest stable semver tag; ties (`v1.2.3` and `1.2.3`) prefer the first listed. */
export function newestStableTag(tags: readonly UpstreamTag[]): UpstreamTag | null {
  let best: { tag: UpstreamTag; parts: SemverParts } | null = null;
  for (const tag of tags) {
    const parts = parseStableTag(tag.name);
    if (parts && (!best || compareSemver(parts, best.parts) > 0)) {
      best = { tag, parts };
    }
  }
  return best?.tag ?? null;
}

/** Picks the target from the repository's tags, or its default branch head without them. */
export function pickUpstreamTarget(
  tags: readonly UpstreamTag[],
  branch: { name: string; sha: string },
): UpstreamTarget {
  const tag = newestStableTag(tags);
  return tag
    ? { ref: tag.name, sha: tag.sha, kind: "tag" }
    : { ref: branch.name, sha: branch.sha, kind: "branch" };
}

const tagSchema = z.object({ name: z.string(), sha: z.string().regex(/^[0-9a-f]{40}$/) });
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);

/** Reads the upstream state with read-only `gh api` calls. */
export interface UpstreamSource {
  resolve(repo: string): UpstreamTarget;
  /** Commit subjects between two SHAs (oldest first) and the total count. */
  compare(repo: string, from: string, to: string): { total: number; subjects: string[] };
  /** How many commits `head` has that `base` does not (the compare API's `ahead_by`). */
  aheadBy(repo: string, base: string, head: string): number;
}

export function createGhUpstream(run: GhRunner = runGh): UpstreamSource {
  const text = (args: string[]) => run(args).toString("utf8").trim();
  return {
    resolve(repo) {
      const tags = text([
        "api",
        "--paginate",
        `repos/${repo}/tags?per_page=100`,
        "--jq",
        ".[] | {name, sha: .commit.sha} | @json",
      ])
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => tagSchema.parse(JSON.parse(l)));
      if (newestStableTag(tags)) {
        return pickUpstreamTarget(tags, { name: "", sha: "" });
      }
      const branch = text(["api", `repos/${repo}`, "--jq", ".default_branch"]);
      if (!branch) {
        throw new Error(`${repo} has no default branch`);
      }
      const sha = shaSchema.parse(
        text(["api", `repos/${repo}/commits/${encodeURIComponent(branch)}`, "--jq", ".sha"]),
      );
      return { ref: branch, sha, kind: "branch" };
    },
    compare(repo, from, to) {
      const out = JSON.parse(
        text([
          "api",
          `repos/${repo}/compare/${from}...${to}`,
          "--jq",
          '{total: .total_commits, subjects: [.commits[].commit.message | split("\\n")[0]]}',
        ]),
      ) as { total: number; subjects: string[] };
      return out;
    },
    aheadBy(repo, base, head) {
      const n = Number(
        text(["api", `repos/${repo}/compare/${base}...${head}`, "--jq", ".ahead_by"]),
      );
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`unexpected ahead_by comparing ${base}...${head} in ${repo}`);
      }
      return n;
    },
  };
}
