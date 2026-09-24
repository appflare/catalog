import { z } from "zod";
import type { AppEntry } from "./apps.ts";
import { readManifestFile } from "./apps.ts";
import type { CatalogAppStats, CatalogStats } from "./types.ts";

/**
 * `stats.json`: popularity numbers the Pages site publishes next to
 * `index.json`, rebuilt about hourly by the stats workflow without any
 * commit. Two sources:
 *
 * - GitHub stars of each entry's upstream repository, from one GraphQL
 *   request with the workflow's own token;
 * - install counts from the anonymous events Appflare managers send to
 *   PostHog, from two HogQL queries with a read-only personal API key.
 *
 * When a source fails, the numbers it gave last time are carried forward from
 * the previous `stats.json` with their old `fetchedAt`, and the source is
 * marked `ok: false`. Install counts below {@link MIN_PUBLISHED_INSTALLS} are
 * published as null, never as the number.
 *
 * The stats workflow runs without a built appflare checkout, so the file's
 * shape is checked here with a copy of `@appflare/schema`'s
 * `catalogStatsSchema`; a test holds the two to the same fixtures.
 */

export const MIN_PUBLISHED_INSTALLS = 10;

/** PostHog Cloud EU's API host (queries; events are sent to eu.i.posthog.com). */
export const POSTHOG_API_HOST = "https://eu.posthog.com";

/**
 * The project key Appflare managers send events with. It is public (it can
 * only send events); here it picks the project to query among those the
 * personal API key can read.
 */
export const POSTHOG_PROJECT_API_KEY = "phc_ALESBsbeNDUPHQQN3KNbEYTrFJwBmJvqh28BGDXF9PUs";

/**
 * Distinct managers with a successful install job per app in 30 days.
 * Development builds (version 0.0.0-...) are left out.
 */
export const INSTALLS_30D_QUERY = `SELECT properties.slug AS app, count(DISTINCT distinct_id) AS installs
FROM events
WHERE event = 'job finished'
  AND properties.kind = 'install'
  AND properties.outcome = 'succeeded'
  AND timestamp > now() - INTERVAL 30 DAY
  AND NOT startsWith(ifNull(properties.manager_version, ''), '0.0.0')
GROUP BY app
ORDER BY installs DESC
LIMIT 5000`;

/**
 * Distinct managers whose latest daily report in 7 days lists the app, among
 * managers seen on two days (a manager set up and removed again the same day
 * does not count). Only managers reading the official catalog report apps.
 */
export const ACTIVE_INSTALLS_QUERY = `SELECT replaceAll(arrayJoin(JSONExtractArrayRaw(apps ?? '[]')), '"', '') AS app,
       count() AS active_installs
FROM (
  SELECT distinct_id, argMax(properties.apps, timestamp) AS apps
  FROM events
  WHERE event = 'manager heartbeat'
    AND timestamp > now() - INTERVAL 7 DAY
    AND properties.catalog = 'official'
    AND NOT startsWith(ifNull(properties.manager_version, ''), '0.0.0')
  GROUP BY distinct_id
  HAVING dateDiff('hour', min(timestamp), max(timestamp)) >= 20
)
GROUP BY app
ORDER BY active_installs DESC
LIMIT 5000`;

const iso = z.iso.datetime();
const countSchema = z.number().int().min(MIN_PUBLISHED_INSTALLS).nullable();
const sourceSchema = z.object({ ok: z.boolean(), at: iso.nullable() });

/** A copy of `@appflare/schema`'s `catalogStatsSchema` (see this module's header). */
export const statsSchema = z.object({
  generatedAt: iso,
  apps: z.record(
    z.string().min(1),
    z.object({
      stars: z.object({ count: z.number().int().nonnegative(), fetchedAt: iso }).nullable(),
      installs: z.object({ last30d: countSchema, active: countSchema, fetchedAt: iso }).nullable(),
    }),
  ),
  sources: z.object({ github: sourceSchema, telemetry: sourceSchema }),
});

/** One entry to count: its slug, and its upstream repository when the stars are its own. */
export interface StatsTarget {
  slug: string;
  /** `owner/name`, or null when the repository hosts more than this app (its stars are not the app's). */
  repo: string | null;
}

const targetManifestSchema = z.object({
  slug: z.string().min(1),
  repo: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
  homepage: z.string(),
});

/**
 * The entries to count, from their manifests (read with a local schema; the
 * workflow has no appflare checkout). An entry whose homepage is a folder of
 * its repository (`.../tree/...`) lives in a shared repository, such as a
 * collection of templates, whose stars say nothing about the entry.
 */
