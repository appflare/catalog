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
