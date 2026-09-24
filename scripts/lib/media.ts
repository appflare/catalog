import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pagesBaseUrl } from "./sandbox-entry.ts";
import type { IndexMedia, IndexMediaFile } from "./types.ts";

/**
 * Catalog media: an entry's images live next to its manifest and are
 * published with the Pages site at the same path, addressed in `index.json`
 * by URL and sha256. Every image is optional; an entry without an icon is
 * shown with a monogram the manager draws from its name.
 *
 *   apps/<slug>/icon.svg or icon.png   square icon for lists (at most one of the two)
 *   apps/<slug>/cover.png              1200x630 cover, sized for OpenGraph previews
 *   apps/<slug>/screenshots/*.png      in file name order
 *   apps/<slug>/MEDIA.md               where each image comes from and its licence
 *
 * Images come from the upstream project only, never generated. A
 * screenshot's alt text comes from its file name: `01-inbox-view.png` reads
 * "Inbox view". Every image must be named in `MEDIA.md` on a line that links
 * the upstream file it was taken from, so each file's source is on record.
 */

export const COVER_WIDTH = 1200;
export const COVER_HEIGHT = 630;
export const MIN_ICON_PX = 128;
export const MAX_ICON_PX = 1024;
export const MAX_SCREENSHOTS = 8;
const MAX_ICON_BYTES = 256 * 1024;
const MAX_COVER_BYTES = 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
const MIN_SCREENSHOT_PX = 320;
const MAX_SCREENSHOT_PX = 2560;

/** The file that records where each image of an entry comes from. */
export const MEDIA_SOURCES_FILE = "MEDIA.md";

/** Files an app folder may hold besides its media. */
const OTHER_FILES = new Set(["appflare.jsonc", "README.md", MEDIA_SOURCES_FILE]);

/** One image to publish: its path in the repository and in the site, and its bytes. */
export interface MediaFile {
  /** Path relative to the catalog root and to the site root (they are the same). */
  rel: string;
  bytes: Buffer;
  sha256: string;
}

