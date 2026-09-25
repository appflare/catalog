import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { artifactManifestFixture } from "../fixtures/artifact-manifest.ts";
import { sandboxFixture, selfDeployingFixture } from "../fixtures/sandbox-manifest.ts";
import { appflareAvailable, testSchema } from "../fixtures/schema.ts";
import type { AppflareSchema, AppServicesOf } from "./appflare-schema.ts";
import { listApps, loadManifest } from "./apps.ts";
import type { ReleaseArtifact, ReleaseLookup } from "./github-releases.ts";
import {
  artifactUrls,
  buildIndexApps,
  finalizeIndex,
  type IndexBuildOptions,
  lastVerifiedFor,
  serializeIndex,
  sha256Hex,
  verifiedDigest,
} from "./index-builder.ts";
import { publishedManifestBytes } from "./sandbox-entry.ts";
import type { CatalogManifest, IndexApp } from "./types.ts";
import type { VersionResolver } from "./versions.ts";

const fixtureApps = path.join(import.meta.dirname, "..", "fixtures", "apps");
const PIN = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";

let schema: AppflareSchema;
let hello: CatalogManifest;
let distDir: string;
let warnings: string[];

beforeAll(async () => {
  schema = await testSchema();
  const app = listApps(fixtureApps).find((a) => a.slug === "hello");
  if (!app) {
    throw new Error("fixture app missing");
  }
  hello = loadManifest(app, schema.catalogManifest);
});

beforeEach(() => {
  distDir = mkdtempSync(path.join(tmpdir(), "catalog-index-test-"));
  warnings = [];
});

afterEach(() => {
  rmSync(distDir, { recursive: true, force: true });
});

function writeLocal(manifest: Record<string, unknown>): Buffer {
  const dir = path.join(distDir, "hello");
  mkdirSync(dir, { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(dir, "manifest.json"), bytes);
  return bytes;
}

function releaseOf(version: string, sha = PIN): ReleaseArtifact {
  const manifestBytes = Buffer.from(
    JSON.stringify(
      artifactManifestFixture({ app: "hello", version, sha, keyId: "catalog-2026-09" }),
    ),
  );
  return { tag: `hello@${version}`, manifestBytes };
}

/** A lookup holding exactly these releases, recording the tags asked for. */
function releasesOf(...list: ReleaseArtifact[]): ReleaseLookup & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    byTag: (tag) => {
      asked.push(tag);
      return list.find((r) => r.tag === tag) ?? null;
    },
  };
}

/** The current pin of the fixture app packs to 1.2.3. */
const versions: VersionResolver = { versionOf: () => "1.2.3" };

/**
 * Stands in for `appServices`: names the inputs it was given, so a row shows
 * whether its services came from an artifact's Worker and which `requires`.
 */
const echoServices: AppServicesOf = (catalog, worker) => ({
  ids: [
    ...(worker === null ? ["no-worker"] : worker.bindings.map((b) => `binding:${b.type}`)),
    ...catalog.requires.map((r) => `requires:${r}`),
  ],
  keyValueDurableObjects: false,
});

function options(overrides: Partial<IndexBuildOptions> = {}): IndexBuildOptions {
  return {
    repo: "appflare/catalog",
    distDir,
    releases: null,
    versions,
    strictReleases: false,
    artifactManifest: schema.artifactManifest,
    warn: (m) => warnings.push(m),
    sandboxDefaults: schema.sandboxDefaults,
    services: echoServices,
    revisionProblem: schema.revisionProblem,
    ...overrides,
  };
}

describe("artifactUrls", () => {
  it("follows the <slug>@<version> release naming", () => {
    expect(artifactUrls("appflare/catalog", "cut", "0.1.0")).toEqual({
      zip: "https://github.com/appflare/catalog/releases/download/cut@0.1.0/cut-0.1.0.zip",
      manifest: "https://github.com/appflare/catalog/releases/download/cut@0.1.0/manifest.json",
      sig: "https://github.com/appflare/catalog/releases/download/cut@0.1.0/manifest.sig",
    });
  });
});

