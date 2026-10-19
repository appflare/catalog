import { z } from "zod";
import { parseJsonc } from "./jsonc.ts";
import { type FetchLike, fetchStars } from "./stats.ts";

/**
 * The catalog's bar for new apps: the GitHub stars an app's upstream
 * repository needs before the app can be added. The bar may rise over time; it
 * is checked only when an app is added, so raising it removes nothing already
 * listed. CONTRIBUTING.md and appflare.dev's "Submit an app" page state the
 * same number.
 *
 * The min-stars workflow runs on `pull_request_target` and never checks out
 * the pull request: it lists the files the pull request adds and reads each
 * new manifest through the API, as data.
 */
export const MIN_STARS = 50;

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const ADDED_MANIFEST = /^apps\/([a-z0-9][a-z0-9-]*)\/appflare\.jsonc$/;

/** One file of a pull request, as `GET /repos/{repo}/pulls/{n}/files` lists it. */
export interface PullFile {
  filename: string;
  status: string;
}

/** The new apps a pull request adds: slug and manifest path of each added `appflare.jsonc`. */
export function addedApps(files: readonly PullFile[]): Array<{ slug: string; path: string }> {
  const apps = new Map<string, string>();
  for (const f of files) {
    const match = ADDED_MANIFEST.exec(f.filename);
    if (f.status === "added" && match?.[1]) apps.set(match[1], f.filename);
  }
  return [...apps].sort(([a], [b]) => a.localeCompare(b)).map(([slug, path]) => ({ slug, path }));
}

const repoFieldsSchema = z.object({
  repo: z.string().regex(REPO),
  upstreamRepo: z.string().regex(REPO).optional(),
});

/**
 * The repository whose stars count for a manifest: `upstreamRepo` when the
 * build comes from a template or packaging fork, else `repo` (as stats.json
 * counts it). Throws when the manifest names neither.
 */
export function starsRepo(manifestText: string): string {
  const parsed = repoFieldsSchema.safeParse(parseJsonc(manifestText));
  if (!parsed.success) throw new Error("the manifest has no valid repo");
  return parsed.data.upstreamRepo ?? parsed.data.repo;
}

export interface StarsResult {
  slug: string;
  repo: string;
  /** null when GitHub cannot find the repository. */
  stars: number | null;
}

/** Stars of each new app's repository, in one GraphQL request. */
export async function countStars(
  apps: ReadonlyArray<{ slug: string; repo: string }>,
  token: string,
  fetchImpl: FetchLike,
): Promise<StarsResult[]> {
  const stars = await fetchStars(apps, token, fetchImpl);
  return apps.map((a) => ({ ...a, stars: stars.get(a.slug) ?? null }));
}

/** The apps under the bar. A repository GitHub cannot find is not, since its manifest is broken. */
export function belowMinimum(results: readonly StarsResult[], min = MIN_STARS): StarsResult[] {
  return results.filter((r) => r.stars !== null && r.stars < min);
}

/** The comment left on a pull request closed for adding apps under the bar. */
export function rejectionComment(
  below: readonly StarsResult[],
  catalog: string,
  min = MIN_STARS,
): string {
  const lines = below.map(
    (r) =>
      `- \`${r.slug}\`: [${r.repo}](https://github.com/${r.repo}) has ${r.stars} star${r.stars === 1 ? "" : "s"}`,
  );
  return [
    `Thanks for the submission! New apps need at least ${min} GitHub stars on their upstream repository to join the catalog, and this pull request adds:`,
    "",
    ...lines,
    "",
    "So it is closed for now. Once the repository reaches the bar, reopen this pull request (or open a new one) and the check runs again.",
    "",
    `The bar may rise over time; see [Catalog policy](https://github.com/${catalog}/blob/main/CONTRIBUTING.md#catalog-policy).`,
  ].join("\n");
}
