import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { formatIssues, type Parser } from "./appflare-schema.ts";
import { COVER_HEIGHT, COVER_WIDTH, type MediaFile, pngSize, sha256Hex } from "./media.ts";
import { pagesBaseUrl } from "./sandbox-entry.ts";
import type { FeaturedItem } from "./types.ts";

/**
 * The sponsored slot. `featured.json` holds the items, in display order;
 * each item's image, when it has one, is `featured/<id>.png` (1200x630, like
 * an app cover) and is published with the Pages site, so the manager never
 * loads anything from a sponsor's servers. build-index copies the items into
 * `index.json` with the image's URL and sha256 filled in; the array is
 * written even while it is empty.
 *
 * In `featured.json` an item is written like the published one, except that
 * `image` holds only `alt`: its URL and digest come from the file.
 */

export const FEATURED_FILE = "featured.json";
export const FEATURED_DIR = "featured";
const MAX_IMAGE_BYTES = 1024 * 1024;

export interface FeaturedContent {
  items: FeaturedItem[];
  /** Images to publish, at `featured/<id>.png` in the site. */
  files: MediaFile[];
}

/**
 * Reads `featured.json` and `featured/`, validating each item with
 * `@appflare/schema`'s `featuredItemSchema`. Throws listing every problem.
 * A missing `featured.json` reads as no items.
 */
export function readFeatured(
  root: string,
  repo: string,
  parser: Parser<FeaturedItem>,
): FeaturedContent {
  const file = path.join(root, FEATURED_FILE);
  if (!existsSync(file)) return { items: [], files: [] };
  let authored: unknown;
  try {
    authored = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${FEATURED_FILE}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(authored)) {
    throw new Error(`${FEATURED_FILE}: must be a JSON array of items`);
  }
  const problems: string[] = [];
  const items: FeaturedItem[] = [];
  const files: MediaFile[] = [];
  const ids = new Set<string>();
  const imageDir = path.join(root, FEATURED_DIR);
  authored.forEach((entry: unknown, i) => {
    const label = `${FEATURED_FILE}[${i}]`;
    if (typeof entry !== "object" || entry === null) {
      problems.push(`${label}: must be an object`);
      return;
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    let published: Record<string, unknown> = { ...record };
    if (record.image !== undefined) {
      const alt = (record.image as { alt?: unknown } | null)?.alt;
      const rel = `${FEATURED_DIR}/${id}.png`;
      const imagePath = path.join(root, rel);
      if (!existsSync(imagePath)) {
        problems.push(`${label}: has an image but ${rel} does not exist`);
        return;
      }
      const bytes = readFileSync(imagePath);
      const size = pngSize(bytes);
      if (size === null || size.width !== COVER_WIDTH || size.height !== COVER_HEIGHT) {
        problems.push(`${rel}: must be a ${COVER_WIDTH}x${COVER_HEIGHT} PNG`);
      }
      if (bytes.length > MAX_IMAGE_BYTES) {
        problems.push(`${rel}: ${bytes.length} bytes, more than ${MAX_IMAGE_BYTES}`);
      }
      const sha256 = sha256Hex(bytes);
      files.push({ rel, bytes, sha256 });
      published = { ...record, image: { url: `${pagesBaseUrl(repo)}${rel}`, sha256, alt } };
    }
    const result = parser.safeParse(published);
    if (!result.success) {
      problems.push(`${label} is invalid:\n${formatIssues(result.error.issues)}`);
      return;
    }
    if (ids.has(result.data.id)) {
      problems.push(`${label}: duplicate id "${result.data.id}"`);
      return;
    }
    ids.add(result.data.id);
    items.push(result.data);
  });
  if (existsSync(imageDir)) {
    for (const name of readdirSync(imageDir)) {
      if (!ids.has(name.replace(/\.png$/, "")) || !name.endsWith(".png")) {
        problems.push(`${FEATURED_DIR}/${name}: no item in ${FEATURED_FILE} uses it`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(problems.join("\n"));
  }
  return { items, files };
}

/**
 * The images to publish for the index's featured items, checked against the
 * digests `index.json` lists.
 */
export function publishedFeaturedFor(
  items: readonly FeaturedItem[],
  current: FeaturedContent,
): MediaFile[] {
  const out: MediaFile[] = [];
  for (const item of items) {
    if (item.image === undefined) continue;
    const { url, sha256 } = item.image;
    const match = current.files.find((f) => url.endsWith(`/${f.rel}`));
    if (match === undefined || match.sha256 !== sha256) {
      throw new Error(
        `featured item ${item.id}: ${url} (sha256 ${sha256}) does not match ${FEATURED_DIR}/; rebuild index.json`,
      );
    }
    out.push(match);
  }
  return out;
}
