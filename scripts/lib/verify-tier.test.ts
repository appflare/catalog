import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { sandboxFixture, selfDeployingFixture } from "../fixtures/sandbox-manifest.ts";
import { testSchema } from "../fixtures/schema.ts";
import type { AppflareSchema } from "./appflare-schema.ts";
import { findApp, loadManifest } from "./apps.ts";
import type { CfRequest, CfResponse, Probe } from "./ci-install.ts";
import { artifactUrls } from "./index-builder.ts";
import { sandboxBuild } from "./sandbox-entry.ts";
import type { CatalogManifest, IndexApp, IndexJson } from "./types.ts";
import {
  checkedWorker,
  fitsWorkerTemplate,
  manualCheckRow,
  runManualCheck,
  workerExists,
} from "./verify-tier.ts";

const fixtureApps = path.join(import.meta.dirname, "..", "fixtures", "apps");
const NOW = Date.parse("2026-09-24T12:00:00.000Z");

let schema: AppflareSchema;
let built: CatalogManifest;
let index: IndexJson;
let sandboxRow: IndexApp;
let seo: CatalogManifest;
let seoRow: IndexApp;

beforeAll(async () => {
  schema = await testSchema();
  const hello = loadManifest(findApp(fixtureApps, "hello"), schema.catalogManifest);
  built = sandboxFixture(hello, schema);
  seo = selfDeployingFixture(hello, schema);
  seoRow = {
    slug: "seo",
    name: "Hello",
    summary: "s",
    version: "1.2.3",
    tier: "self-deploying",
    plan: "paid",
    requires: [],
    lastVerified: null,
    authors: [{ name: "octocat", github: "octocat" }],
    maintainers: ["octocat"],
    build: sandboxBuild(seo, "appflare/catalog", schema.sandboxDefaults),
  };
  sandboxRow = {
    slug: "built",
    name: "Hello",
    summary: "s",
    version: "1.2.3",
    tier: "sandbox",
    plan: "paid",
    requires: [],
    lastVerified: null,
    authors: [{ name: "octocat", github: "octocat" }],
    maintainers: ["octocat"],
    build: sandboxBuild(built, "appflare/catalog", schema.sandboxDefaults),
  };
  index = {
    generatedAt: "2026-09-20T00:00:00.000Z",
    featured: [],
    apps: [
      sandboxRow,
      seoRow,
      {
        slug: "hello",
        name: "Hello",
        summary: "s",
        version: "1.2.3",
        artifacts: artifactUrls("appflare/catalog", "hello", "1.2.3"),
        digest: "d".repeat(64),
        tier: "artifact",
        plan: "free",
        requires: [],
        lastVerified: null,
        authors: [{ name: "octocat", github: "octocat" }],
        maintainers: ["octocat"],
      },
    ],
  };
});

/** An account holding exactly these Workers, recording each request. */
function account(workers: string[], calls: string[] = []): CfRequest {
  return async (method, apiPath): Promise<CfResponse> => {
    calls.push(`${method} ${apiPath}`);
    if (apiPath === "/workers/subdomain") {
      return { status: 200, body: { success: true, result: { subdomain: "acme" } } };
    }
    const match = /^\/workers\/scripts\/([^/]+)\/settings$/.exec(apiPath);
    if (match?.[1] && workers.includes(decodeURIComponent(match[1]))) {
      return { status: 200, body: { success: true, result: {} } };
    }
    return {
      status: 404,
      body: {
        success: false,
        errors: [{ code: 10007, message: "workers.api.error.script_not_found" }],
      },
    };
  };
}

function check(request: CfRequest, probe: (url: string) => Promise<Probe>, over = {}) {
  return runManualCheck({
    index,
    slug: "built",
    version: "1.2.3",
    manifest: built,
    request,
    probe,
    now: () => NOW,
    sleep: async () => {},
    log: () => {},
    timeoutMs: 0,
    ...over,
  });
}

describe("manualCheckRow", () => {
  it("returns the sandbox row and its manifestDigest", () => {
    expect(manualCheckRow(index, "built", "1.2.3")).toEqual({
      row: sandboxRow,
      digest: sandboxRow.build?.manifestDigest,
    });
  });

  it("refuses unlisted entries, artifact tier entries, and another version", () => {
    expect(() => manualCheckRow(index, "nope", "1.0.0")).toThrow(/not listed in index\.json/);
    expect(() => manualCheckRow(index, "hello", "1.2.3")).toThrow(/nightly workflow/);
    expect(() => manualCheckRow(index, "built", "1.2.2")).toThrow(
      /index\.json lists built 1\.2\.3, not 1\.2\.2/,
    );
  });
});

describe("checkedWorker", () => {
  it("defaults to the manifest's workerName, or takes the one given", () => {
    expect(checkedWorker(built, undefined)).toBe("built");
    expect(checkedWorker(built, "built-2")).toBe("built-2");
  });

  it("needs a self-deploying entry's Worker, named after its first template", () => {
    expect(() => checkedWorker(seo, undefined)).toThrow(
      /seo names its Worker after each install's stage \(seo-\{\{stage\}\}\)/,
    );
    expect(checkedWorker(seo, "seo-appflare-1a2b3c4d")).toBe("seo-appflare-1a2b3c4d");
    expect(() => checkedWorker(seo, "seo")).toThrow(/installer names that one seo-\{\{stage\}\}/);
    expect(() => checkedWorker(seo, "other-appflare-1a2b3c4d")).toThrow(
      /not the Worker that serves seo/,
    );
    // The entry's other Worker fits the first template too, with a wrong stage.
    expect(() => checkedWorker(seo, "seo-appflare-1a2b3c4d-worker")).toThrow(
      /not seo-\{\{stage\}\}-worker/,
    );
  });
});

