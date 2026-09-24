import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pngHeader } from "../fixtures/png.ts";
import {
  altFromFileName,
  mediaReader,
  pngSize,
  publishedMediaFor,
  readAppMedia,
  sha256Hex,
  svgProblems,
} from "./media.ts";

const REPO = "appflare/catalog";
const SITE = "https://appflare.github.io/catalog/apps/demo";
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "catalog-media-"));
  dir = path.join(root, "demo");
  mkdirSync(dir);
  writeFileSync(path.join(dir, "appflare.jsonc"), "{}");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, bytes: Buffer | string) {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), bytes);
}

function sources(...files: string[]) {
  write(
    "MEDIA.md",
    files
      .map((f) => `- \`${f}\`: [upstream](https://github.com/o/r/blob/abc/${f}) (MIT).`)
      .join("\n"),
  );
}

describe("image checks", () => {
  it("reads a PNG's size and refuses anything else", () => {
    expect(pngSize(pngHeader(1200, 630))).toEqual({ width: 1200, height: 630 });
    expect(pngSize(Buffer.from("GIF89a"))).toBeNull();
  });

  it("refuses SVGs that script or load other files", () => {
    expect(svgProblems(SVG)).toEqual([]);
    expect(
      svgProblems('<svg><use href="#a"/><image href="data:image/png;base64,AA"/></svg>'),
    ).toEqual([]);
    const bad = [
      "<svg><script>alert(1)</script></svg>",
      '<svg onload="alert(1)"></svg>',
      "<svg><foreignObject></foreignObject></svg>",
      '<svg><image href="https://tracker.example/p.png"/></svg>',
      '<svg><image xlink:href="other.svg"/></svg>',
      '<svg><rect style="fill:url(https://x.example/a)"/></svg>',
      "<html></html>",
    ];
    for (const text of bad) expect(svgProblems(text).length).toBeGreaterThan(0);
  });

  it("derives screenshot alt text from the file name", () => {
    expect(altFromFileName("01-inbox-view.png")).toBe("Inbox view");
    expect(altFromFileName("dark_mode.png")).toBe("Dark mode");
    expect(altFromFileName("02.png")).toBeNull();
  });
});

describe("readAppMedia", () => {
  it("lists icon, cover and screenshots by Pages URL and digest", () => {
    const icon = Buffer.from(SVG);
    const cover = pngHeader(1200, 630);
    const shot = pngHeader(1280, 800, "a");
    write("icon.svg", icon);
    write("cover.png", cover);
    write("screenshots/02-settings.png", pngHeader(1280, 800, "b"));
    write("screenshots/01-inbox-view.png", shot);
    sources(
      "icon.svg",
      "cover.png",
      "screenshots/01-inbox-view.png",
      "screenshots/02-settings.png",
    );
    const read = readAppMedia(dir, "demo", "Demo", REPO);
    expect(read.problems).toEqual([]);
    expect(read.media?.icon).toEqual({ url: `${SITE}/icon.svg`, sha256: sha256Hex(icon) });
    expect(read.media?.cover).toEqual({ url: `${SITE}/cover.png`, sha256: sha256Hex(cover) });
    expect(read.media?.screenshots.map((s) => s.alt)).toEqual([
      "Demo: Inbox view",
      "Demo: Settings",
    ]);
    expect(read.media?.screenshots[0]?.sha256).toBe(sha256Hex(shot));
    expect(read.files.map((f) => f.rel)).toEqual([
      "apps/demo/icon.svg",
      "apps/demo/cover.png",
      "apps/demo/screenshots/01-inbox-view.png",
      "apps/demo/screenshots/02-settings.png",
    ]);
  });

  it("reports wrong sizes, both icons, stray files and missing sources", () => {
    write("icon.svg", SVG);
    write("icon.png", pngHeader(100, 80));
    write("cover.png", pngHeader(1280, 640));
    write("cover.jpg", "x");
    write("screenshots/01-a.jpg", "x");
    const { problems } = readAppMedia(dir, "demo", "Demo", REPO);
    const text = problems.join("\n");
    expect(text).toMatch(/both icon.svg and icon.png/);
    expect(text).toMatch(/cover.png: 1280x640, must be a 1200x630 PNG/);
    expect(text).toMatch(/cover.jpg: unexpected file/);
    expect(text).toMatch(/screenshots must be .png/);
    expect(text).toMatch(/MEDIA.md: missing/);
  });

  it("accepts an entry with no images, or with only some of them", () => {
    expect(readAppMedia(dir, "demo", "Demo", REPO)).toEqual({
      media: undefined,
      files: [],
      problems: [],
    });
    expect(mediaReader(root, REPO)({ slug: "demo", name: "Demo" })).toBeUndefined();
    write("screenshots/01-inbox.png", pngHeader(1280, 800));
    sources("screenshots/01-inbox.png");
    const read = readAppMedia(dir, "demo", "Demo", REPO);
    expect(read.problems).toEqual([]);
    expect(read.media?.icon).toBeUndefined();
    expect(read.media?.cover).toBeUndefined();
    expect(read.media?.screenshots).toHaveLength(1);
  });

  it("requires MEDIA.md to link the upstream source of each image", () => {
    write("icon.svg", SVG);
    write("MEDIA.md", "- `icon.svg`: drawn for the catalog.\n");
    expect(readAppMedia(dir, "demo", "Demo", REPO).problems).toEqual([
      "apps/demo/MEDIA.md: names `icon.svg` without linking the upstream file it comes from",
    ]);
  });

  it("refuses invalid images in the index", () => {
    write("cover.png", pngHeader(10, 10));
    expect(() => mediaReader(root, REPO)({ slug: "demo", name: "Demo" })).toThrow(
      /media is invalid/,
    );
  });

  it("publishes only files whose digest matches the index", () => {
    write("icon.svg", SVG);
    sources("icon.svg");
    const current = readAppMedia(dir, "demo", "Demo", REPO);
    const row = { slug: "demo", media: current.media };
    expect(publishedMediaFor(row, current).map((f) => f.rel)).toEqual(["apps/demo/icon.svg"]);
    const stale = {
      slug: "demo",
      media: { screenshots: [], icon: { url: `${SITE}/icon.svg`, sha256: "0".repeat(64) } },
    };
    expect(() => publishedMediaFor(stale, current)).toThrow(/rebuild index.json/);
    const gone = {
      slug: "demo",
      media: { screenshots: [], cover: { url: `${SITE}/cover.png`, sha256: "0".repeat(64) } },
    };
    expect(() => publishedMediaFor(gone, current)).toThrow(/no longer has/);
  });
});
