import { describe, expect, it } from "vitest";
import { isNullSha, slugsFromChangedPaths } from "./changed-apps.ts";

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
