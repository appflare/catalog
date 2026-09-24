import { describe, expect, it } from "vitest";
import { coverSvg, escapeXml, hueFor, iconSvg, initials, wrapText } from "./cover-art.ts";
import { svgProblems } from "./media.ts";

describe("cover art", () => {
  it("wraps text between words and marks cut text", () => {
    expect(wrapText("one two three four", 9, 3)).toEqual(["one two", "three", "four"]);
    expect(wrapText("aaaa bbbb cccc dddd eeee", 9, 2)).toEqual(["aaaa bbbb", "cccc…"]);
    expect(wrapText("", 10, 2)).toEqual([]);
  });

  it("takes up to two initials", () => {
    expect(initials("Second Brain")).toBe("SB");
    expect(initials("mail2telegram")).toBe("M");
    expect(initials("UniFi DDNS")).toBe("UD");
  });

  it("gives an entry the same colours every time", () => {
    expect(hueFor("cut")).toBe(hueFor("cut"));
    expect(hueFor("cut")).toBeLessThan(360);
  });

  it("escapes text and stays a self-contained SVG", () => {
    expect(escapeXml(`<a & "b">`)).toBe("&lt;a &amp; &quot;b&quot;&gt;");
    const cover = coverSvg({
      slug: "x",
      name: "A <b>",
      summary: "Tom & Jerry",
      repo: "o/r",
      iconDataUri: "data:image/png;base64,AAAA",
    });
    expect(cover).toContain("A &lt;b&gt;");
    expect(cover).toContain('width="1200" height="630"');
    expect(svgProblems(cover)).toEqual([]);
    expect(svgProblems(iconSvg({ slug: "x", name: "X" }))).toEqual([]);
  });
});
