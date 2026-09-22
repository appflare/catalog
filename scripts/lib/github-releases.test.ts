import { describe, expect, it } from "vitest";
import {
  createGhReleaseLookup,
  GhNotFoundError,
  type GhRunner,
  type GitHubRelease,
  IncompleteReleaseError,
  manifestAssetId,
  parseTag,
  releaseAssetNames,
} from "./github-releases.ts";

function release(tag: string, overrides: Partial<GitHubRelease> = {}): GitHubRelease {
  const { slug, version } = parseTag(tag);
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/appflare/catalog/releases/tag/${tag}`,
    assets: releaseAssetNames(slug, version).map((name, i) => ({ id: i + 1, name })),
    ...overrides,
  };
}

const notFound = () => {
  throw new GhNotFoundError("gh: Not Found (HTTP 404)");
};

/** A fake gh: routes by the API path in args[1] (or args[2] with --paginate). */
function fakeGh(routes: {
  repo?: () => Buffer;
  tag?: (path: string) => Buffer;
  list?: () => Buffer;
  asset?: () => Buffer;
}): GhRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = ((args: string[]) => {
    calls.push(args);
    const target = args[1] === "--paginate" ? args[2] : args[1] === "-H" ? args[3] : args[1];
    if (target === "repos/appflare/catalog") {
      return (routes.repo ?? (() => Buffer.from("appflare/catalog")))();
    }
    if (target?.includes("/releases/tags/")) {
      return (routes.tag ?? notFound)(target);
    }
    if (target?.includes("/releases/assets/")) {
      return (routes.asset ?? (() => Buffer.from('{"app":"cut"}')))();
    }
    if (target?.includes("/releases?")) {
      return (routes.list ?? (() => Buffer.from("")))();
    }
    throw new Error(`unexpected gh call ${args.join(" ")}`);
  }) as GhRunner & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

describe("parseTag", () => {
  it("splits <slug>@<version> at the first @", () => {
    expect(parseTag("cut@0.0.0-20260826.6056400")).toEqual({
      slug: "cut",
      version: "0.0.0-20260826.6056400",
    });
    expect(() => parseTag("cut")).toThrow(/not a <slug>@<version> tag/);
    expect(() => parseTag("cut@")).toThrow();
  });
});

describe("manifestAssetId", () => {
  it("returns the manifest.json asset of a complete, published release", () => {
    expect(manifestAssetId(release("cut@0.1.0"))).toBe(2);
  });

  it.each<[string, Partial<GitHubRelease>, RegExp]>([
    ["a draft", { draft: true }, /is a draft/],
    ["a prerelease", { prerelease: true }, /is a prerelease/],
    [
      "a release missing assets",
      { assets: [{ id: 9, name: "manifest.json" }] },
      /is missing cut-0\.1\.0\.zip, manifest\.sig/,
    ],
  ])("rejects %s, naming the release", (_name, overrides, message) => {
    const run = () => manifestAssetId(release("cut@0.1.0", overrides));
    expect(run).toThrow(IncompleteReleaseError);
    expect(run).toThrow(message);
    expect(run).toThrow(/release cut@0\.1\.0 \(https:\/\/github\.com\//);
  });
});

describe("createGhReleaseLookup", () => {
  it("gets the release by exact tag and downloads its manifest.json", () => {
    const gh = fakeGh({ tag: () => Buffer.from(JSON.stringify(release("cut@0.1.0"))) });
    expect(createGhReleaseLookup("appflare/catalog", gh).byTag("cut@0.1.0")).toEqual({
      tag: "cut@0.1.0",
      manifestBytes: Buffer.from('{"app":"cut"}'),
    });
    expect(gh.calls.map((c) => (c[1] === "-H" ? c[3] : c[1]))).toEqual([
      "repos/appflare/catalog",
      "repos/appflare/catalog/releases/tags/cut%400.1.0",
      "repos/appflare/catalog/releases/assets/2",
    ]);
  });

  it("treats a per-tag 404 as absent once the repository is reachable", () => {
    const lookup = createGhReleaseLookup("appflare/catalog", fakeGh({}));
    expect(lookup.byTag("cut@9.9.9")).toBe(null);
  });

  it("fails when the repository itself is not found", () => {
    const lookup = createGhReleaseLookup("appflare/catalog", fakeGh({ repo: notFound }));
    expect(() => lookup.byTag("cut@9.9.9")).toThrow(/repository appflare\/catalog was not found/);
  });

  it("fails on any other API error", () => {
    const lookup = createGhReleaseLookup(
      "appflare/catalog",
      fakeGh({
        tag: () => {
          throw new Error("gh api failed: HTTP 502");
        },
      }),
    );
    expect(() => lookup.byTag("cut@9.9.9")).toThrow(/HTTP 502/);
  });

  it("fails, naming the release, when the tag belongs to an incomplete release", () => {
    const incomplete = release("cut@0.1.0", { assets: [] });
    const lookup = createGhReleaseLookup(
      "appflare/catalog",
      fakeGh({ tag: () => Buffer.from(JSON.stringify(incomplete)) }),
    );
    expect(() => lookup.byTag("cut@0.1.0")).toThrow(IncompleteReleaseError);
  });

  it("fails when a draft uses the tag (the tag endpoint does not return drafts)", () => {
    const draft = release("cut@0.1.0", { draft: true });
    const lookup = createGhReleaseLookup(
      "appflare/catalog",
      fakeGh({ list: () => Buffer.from(`${JSON.stringify(draft)}\n`) }),
    );
    expect(() => lookup.byTag("cut@0.1.0")).toThrow(/cut@0\.1\.0 .* is a draft/);
  });
});
