import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { sandboxFixture, selfDeployingFixture } from "../fixtures/sandbox-manifest.ts";
import { testSchema } from "../fixtures/schema.ts";
import { findApp, loadManifest } from "./apps.ts";
import { tierProblems } from "./tier-rules.ts";
import type { CatalogManifest } from "./types.ts";

const fixtureApps = path.join(import.meta.dirname, "..", "fixtures", "apps");

let hello: CatalogManifest;
let built: CatalogManifest;
let seo: CatalogManifest;

beforeAll(async () => {
  const schema = await testSchema();
  hello = loadManifest(findApp(fixtureApps, "hello"), schema.catalogManifest);
  built = sandboxFixture(hello, schema);
  seo = selfDeployingFixture(hello, schema);
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
    expect(tierProblems({ ...seo, bump: { autoMerge: true } })).toEqual([
      "- bump.autoMerge: not allowed on a self-deploying tier entry; CI does not install it, " +
        "so a maintainer must merge each bump",
    ]);
    expect(tierProblems({ ...seo, bump: { autoMerge: false } })).toEqual([]);
  });

  it("accepts a complete self-deploying entry, with or without a build command", () => {
    expect(tierProblems(seo)).toEqual([]);
    expect(
      tierProblems({ ...seo, install: { ...seo.install, buildCommand: "pnpm build" } }),
    ).toEqual([]);
  });

  it("requires a self-deploying entry to be on the paid plan", () => {
    expect(tierProblems({ ...seo, plan: "free" })).toEqual([
      '- plan: must be "paid"; a self-deploying entry\'s installer runs in a container in ' +
        "the user's account, which needs Workers Paid",
    ]);
  });

  it("requires a self-deploying entry to describe its installer", () => {
    const { selfDeploying: _, ...install } = seo.install;
    const problems = tierProblems({ ...seo, install });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^- install\.selfDeploying: a self-deploying tier entry must/);
  });

  it("requires a self-deploying entry to list its token's permissions", () => {
    const problems = tierProblems({ ...seo, tokenPermissions: [] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^- tokenPermissions: a self-deploying tier entry must list/);
  });

  it("keeps sandbox rules off self-deploying entries and the reverse", () => {
    // No buildCommand on a self-deploying entry is fine; tokenPermissions on a sandbox one too.
    expect(seo.install.buildCommand).toBeUndefined();
    expect(tierProblems({ ...built, tokenPermissions: [] })).toEqual([]);
  });

  it("lists every problem at once", () => {
    const { buildCommand: _, ...install } = built.install;
    expect(
      tierProblems({ ...built, plan: "free", install, bump: { autoMerge: true } }),
    ).toHaveLength(3);
    const { selfDeploying: _sd, ...seoInstall } = seo.install;
    expect(
      tierProblems({
        ...seo,
        plan: "free",
        install: seoInstall,
        tokenPermissions: [],
        bump: { autoMerge: true },
      }),
    ).toHaveLength(4);
  });
});
