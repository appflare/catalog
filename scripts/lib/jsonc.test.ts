import { describe, expect, it } from "vitest";
import { parseJsonc } from "./jsonc.ts";

describe("parseJsonc", () => {
  it("strips line and block comments and trailing commas", () => {
    const text = `{
      // a line comment
      "a": 1, /* block */ "b": [1, 2, /* x */],
      "c": { "d": true, },
    }`;
    expect(parseJsonc(text)).toEqual({ a: 1, b: [1, 2], c: { d: true } });
  });

  it("leaves comment and comma lookalikes inside strings alone", () => {
    const text = `{ "url": "https://x.dev/a//b", "s": "a, ]", "q": "say \\"/* hi */\\"" }`;
    expect(parseJsonc(text)).toEqual({
      url: "https://x.dev/a//b",
      s: "a, ]",
      q: 'say "/* hi */"',
    });
  });

  it("rejects an unterminated block comment", () => {
    expect(() => parseJsonc("{ /* }")).toThrow(/unterminated block comment/);
  });

  it("rejects invalid JSON after stripping", () => {
    expect(() => parseJsonc("{ a: 1 }")).toThrow(SyntaxError);
  });
});
