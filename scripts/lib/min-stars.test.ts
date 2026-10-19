import { describe, expect, it } from "vitest";
import {
  addedApps,
  belowMinimum,
  countStars,
  MIN_STARS,
  rejectionComment,
  starsRepo,
} from "./min-stars.ts";
import type { FetchLike } from "./stats.ts";

describe("addedApps", () => {
  it("keeps only manifests the pull request adds", () => {
    expect(
      addedApps([
        { filename: "apps/zed/appflare.jsonc", status: "added" },
        { filename: "apps/cut/appflare.jsonc", status: "modified" },
        { filename: "apps/new/README.md", status: "added" },
        { filename: "apps/moved/appflare.jsonc", status: "renamed" },
        { filename: "apps/nested/x/appflare.jsonc", status: "added" },
        { filename: "apps/abc/appflare.jsonc", status: "added" },
        { filename: "CODEOWNERS", status: "modified" },
      ]),
    ).toEqual([
      { slug: "abc", path: "apps/abc/appflare.jsonc" },
      { slug: "zed", path: "apps/zed/appflare.jsonc" },
    ]);
  });
});

describe("starsRepo", () => {
  it("counts upstreamRepo when set, else repo", () => {
    expect(starsRepo(`{ "repo": "a/fork", // packaging fork\n "upstreamRepo": "b/main", }`)).toBe(
      "b/main",
    );
    expect(starsRepo(`{ "repo": "a/app" }`)).toBe("a/app");
  });

  it("refuses a manifest without a valid repo", () => {
    expect(() => starsRepo(`{ "slug": "x" }`)).toThrow(/no valid repo/);
    expect(() => starsRepo(`{ "repo": "https://github.com/a/b" }`)).toThrow(/no valid repo/);
  });
});

describe("countStars and belowMinimum", () => {
  it("flags repositories under the bar, not ones GitHub cannot find", async () => {
    const fetch: FetchLike = async () =>
      Response.json({
        data: {
          r0: { stargazerCount: MIN_STARS },
          r1: { stargazerCount: MIN_STARS - 1 },
          r2: null,
        },
      });
    const results = await countStars(
      [
        { slug: "big", repo: "a/big" },
        { slug: "small", repo: "a/small" },
        { slug: "gone", repo: "a/gone" },
      ],
      "t",
      fetch,
    );
    expect(results).toEqual([
      { slug: "big", repo: "a/big", stars: MIN_STARS },
      { slug: "small", repo: "a/small", stars: MIN_STARS - 1 },
      { slug: "gone", repo: "a/gone", stars: null },
    ]);
    expect(belowMinimum(results).map((r) => r.slug)).toEqual(["small"]);
    expect(belowMinimum(results, 0)).toEqual([]);
  });
});

describe("rejectionComment", () => {
  it("names each app, its repository and stars, and the bar", () => {
    const comment = rejectionComment(
      [
        { slug: "small", repo: "a/small", stars: 1 },
        { slug: "tiny", repo: "a/tiny", stars: 12 },
      ],
      "appflare/catalog",
    );
    expect(comment).toContain(`at least ${MIN_STARS} GitHub stars`);
    expect(comment).toContain("- `small`: [a/small](https://github.com/a/small) has 1 star\n");
    expect(comment).toContain("- `tiny`: [a/tiny](https://github.com/a/tiny) has 12 stars");
    expect(comment).toContain(
      "https://github.com/appflare/catalog/blob/main/CONTRIBUTING.md#catalog-policy",
    );
  });
});
