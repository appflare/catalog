import { describe, expect, it } from "vitest";
import { createGhBumpHistory, lastBumpTag } from "./bump-history.ts";
import type { GhRequest, GhRunner } from "./gh-api.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("createGhBumpHistory", () => {
  it("lists the app's bump branches and pull requests, reading each list once", () => {
    const calls: string[] = [];
    const run: GhRunner = (request) => {
      expect(request.paginate).toBe(true);
      const target = request.path;
      calls.push(target);
      if (target.startsWith("repos/appflare/catalog/pulls")) {
        return Buffer.from(
          [
            JSON.stringify({
              number: 3,
              head: "bump/cut/1111111",
              headSha: A,
              state: "open",
              createdAt: "2026-09-01T00:00:00Z",
            }),
            JSON.stringify({
              number: 4,
              head: "bump/cutter/2222222",
              headSha: B,
              state: "closed",
              createdAt: "2026-09-02T00:00:00Z",
            }),
          ].join("\n"),
        );
      }
      return Buffer.from(
        "refs/heads/bump/cut/1111111\nrefs/heads/bump/cut/3333333\nrefs/heads/bump/cutter/2222222\n",
      );
    };
    const history = createGhBumpHistory("appflare/catalog", run);
    expect(history.existing("cut")).toEqual({
      branches: ["bump/cut/1111111", "bump/cut/3333333"],
      prs: [
        {
          number: 3,
          head: "bump/cut/1111111",
          headSha: A,
          state: "open",
          createdAt: "2026-09-01T00:00:00Z",
        },
      ],
    });
    expect(history.existing("cutter").branches).toEqual(["bump/cutter/2222222"]);
    expect(calls).toEqual([
      "repos/appflare/catalog/pulls?state=all&per_page=100",
      "repos/appflare/catalog/git/matching-refs/heads/bump/",
    ]);
  });

  it("reports statuses and pull_request check runs, never workflow_dispatch check runs", () => {
    const requests: GhRequest[] = [];
    const run: GhRunner = (request) => {
      requests.push(request);
      if (request.path.endsWith("/statuses")) {
        return Buffer.from("CodeRabbit\nmerge check\n");
      }
      if (request.path.includes("/actions/runs?")) {
        // The pull_request runs' check suites; 22 belongs to a dispatched run.
        return Buffer.from("11\n");
      }
      return Buffer.from(
        [
          JSON.stringify({ name: "commit messages", suite: 11 }),
          JSON.stringify({ name: "verify passed", suite: 22 }),
          JSON.stringify({ name: "merge check", suite: 11 }),
        ].join("\n"),
      );
    };
    const history = createGhBumpHistory("appflare/catalog", run);
    expect(history.reportedChecks(A).sort()).toEqual([
      "CodeRabbit",
      "commit messages",
      "merge check",
    ]);
    expect(requests.map((r) => r.path)).toEqual([
      `repos/appflare/catalog/commits/${A}/statuses`,
      `repos/appflare/catalog/actions/runs?head_sha=${A}&event=pull_request`,
      `repos/appflare/catalog/commits/${A}/check-runs`,
    ]);
    expect(requests.every((r) => r.paginate)).toBe(true);
    expect(() => history.reportedChecks("main")).toThrow();
  });
});

describe("lastBumpTag", () => {
  it("reads the tag of the app's newest bump commit", () => {
    expect(
      lastBumpTag("cut", [
        "docs(cut): describe the settings",
        "chore(cutter): bump to v9.0.0",
        "chore(cut): bump to cut@0.5.5 (#21)",
        "chore(cut): bump to main@1234567",
      ]),
    ).toBe("cut@0.5.5");
    expect(lastBumpTag("cut", ["chore(cut): bump to app-v0.42.1"])).toBe("app-v0.42.1");
  });

  it("is null when the newest bump moved to a branch head or names only the commit", () => {
    expect(
      lastBumpTag("cut", ["chore(cut): bump to main@1234567 (#3)", "chore(cut): bump to v1.0.0"]),
    ).toBe(null);
    expect(lastBumpTag("cut", ["chore(cut): bump to 89abcde"])).toBe(null);
    expect(lastBumpTag("cut", ["feat(cut): add the entry"])).toBe(null);
  });

  it("reads the app manifest's commits on the default branch", () => {
    const requests: GhRequest[] = [];
    const run: GhRunner = (request) => {
      requests.push(request);
      return Buffer.from("chore(cut): bump to stable (#4)\nfeat(cut): add the entry\n");
    };
    expect(createGhBumpHistory("appflare/catalog", run).lastBumpTag("cut")).toBe("stable");
    expect(requests.map((r) => r.path)).toEqual([
      "repos/appflare/catalog/commits?path=apps%2Fcut%2Fappflare.jsonc&per_page=30",
    ]);
  });
});
