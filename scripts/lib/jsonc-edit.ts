/**
 * Edits string values inside a JSONC document in place, keeping comments,
 * whitespace, and key order exactly as written. Only what the bump workflow
 * needs: replace the value of an existing string property at a given path.
 */

interface Token {
  kind: "string" | "punct" | "other";
  start: number;
  end: number;
  /** Decoded value for strings; the character for punctuation. */
  value: string;
}

/** Tokens outside comments: strings, `{}[]:,`, and runs of anything else. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) {
        throw new SyntaxError("unterminated block comment in JSONC");
      }
      i = end + 2;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        j += text[j] === "\\" ? 2 : 1;
      }
      if (j >= text.length) {
        throw new SyntaxError("unterminated string in JSONC");
      }
      tokens.push({
        kind: "string",
        start: i,
        end: j + 1,
        value: JSON.parse(text.slice(i, j + 1)) as string,
      });
      i = j + 1;
    } else if ("{}[]:,".includes(ch)) {
      tokens.push({ kind: "punct", start: i, end: i + 1, value: ch });
      i++;
    } else if (/\s/.test(ch)) {
      i++;
    } else {
      const start = i;
      while (i < text.length && !/[\s{}[\]:,"/]/.test(text[i] as string)) {
        i++;
      }
      tokens.push({ kind: "other", start, end: i, value: text.slice(start, i) });
    }
  }
  return tokens;
}

/** Finds the token range of the string value at `path` (object keys only). */
function findStringValue(tokens: Token[], path: readonly string[]): Token {
  const stack: { type: "{" | "["; key: string | null }[] = [];
  let pendingKey: string | null = null;
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t] as Token;
    const inObject = stack.at(-1)?.type === "{";
    if (tok.kind === "string" && inObject && tokens[t + 1]?.value === ":") {
      pendingKey = tok.value;
      t++; // skip the colon
      continue;
    }
    const keys = [...stack.slice(1).map((s) => s.key ?? ""), pendingKey ?? ""];
    if (tok.kind === "punct" && (tok.value === "{" || tok.value === "[")) {
      stack.push({ type: tok.value, key: pendingKey });
      pendingKey = null;
      continue;
    }
    if (tok.kind === "punct" && (tok.value === "}" || tok.value === "]")) {
      stack.pop();
      pendingKey = null;
      continue;
    }
    if (
      tok.kind === "string" &&
      pendingKey !== null &&
      keys.length === path.length &&
      keys.every((k, i) => k === path[i])
    ) {
      return tok;
    }
    if (tok.kind !== "punct") {
      pendingKey = null;
    }
  }
  throw new Error(`no string property at ${path.join(".")}`);
}

/**
 * Returns `text` with the string values at each path replaced. Every path must
 * already hold a string; nothing else in the document changes.
 */
export function setJsoncStrings(
  text: string,
  edits: ReadonlyArray<{ path: readonly string[]; value: string }>,
): string {
  const tokens = tokenize(text);
  const replacements = edits
    .map((edit) => ({ token: findStringValue(tokens, edit.path), value: edit.value }))
    .sort((a, b) => b.token.start - a.token.start);
  let out = text;
  for (const { token, value } of replacements) {
    out = out.slice(0, token.start) + JSON.stringify(value) + out.slice(token.end);
  }
  return out;
}
