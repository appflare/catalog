import { describe, expect, it } from "vitest";
import { testSchema } from "../fixtures/schema.ts";
import { artifactUrls } from "./index-builder.ts";
import { patchLastVerified } from "./record-verified.ts";
import type { IndexApp, IndexJson } from "./types.ts";

const D = "d".repeat(64);
const NOW = new Date("2026-09-24T03:00:00.000Z");

function row(slug: string, version: string, digest = D): IndexApp {
  return {
    slug,
    name: slug,
    summary: "s",
    version,
    artifacts: artifactUrls("appflare/catalog", slug, version),
    digest,
    tier: "artifact",
    plan: "free",
    requires: [],
    lastVerified: null,
    maintainers: ["octocat"],
  };
}

const index: IndexJson = {
  generatedAt: "2026-09-20T00:00:00.000Z",
  apps: [row("cut", "0.1.0"), row("other", "2.0.0"), row("third", "1.0.0")],
};

describe("patchLastVerified", () => {
  it("sets lastVerified only on rows matching slug, version, and digest", async () => {
    const result = patchLastVerified(
      index,
      {
        cut: { version: "0.1.0", digest: D, at: "2026-09-24T02:59:00.000Z" },
        other: { version: "1.9.0", digest: D, at: "2026-09-24T02:59:00.000Z" },
        third: { version: "1.0.0", digest: "e".repeat(64), at: "2026-09-24T02:59:00.000Z" },
      },
      NOW,
    );
    expect(result.updated).toEqual(["cut"]);
    expect(result.unmatched).toEqual(["other", "third"]);
    expect(result.index.apps.map((a) => [a.slug, a.lastVerified])).toEqual([
      ["cut", "2026-09-24T02:59:00.000Z"],
      ["other", null],
      ["third", null],
    ]);
    expect(result.index.generatedAt).toBe(NOW.toISOString());
    const schema = await testSchema();
    expect(schema.indexJson.safeParse(result.index).success).toBe(true);
  });

  it("never drops or adds apps, even when every check failed or names unknown apps", () => {
    const result = patchLastVerified(
      index,
      { ghost: { version: "1.0.0", digest: D, at: "2026-09-24T02:59:00.000Z" } },
      NOW,
    );
    expect(result.index.apps).toEqual(index.apps);
    expect(result.index.generatedAt).toBe(index.generatedAt);
    expect(result.unmatched).toEqual(["ghost"]);
    expect(patchLastVerified(index, {}, NOW).index).toEqual(index);
  });
});

describe("patchLastVerified for sandbox tier rows", () => {
  const M = "a".repeat(64);
  const sandboxRow: IndexApp = {
    slug: "built",
    name: "Built",
    summary: "s",
    version: "1.0.0",
    tier: "sandbox",
    plan: "paid",
    requires: [],
    lastVerified: null,
    maintainers: ["octocat"],
    build: {
      pin: "0".repeat(40),
      manifest: "https://appflare.github.io/catalog/apps/built/manifest.json",
      manifestDigest: M,
      expectedMinutes: 10,
      instanceType: "standard-1",
    },
  };
  const sandboxIndex: IndexJson = { generatedAt: index.generatedAt, apps: [sandboxRow] };

  it("matches the row by build.manifestDigest", () => {
    const at = "2026-09-24T02:59:00.000Z";
    const result = patchLastVerified(
      sandboxIndex,
      { built: { version: "1.0.0", digest: M, at } },
      NOW,
    );
    expect(result.updated).toEqual(["built"]);
    expect(result.unmatched).toEqual([]);
    expect(result.index.apps[0]).toEqual({ ...sandboxRow, lastVerified: at });
  });

  it("does not record a check of another manifest", () => {
    const result = patchLastVerified(
      sandboxIndex,
      { built: { version: "1.0.0", digest: D, at: "2026-09-24T02:59:00.000Z" } },
      NOW,
    );
    expect(result.updated).toEqual([]);
    expect(result.unmatched).toEqual(["built"]);
  });
});
