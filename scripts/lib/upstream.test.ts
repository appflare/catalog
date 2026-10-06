import { describe, expect, it } from "vitest";
import { GhNotFoundError, type GhRequest, type GhRunner } from "./gh-api.ts";
import {
  COMPARE_FILES_LIMIT,
  compareSemver,
  createGhUpstream,
  isPrereleaseTag,
  newestStableTag,
  parseStableTag,
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

describe("createGhUpstream", () => {
  function gh(routes: Record<string, string>): GhRunner & { calls: string[] } {
    const calls: string[] = [];
    const fn = ((request: GhRequest) => {
      const target = request.path;
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

  it("lists every tag with its commit, across pages", () => {
    const run = gh({
      "repos/o/r/tags?per_page=100": [
        JSON.stringify({ name: "v1.2.0", sha: sha("1") }),
        JSON.stringify({ name: "app-v1.10.0", sha: sha("2") }),
        JSON.stringify({ name: "v2.0.0-rc.1", sha: sha("3") }),
      ].join("\n"),
    });
    expect(createGhUpstream(run).tags("o/r")).toEqual([
      { name: "v1.2.0", sha: sha("1") },
      { name: "app-v1.10.0", sha: sha("2") },
      { name: "v2.0.0-rc.1", sha: sha("3") },
    ]);
    expect(run.calls).toEqual(["repos/o/r/tags?per_page=100"]);
  });

  it("lists no tags for an untagged repository", () => {
    expect(createGhUpstream(gh({ "repos/o/r/tags?per_page=100": "" })).tags("o/r")).toEqual([]);
  });

  it("reads the default branch under its current name, with its head commit", () => {
    const run = gh({
      "repos/o/r": "trunk",
      "repos/o/r/commits/trunk": sha("9"),
    });
    expect(createGhUpstream(run).defaultBranch("o/r")).toEqual({ name: "trunk", sha: sha("9") });
  });

  it("reads a branch's head, and null for a branch upstream does not have", () => {
    const run = gh({
      "repos/o/r/branches/release%2F2.x": JSON.stringify({ name: "release/2.x", sha: sha("7") }),
    });
    const upstream = createGhUpstream(run);
    expect(upstream.branch("o/r", "release/2.x")).toEqual({ name: "release/2.x", sha: sha("7") });
    expect(upstream.branch("o/r", "main")).toBe(null);
  });

  it("reads a branch GitHub redirects to another name as gone", () => {
    const run = gh({ "repos/o/r/branches/main": JSON.stringify({ name: "trunk", sha: sha("7") }) });
    expect(createGhUpstream(run).branch("o/r", "main")).toBe(null);
  });

  it("throws any failure reading a branch other than 404", () => {
    const run = (() => {
      throw new Error("gh api GET repos/o/r/branches/main: HTTP 502");
    }) as GhRunner;
    expect(() => createGhUpstream(run).branch("o/r", "main")).toThrow("HTTP 502");
  });

  it("propagates API failures", () => {
    expect(() => createGhUpstream(gh({})).tags("o/missing")).toThrow(/HTTP 404/);
    expect(() => createGhUpstream(gh({})).defaultBranch("o/missing")).toThrow(/HTTP 404/);
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

describe("relation", () => {
  it("reads ahead_by and behind_by from the compare API", () => {
    const run = ((request: GhRequest) => {
      expect(request.path).toBe(`repos/o/r/compare/${sha("a")}...${sha("b")}`);
      return Buffer.from("0 3\n");
    }) as GhRunner;
    expect(createGhUpstream(run).relation("o/r", sha("a"), sha("b"))).toEqual({
      ahead: 0,
      behind: 3,
    });
  });

  describe("when the compare API answers 404", () => {
    const COMPARE = `repos/o/r/compare/${sha("a")}...${sha("b")}`;
    const runner = (found: string[]) => {
      const calls: string[] = [];
      const run = ((request: GhRequest) => {
        calls.push(request.path);
        if (request.path === COMPARE) {
          throw new GhNotFoundError(`gh api GET ${COMPARE}: HTTP 404 (gh: No common ancestor)`);
        }
        const commit = /^repos\/o\/r\/commits\/([0-9a-f]{40})$/.exec(request.path)?.[1];
        if (commit && found.includes(commit)) {
          expect(request.jq).toBe(".sha");
          return Buffer.from(`${commit}\n`);
        }
        throw new GhNotFoundError(`gh api GET ${request.path}: HTTP 404`);
      }) as GhRunner;
      return { run, calls };
    };

    it("is null when both commits exist: they share no history", () => {
      const { run, calls } = runner([sha("a"), sha("b")]);
      expect(createGhUpstream(run).relation("o/r", sha("a"), sha("b"))).toBe(null);
      expect(calls).toEqual([
        COMPARE,
        `repos/o/r/commits/${sha("a")}`,
        `repos/o/r/commits/${sha("b")}`,
      ]);
    });

    it("throws the compare error when either commit is gone", () => {
      for (const found of [[sha("a")], [sha("b")], []]) {
        expect(() =>
          createGhUpstream(runner(found).run).relation("o/r", sha("a"), sha("b")),
        ).toThrow("No common ancestor");
      }
    });

    it("throws any other failure while checking the commits", () => {
      const run = ((request: GhRequest) => {
        if (request.path === COMPARE) {
          throw new GhNotFoundError("HTTP 404");
        }
        throw new Error("HTTP 502");
      }) as GhRunner;
      expect(() => createGhUpstream(run).relation("o/r", sha("a"), sha("b"))).toThrow("HTTP 502");
    });
  });

  it("rejects an unexpected answer", () => {
    const run = (() => Buffer.from("null null")) as GhRunner;
    expect(() => createGhUpstream(run).relation("o/r", sha("a"), sha("b"))).toThrow(
      /unexpected compare/,
    );
  });
});

describe("changedFiles", () => {
  const listing = (count: number | null, paths: string[]) =>
    (() => Buffer.from(`${JSON.stringify({ count, paths })}\n`)) as GhRunner;

  it("reads file names from the compare API", () => {
    const run = ((request: GhRequest) => {
      expect(request.path).toBe(`repos/o/r/compare/${sha("a")}...${sha("b")}`);
      return Buffer.from(JSON.stringify({ count: 2, paths: ["a/x.ts", "b/y.ts", "a/old.ts"] }));
    }) as GhRunner;
    expect(createGhUpstream(run).changedFiles("o/r", sha("a"), sha("b"))).toEqual({
      paths: ["a/x.ts", "b/y.ts", "a/old.ts"],
      complete: true,
    });
  });

  it("marks a list GitHub may have cut short, or a missing one, as incomplete", () => {
    const paths = Array.from({ length: COMPARE_FILES_LIMIT }, (_, i) => `f${i}`);
    expect(
      createGhUpstream(listing(COMPARE_FILES_LIMIT, paths)).changedFiles("o/r", sha("a"), sha("b"))
        .complete,
    ).toBe(false);
    expect(
      createGhUpstream(listing(null, [])).changedFiles("o/r", sha("a"), sha("b")).complete,
    ).toBe(false);
    expect(createGhUpstream(listing(0, [])).changedFiles("o/r", sha("a"), sha("b")).complete).toBe(
      true,
    );
  });
});
