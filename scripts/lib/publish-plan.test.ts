import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { artifactManifestFixture } from "../fixtures/artifact-manifest.ts";
import { sandboxFixture } from "../fixtures/sandbox-manifest.ts";
import { appflareAvailable, testSchema } from "../fixtures/schema.ts";
import type { AppflareSchema } from "./appflare-schema.ts";
import { findApp, loadManifest } from "./apps.ts";
import { canonicalJson, changedFields } from "./canonical.ts";
import type { ReleaseLookup } from "./github-releases.ts";
import { IncompleteReleaseError } from "./github-releases.ts";
import { sha256Hex } from "./index-builder.ts";
import { decide, type PlanDecision, type RevisionContext } from "./publish-plan.ts";
import { revisedManifestDigest, revisedManifestFile } from "./revision.ts";
import type { CatalogManifest, IndexApp } from "./types.ts";
import type { VersionResolver } from "./versions.ts";

const fixtureApps = path.join(import.meta.dirname, "..", "fixtures", "apps");
const PIN = "0123456789abcdef0123456789abcdef01234567";
const versions: VersionResolver = { versionOf: () => "1.2.3" };
const KEY_ID = "catalog-2026-09";
const REPO = "appflare/catalog";

let schema: AppflareSchema;
let hello: CatalogManifest;

beforeAll(async () => {
  schema = await testSchema();
  hello = loadManifest(findApp(fixtureApps, "hello"), schema.catalogManifest);
});

/** The bytes of a release `manifest.json` with `catalog` embedded. */
function releaseBytes(catalog: unknown, sha = PIN, ref?: string): Buffer {
  const manifest = artifactManifestFixture({ app: "hello", version: "1.2.3", sha, ref });
  manifest.catalog = catalog;
  return Buffer.from(JSON.stringify(manifest));
}

/** A lookup where `tag` is released with `catalog` embedded in its manifest.json. */
function releasedWith(tag: string, catalog: unknown, sha = PIN, ref?: string): ReleaseLookup {
  const manifestBytes = releaseBytes(catalog, sha, ref);
  return { byTag: (t) => (t === tag ? { tag, manifestBytes } : null) };
}

/** No previous index row, and the real revision rule. */
function context(overrides: Partial<RevisionContext> = {}): RevisionContext {
  return { previous: undefined, revisionProblem: schema.revisionProblem, ...overrides };
}

function plan(
  manifest: CatalogManifest,
  releases: ReleaseLookup,
  overrides: Partial<RevisionContext> = {},
): Promise<PlanDecision> {
  return decide(manifest, versions, releases, schema.artifactManifest, KEY_ID, context(overrides));
}

