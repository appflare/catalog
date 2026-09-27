import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ADDED_LOG_ARGS,
  gitIn,
  parseAddedTimes,
  previousAddedTimes,
  readAddedTimes,
} from "./added-at.ts";

describe("parseAddedTimes", () => {
  it("keeps the oldest time each manifest was added, ignoring other paths", () => {
    const log = [
      "\u00012026-09-25T10:00:00+00:00",
      "",
      "apps/cut/appflare.jsonc",
      "\u00012026-09-20T09:00:00+02:00",
      "",
      "apps/drop/appflare.jsonc",
      "apps/drop/extra/appflare.jsonc",
      "\u00012026-09-10T08:00:00+00:00",
      "",
      "apps/cut/appflare.jsonc",
      "",
    ].join("\n");
    expect([...parseAddedTimes(log)]).toEqual([
      ["cut", "2026-09-10T08:00:00+00:00"],
      ["drop", "2026-09-20T09:00:00+02:00"],
    ]);
  });

  it("reads an empty log as no times", () => {
    expect(parseAddedTimes("").size).toBe(0);
  });

  it("asks git for additions only, renames as additions", () => {
    expect(ADDED_LOG_ARGS).toEqual(expect.arrayContaining(["--diff-filter=A", "--no-renames"]));
  });
});

describe("previousAddedTimes", () => {
  it("reads the rows that have addedAt", () => {
    const rows = [{ slug: "cut", addedAt: "2026-09-10T08:00:00Z" }, { slug: "drop" }];
    expect([...previousAddedTimes(rows)]).toEqual([["cut", "2026-09-10T08:00:00Z"]]);
  });
});

describe("readAddedTimes", () => {
  let dir: string;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (cwd: string, args: string[], date?: string) => {
    const res = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      env: date === undefined ? env : { ...env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
    });
    if (res.status !== 0) throw new Error(res.stderr);
  };
  const write = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "catalog-added-at-"));
    git(dir, ["init", "--quiet", "--initial-branch=main"]);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("dates each entry by the commit that first added its manifest", () => {
    write("apps/cut/appflare.jsonc", "{}");
    git(dir, ["add", "."]);
    git(dir, ["commit", "--quiet", "-m", "add cut"], "2026-09-01T10:00:00+02:00");
    write("apps/cut/appflare.jsonc", '{ "edited": true }');
    write("apps/drop/appflare.jsonc", "{}");
    git(dir, ["add", "."]);
    git(dir, ["commit", "--quiet", "-m", "edit cut, add drop"], "2026-09-05T12:00:00+00:00");
    git(dir, ["mv", "apps/drop", "apps/drops"]);
    git(dir, ["commit", "--quiet", "-m", "rename drop"], "2026-09-07T12:00:00+00:00");
    expect(Object.fromEntries(readAddedTimes(gitIn(dir)))).toEqual({
      cut: "2026-09-01T10:00:00+02:00",
      drop: "2026-09-05T12:00:00Z",
      drops: "2026-09-07T12:00:00Z",
    });
  });

  it("refuses a shallow clone", () => {
    for (const [i, slug] of ["a", "b"].entries()) {
      write(`apps/${slug}/appflare.jsonc`, "{}");
      git(dir, ["add", "."]);
      git(dir, ["commit", "--quiet", "-m", slug], `2026-09-0${i + 1}T00:00:00+00:00`);
    }
    const shallow = `${dir}-shallow`;
    try {
      git(tmpdir(), ["clone", "--quiet", "--depth", "1", `file://${dir}`, shallow]);
      expect(() => readAddedTimes(gitIn(shallow))).toThrow(/shallow.*fetch-depth: 0/);
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
  });
});
