import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  artifactManifestFixture,
  duoArtifactManifestFixture,
} from "../fixtures/artifact-manifest.ts";
import { loadEntryWorkerHelpers, oneWorkerFacts } from "./appflare-schema.ts";
import { appflarePaths } from "./paths.ts";
import type { ArtifactManifest } from "./types.ts";

const PIN = "0123456789abcdef0123456789abcdef01234567";

describe("loadEntryWorkerHelpers", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "appflare-schema-test-"));
    for (const file of Object.values(appflarePaths(dir))) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "");
    }
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("names the first missing function of a schema build that predates them", async () => {
    writeFileSync(
      appflarePaths(dir).schemaDist,
      "export function appWorkersInDeployOrder() {}\nexport const workerManifest = 1;\n",
    );
    await expect(loadEntryWorkerHelpers(dir)).rejects.toThrow(
      /does not export workerManifest\(\); build a newer appflare checkout/,
    );
  });

  it("returns the functions of a build that has them all", async () => {
    writeFileSync(
      appflarePaths(dir).schemaDist,
      [
        "appWorkersInDeployOrder",
        "workerManifest",
        "entryScriptName",
        "entryWorkerRefName",
        "renderEntryWorkerPlaceholders",
      ]
        .map((name) => `export function ${name}() { return "${name}"; }`)
        .join("\n"),
    );
    const helpers = await loadEntryWorkerHelpers(dir);
    expect(helpers.entryScriptName("a", "b", false)).toBe("entryScriptName");
  });
});

describe("oneWorkerFacts", () => {
  it("is the Worker of an app of one Worker, and refuses an app of several", () => {
    const one = artifactManifestFixture({ app: "hello", version: "1.2.3", sha: PIN });
    expect(oneWorkerFacts(one as unknown as ArtifactManifest)).toBe(one.worker);
    const duo = duoArtifactManifestFixture({ sha: PIN }) as unknown as ArtifactManifest;
    expect(() => oneWorkerFacts(duo)).toThrow(/has several Workers/);
  });
});
