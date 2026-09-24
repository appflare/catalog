import { createHash } from "node:crypto";
import { COVER_HEIGHT, COVER_WIDTH } from "./media.ts";

/**
 * SVG artwork for entries without an upstream image: a 1200x630 cover from
 * the entry's name and summary (with its icon, when it has one) and a
 * square monogram icon. `gen-media.ts` renders them to PNG. Colours come
 * from the slug, so an entry always gets the same ones.
 */

export const GENERATED_ICON_PX = 512;

/** Fonts the renderer tries, in order; the first one installed wins. */
export const FONT_FAMILY = "Inter, 'Open Sans', 'Noto Sans', 'DejaVu Sans', Arial, sans-serif";

/** A hue (0-359) derived from the slug. */
export function hueFor(slug: string): number {
  return createHash("sha256").update(slug).digest().readUInt16BE(0) % 360;
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Splits `text` into at most `maxLines` lines of at most `width` characters,
 * breaking between words; the last line ends in an ellipsis when text is cut.
 */
export function wrapText(text: string, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  const words = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] as string;
    const next = line === "" ? word : `${line} ${word}`;
    if (next.length <= width || line === "") {
      line = next;
      continue;
    }
    lines.push(line);
    line = word;
    if (lines.length === maxLines) {
      let last = (lines[maxLines - 1] as string).replace(/[\s,.;:]+$/, "");
      // Drop whole words until the ellipsis fits.
      while (last.length + 1 > width && last.includes(" ")) {
        last = last.slice(0, last.lastIndexOf(" ")).replace(/[\s,.;:]+$/, "");
      }
      lines[maxLines - 1] = `${last}…`;
      return lines;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** Up to two initials: "Second Brain" -> "SB", "mail2telegram" -> "M". */
export function initials(name: string): string {
  const words = name.split(/[\s-]+/).filter((w) => /[A-Za-z0-9]/.test(w));
  const letters = words.slice(0, 2).map((w) => (w.match(/[A-Za-z0-9]/)?.[0] ?? "").toUpperCase());
  return letters.join("") || "?";
}

export interface CoverInput {
  slug: string;
  name: string;
  summary: string;
  /** `owner/name` of the upstream repository, shown at the bottom. */
  repo: string;
  /** The entry's icon as a data URI, drawn beside the name. */
  iconDataUri?: string;
}

export function coverSvg(input: CoverInput): string {
  const hue = hueFor(input.slug);
  const left = input.iconDataUri === undefined ? 96 : 96 + 176 + 48;
  const nameSize = input.name.length > 18 ? 64 : 80;
  const summary = wrapText(input.summary, input.iconDataUri === undefined ? 50 : 40, 3);
  const summaryTop = 300 + (nameSize - 64);
  const icon =
    input.iconDataUri === undefined
      ? ""
      : `<rect x="96" y="171" width="176" height="176" rx="36" fill="#ffffff" fill-opacity="0.96"/>
  <image x="116" y="191" width="136" height="136" href="${input.iconDataUri}" preserveAspectRatio="xMidYMid meet"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${COVER_WIDTH}" height="${COVER_HEIGHT}" viewBox="0 0 ${COVER_WIDTH} ${COVER_HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue}, 45%, 18%)"/>
      <stop offset="1" stop-color="hsl(${(hue + 40) % 360}, 50%, 10%)"/>
    </linearGradient>
  </defs>
  <rect width="${COVER_WIDTH}" height="${COVER_HEIGHT}" fill="url(#bg)"/>
  <circle cx="1080" cy="80" r="260" fill="hsl(${hue}, 70%, 60%)" fill-opacity="0.12"/>
  ${icon}
  <g font-family="${FONT_FAMILY}" fill="#ffffff">
    <text x="${left}" y="${summaryTop - 56}" font-size="${nameSize}" font-weight="700">${escapeXml(input.name)}</text>
    ${summary
      .map(
        (line, i) =>
          `<text x="${left}" y="${summaryTop + 20 + i * 46}" font-size="34" fill-opacity="0.82">${escapeXml(line)}</text>`,
      )
      .join("\n    ")}
    <text x="96" y="566" font-size="26" fill-opacity="0.6">github.com/${escapeXml(input.repo)}</text>
  </g>
</svg>
`;
}

export function iconSvg(input: { slug: string; name: string }): string {
  const hue = hueFor(input.slug);
  const text = initials(input.name);
  const size = GENERATED_ICON_PX;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue}, 60%, 52%)"/>
      <stop offset="1" stop-color="hsl(${(hue + 40) % 360}, 60%, 36%)"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="112" fill="url(#bg)"/>
  <text x="50%" y="50%" dominant-baseline="central" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="${text.length > 1 ? 208 : 256}" font-weight="700" fill="#ffffff">${escapeXml(text)}</text>
</svg>
`;
}