describe("buildIndexApps", () => {
  it("lists a local artifact built from the current pin, with the digest of its bytes", () => {
    const bytes = writeLocal(artifactManifestFixture({ app: "hello", version: "1.2.3", sha: PIN }));
    const releases: ReleaseLookup = {
      byTag: () => {
        throw new Error("must not be consulted when a local artifact matches");
      },
    };
    const [row, ...rest] = buildIndexApps([hello], options({ releases }));
    expect(rest).toHaveLength(0);
    expect(row).toEqual({
      slug: "hello",
      name: "Hello",
      summary: "Fixture app for the catalog scripts' tests.",
      version: "1.2.3",
      artifacts: artifactUrls("appflare/catalog", "hello", "1.2.3"),
      digest: sha256Hex(bytes),
      tier: "artifact",
      plan: "free",
      requires: ["r2"],
      lastVerified: null,
      authors: [{ name: "example", github: "example" }],
      maintainers: ["octocat", "@example/maintainers"],
      // From the artifact's Worker, with the current manifest's `requires` added
      // (the fixture artifact's own catalog manifest requires nothing).
      services: ["binding:kv_namespace", "requires:r2"],
      categories: ["utilities"],
      revision: 1,
    });
    expect(warnings.join("\n")).toMatch(/UNSIGNED/);
  });

  it("works out services from the release's artifact manifest", () => {
    const published = artifactManifestFixture({
      app: "hello",
      version: "1.2.3",
      sha: PIN,
      keyId: "catalog-2026-09",
    });
    const worker = published.worker as Record<string, unknown>;
    published.worker = { ...worker, bindings: [{ type: "d1", name: "DB" }] };
    const release = { tag: "hello@1.2.3", manifestBytes: Buffer.from(JSON.stringify(published)) };
    const [row] = buildIndexApps(
      [hello],
      options({ distDir: null, releases: releasesOf(release) }),
    );
    expect(row?.services).toEqual(["binding:d1", "requires:r2"]);
    expect(row).not.toHaveProperty("keyValueDurableObjects");
  });

  it("writes keyValueDurableObjects only when the services say so", () => {
    writeLocal(artifactManifestFixture({ app: "hello", version: "1.2.3", sha: PIN }));
    const keyValue: AppServicesOf = () => ({
      ids: ["durable-objects"],
      keyValueDurableObjects: true,
    });
    const [row] = buildIndexApps([hello], options({ services: keyValue }));
    expect(row?.services).toEqual(["durable-objects"]);
    expect(row?.keyValueDurableObjects).toBe(true);
  });

  it("selects the release for the version the current pin packs to, not the newest one", () => {
    const current = releaseOf("1.2.3");
    const releases = releasesOf(releaseOf("1.2.2"), current, releaseOf("9.0.0"));
    const rows = buildIndexApps([hello], options({ distDir: null, releases }));
    expect(releases.asked).toEqual(["hello@1.2.3"]);
    expect(rows.map((r) => [r.version, r.digest])).toEqual([
      ["1.2.3", sha256Hex(current.manifestBytes)],
    ]);
  });

  it("ignores a local artifact from another pin and falls back to the release", () => {
    writeLocal(artifactManifestFixture({ app: "hello", version: "1.0.0", sha: OTHER_SHA }));
    const release = releaseOf("1.2.3");
    const rows = buildIndexApps([hello], options({ releases: releasesOf(release) }));
    expect(rows.map((r) => r.digest)).toEqual([sha256Hex(release.manifestBytes)]);
    expect(warnings.join("\n")).toMatch(/not the current pin/);
  });

  it("uses releases only when distDir is null", () => {
    writeLocal(artifactManifestFixture({ app: "hello", version: "1.2.3", sha: PIN }));
    const release = releaseOf("1.2.3");
    const rows = buildIndexApps([hello], options({ distDir: null, releases: releasesOf(release) }));
    expect(rows[0]?.digest).toBe(sha256Hex(release.manifestBytes));
  });

  it("omits the app when the release for its tag was built from another sha", () => {
    const rows = buildIndexApps(
      [hello],
      options({ distDir: null, releases: releasesOf(releaseOf("1.2.3", OTHER_SHA)) }),
    );
    expect(rows).toEqual([]);
    expect(warnings.join("\n")).toMatch(/hello: omitted: .* not the current pin/);
  });

  it("omits the app when its pin has no release yet, even if older releases exist", () => {
    const rows = buildIndexApps([hello], options({ releases: releasesOf(releaseOf("1.2.2")) }));
    expect(rows).toEqual([]);
    expect(warnings).toEqual([
      "hello: no release hello@1.2.3 for the current pin; omitted from index.json",
    ]);
  });

  it("omits apps with a warning when no release lookup is available", () => {
    expect(buildIndexApps([hello], options())).toEqual([]);
    expect(warnings).toEqual([
      "hello: no local artifact and no release lookup; omitted from index.json",
    ]);
  });

  it("warns once and continues when the release lookup fails and strictReleases is off", () => {
    let calls = 0;
    const releases: ReleaseLookup = {
      byTag: () => {
        calls++;
        throw new Error("gh is not installed");
      },
    };
    const other = { ...hello, slug: "other" };
    const rows = buildIndexApps([hello, other], options({ releases }));
    expect(rows).toEqual([]);
    expect(calls).toBe(1);
    expect(warnings.filter((w) => w.includes("release lookup unavailable"))).toHaveLength(1);
  });

  it("fails when the release lookup or version derivation fails and strictReleases is on", () => {
    const releases: ReleaseLookup = {
      byTag: () => {
        throw new Error("HTTP 401");
      },
    };
    expect(() => buildIndexApps([hello], options({ releases, strictReleases: true }))).toThrow(
      /HTTP 401/,
    );
    const noGit: VersionResolver = {
      versionOf: () => {
        throw new Error("could not read the commit date");
      },
    };
    expect(() =>
      buildIndexApps(
        [hello],
        options({ releases: releasesOf(), versions: noGit, strictReleases: true }),
      ),
    ).toThrow(/commit date/);
  });
});

