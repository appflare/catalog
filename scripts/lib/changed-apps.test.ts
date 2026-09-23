import { describe, expect, it } from "vitest";
import { declaredTier, filterByTier, isNullSha, slugsFromChangedPaths } from "./changed-apps.ts";

describe("slugsFromChangedPaths", () => {
  it("keeps apps whose appflare.jsonc changed and still exists", () => {
    const exists = (slug: string) => slug !== "deleted";
    expect(
      slugsFromChangedPaths(
        [
          "apps/cut/appflare.jsonc",
          "apps/cut/README.md",
          "apps/zed/appflare.jsonc",
          "apps/deleted/appflare.jsonc",
          "apps/nested/x/appflare.jsonc",
          "scripts/build-index.ts",
          "apps/cut/appflare.jsonc",
          "",
        ],
        exists,
      ),
    ).toEqual(["cut", "zed"]);
  });
});

describe("isNullSha", () => {
  it("treats missing and all-zero SHAs as null", () => {
    expect(isNullSha(undefined)).toBe(true);
    expect(isNullSha("")).toBe(true);
    expect(isNullSha("0000000000000000000000000000000000000000")).toBe(true);
    expect(isNullSha("6056400d47530aa87e4ae5764b37ffca9d00e87f")).toBe(false);
  });
});

describe("declaredTier", () => {
  it("reads install.tier, counting anything missing or unknown as artifact", () => {
    expect(declaredTier({ install: { tier: "sandbox" } })).toBe("sandbox");
    expect(declaredTier({ install: { tier: "self-deploying" } })).toBe("self-deploying");
    expect(declaredTier({ install: { tier: "artifact" } })).toBe("artifact");
    expect(declaredTier({ install: { tier: "docker" } })).toBe("artifact");
    expect(declaredTier({ install: {} })).toBe("artifact");
    expect(declaredTier({ install: null })).toBe("artifact");
    expect(declaredTier([])).toBe("artifact");
    expect(declaredTier(null)).toBe("artifact");
  });
});

describe("filterByTier", () => {
  it("keeps the apps of the given tiers, in order", () => {
    const tiers: Record<string, string> = { a: "artifact", b: "sandbox", c: "self-deploying" };
    const tierOf = (slug: string) => tiers[slug] ?? "artifact";
    expect(filterByTier(["a", "b", "c"], tierOf, ["artifact", "sandbox"])).toEqual(["a", "b"]);
    expect(filterByTier(["a", "b", "c"], tierOf, ["artifact"])).toEqual(["a"]);
    expect(filterByTier(["c"], tierOf, ["artifact", "sandbox"])).toEqual([]);
  });
});
