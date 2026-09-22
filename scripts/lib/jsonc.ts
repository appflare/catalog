/**
 * A small, string-aware JSONC reader for `appflare.jsonc`: removes `//` and block
 * comments, then trailing commas, both only outside of strings, and hands the
 * result to `JSON.parse`. Accepts the same files as the packer's reader.
 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripTrailingCommas(stripComments(text)));
}

/**
 * Walks `text` and calls `onCode` for each character outside a string literal;
 * characters inside strings are copied verbatim. `onCode` returns how many
 * characters it consumed (at least 1) and what to emit for them.
 */
function transformOutsideStrings(
  text: string,
  onCode: (index: number) => { consumed: number; emit: string },
): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        j += text[j] === "\\" ? 2 : 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const { consumed, emit } = onCode(i);
    out += emit;
    i += consumed;
  }
  return out;
}

function stripComments(text: string): string {
  return transformOutsideStrings(text, (i) => {
    if (text[i] === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      return { consumed: (end === -1 ? text.length : end) - i, emit: "" };
    }
    if (text[i] === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) {
        throw new SyntaxError("unterminated block comment in JSONC");
      }
      // Keep a space so tokens on either side of the comment stay separated.
      return { consumed: end + 2 - i, emit: " " };
    }
    return { consumed: 1, emit: text[i] as string };
  });
}

function stripTrailingCommas(text: string): string {
  return transformOutsideStrings(text, (i) => {
    if (text[i] === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] as string)) {
        j++;
      }
      if (text[j] === "}" || text[j] === "]") {
        return { consumed: 1, emit: "" };
      }
    }
    return { consumed: 1, emit: text[i] as string };
  });
}
