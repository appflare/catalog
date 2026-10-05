import { z } from "zod";
import type { BumpPr } from "./bump.ts";
import { type GhRequest, type GhRunner, runGh } from "./gh-api.ts";

/** The catalog's existing bump branches and pull requests for an app. */
export interface BumpHistory {
  existing(slug: string): { branches: string[]; prs: BumpPr[] };
}

const prSchema = z.object({
  number: z.number(),
  head: z.string(),
  state: z.enum(["open", "closed"]),
  createdAt: z.string(),
});

/** Reads bump branches and pull requests of `repo` (the catalog) with read-only `gh api` calls. */
export function createGhBumpHistory(repo: string, run: GhRunner = runGh): BumpHistory {
  let prs: BumpPr[] | null = null;
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
        jq: '.[] | select(.head.ref | startswith("bump/")) | {number, head: .head.ref, state, createdAt: .created_at} | @json',
      }).map((l) => prSchema.parse(JSON.parse(l)));
      const branches = lines({
        path: `repos/${repo}/git/matching-refs/heads/bump/${slug}/`,
        paginate: true,
        jq: ".[].ref",
      }).map((ref) => ref.replace(/^refs\/heads\//, ""));
      return { branches, prs: prs.filter((p) => p.head.startsWith(`bump/${slug}/`)) };
    },
  };
}