describe("finalizeIndex", () => {
  const now = new Date("2026-09-22T12:00:00.000Z");

  it("stamps generatedAt and validates the index", () => {
    writeLocal(artifactManifestFixture({ app: "hello", version: "1.2.3", sha: PIN }));
    const apps = buildIndexApps([hello], options());
    const index = finalizeIndex(apps, null, now, schema.indexJson);
    expect(index).toEqual({ generatedAt: "2026-09-22T12:00:00.000Z", apps, featured: [] });
  });

  it("keeps the previous generatedAt when the apps are unchanged", () => {
    writeLocal(artifactManifestFixture({ app: "hello", version: "1.2.3", sha: PIN }));
    const apps = buildIndexApps([hello], options());
    const previous = serializeIndex({
      generatedAt: "2026-01-01T00:00:00.000Z",
      apps,
      featured: [],
    });
    expect(finalizeIndex(apps, previous, now, schema.indexJson).generatedAt).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    const changed = serializeIndex({
      generatedAt: "2026-01-01T00:00:00.000Z",
      apps: [],
      featured: [],
    });
    expect(finalizeIndex(apps, changed, now, schema.indexJson).generatedAt).toBe(now.toISOString());
    expect(finalizeIndex(apps, "not json", now, schema.indexJson).generatedAt).toBe(
      now.toISOString(),
    );
  });
});

