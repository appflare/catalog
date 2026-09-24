import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { listApps } from "./lib/apps.ts";
import { catalogRepo, info, runMain, warn } from "./lib/cli.ts";
import { appsDir } from "./lib/paths.ts";
import { pagesBaseUrl } from "./lib/sandbox-entry.ts";
import {
  buildStats,
  type FetchLike,
  fetchInstalls,
  fetchStars,
  type InstallCounts,
  parsePreviousStats,
  type SourceResult,
  statsTargets,
} from "./lib/stats.ts";

const USAGE = `Usage: pnpm -s build-stats --out <file> [--previous <file>]

Writes stats.json: GitHub stars of each entry's upstream repository and, from
the anonymous events Appflare managers send, how many managers installed each
app in 30 days and how many run it. Needs no appflare checkout.

Environment:
  GITHUB_TOKEN               token for the GitHub GraphQL API (the workflow token)
  POSTHOG_PERSONAL_API_KEY   read-only PostHog personal API key (query:read,
                             project:read); without it install counts are not read
  POSTHOG_PROJECT_ID         optional; skips looking the project up by its key

A source that fails keeps the numbers it gave last time, from --previous or,
by default, the stats.json currently live on the catalog's Pages site. The
script fails only when it cannot write a valid file.
`;

async function previousText(
  fetchImpl: FetchLike,
  file: string | undefined,
): Promise<string | null> {
  if (file !== undefined) return readFileSync(path.resolve(file), "utf8");
  const url = `${pagesBaseUrl(catalogRepo())}stats.json`;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      warn(`${url} answered HTTP ${response.status}; nothing to carry forward`);
      return null;
    }
    return await response.text();
  } catch (err) {
    warn(`could not read ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function attempt<T>(label: string, run: () => Promise<T>): Promise<SourceResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    warn(`${label} failed, keeping its previous numbers: ${error}`);
    return { ok: false, error };
  }
}

runMain(async () => {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      previous: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || !values.out) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 1;
  }
  const fetchImpl: FetchLike = (url, init) => fetch(url, init);
  const targets = statsTargets(listApps(appsDir));
  const previous = parsePreviousStats(await previousText(fetchImpl, values.previous));

  const githubToken = process.env.GITHUB_TOKEN?.trim();
  const stars = await attempt("GitHub stars", async () => {
    if (!githubToken) throw new Error("GITHUB_TOKEN is not set");
    return fetchStars(targets, githubToken, fetchImpl);
  });

  const posthogKey = process.env.POSTHOG_PERSONAL_API_KEY?.trim();
  const projectId = process.env.POSTHOG_PROJECT_ID?.trim();
  const installs = await attempt<InstallCounts>("install counts", async () => {
    if (!posthogKey) throw new Error("POSTHOG_PERSONAL_API_KEY is not set");
    return fetchInstalls(posthogKey, fetchImpl, projectId ? Number(projectId) : undefined);
  });

  const stats = buildStats({ now: new Date(), targets, stars, installs, previous });
  writeFileSync(path.resolve(values.out), `${JSON.stringify(stats, null, 2)}\n`);
  const counted = Object.values(stats.apps).filter((a) => a.stars !== null).length;
  info(
    `wrote ${values.out}: ${targets.length} app(s), stars for ${counted}; ` +
      `github ${stats.sources.github.ok ? "ok" : "failed"}, telemetry ${stats.sources.telemetry.ok ? "ok" : "failed"}`,
  );
  return 0;
});
