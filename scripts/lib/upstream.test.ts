import { describe, expect, it } from "vitest";
import { GhNotFoundError, type GhRunner } from "./github-releases.ts";
import {
  compareSemver,
  createGhUpstream,
  isPrereleaseTag,
  newestStableTag,
  parseStableTag,
  pickUpstreamTarget,
} from "./upstream.ts";

const sha = (c: string) => c.repeat(40);

describe("parseStableTag", () => {
  it("accepts stable semver tags with or without v", () => {
    expect(parseStableTag("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseStableTag("10.0.1")).toEqual({ major: 10, minor: 0, patch: 1 });
    expect(parseStableTag("v1.2.3+build.5")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it("ignores prereleases and non-semver tags", () => {
    for (const tag of ["v1.2.3-rc.1", "1.0.0-beta", "v1.2", "release-1", "v01.2.3", "latest"]) {
      expect(parseStableTag(tag)).toBe(null);
    }
  });
});

describe("newestStableTag", () => {
  it("orders by semver, not by listing order or string order", () => {
    const tags = [
      { name: "v1.10.0", sha: sha("a") },
      { name: "v1.9.9", sha: sha("b") },
      { name: "v2.0.0-rc.1", sha: sha("c") },
      { name: "v1.2.30", sha: sha("d") },
    ];
    expect(newestStableTag(tags)).toEqual({ name: "v1.10.0", sha: sha("a") });
    expect(
      compareSemver({ major: 1, minor: 10, patch: 0 }, { major: 1, minor: 9, patch: 9 }),
    ).toBeGreaterThan(0);
  });

  it("returns null when only prereleases exist", () => {
    expect(newestStableTag([{ name: "v3.0.0-alpha", sha: sha("a") }])).toBe(null);
  });
});

describe("pickUpstreamTarget", () => {
  const branch = { name: "main", sha: sha("f") };

  it("prefers the newest stable tag", () => {
    expect(pickUpstreamTarget([{ name: "v0.2.0", sha: sha("2") }], branch)).toEqual({
      ref: "v0.2.0",
      sha: sha("2"),
      kind: "tag",
    });
  });

  it("falls back to the default branch head without stable tags", () => {
    expect(pickUpstreamTarget([{ name: "v1.0.0-rc.1", sha: sha("1") }], branch)).toEqual({
      ref: "main",
      sha: sha("f"),
      kind: "branch",
    });
  });
});

describe("createGhUpstream", () => {
  function gh(routes: Record<string, string>): GhRunner & { calls: string[] } {
    const calls: string[] = [];
    const fn = ((args: string[]) => {
      const target = args[1] === "--paginate" ? (args[2] as string) : (args[1] as string);
      calls.push(target);
      const body = routes[target];
      if (body === undefined) {
        throw new GhNotFoundError(`gh: Not Found (HTTP 404) ${target}`);
      }
      return Buffer.from(body);
    }) as GhRunner & { calls: string[] };
    fn.calls = calls;
    return fn;
  }

  it("resolves a tagged repository to its newest stable tag without reading branches", () => {
    const run = gh({
      "repos/o/r/tags?per_page=100": [
        JSON.stringify({ name: "v1.2.0", sha: sha("1") }),
        JSON.stringify({ name: "v1.10.0", sha: sha("2") }),
        JSON.stringify({ name: "v2.0.0-rc.1", sha: sha("3") }),
      ].join("\n"),
    });
    expect(createGhUpstream(run).resolve("o/r")).toEqual({
      ref: "v1.10.0",
      sha: sha("2"),
      kind: "tag",
    });
    expect(run.calls).toEqual(["repos/o/r/tags?per_page=100"]);
  });

  it("resolves an untagged repository to its default branch head", () => {
    const run = gh({
      "repos/o/r/tags?per_page=100": "",
      "repos/o/r": "trunk",
      "repos/o/r/commits/trunk": sha("9"),
    });
    expect(createGhUpstream(run).resolve("o/r")).toEqual({
      ref: "trunk",
      sha: sha("9"),
      kind: "branch",
    });
  });

  it("propagates API failures", () => {
    expect(() => createGhUpstream(gh({})).resolve("o/missing")).toThrow(/HTTP 404/);
  });
});

describe("isPrereleaseTag", () => {
  it("recognizes semver prereleases only", () => {
    expect(isPrereleaseTag("v2.0.0-rc.1")).toBe(true);
    expect(isPrereleaseTag("1.0.0-beta+exp")).toBe(true);
    expect(isPrereleaseTag("v2.0.0")).toBe(false);
    expect(isPrereleaseTag("main")).toBe(false);
  });
});
