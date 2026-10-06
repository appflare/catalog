import { z } from "zod";
import type { BumpPr } from "./bump.ts";
import { type GhRequest, type GhRunner, runGh } from "./gh-api.ts";

/** The catalog's existing bump branches and pull requests for an app. */
export interface BumpHistory {
  existing(slug: string): { branches: string[]; prs: BumpPr[] };
  /**
   * The check names a pull request sees on commit `sha`: its commit statuses,
   * and the check runs of pull_request workflow runs. Check runs of
   * workflow_dispatch runs are left out, as GitHub leaves them out of a pull
   * request's checks and of the ruleset's required checks.
   */
  reportedChecks(sha: string): string[];
  /**
   * The tag the app's last bump commit on the default branch moved it to,
   * read from its subject (see {@link lastBumpTag}).
   */
  lastBumpTag(slug: string): string | null;
}

/**
 * The tag in the newest bump commit subject of `slug` among `subjects`
 * (newest first): `chore(<slug>): bump to <tag>`, with the pull request number
 * a squash merge adds. Null when that bump moved the app to a branch head
 * (`<branch>@<short sha>`), when its subject names only the commit (a tag too
 * long for the header), or when there is no bump.
 */
export function lastBumpTag(slug: string, subjects: readonly string[]): string | null {
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bump = new RegExp(`^chore\\(${escaped}\\): bump to (\\S+)(?: \\(#\\d+\\))?$`);
  for (const subject of subjects) {
    const label = bump.exec(subject)?.[1];
    if (label !== undefined) {
      return /@[0-9a-f]{7}$/.test(label) || /^[0-9a-f]{7}$/.test(label) ? null : label;
    }
  }
  return null;
}

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const prSchema = z.object({
  number: z.number(),
  head: z.string(),
  headSha: sha,
  state: z.enum(["open", "closed"]),
  createdAt: z.string(),
});
const checkRunSchema = z.object({ name: z.string(), suite: z.number() });

/** Reads bump branches and pull requests of `repo` (the catalog) with read-only `gh api` calls. */
export function createGhBumpHistory(repo: string, run: GhRunner = runGh): BumpHistory {
  let prs: BumpPr[] | null = null;
  let branches: string[] | null = null;
  const lines = (request: GhRequest) =>
    run(request)
      .toString("utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  return {
    existing(slug) {
      prs ??= lines({
        path: `repos/${repo}/pulls?state=all&per_page=100`,
        paginate: true,
        jq: '.[] | select(.head.ref | startswith("bump/")) | {number, head: .head.ref, headSha: .head.sha, state, createdAt: .created_at} | @json',
      }).map((l) => prSchema.parse(JSON.parse(l)));
      branches ??= lines({
        path: `repos/${repo}/git/matching-refs/heads/bump/`,
        paginate: true,
        jq: ".[].ref",
      }).map((ref) => ref.replace(/^refs\/heads\//, ""));
      const prefix = `bump/${slug}/`;
      return {
        branches: branches.filter((b) => b.startsWith(prefix)),
        prs: prs.filter((p) => p.head.startsWith(prefix)),
      };
    },
    lastBumpTag(slug) {
      return lastBumpTag(
        slug,
        lines({
          path: `repos/${repo}/commits?path=${encodeURIComponent(`apps/${slug}/appflare.jsonc`)}&per_page=30`,
          jq: '.[].commit.message | split("\\n")[0]',
        }),
      );
    },
    reportedChecks(commit) {
      sha.parse(commit);
      const statuses = lines({
        path: `repos/${repo}/commits/${commit}/statuses`,
        paginate: true,
        jq: ".[].context",
      });
      const suites = new Set(
        lines({
          path: `repos/${repo}/actions/runs?head_sha=${commit}&event=pull_request`,
          paginate: true,
          jq: ".workflow_runs[].check_suite_id",
        }).map(Number),
      );
      const checkRuns = lines({
        path: `repos/${repo}/commits/${commit}/check-runs`,
        paginate: true,
        jq: ".check_runs[] | {name, suite: .check_suite.id} | @json",
      })
        .map((l) => checkRunSchema.parse(JSON.parse(l)))
        .filter((c) => suites.has(c.suite))
        .map((c) => c.name);
      return [...new Set([...statuses, ...checkRuns])];
    },
  };
}