describe.skipIf(!appflareAvailable)("with the real @appflare/schema", () => {
  it("rejects an index row with a malformed digest", () => {
    writeLocal(artifactManifestFixture({ app: "hello", version: "1.2.3", sha: PIN }));
    const [row] = buildIndexApps([hello], options());
    if (!row) {
      throw new Error("expected a row");
    }
    expect(() =>
      finalizeIndex([{ ...row, digest: "nope" }], null, new Date(), schema.indexJson),
    ).toThrow(/apps\.0\.digest/);
  });

  it("rejects a local artifact manifest that is not schema-valid", () => {
    const bad = artifactManifestFixture({ app: "hello", version: "1.2.3", sha: PIN });
    delete bad.worker;
    writeLocal(bad);
    expect(() => buildIndexApps([hello], options())).toThrow(/worker/);
  });

  it("lists the services @appflare/schema works out, for every tier", () => {
    writeLocal(artifactManifestFixture({ app: "hello", version: "1.2.3", sha: PIN }));
    const opts = options({ services: schema.appServices });
    const edited = selfDeployingFixture(hello, schema, {
      tokenPermissions: [
        { name: "Workers Scripts", scope: "account" },
        { name: "D1", scope: "account" },
        { name: "Zone.DNS", scope: "zone" },
      ],
    });
    const rows = buildIndexApps([hello, sandboxFixture(hello, schema), edited], opts);
    expect(rows.map((r) => [r.slug, r.services, r.categories])).toEqual([
      ["built", ["r2"], ["utilities"]],
      // The artifact's KV binding, and the manifest's `requires`.
      ["hello", ["kv", "r2"], ["utilities"]],
      // A self-deploying entry: what its token may touch.
      ["seo", ["d1", "r2", "zone"], ["utilities"]],
    ]);
    const index = finalizeIndex(rows, null, new Date(), schema.indexJson);
    expect(index.apps).toEqual(rows);
  });

  it("the committed index.json is schema-valid", () => {
    const text = readFileSync(path.join(import.meta.dirname, "..", "..", "index.json"), "utf8");
    expect(schema.indexJson.safeParse(JSON.parse(text)).success).toBe(true);
  });
});

describe("lastVerified", () => {
  const artifact = { version: "1.2.3", digest: "d".repeat(64) };
  const row = (over: Partial<IndexApp>): IndexApp => ({
    slug: "hello",
    name: "Hello",
    summary: "s",
    version: "1.2.3",
    artifacts: artifactUrls("appflare/catalog", "hello", "1.2.3"),
    digest: "d".repeat(64),
    tier: "artifact",
    plan: "free",
    requires: [],
    lastVerified: "2026-09-01T00:00:00.000Z",
    authors: [{ name: "octocat", github: "octocat" }],
    maintainers: ["octocat"],
    services: [],
    categories: [],
    ...over,
  });

  it("carries the previous value while version and digest are unchanged, and resets otherwise", () => {
    expect(lastVerifiedFor("hello", artifact, [row({})])).toBe("2026-09-01T00:00:00.000Z");
    expect(lastVerifiedFor("hello", artifact, [row({ version: "1.2.2" })])).toBe(null);
    expect(lastVerifiedFor("hello", artifact, [row({ digest: "e".repeat(64) })])).toBe(null);
    expect(lastVerifiedFor("hello", artifact, [])).toBe(null);
  });

  it("is carried into rebuilt rows by buildIndexApps", () => {
    const bytes = writeLocal(artifactManifestFixture({ app: "hello", version: "1.2.3", sha: PIN }));
    const previousApps = [row({ digest: sha256Hex(bytes) })];
    const [r] = buildIndexApps([hello], options({ previousApps }));
    expect(r?.lastVerified).toBe("2026-09-01T00:00:00.000Z");
  });
});

