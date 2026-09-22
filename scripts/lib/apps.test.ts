import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appflareAvailable, testSchema } from "../fixtures/schema.ts";
import type { Parser } from "./appflare-schema.ts";
import { findApp, listApps, loadManifest } from "./apps.ts";
import { appsDir } from "./paths.ts";
import type { CatalogManifest } from "./types.ts";

const fixtureApps = path.join(import.meta.dirname, "..", "fixtures", "apps");

describe("listApps / findApp", () => {
  it("lists folders that contain appflare.jsonc, sorted", () => {
    expect(listApps(fixtureApps).map((a) => a.slug)).toEqual(["hello"]);
    expect(listApps(path.join(fixtureApps, "nope"))).toEqual([]);
  });

  it("names the expected path for an unknown slug", () => {
    expect(() => findApp(fixtureApps, "nope")).toThrow(/nope\/appflare\.jsonc/);
  });
});

describe("loadManifest layout rules", () => {
  // Pass-through parser: these are the catalog's own rules, not the schema's.
  const passthrough: Parser<CatalogManifest> = {
    safeParse: (input) => ({ success: true, data: input as CatalogManifest }),
  };

  it.each<[string, (m: Record<string, unknown>) => void]>([
    [
      "slug must match its folder",
      (m) => {
        m.slug = "other";
      },
    ],
    [
      "$schema must be the v1 URL",
      (m) => {
        m.$schema = "https://example.com/schema.json";
      },
    ],
    [
      "maintainers must not be empty",
      (m) => {
        m.maintainers = [];
      },
    ],
  ])("%s", (_name, edit) => {
    const root = mkdtempSync(path.join(tmpdir(), "catalog-apps-test-"));
    try {
      cpSync(path.join(fixtureApps, "hello"), path.join(root, "hello"), { recursive: true });
      const manifest: Record<string, unknown> = {
        $schema: "https://appflare.github.io/catalog/schema/v1.json",
        slug: "hello",
        maintainers: ["octocat"],
      };
      edit(manifest);
      writeFileSync(path.join(root, "hello", "appflare.jsonc"), JSON.stringify(manifest));
      expect(() => loadManifest(findApp(root, "hello"), passthrough)).toThrow(/is invalid/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!appflareAvailable)("committed catalog manifests", () => {
  it("every apps/<slug>/appflare.jsonc is valid", async () => {
    const schema = await testSchema();
    const apps = listApps(appsDir);
    expect(apps.length).toBeGreaterThan(0);
    for (const app of apps) {
      expect(loadManifest(app, schema.catalogManifest).slug).toBe(app.slug);
    }
  });

  it("reports schema issues with their paths", async () => {
    const schema = await testSchema();
    const root = mkdtempSync(path.join(tmpdir(), "catalog-apps-test-"));
    try {
      cpSync(path.join(fixtureApps, "hello"), path.join(root, "hello"), { recursive: true });
      writeFileSync(
        path.join(root, "hello", "appflare.jsonc"),
        JSON.stringify({ slug: "hello", source: { ref: "main", sha: "short" } }),
      );
      const app = findApp(root, "hello");
      expect(() => loadManifest(app, schema.catalogManifest)).toThrow(/- source\.sha: /);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
