import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearArtifactDir } from "./out-dir.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "catalog-out-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("clearArtifactDir", () => {
  it("empties a previous artifact directory", () => {
    for (const name of ["cut-0.1.0.zip", "manifest.json", "manifest.sig"]) {
      writeFileSync(path.join(root, name), "x");
    }
    clearArtifactDir(root);
    expect(readdirSync(root)).toEqual([]);
  });

  it("does nothing for a missing directory", () => {
    clearArtifactDir(path.join(root, "missing"));
    expect(existsSync(path.join(root, "missing"))).toBe(false);
  });

  it("refuses a directory with other content", () => {
    writeFileSync(path.join(root, "manifest.json"), "x");
    mkdirSync(path.join(root, "src"));
    expect(() => clearArtifactDir(root)).toThrow(/non-artifact files \(src\)/);
    expect(readdirSync(root).sort()).toEqual(["manifest.json", "src"]);
  });
});
