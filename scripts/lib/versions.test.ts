import { describe, expect, it } from "vitest";
import { appflareAvailable, appflareDir } from "../fixtures/schema.ts";
import type { CatalogManifest } from "./types.ts";
import {
  type CommitDateLookup,
  createVersionResolver,
  loadPackerVersioning,
  type PackerVersioning,
} from "./versions.ts";

const SHA = "6056400d47530aa87e4ae5764b37ffca9d00e87f";

function manifest(ref: string): CatalogManifest {
  return { repo: "MendyLanda/cut", source: { ref, sha: SHA } } as CatalogManifest;
}

/** Mirrors the packer's rule, so these tests run without an appflare build. */
const fakePacker: PackerVersioning = {
  semverFromRef: (ref) => /^v?(\d+\.\d+\.\d+)$/.exec(ref)?.[1] ?? null,
  deriveVersion: ({ ref, sha, commitDate, buildDate }) =>
    fakePacker.semverFromRef(ref) ?? `0.0.0-${commitDate ?? buildDate}.${sha.slice(0, 7)}`,
  formatBuildDate: () => "20990101",
};

describe("createVersionResolver", () => {
  it("uses the pin's commit date for branch pins, once per pin", () => {
    const asked: string[] = [];
    const commitDate: CommitDateLookup = (repo, sha) => {
      asked.push(`${repo}@${sha}`);
      return "20260826";
    };
    const versions = createVersionResolver(fakePacker, commitDate);
    expect(versions.versionOf(manifest("main"))).toBe("0.0.0-20260826.6056400");
    expect(versions.versionOf(manifest("main"))).toBe("0.0.0-20260826.6056400");
    expect(asked).toEqual([`MendyLanda/cut@${SHA}`]);
  });

  it("does not fetch the commit date for a semver tag pin", () => {
    const versions = createVersionResolver(fakePacker, () => {
      throw new Error("must not be called");
    });
    expect(versions.versionOf(manifest("v0.1.0"))).toBe("0.1.0");
  });
});

describe.skipIf(!appflareAvailable)("with the real @appflare/pack", () => {
  it("derives the same versions as the packer", async () => {
    const versions = createVersionResolver(
      await loadPackerVersioning(appflareDir),
      () => "20260826",
    );
    expect(versions.versionOf(manifest("main"))).toBe("0.0.0-20260826.6056400");
    expect(versions.versionOf(manifest("v1.2.3"))).toBe("1.2.3");
  });
});