export function statsTargets(apps: readonly AppEntry[]): StatsTarget[] {
  return apps.map((app) => {
    const m = targetManifestSchema.parse(readManifestFile(app.manifestPath));
    const shared = m.homepage.startsWith(`https://github.com/${m.repo}/tree/`);
    return { slug: m.slug, repo: shared ? null : m.repo };
  });
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

async function json(response: Response, what: string): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${what} answered HTTP ${response.status}`);
  }
  return response.json();
}

const starsResponseSchema = z.object({
  data: z.record(z.string(), z.object({ stargazerCount: z.number().int() }).nullable()).nullable(),
});

/**
 * Stars per slug, in one GraphQL request. A repository GitHub cannot find is
 * left out (its old number is carried forward). Throws when the request fails.
 */
export async function fetchStars(
  targets: readonly StatsTarget[],
  token: string,
  fetchImpl: FetchLike,
): Promise<Map<string, number>> {
  const counted = targets.filter((t): t is StatsTarget & { repo: string } => t.repo !== null);
  const stars = new Map<string, number>();
  if (counted.length === 0) return stars;
  const fields = counted.map((t, i) => {
    const [owner = "", name = ""] = t.repo.split("/");
    return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { stargazerCount }`;
  });
  const response = await fetchImpl("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "appflare-catalog-stats",
    },
    body: JSON.stringify({ query: `query { ${fields.join(" ")} }` }),
  });
  const body = starsResponseSchema.parse(await json(response, "GitHub GraphQL"));
  if (body.data === null) throw new Error("GitHub GraphQL returned no data");
  counted.forEach((t, i) => {
    const repo = body.data?.[`r${i}`];
    if (repo) stars.set(t.slug, repo.stargazerCount);
  });
  return stars;
}

const projectsSchema = z.object({
  results: z.array(z.object({ id: z.number().int(), api_token: z.string().optional() })),
});

/**
 * The id of the PostHog project whose public key is
 * {@link POSTHOG_PROJECT_API_KEY}, among the projects the personal API key can
 * read (`GET /api/projects/`, which needs the key's `project:read` scope).
 */
export async function discoverProjectId(
  apiKey: string,
  fetchImpl: FetchLike,
  host = POSTHOG_API_HOST,
): Promise<number> {
  const response = await fetchImpl(`${host}/api/projects/`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const { results } = projectsSchema.parse(await json(response, "PostHog projects"));
  const match = results.find((p) => p.api_token === POSTHOG_PROJECT_API_KEY);
  if (match !== undefined) return match.id;
  if (results.length === 1 && results[0] !== undefined && results[0].api_token === undefined) {
    return results[0].id;
  }
  throw new Error(
    `none of the ${results.length} PostHog project(s) the key can read has Appflare's project key; set POSTHOG_PROJECT_ID`,
  );
}

const queryResponseSchema = z.object({
  results: z.array(z.tuple([z.string().nullable(), z.number()]).rest(z.unknown())),
});

/** Runs a HogQL query and returns `app -> count` from its two columns. */
export async function hogqlCounts(
  apiKey: string,
  projectId: number,
  query: string,
  fetchImpl: FetchLike,
  host = POSTHOG_API_HOST,
): Promise<Map<string, number>> {
  const response = await fetchImpl(`${host}/api/projects/${projectId}/query/`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
  });
  const { results } = queryResponseSchema.parse(await json(response, "PostHog query"));
  const counts = new Map<string, number>();
  for (const [app, count] of results) {
    if (app !== null && app !== "") counts.set(app, count);
  }
  return counts;
}

export interface InstallCounts {
  last30d: Map<string, number>;
  active: Map<string, number>;
}

/** Both install counts. Throws when discovery or either query fails. */
export async function fetchInstalls(
  apiKey: string,
  fetchImpl: FetchLike,
  projectId?: number,
): Promise<InstallCounts> {
  const id = projectId ?? (await discoverProjectId(apiKey, fetchImpl));
  const last30d = await hogqlCounts(apiKey, id, INSTALLS_30D_QUERY, fetchImpl);
  const active = await hogqlCounts(apiKey, id, ACTIVE_INSTALLS_QUERY, fetchImpl);
  return { last30d, active };
}

/** What one source gave this run: its numbers, or why it failed. */
export type SourceResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** A count as published: null below the floor. */
export function published(count: number | undefined): number | null {
  return count === undefined || count < MIN_PUBLISHED_INSTALLS ? null : count;
}

/**
 * Assembles `stats.json` from this run's sources and the previous file:
 * every target gets an entry; a failed source's numbers come from `previous`
 * unchanged, a working one's are replaced (and an app it did not report
 * counts as zero installs, published as null).
 */
export function buildStats(input: {
  now: Date;
  targets: readonly StatsTarget[];
  stars: SourceResult<Map<string, number>>;
  installs: SourceResult<InstallCounts>;
  previous: CatalogStats | null;
}): CatalogStats {
  const at = input.now.toISOString();
  const apps: Record<string, CatalogAppStats> = {};
  for (const { slug, repo } of input.targets) {
    const before = input.previous?.apps[slug];
    let stars: CatalogAppStats["stars"] = null;
    if (repo !== null) {
      const count = input.stars.ok ? input.stars.value.get(slug) : undefined;
      stars = count === undefined ? (before?.stars ?? null) : { count, fetchedAt: at };
    }
    const installs: CatalogAppStats["installs"] = input.installs.ok
      ? {
          last30d: published(input.installs.value.last30d.get(slug)),
          active: published(input.installs.value.active.get(slug)),
          fetchedAt: at,
        }
      : (before?.installs ?? null);
    apps[slug] = { stars, installs };
  }
  const previousSources = input.previous?.sources;
  return statsSchema.parse({
    generatedAt: at,
    apps,
    sources: {
      github: input.stars.ok
        ? { ok: true, at }
        : { ok: false, at: previousSources?.github.at ?? null },
      telemetry: input.installs.ok
        ? { ok: true, at }
        : { ok: false, at: previousSources?.telemetry.at ?? null },
    },
  });
}

/** The previous `stats.json`, or null when there is none or it is unreadable. */
export function parsePreviousStats(text: string | null): CatalogStats | null {
  if (text === null) return null;
  try {
    const result = statsSchema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