describe("sandbox tier entries", () => {
  const throwingReleases: ReleaseLookup = {
    byTag: () => {
      throw new Error("a sandbox entry has no release to look up");
    },
  };

  it("are listed with a build block instead of artifacts, without a release", () => {
    const built = sandboxFixture(hello, schema);
    const rows = buildIndexApps([built], options({ releases: throwingReleases }));
    expect(rows).toEqual([
      {
        slug: "built",
        name: "Hello",
        summary: "Fixture app for the catalog scripts' tests.",
        version: "1.2.3",
        tier: "sandbox",
        plan: "paid",
        requires: ["r2"],
        lastVerified: null,
        authors: [{ name: "example", github: "example" }],
        maintainers: ["octocat", "@example/maintainers"],
        build: {
          pin: PIN,
          manifest: "https://appflare.github.io/catalog/apps/built/manifest.json",
          manifestDigest: sha256Hex(publishedManifestBytes(built)),
          buildCommand: "pnpm run build",
          expectedMinutes: 10,
          instanceType: "standard-1",
        },
        services: ["no-worker", "requires:r2"],
        categories: ["utilities"],
        revision: 1,
      },
    ]);
    expect(rows[0]).not.toHaveProperty("artifacts");
    expect(rows[0]).not.toHaveProperty("digest");
    expect(warnings).toEqual([]);
  });

  it("sit next to artifact tier rows, which are unchanged", () => {
    const bytes = writeLocal(artifactManifestFixture({ app: "hello", version: "1.2.3", sha: PIN }));
    const rows = buildIndexApps([sandboxFixture(hello, schema), hello], options());
    expect(rows.map((r) => r.slug)).toEqual(["built", "hello"]);
    expect(rows[1]).toEqual({
      slug: "hello",
      name: "Hello",
      summary: "Fixture app for the catalog scripts' tests.",
      version: "1.2.3",
      artifacts: artifactUrls("appflare/catalog", "hello", "1.2.3"),
      digest: sha256Hex(bytes),
      tier: "artifact",
      plan: "free",
      requires: ["r2"],
      lastVerified: null,
      authors: [{ name: "example", github: "example" }],
      maintainers: ["octocat", "@example/maintainers"],
      services: ["binding:kv_namespace", "requires:r2"],
      categories: ["utilities"],
      revision: 1,
    });
  });

  it("list the manifest's authors, or the repository owner when it names none", () => {
    writeLocal(artifactManifestFixture({ app: "hello", version: "1.2.3", sha: PIN }));
    const authors = [
      { name: "Ada Lovelace", url: "https://ada.example", github: "ada", x: "ada_l" },
      { name: "Example", github: "example" },
    ];
    const built = { ...sandboxFixture(hello, schema), authors };
    const rows = buildIndexApps([built, hello], options());
    expect(rows.map((r) => [r.slug, r.authors])).toEqual([
      ["built", authors],
      ["hello", [{ name: "example", github: "example" }]],
    ]);
  });

  it("carry lastVerified over while version and manifestDigest stay the same", () => {
    const built = sandboxFixture(hello, schema);
    const [first] = buildIndexApps([built], options());
    if (!first) {
      throw new Error("expected a row");
    }
    const verified = { ...first, lastVerified: "2026-09-01T00:00:00.000Z" };
    expect(verifiedDigest(verified)).toBe(first.build?.manifestDigest);
    const [same] = buildIndexApps([built], options({ previousApps: [verified] }));
    expect(same?.lastVerified).toBe("2026-09-01T00:00:00.000Z");
    const edited = sandboxFixture(hello, schema, { buildCommand: "pnpm run build:worker" });
    const [changed] = buildIndexApps([edited], options({ previousApps: [verified] }));
    expect(changed?.lastVerified).toBeNull();
  });

  it("omit the entry with a warning when its version cannot be worked out, unless strict", () => {
    const noGit: VersionResolver = {
      versionOf: () => {
        throw new Error("could not read the commit date");
      },
    };
    const built = sandboxFixture(hello, schema);
    expect(buildIndexApps([built], options({ versions: noGit }))).toEqual([]);
    expect(warnings).toEqual([
      "built: omitted: could not work out the version of the current pin: could not read the commit date",
    ]);
    expect(() =>
      buildIndexApps([built], options({ versions: noGit, strictReleases: true })),
    ).toThrow(/commit date/);
  });
});

