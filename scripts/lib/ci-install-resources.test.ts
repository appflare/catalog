import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resourcesArtifactManifestFixture } from "../fixtures/artifact-manifest.ts";
import { appflareAvailable, appflareDir } from "../fixtures/schema.ts";
import { loadAppflareSchema, loadR2LifecycleHelpers } from "./appflare-schema.ts";
import {
  type CfRequest,
  createVectorizeIndexes,
  needsR2LifecycleHelpers,
  planCiApp,
  planCiInstall,
  setR2LifecycleRules,
  unpackArtifact,
} from "./ci-install.ts";
import type { ArtifactManifest, R2LifecycleRule } from "./types.ts";

const PIN = "0123456789abcdef0123456789abcdef01234567";

const search = () => resourcesArtifactManifestFixture({ sha: PIN }) as unknown as ArtifactManifest;

const DEFAULT_RULE = {
  id: "Default Multipart Abort Rule",
  enabled: true,
  conditions: { prefix: "" },
  abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 604800 } },
};

/** A stand-in for `mergeR2LifecycleRules`: the rules kept, then the declared ones by id. */
const fakeMerge = (existing: readonly unknown[], declared: readonly R2LifecycleRule[]) => [
  ...existing,
  ...declared.map((r) => ({ merged: r.id })),
];

describe("planning resource settings", () => {
  it("plans the Vectorize index with its metadata indexes", () => {
    expect(planCiInstall(search(), "ci-search-pr1").vectorizeIndexes).toEqual([
      {
        name: "ci-search-pr1-vectors",
        dimensions: 768,
        metric: "cosine",
        metadataIndexes: [
          { propertyName: "url", type: "string" },
          { propertyName: "published", type: "number" },
        ],
      },
    ]);
  });

  it("plans the bucket's lifecycle rules, and the app needs the merge helper", () => {
    const app = planCiApp(search(), "ci-search-pr1");
    expect(app.r2Lifecycles).toEqual([
      {
        bucket: "ci-search-pr1-files",
        binding: "FILES",
        rules: [
          { id: "Delete temporary files", prefix: "tmp/", deleteAfterDays: 7 },
          { id: "Archive exports", prefix: "exports/", infrequentAccessAfterDays: 30 },
        ],
      },
    ]);
    expect(needsR2LifecycleHelpers(app)).toBe(true);
    expect(app.workers[0]?.plan.config.r2_buckets).toEqual([
      { binding: "FILES", bucket_name: "ci-search-pr1-files" },
    ]);
  });

  it("plans no lifecycle rules for a bucket without any", () => {
    const m = search();
    m.worker.bindings = [{ type: "r2_bucket", name: "FILES" }];
    const app = planCiApp(m, "ci-search-pr1");
    expect(app.r2Lifecycles).toEqual([]);
    expect(needsR2LifecycleHelpers(app)).toBe(false);
  });

  it("refuses metadata indexes it cannot use", () => {
    const m = search();
    m.worker.bindings = [
      {
        type: "vectorize",
        name: "VECTORS",
        dimensions: 768,
        metric: "cosine",
        metadataIndexes: [{ propertyName: "url", type: "date" }],
      },
    ];
    expect(() => planCiInstall(m, "ci-search-pr1")).toThrow(
      "vectorize binding VECTORS records unusable metadata indexes",
    );
  });

  it("keeps _redirects and _headers out of the config's assets block", () => {
    expect(planCiInstall(search(), "ci-search-pr1").config.assets).toEqual({
      html_handling: "auto-trailing-slash",
      directory: "assets",
      binding: "ASSETS",
    });
  });
});

describe("createVectorizeIndexes with metadata indexes", () => {
  it("creates each metadata index right after its index", async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const request: CfRequest = async (method, p, body) => {
      calls.push({ method, path: p, body });
      return { status: 200, body: { success: true, result: { mutationId: "m" } } };
    };
    await createVectorizeIndexes(request, planCiInstall(search(), "ci-search-pr1"));
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/vectorize/v2/indexes",
        body: { name: "ci-search-pr1-vectors", config: { dimensions: 768, metric: "cosine" } },
      },
      {
        method: "POST",
        path: "/vectorize/v2/indexes/ci-search-pr1-vectors/metadata_index/create",
        body: { propertyName: "url", indexType: "string" },
      },
      {
        method: "POST",
        path: "/vectorize/v2/indexes/ci-search-pr1-vectors/metadata_index/create",
        body: { propertyName: "published", indexType: "number" },
      },
    ]);
  });

  it("fails with Cloudflare's error when a metadata index is refused", async () => {
    const request: CfRequest = async (_method, p) =>
      p.endsWith("/metadata_index/create")
        ? { status: 400, body: { success: false, errors: [{ code: 40026, message: "bad" }] } }
        : { status: 201, body: { success: true, result: {} } };
    await expect(
      createVectorizeIndexes(request, planCiInstall(search(), "ci-search-pr1")),
    ).rejects.toThrow(
      'creating the metadata index on "url" of Vectorize index ci-search-pr1-vectors failed: HTTP 400 (40026 bad)',
    );
  });
});

