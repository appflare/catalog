import { describe, expect, it } from "vitest";
import { GhApiError, GhNotFoundError, type GhRequest, type GhRunner } from "./gh-api.ts";
import {
  createGhReleaseLookup,
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

/** A fake gh: routes by the request's API path. */
function fakeGh(routes: {
  repo?: () => Buffer;
  tag?: (path: string) => Buffer;
  list?: () => Buffer;
  asset?: () => Buffer;
}): GhRunner & { calls: GhRequest[] } {
  const calls: GhRequest[] = [];
  const fn = ((request: GhRequest) => {
    calls.push(request);
    const target = request.path;
    if (target === "repos/appflare/catalog") {
      return (routes.repo ?? (() => Buffer.from("appflare/catalog")))();
    }
    if (target.includes("/releases/tags/")) {
      return (routes.tag ?? notFound)(target);
    }
    if (target.includes("/releases/assets/")) {
      expect(request.accept).toBe("application/octet-stream");
      return (routes.asset ?? (() => Buffer.from('{"app":"cut"}')))();
    }
    if (target.includes("/releases?")) {
      expect(request.paginate).toBe(true);
      return (routes.list ?? (() => Buffer.from("")))();
    }
    throw new Error(`unexpected gh call ${target}`);
  }) as GhRunner & { calls: GhRequest[] };
  fn.calls = calls;
  return fn;
}

const listing =
  (...releases: GitHubRelease[]) =>
  () =>
    Buffer.from(releases.map((r) => `${JSON.stringify(r)}\n`).join(""));

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
  it("answers from one listing of the releases and downloads the manifest.json", () => {
    const gh = fakeGh({ list: listing(release("cut@0.1.0"), release("glance@1.0.0")) });
    const lookup = createGhReleaseLookup("appflare/catalog", gh);
    expect(lookup.byTag("cut@0.1.0")).toEqual({
      tag: "cut@0.1.0",
      manifestBytes: Buffer.from('{"app":"cut"}'),
    });
    expect(lookup.byTag("glance@1.0.0")?.tag).toBe("glance@1.0.0");
    expect(gh.calls.map((c) => c.path)).toEqual([
      "repos/appflare/catalog",
      "repos/appflare/catalog/releases?per_page=100",
      "repos/appflare/catalog/releases/assets/2",
      "repos/appflare/catalog/releases/assets/2",
    ]);
  });

  it("asks for a tag the listing lacks by name", () => {
    const gh = fakeGh({ tag: () => Buffer.from(JSON.stringify(release("cut@0.1.0"))) });
    expect(createGhReleaseLookup("appflare/catalog", gh).byTag("cut@0.1.0")?.tag).toBe("cut@0.1.0");
    expect(gh.calls.map((c) => c.path)).toEqual([
      "repos/appflare/catalog",
      "repos/appflare/catalog/releases?per_page=100",
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

  it("fails on any other API error, naming the release", () => {
    const lookup = createGhReleaseLookup(
      "appflare/catalog",
      fakeGh({
        tag: () => {
          throw new GhApiError("gh api GET repos/x failed after 5 attempts: HTTP 502", 502, 5);
        },
      }),
    );
    expect(() => lookup.byTag("cut@9.9.9")).toThrow(/looking up release cut@9\.9\.9: .*HTTP 502/);
  });

  it("names the release whose manifest.json download failed", () => {
    const lookup = createGhReleaseLookup(
      "appflare/catalog",
      fakeGh({
        list: listing(release("cut@0.1.0")),
        asset: () => {
          throw new GhApiError("gh api GET repos/x failed after 5 attempts: HTTP 502", 502, 5);
        },
      }),
    );
    expect(() => lookup.byTag("cut@0.1.0")).toThrow(
      /^downloading manifest\.json of release cut@0\.1\.0: gh api GET/,
    );
  });

  it("lists once: a failed listing fails every later lookup without calling gh again", () => {
    const gh = fakeGh({
      list: () => {
        throw new GhApiError("gh api GET repos/x failed after 5 attempts: HTTP 502", 502, 5);
      },
    });
    const lookup = createGhReleaseLookup("appflare/catalog", gh);
    expect(() => lookup.byTag("cut@0.1.0")).toThrow(/listing the releases of appflare\/catalog/);
    expect(() => lookup.byTag("glance@1.0.0")).toThrow(/listing the releases/);
    expect(gh.calls).toHaveLength(2);
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
    const lookup = createGhReleaseLookup("appflare/catalog", fakeGh({ list: listing(draft) }));
    expect(() => lookup.byTag("cut@0.1.0")).toThrow(/cut@0\.1\.0 .* is a draft/);
  });

  it("prefers the published release when a draft names the same tag", () => {
    const lookup = createGhReleaseLookup(
      "appflare/catalog",
      fakeGh({
        list: listing(release("cut@0.1.0", { draft: true }), release("cut@0.1.0")),
      }),
    );
    expect(lookup.byTag("cut@0.1.0")?.tag).toBe("cut@0.1.0");
  });
});