describe("self-deploying tier entries", () => {
  const throwingReleases: ReleaseLookup = {
    byTag: () => {
      throw new Error("a self-deploying entry has no release to look up");
    },
  };

  it("are listed with a build block exactly like sandbox entries", () => {
    const seo = selfDeployingFixture(hello, schema);
    const rows = buildIndexApps([seo], options({ releases: throwingReleases }));
    expect(rows).toEqual([
      {
        slug: "seo",
        name: "Hello",
        summary: "Fixture app for the catalog scripts' tests.",
        version: "1.2.3",
        tier: "self-deploying",
        plan: "paid",
        requires: ["r2"],
        lastVerified: null,
        authors: [{ name: "example", github: "example" }],
        maintainers: ["octocat", "@example/maintainers"],
        build: {
          pin: PIN,
          manifest: "https://appflare.github.io/catalog/apps/seo/manifest.json",
          manifestDigest: sha256Hex(publishedManifestBytes(seo)),
          expectedMinutes: 15,
          instanceType: "standard-2",
        },
        services: ["no-worker", "requires:r2"],
        categories: ["utilities"],
        revision: 1,
      },
    ]);
    expect(rows[0]).not.toHaveProperty("artifacts");
    expect(rows[0]).not.toHaveProperty("digest");
    expect(warnings).toEqual([]);
  });

  it("carry the build command when the entry declares one", () => {
    const seo = selfDeployingFixture(hello, schema);
    const withBuild = { ...seo, install: { ...seo.install, buildCommand: "pnpm run build" } };
    const [row] = buildIndexApps([withBuild], options({ releases: throwingReleases }));
    expect(row?.build?.buildCommand).toBe("pnpm run build");
  });

  it("carry lastVerified over only while manifestDigest stays the same", () => {
    const seo = selfDeployingFixture(hello, schema);
    const [first] = buildIndexApps([seo], options());
    if (!first) {
      throw new Error("expected a row");
    }
    const verified = { ...first, lastVerified: "2026-09-01T00:00:00.000Z" };
    const [same] = buildIndexApps([seo], options({ previousApps: [verified] }));
    expect(same?.lastVerified).toBe("2026-09-01T00:00:00.000Z");
    const edited = selfDeployingFixture(hello, schema, {
      tokenPermissions: [
        { name: "Workers Scripts", scope: "account" },
        { name: "D1", scope: "account" },
      ],
    });
    const [changed] = buildIndexApps([edited], options({ previousApps: [verified] }));
    expect(changed?.version).toBe(first.version);
    expect(changed?.lastVerified).toBeNull();
  });

  it("leave artifact and sandbox rows as they were", () => {
    const bytes = writeLocal(artifactManifestFixture({ app: "hello", version: "1.2.3", sha: PIN }));
    const built = sandboxFixture(hello, schema);
    const without = buildIndexApps([built, hello], options());
    const withSeo = buildIndexApps([built, selfDeployingFixture(hello, schema), hello], options());
    expect(withSeo.map((r) => r.slug)).toEqual(["built", "hello", "seo"]);
    expect(withSeo.filter((r) => r.slug !== "seo")).toEqual(without);
    expect(without[1]?.digest).toBe(sha256Hex(bytes));
  });
});

describe.skipIf(!appflareAvailable)("sandbox rows with the real @appflare/schema", () => {
  it("pass the index schema, keep their key order, and stay idempotent", () => {
    const rows = buildIndexApps(
      [sandboxFixture(hello, schema), selfDeployingFixture(hello, schema)],
      options(),
    );
    const now = new Date("2026-09-22T12:00:00.000Z");
    const index = finalizeIndex(rows, null, now, schema.indexJson);
    expect(index.apps).toEqual(rows);
    expect(Object.keys(index.apps[0] ?? {})).toEqual(Object.keys(rows[0] ?? {}));
    const again = finalizeIndex(rows, serializeIndex(index), new Date(), schema.indexJson);
    expect(again.generatedAt).toBe(now.toISOString());
  });
});

