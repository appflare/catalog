import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { appflareAvailable, appflareDir } from "../fixtures/schema.ts";
import { indexAuthors } from "./authors.ts";
import { appflarePaths } from "./paths.ts";
import type { CatalogAuthor, CatalogManifest } from "./types.ts";

const listed: CatalogAuthor[] = [
  { name: "Gabriel Massadas", url: "https://massadas.com", github: "G4brym", x: "G4brym" },
  { name: "Cloudflare", url: "https://www.cloudflare.com", github: "cloudflare" },
];

const cases: Pick<CatalogManifest, "authors" | "repo">[] = [
  { repo: "cloudflare/templates", authors: listed },
  { repo: "willswire/unifi-ddns" },
  { repo: "not_a.login/repo" },
];

describe("indexAuthors", () => {
  it("lists the manifest's authors as written", () => {
    expect(indexAuthors({ repo: "cloudflare/templates", authors: listed })).toEqual(listed);
  });

  it("falls back to the repository owner, linked to GitHub", () => {
    expect(indexAuthors({ repo: "willswire/unifi-ddns" })).toEqual([
      { name: "willswire", github: "willswire" },
    ]);
  });

  it("leaves out the GitHub link for an owner that is not a GitHub login", () => {
    expect(indexAuthors({ repo: "not_a.login/repo" })).toEqual([{ name: "not_a.login" }]);
  });
});

describe.skipIf(!appflareAvailable)("indexAuthors and @appflare/schema", () => {
  it("follow the same rule as catalogAuthors()", async () => {
    const mod = (await import(pathToFileURL(appflarePaths(appflareDir).schemaDist).href)) as {
      catalogAuthors?: (manifest: Pick<CatalogManifest, "authors" | "repo">) => CatalogAuthor[];
    };
    expect(typeof mod.catalogAuthors).toBe("function");
    for (const manifest of cases) {
      expect(indexAuthors(manifest)).toEqual(mod.catalogAuthors?.(manifest));
    }
  });
});