describe("setR2LifecycleRules", () => {
  it("reads the bucket's rules, merges the declared ones in, and puts them back", async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const request: CfRequest = async (method, p, body) => {
      calls.push({ method, path: p, body });
      return method === "GET"
        ? { status: 200, body: { success: true, result: { rules: [DEFAULT_RULE] } } }
        : { status: 200, body: { success: true, result: {} } };
    };
    await setR2LifecycleRules(request, planCiApp(search(), "ci-search-pr1"), fakeMerge);
    expect(calls).toEqual([
      { method: "GET", path: "/r2/buckets/ci-search-pr1-files/lifecycle", body: undefined },
      {
        method: "PUT",
        path: "/r2/buckets/ci-search-pr1-files/lifecycle",
        body: {
          rules: [
            DEFAULT_RULE,
            { merged: "Delete temporary files" },
            { merged: "Archive exports" },
          ],
        },
      },
    ]);
  });

  it("fails when the rules cannot be read, and puts nothing", async () => {
    const calls: string[] = [];
    const request: CfRequest = async (method) => {
      calls.push(method);
      return { status: 404, body: { success: false, errors: [{ code: 10006, message: "no" }] } };
    };
    await expect(
      setR2LifecycleRules(request, planCiApp(search(), "ci-search-pr1"), fakeMerge),
    ).rejects.toThrow(
      "reading the lifecycle rules of R2 bucket ci-search-pr1-files failed: HTTP 404 (10006 no)",
    );
    expect(calls).toEqual(["GET"]);
  });
});

describe("unpackArtifact with asset rule files", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ci-unpack-resources-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes _redirects and _headers at the root of the assets directory", () => {
    const main = Buffer.from("export default {}");
    const page = Buffer.from("<h1>hi</h1>");
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    writeFileSync(path.join(dir, "a.zip"), Buffer.concat([main, page]));
    const m = search();
    m.worker.modules = [
      {
        name: "index.js",
        type: "esm",
        path: "worker/index.js",
        size: main.length,
        sha256: sha(main),
        offset: 0,
      },
    ];
    m.assets.files = [
      {
        path: "assets/index.html",
        route: "/index.html",
        size: page.length,
        sha256: sha(page),
        offset: main.length,
      },
    ];
    const out = path.join(dir, "out");
    unpackArtifact(m, path.join(dir, "a.zip"), out);
    expect(readFileSync(path.join(out, "assets/_redirects"), "utf8")).toBe("/old /new 301\n");
    expect(readFileSync(path.join(out, "assets/_headers"), "utf8")).toBe(
      "/*\n  X-Frame-Options: DENY\n",
    );
    expect(readFileSync(path.join(out, "assets/index.html"), "utf8")).toBe("<h1>hi</h1>");
  });
});

describe.skipIf(!appflareAvailable)("resource settings with the real @appflare/schema", () => {
  it("accepts the fixture", async () => {
    const schema = await loadAppflareSchema(appflareDir);
    const m = resourcesArtifactManifestFixture({ sha: PIN });
    const parsed = schema.artifactManifest.safeParse(m);
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });

  it("merges rules with the manager's function, keeping Cloudflare's default rule", async () => {
    const { mergeR2LifecycleRules } = await loadR2LifecycleHelpers(appflareDir);
    const bodies: unknown[] = [];
    const request: CfRequest = async (method, _p, body) => {
      if (method === "PUT") bodies.push(body);
      return method === "GET"
        ? { status: 200, body: { success: true, result: { rules: [DEFAULT_RULE] } } }
        : { status: 200, body: { success: true, result: {} } };
    };
    await setR2LifecycleRules(request, planCiApp(search(), "ci-search-pr1"), mergeR2LifecycleRules);
    expect(bodies).toEqual([
      {
        rules: [
          DEFAULT_RULE,
          {
            // On the bucket, the rules Appflare manages carry its prefix.
            id: "appflare:Delete temporary files",
            enabled: true,
            conditions: { prefix: "tmp/" },
            deleteObjectsTransition: { condition: { type: "Age", maxAge: 7 * 86400 } },
          },
          {
            id: "appflare:Archive exports",
            enabled: true,
            conditions: { prefix: "exports/" },
            storageClassTransitions: [
              {
                condition: { type: "Age", maxAge: 30 * 86400 },
                storageClass: "InfrequentAccess",
              },
            ],
          },
        ],
      },
    ]);
  });
});