describe("revisions of artifact tier entries", () => {
  const selectVar = {
    name: "MODE",
    label: "Mode",
    required: false,
    type: "select",
    options: [
      { value: "a", label: "First" },
      { value: "b", label: "Second" },
    ],
  };

  /** The release of hello@1.2.3, built with `catalog`. */
  function releasedWith(catalog: CatalogManifest): ReleaseArtifact {
    const manifest = artifactManifestFixture({
      app: "hello",
      version: "1.2.3",
      sha: PIN,
      keyId: "catalog-2026-09",
    });
    manifest.catalog = catalog;
    return { tag: "hello@1.2.3", manifestBytes: Buffer.from(JSON.stringify(manifest)) };
  }

  /** What sign-revisions wrote for `manifest` (the signature is opaque here). */
  const signed = (manifest: CatalogManifest, keyId = "catalog-2026-09") => ({
    hello: {
      sha256: sha256Hex(publishedManifestBytes(manifest)),
      keyId,
      signature: "c2lnbmVk",
    },
  });

  it("list a signed revision above the release's, keeping the release and lastVerified", () => {
    const release = releasedWith(hello);
    const revised: CatalogManifest = { ...hello, vars: [selectVar], revision: 2 };
    const before = buildIndexApps(
      [hello],
      options({ distDir: null, releases: releasesOf(release) }),
    );
    expect(before[0]?.revision).toBe(1);
    expect(before[0]).not.toHaveProperty("catalogManifest");
    const verified = { ...before[0], lastVerified: "2026-09-01T00:00:00.000Z" } as IndexApp;
    const [row] = buildIndexApps(
      [revised],
      options({
        distDir: null,
        releases: releasesOf(release),
        previousApps: [verified],
        revisionSignatures: signed(revised),
      }),
    );
    expect(row).toMatchObject({
      version: "1.2.3",
      digest: sha256Hex(release.manifestBytes),
      artifacts: artifactUrls("appflare/catalog", "hello", "1.2.3"),
      revision: 2,
      catalogManifest: {
        url: "https://appflare.github.io/catalog/apps/hello/manifest.json",
        sha256: sha256Hex(publishedManifestBytes(revised)),
        keyId: "catalog-2026-09",
        signature: "c2lnbmVk",
      },
      lastVerified: "2026-09-01T00:00:00.000Z",
    });
    expect(warnings).toEqual([]);
    // A rebuild keeps the signature while the bytes are the same.
    const [again] = buildIndexApps(
      [revised],
      options({ distDir: null, releases: releasesOf(release), previousApps: [row as IndexApp] }),
    );
    expect(again?.catalogManifest).toEqual(row?.catalogManifest);
  });

  it("omit a revision no signature covers, or one signed with another key; fail when strict", () => {
    const release = releasedWith(hello);
    const revised: CatalogManifest = { ...hello, vars: [selectVar], revision: 2 };
    const stale = signed({ ...revised, summary: "Other bytes." });
    for (const revisionSignatures of [{}, stale, signed(revised, "appflare-2026-09")]) {
      warnings = [];
      const rows = buildIndexApps(
        [revised],
        options({ distDir: null, releases: releasesOf(release), revisionSignatures }),
      );
      expect(rows).toEqual([]);
      expect(warnings.join("\n")).toMatch(
        /hello: omitted: .*revision 2 of hello@1\.2\.3, but (no signature is known|it is signed with key "appflare-2026-09")/,
      );
    }
    expect(() =>
      buildIndexApps(
        [revised],
        options({ distDir: null, releases: releasesOf(release), strictReleases: true }),
      ),
    ).toThrow(/no signature is known for its bytes/);
  });

  it("list no revised manifest while the revision is the release's own", () => {
    const release = releasedWith({ ...hello, revision: 2 });
    const [row] = buildIndexApps(
      [{ ...hello, revision: 2 }],
      options({ distDir: null, releases: releasesOf(release) }),
    );
    expect(row?.revision).toBe(2);
    expect(row).not.toHaveProperty("catalogManifest");
  });

  it.skipIf(!appflareAvailable)(
    "omit an entry whose revision changes what only a new build can, or fail when strict",
    () => {
      const release = releasedWith(hello);
      const moved: CatalogManifest = { ...hello, requires: [], revision: 2 };
      const rows = buildIndexApps(
        [moved],
        options({ distDir: null, releases: releasesOf(release) }),
      );
      expect(rows).toEqual([]);
      expect(warnings.join("\n")).toMatch(
        /hello: omitted: .*revision 2 of hello@1\.2\.3, but it changes requires, which only a new build can change/,
      );
      expect(() =>
        buildIndexApps(
          [moved],
          options({ distDir: null, releases: releasesOf(release), strictReleases: true }),
        ),
      ).toThrow(/it changes requires/);
    },
  );

  it.skipIf(!appflareAvailable)("pass the index schema with the real @appflare/schema", () => {
    const release = releasedWith(hello);
    const revised: CatalogManifest = { ...hello, vars: [selectVar], revision: 2 };
    const rows = buildIndexApps(
      [revised],
      options({
        distDir: null,
        releases: releasesOf(release),
        revisionSignatures: signed(revised),
      }),
    );
    expect(rows).toHaveLength(1);
    const index = finalizeIndex(rows, null, new Date(), schema.indexJson);
    expect(index.apps).toEqual(rows);
  });
});
