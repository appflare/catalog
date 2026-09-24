import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appflareAvailable, testSchema } from "../fixtures/schema.ts";
import type { AppflareSchema } from "./appflare-schema.ts";
import { listApps } from "./apps.ts";
import {
  buildStats,
  discoverProjectId,
  type FetchLike,
  fetchInstalls,
  fetchStars,
  hogqlCounts,
  INSTALLS_30D_QUERY,
  POSTHOG_PROJECT_API_KEY,
  parsePreviousStats,
  statsSchema,
  statsTargets,
} from "./stats.ts";
import type { CatalogStats } from "./types.ts";

const NOW = new Date("2026-09-24T12:23:00.000Z");
const EARLIER = "2026-09-24T11:23:00.000Z";

let schema: AppflareSchema;
beforeAll(async () => {
  schema = await testSchema();
});

/** A fake fetch answering by URL, recording each request. */
function fakeFetch(answer: (url: string, body: unknown) => unknown) {
  const calls: Array<{ url: string; body: unknown; auth: string | null }> = [];
  const fetch: FetchLike = async (url, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, body, auth: new Headers(init?.headers).get("authorization") });
    const result = answer(url, body);
    return result instanceof Response ? result : Response.json(result);
  };
  return { fetch, calls };
}

describe("statsTargets", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "catalog-stats-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("counts stars only for an entry that has its repository to itself", () => {
    for (const [slug, repo, homepage] of [
      ["cut", "MendyLanda/cut", "https://github.com/MendyLanda/cut"],
      ["r2", "cloudflare/templates", "https://github.com/cloudflare/templates/tree/main/r2"],
    ]) {
      mkdirSync(path.join(root, slug as string));
      writeFileSync(
        path.join(root, slug as string, "appflare.jsonc"),
        JSON.stringify({ slug, repo, homepage }),
      );
    }
    expect(statsTargets(listApps(root))).toEqual([
      { slug: "cut", repo: "MendyLanda/cut" },
      { slug: "r2", repo: null },
    ]);
  });
});

describe("GitHub stars", () => {
  it("asks for every repository in one GraphQL request and skips the ones GitHub cannot find", async () => {
    const api = fakeFetch(() => ({
      data: { r0: { stargazerCount: 17 }, r1: null },
      errors: [{ type: "NOT_FOUND" }],
    }));
    const stars = await fetchStars(
      [
        { slug: "cut", repo: "MendyLanda/cut" },
        { slug: "gone", repo: "someone/gone" },
        { slug: "shared", repo: null },
      ],
      "token",
      api.fetch,
    );
    expect([...stars]).toEqual([["cut", 17]]);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.auth).toBe("Bearer token");
    expect((api.calls[0]?.body as { query: string } | undefined)?.query).toContain(
      'r0: repository(owner: "MendyLanda", name: "cut") { stargazerCount }',
    );
  });

  it("fails when GitHub refuses the request", async () => {
    const api = fakeFetch(() => new Response("no", { status: 401 }));
    await expect(fetchStars([{ slug: "cut", repo: "a/b" }], "t", api.fetch)).rejects.toThrow(
      /HTTP 401/,
    );
  });
});

