import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listApps } from "./apps.ts";
import { CODEOWNERS_HEADER, readOwnership, renderCodeowners } from "./codeowners.ts";
import { appsDir, codeownersFile } from "./paths.ts";

const fixtureApps = path.join(import.meta.dirname, "..", "fixtures", "apps");

describe("renderCodeowners", () => {
  it("writes one line per app with @-prefixed, de-duplicated owners, sorted by slug", () => {
    const out = renderCodeowners([
      { slug: "zeta", maintainers: ["alice"] },
      { slug: "alpha", maintainers: ["@bob", "bob", "acme/team"] },
    ]);
    expect(out).toBe(
      `${CODEOWNERS_HEADER}\n/apps/alpha/ @bob @acme/team\n/apps/zeta/ @alice\n\n` +
        "/featured.json @MendyLanda\n/featured/ @MendyLanda\n",
    );
  });

  it("reads maintainers from the fixture manifest", () => {
    expect(readOwnership(listApps(fixtureApps))).toEqual([
      { slug: "hello", maintainers: ["octocat", "@example/maintainers"] },
    ]);
  });
});

describe("committed CODEOWNERS", () => {
  it("matches what gen-codeowners generates from apps/", () => {
    expect(readFileSync(codeownersFile, "utf8")).toBe(
      renderCodeowners(readOwnership(listApps(appsDir))),
    );
  });
});
