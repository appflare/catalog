import { describe, expect, it } from "vitest";
import { createGhBumpHistory } from "./bump-history.ts";
import type { GhRunner } from "./github-releases.ts";

describe("createGhBumpHistory", () => {
  it("lists the app's bump branches and pull requests, reading pull requests once", () => {
    const calls: string[] = [];
    const run: GhRunner = (args) => {
      const target = args[2] as string;
      calls.push(target);
      if (target.startsWith("repos/appflare/catalog/pulls")) {
        return Buffer.from(
          [
            JSON.stringify({
              number: 3,
              head: "bump/cut/1111111",
              state: "open",
              createdAt: "2026-09-01T00:00:00Z",
            }),
            JSON.stringify({
              number: 4,
              head: "bump/cutter/2222222",
              state: "closed",
              createdAt: "2026-09-02T00:00:00Z",
            }),
          ].join("\n"),
        );
      }
      return Buffer.from("refs/heads/bump/cut/1111111\n");
    };
    const history = createGhBumpHistory("appflare/catalog", run);
    expect(history.existing("cut")).toEqual({
      branches: ["bump/cut/1111111"],
      prs: [
        { number: 3, head: "bump/cut/1111111", state: "open", createdAt: "2026-09-01T00:00:00Z" },
      ],
    });
    history.existing("cutter");
    expect(calls).toEqual([
      "repos/appflare/catalog/pulls?state=all&per_page=100",
      "repos/appflare/catalog/git/matching-refs/heads/bump/cut/",
      "repos/appflare/catalog/git/matching-refs/heads/bump/cutter/",
    ]);
  });
});
