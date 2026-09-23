import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { sandboxFixture } from "../fixtures/sandbox-manifest.ts";
import { testSchema } from "../fixtures/schema.ts";
import { findApp, loadManifest } from "./apps.ts";
import { tierProblems } from "./tier-rules.ts";
import type { CatalogManifest } from "./types.ts";

const fixtureApps = path.join(import.meta.dirname, "..", "fixtures", "apps");

let hello: CatalogManifest;
let built: CatalogManifest;

beforeAll(async () => {
  const schema = await testSchema();
  hello = loadManifest(findApp(fixtureApps, "hello"), schema.catalogManifest);
  built = sandboxFixture(hello, schema);
});

describe("tierProblems", () => {
  it("accepts artifact entries and complete sandbox entries", () => {
    expect(tierProblems(hello)).toEqual([]);
    expect(tierProblems({ ...hello, bump: { autoMerge: true } })).toEqual([]);
    expect(tierProblems(built)).toEqual([]);
  });

  it("requires a sandbox entry to be on the paid plan", () => {
    expect(tierProblems({ ...built, plan: "free" })).toEqual([
      '- plan: must be "paid"; a sandbox tier entry is built in a container in the ' +
        "user's account, which needs Workers Paid",
    ]);
  });

  it("requires a sandbox entry to declare install.buildCommand", () => {
    const { buildCommand: _, ...install } = built.install;
    const problems = tierProblems({ ...built, install });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^- install\.buildCommand: a sandbox tier entry must declare/);
  });

  it("refuses bump.autoMerge on tiers CI does not install", () => {
    expect(tierProblems({ ...built, bump: { autoMerge: true } })).toEqual([
      "- bump.autoMerge: not allowed on a sandbox tier entry; CI does not install it, so a " +
        "maintainer must merge each bump",
    ]);
    expect(tierProblems({ ...built, bump: { autoMerge: false } })).toEqual([]);
    const selfDeploying = {
      ...hello,
      install: { ...hello.install, tier: "self-deploying" as const },
      bump: { autoMerge: true },
    };
    expect(tierProblems(selfDeploying)).toHaveLength(1);
  });

  it("lists every problem at once", () => {
    const { buildCommand: _, ...install } = built.install;
    expect(
      tierProblems({ ...built, plan: "free", install, bump: { autoMerge: true } }),
    ).toHaveLength(3);
  });
});
