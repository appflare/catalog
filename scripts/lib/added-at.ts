import { spawnSync } from "node:child_process";

/**
 * When each entry first appeared in the catalog, for the index's `addedAt`
 * (managers show "New this week" from it): the committer time, in ISO 8601
 * with its offset, of the oldest commit that added `apps/<slug>/appflare.jsonc`.
 * Renames are not followed (`--no-renames`), so an entry moved to a new slug
 * counts from the commit that created its new path. Merge commits add nothing
 * of their own here; a squash merge is the commit that adds the file.
 *
 * It needs the whole history: in a shallow clone the oldest commit present
 * shows every file as added, which would date every entry to it. So
 * {@link readAddedTimes} refuses a shallow repository, and CI checks the
 * catalog out with `fetch-depth: 0` where it builds the index.
 */

/** Runs git in the catalog repository and returns its stdout; throws when git fails. */
export type GitRun = (args: readonly string[]) => string;

/** The manifests whose first commit dates an entry. */
const MANIFEST_PATHSPEC = "apps/*/appflare.jsonc";
const MANIFEST_PATH = /^apps\/([^/]+)\/appflare\.jsonc$/;
/** Starts each commit's record in the log, before its committer time. */
const RECORD = "\u0001";

/** The `git log` arguments whose output {@link parseAddedTimes} reads. */
export const ADDED_LOG_ARGS: readonly string[] = [
  "log",
  "--no-renames",
  "--diff-filter=A",
  `--format=${RECORD}%cI`,
  "--name-only",
  "--",
  MANIFEST_PATHSPEC,
];

/**
 * The time each slug's manifest was first added, from the output of
 * `git log` with {@link ADDED_LOG_ARGS} (newest commit first). A manifest
 * deleted and added again keeps its first time.
 */
export function parseAddedTimes(log: string): Map<string, string> {
  const times = new Map<string, string>();
  for (const record of log.split(RECORD)) {
    const [time, ...paths] = record.split("\n").map((line) => line.trim());
    if (time === undefined || time === "") continue;
    for (const file of paths) {
      const slug = MANIFEST_PATH.exec(file)?.[1];
      // Newest first, so the last time seen for a slug is its oldest.
      if (slug !== undefined) times.set(slug, time);
    }
  }
  return times;
}

/** A {@link GitRun} in `cwd`. */
export function gitIn(cwd: string): GitRun {
  return (args) => {
    const res = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (res.error || res.status !== 0) {
      const why = res.error?.message ?? (res.stderr.trim() || `exit ${res.status}`);
      throw new Error(`git ${args[0]} failed: ${why}`);
    }
    return res.stdout;
  };
}

/**
 * {@link parseAddedTimes} for the repository `git` runs in. Throws when the
 * repository is a shallow clone, whose history would date every entry to
 * its oldest commit.
 */
export function readAddedTimes(git: GitRun): Map<string, string> {
  if (git(["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    throw new Error(
      "the catalog checkout is shallow, so the commit that added each entry is unknown; " +
        "fetch its whole history (git fetch --unshallow, or fetch-depth: 0 in actions/checkout)",
    );
  }
  return parseAddedTimes(git(ADDED_LOG_ARGS));
}

/**
 * Each entry's `addedAt` as recorded in the index being replaced, for a
 * build that cannot read the history (a local shallow clone).
 */
export function previousAddedTimes(
  rows: ReadonlyArray<{ slug: string; addedAt?: string }>,
): Map<string, string> {
  return new Map(
    rows.flatMap((row) => (typeof row.addedAt === "string" ? [[row.slug, row.addedAt]] : [])),
  );
}