describe("decide", () => {
  it("never packs or releases sandbox and self-deploying entries", async () => {
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
    expect(
      await decide(built, noVersion, releases, schema.artifactManifest, KEY_ID, context()),
    ).toEqual({
      slug: "built",
      action: "not-released",
      tier: "sandbox",
    });
    const seo = {
      ...hello,
      slug: "seo",
      install: { ...hello.install, tier: "self-deploying" as const },
    };
    expect(
      await decide(seo, noVersion, releases, schema.artifactManifest, KEY_ID, context()),
    ).toEqual({
      slug: "seo",
      action: "not-released",
      tier: "self-deploying",
    });
  });

  it("publishes when the tag for the current pin does not exist", async () => {
    const none: ReleaseLookup = { byTag: () => null };
    expect(await plan(hello, none)).toEqual({
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

  it("skips when the tag exists with the same catalog manifest (key order ignored)", async () => {
    const reordered = JSON.parse(canonicalJson(hello)) as unknown;
    const releases = releasedWith("hello@1.2.3", reordered);
    expect((await plan(hello, releases)).action).toBe("skip");
  });

  it("fails loudly on a metadata-only edit under an already released pin", async () => {
    const releases = releasedWith("hello@1.2.3", { ...hello, summary: "Old summary." });
    const decision = await plan(hello, releases);
    expect(decision.action).toBe("error");
    expect(decision.action === "error" && decision.message).toMatch(
      /appflare\.jsonc changed \(summary\).*hello@1\.2\.3.*re-pin `source`/,
    );
  });

  it("skips an edit to authors alone: the index reads them from the manifest", async () => {
    const authors = [{ name: "Ada Lovelace", github: "ada" }];
    const released = releasedWith("hello@1.2.3", hello);
    expect((await plan({ ...hello, authors }, released)).action).toBe("skip");
    const other = releasedWith("hello@1.2.3", { ...hello, authors: [{ name: "Someone" }] });
    expect((await plan({ ...hello, authors }, other)).action).toBe("skip");
  });

  it("still fails when authors change together with a field the artifact carries", async () => {
    const releases = releasedWith("hello@1.2.3", { ...hello, summary: "Old summary." });
    const edited = { ...hello, authors: [{ name: "Ada Lovelace" }] };
    const decision = await plan(edited, releases);
    expect(decision.action === "error" && decision.message).toMatch(
      /appflare\.jsonc changed \(summary\)/,
    );
  });

  it("fails, naming the release, when the tag's release is incomplete", async () => {
    const releases: ReleaseLookup = {
      byTag: () => {
        throw new IncompleteReleaseError("release hello@1.2.3 (https://x) is a draft");
      },
    };
    await expect(plan(hello, releases)).rejects.toThrow(/release hello@1\.2\.3 .* is a draft/);
  });
});

describe("decide with a revision", () => {
  const selectVar = {
    name: "MODE",
    label: "Mode",
    required: false,
    type: "select" as const,
    options: [
      { value: "a", label: "First" },
      { value: "b", label: "Second" },
    ],
    default: "a",
  };
  /** hello as released (revision 1) and as revised: a select var, revision 2. */
  const revised = (): CatalogManifest => ({ ...hello, vars: [selectVar], revision: 2 });
  /** The index row publishing `manifest` as a revision of the release of `hello`. */
  const rowFor = (manifest: CatalogManifest, catalogManifest = true): IndexApp =>
    ({
      slug: "hello",
      version: "1.2.3",
      digest: sha256Hex(releaseBytes(hello)),
      revision: manifest.revision ?? 1,
      ...(catalogManifest
        ? {
            catalogManifest: {
              ...revisedManifestFile(manifest, REPO),
              keyId: "catalog-2026-09",
              signature: "c2ln",
            },
          }
        : {}),
    }) as IndexApp;

  it("asks for a revision bump when only the form and copy changed", async () => {
    const releases = releasedWith("hello@1.2.3", hello);
    const decision = await plan({ ...hello, vars: [selectVar] }, releases);
    expect(decision.action === "error" && decision.message).toMatch(
      /changed \(vars\).*re-pin `source`.* to publish the change, or bump revision to 2: only the form and copy changed/,
    );
  });

  it.skipIf(!appflareAvailable)(
    "says why a revision cannot publish a change to the build",
    async () => {
      const releases = releasedWith("hello@1.2.3", hello);
      const decision = await plan({ ...hello, plan: "paid" }, releases);
      expect(decision.action === "error" && decision.message).toMatch(
        /changed \(plan\).*re-pin `source`.*\. Bumping revision cannot publish it: it changes plan, which only a new build can change\./,
      );
    },
  );

  it("plans a revision, which packs nothing, when the revision is above the release's", async () => {
    const releases = releasedWith("hello@1.2.3", hello);
    // The bytes sign-revisions signs, with the key id the release was signed with.
    expect(await plan(revised(), releases)).toEqual({
      slug: "hello",
      tag: "hello@1.2.3",
      action: "revise",
      planned: {
        version: "1.2.3",
        revision: 2,
        sha256: revisedManifestDigest(revised()),
        keyId: "unsigned",
      },
    });
    // The index still lists the release's own copy: still a revision to publish.
    expect((await plan(revised(), releases, { previous: rowFor(hello, false) })).action).toBe(
      "revise",
    );
  });

  it.skipIf(!appflareAvailable)(
    "refuses a revision that changes what only a new build can change",
    async () => {
      const releases = releasedWith("hello@1.2.3", hello);
      const decision = await plan({ ...revised(), requires: [] }, releases);
      expect(decision.action === "error" && decision.message).toMatch(
        /raises revision to 2, but it changes requires, which only a new build can change\. Re-pin `source`/,
      );
    },
  );

  it("skips a revision the index already publishes with the same bytes", async () => {
    const releases = releasedWith("hello@1.2.3", hello);
    const current = revised();
    expect(await plan(current, releases, { previous: rowFor(current) })).toEqual({
      slug: "hello",
      tag: "hello@1.2.3",
      action: "skip",
      revision: 2,
    });
  });

  it("refuses an edit under a revision that is already published, asking for the next", async () => {
    const releases = releasedWith("hello@1.2.3", hello);
    const before = revised();
    const edited = { ...before, summary: "Edited again." };
    const decision = await plan(edited, releases, { previous: rowFor(before) });
    expect(decision.action === "error" && decision.message).toMatch(
      /changed since revision 2 of hello@1\.2\.3 was published.*set revision to 3/,
    );
    // Raising it publishes the edit.
    const next = await plan({ ...edited, revision: 3 }, releases, { previous: rowFor(before) });
    expect(next).toMatchObject({ action: "revise", planned: { revision: 3 } });
  });

  it("needs the next revision even for authors: a signed revision never changes", async () => {
    const releases = releasedWith("hello@1.2.3", hello);
    const before = revised();
    const decision = await plan({ ...before, authors: [{ name: "Ada" }] }, releases, {
      previous: rowFor(before),
    });
    expect(decision.action === "error" && decision.message).toMatch(/set revision to 3/);
  });

  it("refuses a revision below the one the index publishes", async () => {
    const releases = releasedWith("hello@1.2.3", hello);
    const three = { ...revised(), revision: 3 };
    for (const manifest of [revised(), hello]) {
      const decision = await plan(manifest, releases, { previous: rowFor(three) });
      expect(decision.action === "error" && decision.message).toMatch(
        /is already published at revision 3\. Revisions only go up/,
      );
    }
  });

  it("ignores a previous row for another release", async () => {
    const releases = releasedWith("hello@1.2.3", hello);
    const other = { ...rowFor({ ...revised(), revision: 5 }), digest: "f".repeat(64) } as IndexApp;
    expect((await plan(revised(), releases, { previous: other })).action).toBe("revise");
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

  it("refuses a moved pin whose install.version is already released", async () => {
    const current = withVersion(hello, "1.2.3");
    const published = { ...current, source: { ref: "v1.2.2", sha: OLD } };
    const releases = releasedWith("hello@1.2.3", published, OLD, "v1.2.2");
    const decision = await plan(current, releases);
    expect(decision.action).toBe("error");
    expect(decision.action === "error" && decision.message).toMatch(
      /pins v1\.2\.3@0123456, but install\.version is still 1\.2\.3, and hello@1\.2\.3 is already released from v1\.2\.2@89abcde\..*bump install\.version/,
    );
  });

  it("skips when the release was built from the same pin and manifest", async () => {
    const current = withVersion(hello, "1.2.3");
    const releases = releasedWith("hello@1.2.3", JSON.parse(canonicalJson(current)));
    expect((await plan(current, releases)).action).toBe("skip");
  });

  it("asks for a new install.version on a metadata-only edit", async () => {
    const current = withVersion(hello, "1.2.3");
    const releases = releasedWith("hello@1.2.3", { ...current, summary: "Old summary." });
    const decision = await plan(current, releases);
    expect(decision.action === "error" && decision.message).toMatch(
      /changed \(summary\).*comes from install\.version, so bump it.*or bump revision to 2/,
    );
  });
});
