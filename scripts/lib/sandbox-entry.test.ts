import { createHash } from "node:crypto";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { sandboxFixture } from "../fixtures/sandbox-manifest.ts";
import { testSchema } from "../fixtures/schema.ts";
import type { AppflareSchema } from "./appflare-schema.ts";
import { findApp, loadManifest } from "./apps.ts";
import {
  pagesBaseUrl,
  publishedManifestBytes,
  publishedManifestFor,
  publishedManifestUrl,
  sandboxBuild,
} from "./sandbox-entry.ts";
import type { CatalogManifest } from "./types.ts";

const fixtureApps = path.join(import.meta.dirname, "..", "fixtures", "apps");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

let schema: AppflareSchema;
let built: CatalogManifest;

beforeAll(async () => {
  schema = await testSchema();
  const hello = loadManifest(findApp(fixtureApps, "hello"), schema.catalogManifest);
  built = sandboxFixture(hello, schema);
});

describe("published manifest URL", () => {
  it("is the catalog's GitHub Pages site plus apps/<slug>/manifest.json", () => {
    expect(pagesBaseUrl("appflare/catalog")).toBe("https://appflare.github.io/catalog/");
    expect(pagesBaseUrl("Someone/Fork")).toBe("https://someone.github.io/Fork/");
    expect(pagesBaseUrl("someone/someone.github.io")).toBe("https://someone.github.io/");
    expect(publishedManifestUrl("appflare/catalog", "built")).toBe(
      "https://appflare.github.io/catalog/apps/built/manifest.json",
    );
  });
});

describe("publishedManifestBytes", () => {
  it("sorts keys at every level, so key order in appflare.jsonc does not change the digest", () => {
    const text = publishedManifestBytes(built).toString("utf8");
    expect(text.endsWith("}\n")).toBe(true);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
    expect(Object.keys(parsed.install as object)).toEqual(
      [...Object.keys(parsed.install as object)].sort(),
    );
    const reordered = Object.fromEntries(Object.entries(built).reverse()) as CatalogManifest;
    expect(publishedManifestBytes(reordered).equals(publishedManifestBytes(built))).toBe(true);
    expect(parsed).toEqual(JSON.parse(JSON.stringify(built)));
  });
});

describe("sandboxBuild", () => {
  it("pins the source, points at the published manifest, and fills in the defaults", () => {
    expect(sandboxBuild(built, "appflare/catalog", schema.sandboxDefaults)).toEqual({
      pin: built.source.sha,
      manifest: "https://appflare.github.io/catalog/apps/built/manifest.json",
      manifestDigest: sha256(publishedManifestBytes(built)),
      buildCommand: "pnpm run build",
      expectedMinutes: 10,
      instanceType: "standard-1",
    });
  });

  it("takes expected minutes and the container size from install.sandbox", () => {
    const bigger = sandboxFixture(built, schema, {
      sandbox: { expectedMinutes: 25, instanceType: "standard-2" },
    });
    expect(sandboxBuild(bigger, "appflare/catalog", schema.sandboxDefaults)).toMatchObject({
      expectedMinutes: 25,
      instanceType: "standard-2",
    });
  });
});

describe("publishedManifestFor", () => {
  const repo = "appflare/catalog";
  const row = () => ({ slug: "built", build: sandboxBuild(built, repo, schema.sandboxDefaults) });

  it("returns exactly the bytes whose digest the row lists", () => {
    const bytes = publishedManifestFor(row(), built, repo);
    expect(sha256(bytes)).toBe(row().build.manifestDigest);
  });

  it("refuses a row built from another version of the manifest", () => {
    const edited = { ...built, summary: "Edited after the index was built." };
    expect(() => publishedManifestFor(row(), edited, repo)).toThrow(/rebuild index\.json/);
    const moved = { ...built, source: { ...built.source, sha: "f".repeat(40) } };
    expect(() => publishedManifestFor(row(), moved, repo)).toThrow(/pins/);
    expect(() => publishedManifestFor(row(), built, "someone/fork")).toThrow(/site serves/);
    expect(() => publishedManifestFor({ slug: "built" }, built, repo)).toThrow(/no build block/);
  });
});
