import { describe, expect, it } from "vitest";
import { parseJsonc } from "./jsonc.ts";
import { setJsoncStrings } from "./jsonc-edit.ts";

const MANIFEST = `{
  // the pin; "sha": "not this one" lives in a comment
  "name": "Cut { not a brace }",
  "source": { "ref": "main", "sha": "6056400d47530aa87e4ae5764b37ffca9d00e87f" }, /* trailing */
  "install": {
    "sha": "an unrelated nested sha",
    "tier": "artifact",
  },
  "secrets": [{ "name": "ref", "label": "sha" }],
}
`;

describe("setJsoncStrings", () => {
  it("replaces only the addressed values and keeps comments and layout", () => {
    const out = setJsoncStrings(MANIFEST, [
      { path: ["source", "ref"], value: "v1.0.0" },
      { path: ["source", "sha"], value: "a".repeat(40) },
    ]);
    expect(out).toBe(
      MANIFEST.replace('"ref": "main"', '"ref": "v1.0.0"').replace(
        "6056400d47530aa87e4ae5764b37ffca9d00e87f",
        "a".repeat(40),
      ),
    );
    const parsed = parseJsonc(out) as Record<string, Record<string, unknown>>;
    expect(parsed.source).toEqual({ ref: "v1.0.0", sha: "a".repeat(40) });
    expect(parsed.install?.sha).toBe("an unrelated nested sha");
  });

  it("works on a multi-line source object and escapes the new value", () => {
    const text = '{\n  "source": {\n    "ref": "main",\n    // pinned\n    "sha": "x"\n  }\n}\n';
    const out = setJsoncStrings(text, [{ path: ["source", "ref"], value: 'we"ird' }]);
    expect(out).toBe(
      '{\n  "source": {\n    "ref": "we\\"ird",\n    // pinned\n    "sha": "x"\n  }\n}\n',
    );
  });

  it("fails when the path does not hold a string", () => {
    expect(() =>
      setJsoncStrings('{ "source": { "ref": 1 } }', [{ path: ["source", "ref"], value: "v" }]),
    ).toThrow(/no string property at source\.ref/);
    expect(() => setJsoncStrings("{}", [{ path: ["source", "sha"], value: "v" }])).toThrow(
      /source\.sha/,
    );
  });
});
