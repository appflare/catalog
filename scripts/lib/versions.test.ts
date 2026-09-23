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

function manifest(ref: string, installVersion?: string): CatalogManifest {
  return {
    slug: "cut",
    repo: "MendyLanda/cut",
    source: { ref, sha: SHA },
    install: installVersion === undefined ? {} : { version: installVersion },
  } as CatalogManifest;
}

/** Mirrors the packer's rule, so these tests run without an appflare build. */
const fakePacker: PackerVersioning = {
  semverFromRef: (ref) => /^v?(\d+\.\d+\.\d+)$/.exec(ref)?.[1] ?? null,
  deriveVersion: ({ installVersion, ref, sha, commitDate, buildDate }) =>
    installVersion ??
    fakePacker.semverFromRef(ref) ??
    `0.0.0-${commitDate ?? buildDate}.${sha.slice(0, 7)}`,
  formatBuildDate: () => "20990101",
};

/** A packer build from before install.version, which ignores it. */
const oldPacker: PackerVersioning = {
  ...fakePacker,
  deriveVersion: (input) => fakePacker.deriveVersion({ ...input, installVersion: undefined }),
};

const noCommitDate: CommitDateLookup = () => {
  throw new Error("must not be called");
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
    const versions = createVersionResolver(fakePacker, noCommitDate);
    expect(versions.versionOf(manifest("v0.1.0"))).toBe("0.1.0");
  });

  it("takes install.version over the tag and the commit date, without fetching", () => {
    const versions = createVersionResolver(fakePacker, noCommitDate);
    expect(versions.versionOf(manifest("v11.0.0", "1.1.10"))).toBe("1.1.10");
    expect(versions.versionOf(manifest("main", "0.4.0"))).toBe("0.4.0");
    // Same pin, another install.version: not served from the cache.
    expect(versions.versionOf(manifest("v11.0.0", "1.1.11"))).toBe("1.1.11");
    expect(versions.versionOf(manifest("v11.0.0"))).toBe("11.0.0");
  });

  it("refuses a packer build that ignores install.version", () => {
    const versions = createVersionResolver(oldPacker, noCommitDate);
    expect(() => versions.versionOf(manifest("v11.0.0", "1.1.10"))).toThrow(
      /cut sets install\.version 1\.1\.10, but the @appflare\/pack build .* derives 11\.0\.0/,
    );
    expect(versions.versionOf(manifest("v11.0.0"))).toBe("11.0.0");
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
    expect(versions.versionOf(manifest("v11.0.0", "1.1.10"))).toBe("1.1.10");
  });

  it("rejects an install.version that is not semver, as the packer does", async () => {
    const versions = createVersionResolver(await loadPackerVersioning(appflareDir), noCommitDate);
    expect(() => versions.versionOf(manifest("v11.0.0", "v1.1.10"))).toThrow(
      /is not a semver version/,
    );
  });
});