export interface AppMedia {
  /** The row's `media` block; undefined when the entry has no images. */
  media: IndexMedia | undefined;
  files: MediaFile[];
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from a PNG's IHDR chunk, or null when the bytes are not a PNG. */
export function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * Problems that make an SVG unsafe or unfit to publish: scripts, event
 * handlers, embedded HTML, and references to anything outside the file (an
 * `<img>` would not load them, but the file is also served on its own).
 */
export function svgProblems(text: string): string[] {
  const problems: string[] = [];
  if (!/<svg[\s>]/i.test(text)) problems.push("is not an SVG document");
  if (/<script[\s>]/i.test(text)) problems.push("contains a <script>");
  if (/<foreignObject[\s>]/i.test(text)) problems.push("contains a <foreignObject>");
  if (/\son[a-z]+\s*=/i.test(text)) problems.push("has an event handler attribute (on...=)");
  if (/(?:xlink:)?href\s*=\s*["']\s*(?!#|data:image\/)/i.test(text)) {
    problems.push("references another file (only #fragment and data:image/ links are allowed)");
  }
  if (/url\(\s*["']?\s*(?!#|data:image\/)/i.test(text)) {
    problems.push("uses url() with something other than a #fragment or data:image/");
  }
  if (/<!ENTITY/i.test(text)) problems.push("declares an XML entity");
  return problems;
}

/** "01-inbox-view.png" -> "Inbox view"; null when nothing readable is left. */
export function altFromFileName(file: string): string | null {
  const words = path
    .basename(file, path.extname(file))
    .replace(/^\d+[-_ .]*/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return words === "" ? null : words.charAt(0).toUpperCase() + words.slice(1);
}

function readChecked(file: string, maxBytes: number, label: string, problems: string[]): Buffer {
  const bytes = readFileSync(file);
  if (bytes.length > maxBytes) {
    problems.push(`${label}: ${bytes.length} bytes, more than ${maxBytes}`);
  }
  return bytes;
}

/**
 * Reads and checks an app folder's images. Returns the row's `media` block,
 * the files to publish, and every problem found (the caller decides whether
 * problems are fatal).
 */
export function readAppMedia(
  appDir: string,
  slug: string,
  name: string,
  repo: string,
): AppMedia & { problems: string[] } {
  const problems: string[] = [];
  const files: MediaFile[] = [];
  const base = `apps/${slug}`;
  const site = pagesBaseUrl(repo);
  const add = (relInApp: string, bytes: Buffer): IndexMediaFile => {
    const rel = `${base}/${relInApp}`;
    const sha256 = sha256Hex(bytes);
    files.push({ rel, bytes, sha256 });
    return { url: `${site}${rel}`, sha256 };
  };

  const entries = existsSync(appDir) ? readdirSync(appDir) : [];
  for (const entry of entries) {
    if (
      OTHER_FILES.has(entry) ||
      ["icon.svg", "icon.png", "cover.png", "screenshots"].includes(entry)
    ) {
      continue;
    }
    problems.push(
      `${base}/${entry}: unexpected file (media is icon.svg|icon.png, cover.png, screenshots/*.png)`,
    );
  }

  const media: IndexMedia = { screenshots: [] };
  const svgIcon = path.join(appDir, "icon.svg");
  const pngIcon = path.join(appDir, "icon.png");
  if (existsSync(svgIcon) && existsSync(pngIcon)) {
    problems.push(`${base}: has both icon.svg and icon.png; keep one`);
  }
  if (existsSync(svgIcon)) {
    const bytes = readChecked(svgIcon, MAX_ICON_BYTES, `${base}/icon.svg`, problems);
    for (const p of svgProblems(bytes.toString("utf8"))) problems.push(`${base}/icon.svg: ${p}`);
    media.icon = add("icon.svg", bytes);
  } else if (existsSync(pngIcon)) {
    const bytes = readChecked(pngIcon, MAX_ICON_BYTES, `${base}/icon.png`, problems);
    const size = pngSize(bytes);
    if (size === null) {
      problems.push(`${base}/icon.png: not a PNG`);
    } else if (size.width !== size.height || size.width < MIN_ICON_PX || size.width > MAX_ICON_PX) {
      problems.push(
        `${base}/icon.png: ${size.width}x${size.height}, must be square, ${MIN_ICON_PX} to ${MAX_ICON_PX} px`,
      );
    }
    media.icon = add("icon.png", bytes);
  }

  const cover = path.join(appDir, "cover.png");
  if (existsSync(cover)) {
    const bytes = readChecked(cover, MAX_COVER_BYTES, `${base}/cover.png`, problems);
    const size = pngSize(bytes);
    if (size === null || size.width !== COVER_WIDTH || size.height !== COVER_HEIGHT) {
      problems.push(
        `${base}/cover.png: ${size === null ? "not a PNG" : `${size.width}x${size.height}`}, must be a ${COVER_WIDTH}x${COVER_HEIGHT} PNG`,
      );
    }
    media.cover = add("cover.png", bytes);
  }

  const shotsDir = path.join(appDir, "screenshots");
  if (existsSync(shotsDir) && statSync(shotsDir).isDirectory()) {
    const shots = readdirSync(shotsDir).sort();
    if (shots.length > MAX_SCREENSHOTS) {
      problems.push(`${base}/screenshots: ${shots.length} files, at most ${MAX_SCREENSHOTS}`);
    }
    for (const shot of shots) {
      const rel = `screenshots/${shot}`;
      if (!shot.endsWith(".png")) {
        problems.push(`${base}/${rel}: screenshots must be .png files`);
        continue;
      }
      const bytes = readChecked(
        path.join(shotsDir, shot),
        MAX_SCREENSHOT_BYTES,
        `${base}/${rel}`,
        problems,
      );
      const size = pngSize(bytes);
      if (
        size === null ||
        Math.min(size.width, size.height) < MIN_SCREENSHOT_PX ||
        Math.max(size.width, size.height) > MAX_SCREENSHOT_PX
      ) {
        problems.push(
          `${base}/${rel}: ${size === null ? "not a PNG" : `${size.width}x${size.height}`}, each side must be ${MIN_SCREENSHOT_PX} to ${MAX_SCREENSHOT_PX} px`,
        );
      }
      const label = altFromFileName(shot);
      media.screenshots.push({
        ...add(rel, bytes),
        alt: label === null ? `${name} screenshot` : `${name}: ${label}`,
      });
    }
  }

  if (files.length > 0) {
    const sourcesPath = path.join(appDir, MEDIA_SOURCES_FILE);
    const sources = existsSync(sourcesPath) ? readFileSync(sourcesPath, "utf8") : null;
    if (sources === null) {
      problems.push(`${base}/${MEDIA_SOURCES_FILE}: missing; record where each image comes from`);
    } else {
      const lines = sources.split("\n");
      for (const file of files) {
        const relInApp = file.rel.slice(base.length + 1);
        const naming = lines.filter((line) => line.includes(`\`${relInApp}\``));
        if (naming.length === 0) {
          problems.push(
            `${base}/${MEDIA_SOURCES_FILE}: does not name \`${relInApp}\` and its source`,
          );
        } else if (!naming.some((line) => line.includes("https://"))) {
          problems.push(
            `${base}/${MEDIA_SOURCES_FILE}: names \`${relInApp}\` without linking the upstream file it comes from`,
          );
        }
      }
    }
  }

  const empty =
    media.icon === undefined && media.cover === undefined && media.screenshots.length === 0;
  return { media: empty ? undefined : media, files, problems };
}

/**
 * The bytes to publish for a row's media, checked against what the row
 * promises: build-site refuses to publish images whose digest differs from
 * `index.json` (the manager would refuse to show them).
 */
export function publishedMediaFor(
  row: { slug: string; media?: IndexMedia },
  current: AppMedia,
): MediaFile[] {
  const listed: IndexMediaFile[] = [
    ...(row.media?.icon ? [row.media.icon] : []),
    ...(row.media?.cover ? [row.media.cover] : []),
    ...(row.media?.screenshots ?? []),
  ];
  const out: MediaFile[] = [];
  for (const file of listed) {
    const match = current.files.find((f) => file.url.endsWith(`/${f.rel}`));
    if (match === undefined) {
      throw new Error(
        `${row.slug}: index.json lists ${file.url}, which apps/${row.slug}/ no longer has; rebuild index.json`,
      );
    }
    if (match.sha256 !== file.sha256) {
      throw new Error(
        `${row.slug}: ${match.rel} has sha256 ${match.sha256}, but index.json lists ${file.sha256}; rebuild index.json`,
      );
    }
    out.push(match);
  }
  return out;
}

/**
 * `mediaFor` for build-index: each entry's `media` block from its folder
 * under `appsDir`. Throws, listing every problem, when an image is invalid.
 */
export function mediaReader(
  appsDir: string,
  repo: string,
): (manifest: { slug: string; name: string }) => IndexMedia | undefined {
  return (manifest) => {
    const read = readAppMedia(
      path.join(appsDir, manifest.slug),
      manifest.slug,
      manifest.name,
      repo,
    );
    if (read.problems.length > 0) {
      throw new Error(`apps/${manifest.slug} media is invalid:\n- ${read.problems.join("\n- ")}`);
    }
    return read.media;
  };
}