describe("PostHog install counts", () => {
  it("finds the project by Appflare's public project key", async () => {
    const api = fakeFetch(() => ({
      results: [
        { id: 1, api_token: "phc_other" },
        { id: 42, api_token: POSTHOG_PROJECT_API_KEY },
      ],
    }));
    expect(await discoverProjectId("phx_key", api.fetch)).toBe(42);
    expect(api.calls[0]?.url).toBe("https://eu.posthog.com/api/projects/");
    const none = fakeFetch(() => ({ results: [{ id: 1, api_token: "phc_other" }] }));
    await expect(discoverProjectId("phx_key", none.fetch)).rejects.toThrow(/POSTHOG_PROJECT_ID/);
  });

  it("runs both HogQL queries and reads app -> count rows", async () => {
    const api = fakeFetch((url, body) => {
      if (url.endsWith("/api/projects/")) {
        return { results: [{ id: 7, api_token: POSTHOG_PROJECT_API_KEY }] };
      }
      const query = (body as { query: { query: string } }).query.query;
      return query === INSTALLS_30D_QUERY
        ? {
            results: [
              ["cut", 12],
              [null, 3],
            ],
            columns: ["app", "installs"],
          }
        : { results: [["cut", 30]], columns: ["app", "active_installs"] };
    });
    const counts = await fetchInstalls("phx_key", api.fetch);
    expect([...counts.last30d]).toEqual([["cut", 12]]);
    expect([...counts.active]).toEqual([["cut", 30]]);
    expect(api.calls.map((c) => c.url)).toEqual([
      "https://eu.posthog.com/api/projects/",
      "https://eu.posthog.com/api/projects/7/query/",
      "https://eu.posthog.com/api/projects/7/query/",
    ]);
    expect(api.calls[1]?.body).toMatchObject({ query: { kind: "HogQLQuery" } });
  });

  it("skips discovery when the project id is given", async () => {
    const api = fakeFetch(() => ({ results: [] }));
    await hogqlCounts("k", 9, INSTALLS_30D_QUERY, api.fetch);
    await fetchInstalls("k", api.fetch, 9);
    expect(api.calls.every((c) => c.url.includes("/api/projects/9/query/"))).toBe(true);
  });
});

describe("buildStats", () => {
  const targets = [
    { slug: "cut", repo: "MendyLanda/cut" },
    { slug: "r2", repo: null },
  ];
  const previous: CatalogStats = {
    generatedAt: EARLIER,
    apps: {
      cut: {
        stars: { count: 10, fetchedAt: EARLIER },
        installs: { last30d: 11, active: 20, fetchedAt: EARLIER },
      },
    },
    sources: { github: { ok: true, at: EARLIER }, telemetry: { ok: true, at: EARLIER } },
  };

  it("publishes this run's numbers, with install counts below 10 as null", () => {
    const stats = buildStats({
      now: NOW,
      targets,
      stars: { ok: true, value: new Map([["cut", 17]]) },
      installs: {
        ok: true,
        value: { last30d: new Map([["cut", 9]]), active: new Map([["cut", 25]]) },
      },
      previous,
    });
    expect(stats.apps.cut).toEqual({
      stars: { count: 17, fetchedAt: NOW.toISOString() },
      installs: { last30d: null, active: 25, fetchedAt: NOW.toISOString() },
    });
    expect(stats.apps.r2).toEqual({
      stars: null,
      installs: { last30d: null, active: null, fetchedAt: NOW.toISOString() },
    });
    expect(stats.sources.telemetry).toEqual({ ok: true, at: NOW.toISOString() });
  });

  it("carries a failed source's numbers forward and marks it", () => {
    const stats = buildStats({
      now: NOW,
      targets,
      stars: { ok: false, error: "HTTP 502" },
      installs: { ok: false, error: "no key" },
      previous,
    });
    expect(stats.apps.cut).toEqual(previous.apps.cut);
    expect(stats.apps.r2).toEqual({ stars: null, installs: null });
    expect(stats.sources).toEqual({
      github: { ok: false, at: EARLIER },
      telemetry: { ok: false, at: EARLIER },
    });
    const first = buildStats({
      now: NOW,
      targets,
      stars: { ok: false, error: "x" },
      installs: { ok: false, error: "x" },
      previous: null,
    });
    expect(first.sources.github).toEqual({ ok: false, at: null });
  });

  it("reads a previous file only when it is valid", () => {
    expect(parsePreviousStats(JSON.stringify(previous))).toEqual(previous);
    expect(parsePreviousStats("{}")).toBeNull();
    expect(parsePreviousStats("not json")).toBeNull();
    expect(parsePreviousStats(null)).toBeNull();
  });

  it.skipIf(!appflareAvailable)("writes files @appflare/schema accepts, and agrees with it", () => {
    const stats = buildStats({
      now: NOW,
      targets,
      stars: { ok: true, value: new Map([["cut", 17]]) },
      installs: { ok: false, error: "x" },
      previous,
    });
    expect(schema.catalogStats.safeParse(stats).success).toBe(true);
    const low = structuredClone(previous);
    if (low.apps.cut?.installs) low.apps.cut.installs.active = 3;
    expect(schema.catalogStats.safeParse(low).success).toBe(false);
    expect(statsSchema.safeParse(low).success).toBe(false);
  });
});