describe("fitsWorkerTemplate", () => {
  it("matches the template with one stage in place of {{stage}}", () => {
    expect(fitsWorkerTemplate("open-seo-{{stage}}", "open-seo-selfhost")).toBe(true);
    expect(fitsWorkerTemplate("open-seo-{{stage}}-audit", "open-seo-appflare-ab12cd34-audit")).toBe(
      true,
    );
    expect(fitsWorkerTemplate("open-seo-{{stage}}", "open-seo-")).toBe(false);
    expect(fitsWorkerTemplate("open-seo-{{stage}}", "open-seo-Stage")).toBe(false);
    expect(fitsWorkerTemplate("open-seo-{{stage}}", "open-seo-a-")).toBe(false);
    expect(fitsWorkerTemplate("open-seo-{{stage}}", `open-seo-${"a".repeat(25)}`)).toBe(false);
    expect(fitsWorkerTemplate("a.b-{{stage}}", "axb-s")).toBe(false);
  });

  it("rejects a name that also fits another of the entry's templates", () => {
    const audit = "open-seo-appflare-ab12cd34-audit";
    expect(fitsWorkerTemplate("open-seo-{{stage}}", audit)).toBe(true);
    expect(fitsWorkerTemplate("open-seo-{{stage}}", audit, ["open-seo-{{stage}}-audit"])).toBe(
      false,
    );
    expect(
      fitsWorkerTemplate("open-seo-{{stage}}", "open-seo-appflare-ab12cd34", [
        "open-seo-{{stage}}-audit",
      ]),
    ).toBe(true);
  });
});

describe("workerExists", () => {
  it("answers yes or no, and throws on anything else", async () => {
    expect(await workerExists(account(["x"]), "x")).toBe(true);
    expect(await workerExists(account([]), "x")).toBe(false);
    const denied: CfRequest = async () => ({
      status: 403,
      body: { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
    });
    await expect(workerExists(denied, "x")).rejects.toThrow(
      /HTTP 403 \(10000 Authentication error\)/,
    );
  });
});

describe("runManualCheck", () => {
  it("fails clearly, before anything else, when the account has no sandbox Worker", async () => {
    const calls: string[] = [];
    let probed = false;
    await expect(
      check(account(["built"], calls), async () => {
        probed = true;
        return { status: 200, body: "" };
      }),
    ).rejects.toThrow(/this account has no appflare-sandbox Worker/);
    expect(calls).toEqual(["GET /workers/scripts/appflare-sandbox/settings"]);
    expect(probed).toBe(false);
  });

  it("fails when the app's Worker is missing or unhealthy", async () => {
    await expect(
      check(account(["appflare-sandbox"]), async () => ({ status: 200, body: "" })),
    ).rejects.toThrow(/no Worker named built/);
    await expect(
      check(account(["appflare-sandbox", "built"]), async () => ({ status: 503, body: "down" })),
    ).rejects.toThrow(/built failed the health check: HTTP 503/);
  });

  it("returns the check to record, against the row's manifestDigest", async () => {
    const urls: string[] = [];
    const verified = await check(account(["appflare-sandbox", "built"]), async (url) => {
      urls.push(url);
      return { status: 200, body: "ok" };
    });
    expect(urls).toEqual(["https://built.acme.workers.dev/"]);
    expect(verified).toEqual({
      built: {
        version: "1.2.3",
        digest: sandboxRow.build?.manifestDigest,
        at: "2026-09-24T12:00:00.000Z",
      },
    });
  });

  it("checks the Worker name the maintainer installed under", async () => {
    const urls: string[] = [];
    await check(
      account(["appflare-sandbox", "built-2"]),
      async (url) => {
        urls.push(url);
        return { status: 200, body: "ok" };
      },
      { worker: "built-2" },
    );
    expect(urls).toEqual(["https://built-2.acme.workers.dev/"]);
  });

  it("verifies a self-deploying entry at the Worker its installer created", async () => {
    const urls: string[] = [];
    const calls: string[] = [];
    const verified = await check(
      account(["appflare-sandbox", "seo-appflare-1a2b3c4d"], calls),
      async (url) => {
        urls.push(url);
        return { status: 200, body: "ok" };
      },
      { slug: "seo", manifest: seo, worker: "seo-appflare-1a2b3c4d" },
    );
    expect(urls).toEqual(["https://seo-appflare-1a2b3c4d.acme.workers.dev/"]);
    expect(verified).toEqual({
      seo: {
        version: "1.2.3",
        digest: seoRow.build?.manifestDigest,
        at: "2026-09-24T12:00:00.000Z",
      },
    });
  });

  it("refuses a self-deploying check without the Worker name before calling Cloudflare", async () => {
    const calls: string[] = [];
    await expect(
      check(account(["appflare-sandbox"], calls), async () => ({ status: 200, body: "" }), {
        slug: "seo",
        manifest: seo,
      }),
    ).rejects.toThrow(/with the stage the manager's app page shows/);
    expect(calls).toEqual([]);
  });
});
