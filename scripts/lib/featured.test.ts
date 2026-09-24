import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pngHeader } from "../fixtures/png.ts";
import { appflareAvailable, testSchema } from "../fixtures/schema.ts";
import type { AppflareSchema } from "./appflare-schema.ts";
import { publishedFeaturedFor, readFeatured } from "./featured.ts";
import { sha256Hex } from "./media.ts";
import { catalogRoot } from "./paths.ts";

const REPO = "appflare/catalog";
let schema: AppflareSchema;
let root: string;

const item = {
  id: "acme-2026-10",
  title: "Acme Edge",
  text: "Deploy faster.",
  sponsor: { name: "Acme", url: "https://acme.example" },
  link: { url: "https://acme.example/edge", label: "Learn more" },
};

beforeAll(async () => {
  schema = await testSchema();
});

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "catalog-featured-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeFeatured(items: unknown) {
  writeFileSync(path.join(root, "featured.json"), JSON.stringify(items));
}

describe("readFeatured", () => {
  it("reads the catalog's own featured.json, empty from the first release", () => {
    expect(readFeatured(catalogRoot, REPO, schema.featuredItem)).toEqual({ items: [], files: [] });
  });

  it("reads no items without a featured.json", () => {
    expect(readFeatured(root, REPO, schema.featuredItem).items).toEqual([]);
  });

  it("fills in an item's image URL and digest from featured/<id>.png", () => {
    const image = pngHeader(1200, 630);
    mkdirSync(path.join(root, "featured"));
    writeFileSync(path.join(root, "featured", `${item.id}.png`), image);
    writeFeatured([{ ...item, image: { alt: "Acme Edge" } }]);
    const read = readFeatured(root, REPO, schema.featuredItem);
    expect(read.items[0]?.image).toEqual({
      url: `https://appflare.github.io/catalog/featured/${item.id}.png`,
      sha256: sha256Hex(image),
      alt: "Acme Edge",
    });
    expect(publishedFeaturedFor(read.items, read).map((f) => f.rel)).toEqual([
      `featured/${item.id}.png`,
    ]);
  });

  it("refuses a missing or wrongly sized image, stray files and duplicate ids", () => {
    writeFeatured([{ ...item, image: { alt: "A" } }]);
    expect(() => readFeatured(root, REPO, schema.featuredItem)).toThrow(/does not exist/);
    mkdirSync(path.join(root, "featured"));
    writeFileSync(path.join(root, "featured", `${item.id}.png`), pngHeader(800, 600));
    writeFileSync(path.join(root, "featured", "old.png"), pngHeader(1200, 630));
    expect(() => readFeatured(root, REPO, schema.featuredItem)).toThrow(
      /must be a 1200x630 PNG[\s\S]*old.png: no item/,
    );
    writeFeatured([item, item]);
    rmSync(path.join(root, "featured"), { recursive: true });
    expect(() => readFeatured(root, REPO, schema.featuredItem)).toThrow(/duplicate id/);
    writeFeatured({ not: "an array" });
    expect(() => readFeatured(root, REPO, schema.featuredItem)).toThrow(/JSON array/);
  });

  it.skipIf(!appflareAvailable)("validates items with @appflare/schema", () => {
    const { link: _link, ...unlinked } = item;
    writeFeatured([unlinked]);
    expect(() => readFeatured(root, REPO, schema.featuredItem)).toThrow(/link or a slug/);
    writeFeatured([{ ...item, link: { url: "http://acme.example", label: "Go" } }]);
    expect(() => readFeatured(root, REPO, schema.featuredItem)).toThrow(/https/);
  });
});
