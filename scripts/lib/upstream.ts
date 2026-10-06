import { z } from "zod";
import { GhNotFoundError, type GhRequest, type GhRunner, runGh } from "./gh-api.ts";

/**
 * Where an app's upstream is now, for the bump workflow: its tags, of which
 * the newest stable semver tag counts (ordered by semver, not by date, so a
 * patch to an old line never outranks a newer release; prerelease tags are
 * ignored), and its default branch's head commit.
 */

export interface CommitRelation {
  ahead: number;
  behind: number;
}

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

export interface UpstreamBranch {
  name: string;
  sha: string;
}

/**
 * The most files GitHub's compare API lists for one comparison ("up to 300
 * changed files for the entire comparison", REST docs, "Compare two commits").
 * A list this long may be cut short.
 */
export const COMPARE_FILES_LIMIT = 300;

/** Paths a comparison changed, and whether GitHub listed all of them. */
export interface ChangedFiles {
  /** Each changed file's path, plus the old path of a renamed file. */
  paths: string[];
  /** False when the list may be truncated, so a missing path proves nothing. */
  complete: boolean;
}

const changedFilesSchema = z.object({
  count: z.number().int().nonnegative().nullable(),
  paths: z.array(z.string()),
});

const tagSchema = z.object({ name: z.string(), sha: z.string().regex(/^[0-9a-f]{40}$/) });
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const branchSchema = z.object({ name: z.string(), sha: shaSchema });

/** Reads the upstream state with read-only `gh api` calls. */
export interface UpstreamSource {
  /** Every tag of the repository, with the commit it points at. */
  tags(repo: string): UpstreamTag[];
  /** The repository's default branch, under its current name, and its head commit. */
  defaultBranch(repo: string): UpstreamBranch;
  /**
   * The branch `name` and its head commit; null when the repository has no
   * branch of that name (HTTP 404: deleted or renamed). Any other failure
   * throws.
   */
  branch(repo: string, name: string): UpstreamBranch | null;
  /** Commit subjects between two SHAs (oldest first) and the total count. */
  compare(repo: string, from: string, to: string): { total: number; subjects: string[] };
  /**
   * How two commits relate (the compare API's `ahead_by` and `behind_by`):
   * `ahead` counts commits in `head` that `base` lacks, `behind` the reverse.
   * `behind === 0` means `base` is reachable from `head`. Null when both
   * commits exist but share no history (the compare API answers 404, "No
   * common ancestor", for example after upstream rewrote its history).
   */
  relation(repo: string, base: string, head: string): CommitRelation | null;
  /** Files changed between two commits (the compare API's `files[].filename`). */
  changedFiles(repo: string, base: string, head: string): ChangedFiles;
}

export function createGhUpstream(run: GhRunner = runGh): UpstreamSource {
  const text = (request: GhRequest) => run(request).toString("utf8").trim();
  const exists = (repo: string, sha: string): boolean => {
    try {
      return text({ path: `repos/${repo}/commits/${sha}`, jq: ".sha" }) === sha;
    } catch (err) {
      if (err instanceof GhNotFoundError) {
        return false;
      }
      throw err;
    }
  };
  return {
    tags(repo) {
      return text({
        path: `repos/${repo}/tags?per_page=100`,
        paginate: true,
        jq: ".[] | {name, sha: .commit.sha} | @json",
      })
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => tagSchema.parse(JSON.parse(l)));
    },
    defaultBranch(repo) {
      const name = text({ path: `repos/${repo}`, jq: ".default_branch" });
      if (!name) {
        throw new Error(`${repo} has no default branch`);
      }
      const sha = shaSchema.parse(
        text({ path: `repos/${repo}/commits/${encodeURIComponent(name)}`, jq: ".sha" }),
      );
      return { name, sha };
    },
    branch(repo, name) {
      let out: string;
      try {
        out = text({
          path: `repos/${repo}/branches/${encodeURIComponent(name)}`,
          jq: "{name, sha: .commit.sha} | @json",
        });
      } catch (err) {
        if (err instanceof GhNotFoundError) {
          return null;
        }
        throw err;
      }
      const branch = branchSchema.parse(JSON.parse(out));
      // GitHub may redirect a renamed branch's old name to its new one; the
      // pinned name is then gone all the same.
      return branch.name === name ? branch : null;
    },
    compare(repo, from, to) {
      const out = JSON.parse(
        text({
          path: `repos/${repo}/compare/${from}...${to}`,
          jq: '{total: .total_commits, subjects: [.commits[].commit.message | split("\\n")[0]]}',
        }),
      ) as { total: number; subjects: string[] };
      return out;
    },
    relation(repo, base, head) {
      let out: string;
      try {
        out = text({
          path: `repos/${repo}/compare/${base}...${head}`,
          jq: '"\\(.ahead_by) \\(.behind_by)"',
        });
      } catch (err) {
        // The compare API answers 404 both for a commit it cannot find and for
        // two commits without a common ancestor; only the second is an answer.
        if (err instanceof GhNotFoundError && exists(repo, base) && exists(repo, head)) {
          return null;
        }
        throw err;
      }
      const [ahead, behind] = out.split(" ").map(Number);
      const count = (n: number | undefined): n is number =>
        n !== undefined && Number.isInteger(n) && n >= 0;
      if (!count(ahead) || !count(behind)) {
        throw new Error(`unexpected compare result for ${base}...${head} in ${repo}`);
      }
      return { ahead, behind };
    },
    changedFiles(repo, base, head) {
      const out = changedFilesSchema.parse(
        JSON.parse(
          text({
            path: `repos/${repo}/compare/${base}...${head}`,
            jq:
              "{count: (if .files == null then null else (.files | length) end), " +
              "paths: [.files[]? | .filename, (.previous_filename // empty)]}",
          }),
        ),
      );
      return {
        paths: out.paths,
        complete: out.count !== null && out.count < COMPARE_FILES_LIMIT,
      };
    },
  };
}
