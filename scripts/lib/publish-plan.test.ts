import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { artifactManifestFixture } from "../fixtures/artifact-manifest.ts";
import { sandboxFixture } from "../fixtures/sandbox-manifest.ts";
import { testSchema } from "../fixtures/schema.ts";
import type { AppflareSchema } from "./appflare-schema.ts";
import { findApp, loadManifest } from "./apps.ts";
import { canonicalJson, changedFields } from "./canonical.ts";
import type { ReleaseLookup } from "./github-releases.ts";
import { IncompleteReleaseError } from "./github-releases.ts";
import { decide } from "./publish-plan.ts";
import type { CatalogManifest } from "./types.ts";
import type { VersionResolver } from "./versions.ts";

const fixtureApps = path.join(import.meta.dirname, "..", "fixtures", "apps");
const PIN = "0123456789abcdef0123456789abcdef01234567";
const versions: VersionResolver = { versionOf: () => "1.2.3" };
const KEY_ID = "catalog-2026-09";

let schema: AppflareSchema;
let hello: CatalogManifest;

beforeAll(async () => {
  schema = await testSchema();
  hello = loadManifest(findApp(fixtureApps, "hello"), schema.catalogManifest);
});

/** A lookup where `tag` is released with `catalog` embedded in its manifest.json. */
function releasedWith(tag: string, catalog: unknown, sha = PIN, ref?: string): ReleaseLookup {
  const manifest = artifactManifestFixture({ app: "hello", version: "1.2.3", sha, ref });
  manifest.catalog = catalog;
  return {
    byTag: (t) =>
      t === tag ? { tag, manifestBytes: Buffer.from(JSON.stringify(manifest)) } : null,
  };
}

describe("decide", () => {
  it("never packs or releases sandbox and self-deploying entries", () => {
    const releases: ReleaseLookup = {
      byTag: () => {
        throw new Error("must not be consulted");
      },
    };
    const noVersion: VersionResolver = {
      versionOf: () => {
        throw new Error("must not be consulted");
      },
    };
    const built = sandboxFixture(hello, schema);
    expect(decide(built, noVersion, releases, schema.artifactManifest, KEY_ID)).toEqual({
      slug: "built",
      action: "not-released",
      tier: "sandbox",
    });
    const seo = {
      ...hello,
      slug: "seo",
      install: { ...hello.install, tier: "self-deploying" as const },
    };
    expect(decide(seo, noVersion, releases, schema.artifactManifest, KEY_ID)).toEqual({
      slug: "seo",
      action: "not-released",
      tier: "self-deploying",
    });
  });

  it("publishes when the tag for the current pin does not exist", () => {
    const none: ReleaseLookup = { byTag: () => null };
    expect(decide(hello, versions, none, schema.artifactManifest, KEY_ID)).toEqual({
      slug: "hello",
      tag: "hello@1.2.3",
      action: "publish",
      planned: {
        app: "hello",
        version: "1.2.3",
        source: { repo: "example/hello", sha: PIN, ref: "v1.2.3" },
        keyId: KEY_ID,
        catalog: JSON.parse(canonicalJson(hello)),
      },
    });
  });

  it("skips when the tag exists with the same catalog manifest (key order ignored)", () => {
    const reordered = JSON.parse(canonicalJson(hello)) as unknown;
    const releases = releasedWith("hello@1.2.3", reordered);
    expect(decide(hello, versions, releases, schema.artifactManifest, KEY_ID).action).toBe("skip");
  });

  it("fails loudly on a metadata-only edit under an already released pin", () => {
    const releases = releasedWith("hello@1.2.3", { ...hello, summary: "Old summary." });
    const decision = decide(hello, versions, releases, schema.artifactManifest, KEY_ID);
    expect(decision.action).toBe("error");
    expect(decision.action === "error" && decision.message).toMatch(
      /appflare\.jsonc changed \(summary\).*hello@1\.2\.3.*re-pin `source`/,
    );
  });

  it("fails, naming the release, when the tag's release is incomplete", () => {
    const releases: ReleaseLookup = {
      byTag: () => {
        throw new IncompleteReleaseError("release hello@1.2.3 (https://x) is a draft");
      },
    };
    expect(() => decide(hello, versions, releases, schema.artifactManifest, KEY_ID)).toThrow(
      /release hello@1\.2\.3 .* is a draft/,
    );
  });
});

describe("canonicalJson / changedFields", () => {
  it("sorts keys at every level and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[{"y":2,"z":1}]},"b":1}',
    );
  });

  it("names the top-level fields that differ, including added and removed ones", () => {
    expect(
      changedFields(
        { name: "A", vars: [{ name: "X" }], old: 1 },
        { name: "A", vars: [{ name: "Y" }], added: true },
      ),
    ).toEqual(["added", "old", "vars"]);
  });
});

describe("decide with install.version", () => {
  const OLD = "89abcdef0123456789abcdef0123456789abcdef";
  const withVersion = (m: CatalogManifest, version: string): CatalogManifest => ({
    ...m,
    install: { ...m.install, version },
  });

  it("refuses a moved pin whose install.version is already released", () => {
    const current = withVersion(hello, "1.2.3");
    const published = { ...current, source: { ref: "v1.2.2", sha: OLD } };
    const releases = releasedWith("hello@1.2.3", published, OLD, "v1.2.2");
    const decision = decide(current, versions, releases, schema.artifactManifest, KEY_ID);
    expect(decision.action).toBe("error");
    expect(decision.action === "error" && decision.message).toMatch(
      /pins v1\.2\.3@0123456, but install\.version is still 1\.2\.3, and hello@1\.2\.3 is already released from v1\.2\.2@89abcde\..*bump install\.version/,
    );
  });

  it("skips when the release was built from the same pin and manifest", () => {
    const current = withVersion(hello, "1.2.3");
    const releases = releasedWith("hello@1.2.3", JSON.parse(canonicalJson(current)));
    expect(decide(current, versions, releases, schema.artifactManifest, KEY_ID).action).toBe(
      "skip",
    );
  });

  it("asks for a new install.version on a metadata-only edit", () => {
    const current = withVersion(hello, "1.2.3");
    const releases = releasedWith("hello@1.2.3", { ...current, summary: "Old summary." });
    const decision = decide(current, versions, releases, schema.artifactManifest, KEY_ID);
    expect(decision.action === "error" && decision.message).toMatch(
      /changed \(summary\).*comes from install\.version, so bump it/,
    );
  });
});
