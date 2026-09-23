import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { artifactManifestFixture } from "../fixtures/artifact-manifest.ts";
import {
  type CfRequest,
  type CfResponse,
  type CiInstallPlan,
  ciWorkerName,
  classifyProbe,
  cleanupCiInstall,
  type Probe,
  planCiInstall,
  unpackArtifact,
  waitForHealth,
  workersSubdomain,
} from "./ci-install.ts";
import type { ArtifactManifest } from "./types.ts";

const PIN = "0123456789abcdef0123456789abcdef01234567";

function manifest(edit: (m: Record<string, unknown>) => void = () => {}): ArtifactManifest {
  const m = artifactManifestFixture({ app: "hello", version: "1.2.3", sha: PIN });
  edit(m);
  return m as unknown as ArtifactManifest;
}

function worker(m: Record<string, unknown>): Record<string, unknown> {
  return m.worker as Record<string, unknown>;
}

describe("ciWorkerName", () => {
  it("builds ci-<slug>-<suffix> and rejects unusable names", () => {
    expect(ciWorkerName("cut", "pr12")).toBe("ci-cut-pr12");
    expect(() => ciWorkerName("x".repeat(60), "pr1")).toThrow(/not a usable Worker name/);
    expect(() => ciWorkerName("bad_slug", "pr1")).toThrow();
  });
});

describe("planCiInstall", () => {
  it("writes bindings without ids under the manager's resource names", () => {
    const plan = planCiInstall(
      manifest((m) => {
        worker(m).bindings = [
          { type: "kv_namespace", name: "CUT_KV" },
          { type: "d1", name: "DB" },
          { type: "r2_bucket", name: "MEDIA_BUCKET" },
          { type: "workflow", name: "JOBS", workflow_name: "jobs", class_name: "JobWorkflow" },
          { type: "durable_object_namespace", name: "ROOMS", class_name: "Room" },
          { type: "ai", name: "AI" },
          { type: "plain_text", name: "MODE", text: "prod" },
        ];
        m.d1Migrations = {
          DB: [
            {
              name: "0001_init.sql",
              path: "d1/DB/0001_init.sql",
              size: 1,
              sha256: "a".repeat(64),
              offset: 0,
            },
          ],
        };
      }),
      "ci-hello-pr1",
    );
    expect(plan.resources).toEqual([
      { type: "kv", name: "ci-hello-pr1-cut-kv", binding: "CUT_KV" },
      { type: "d1", name: "ci-hello-pr1-db", binding: "DB" },
      { type: "r2", name: "ci-hello-pr1-media-bucket", binding: "MEDIA_BUCKET" },
      { type: "workflow", name: "ci-hello-pr1-jobs", binding: "JOBS" },
    ]);
    expect(plan.d1Migrations).toEqual(["ci-hello-pr1-db"]);
    expect(plan.config).toMatchObject({
      name: "ci-hello-pr1",
      main: "worker/index.js",
      no_bundle: true,
      workers_dev: true,
      kv_namespaces: [{ binding: "CUT_KV" }],
      d1_databases: [{ binding: "DB", database_name: "ci-hello-pr1-db", migrations_dir: "d1/DB" }],
      r2_buckets: [{ binding: "MEDIA_BUCKET", bucket_name: "ci-hello-pr1-media-bucket" }],
      workflows: [{ binding: "JOBS", name: "ci-hello-pr1-jobs", class_name: "JobWorkflow" }],
      durable_objects: { bindings: [{ name: "ROOMS", class_name: "Room" }] },
      ai: { binding: "AI" },
      vars: { MODE: "prod" },
      triggers: { crons: [] },
    });
    expect(JSON.stringify(plan.config)).not.toMatch(/"id"|database_id|account_id/);
  });

  it("takes secrets and var defaults from the catalog manifest", () => {
    const plan = planCiInstall(
      manifest((m) => {
        const catalog = m.catalog as Record<string, unknown>;
        catalog.secrets = [{ name: "ADMIN_PASSWORD", label: "Admin", generate: true }];
        catalog.vars = [
          { name: "HOME_PAGE", label: "Home", required: false },
          { name: "REGION", label: "Region", default: "eu", required: false },
          { name: "API_URL", label: "API", required: true },
        ];
      }),
      "ci-hello-pr1",
    );
    expect(plan.secrets).toEqual(["ADMIN_PASSWORD"]);
    expect(plan.config.vars).toEqual({ REGION: "eu", API_URL: "ci" });
  });

  it("refuses bindings it cannot create and clean up", () => {
    expect(() =>
      planCiInstall(
        manifest((m) => {
          worker(m).bindings = [{ type: "queue", name: "Q" }];
        }),
        "ci-hello-pr1",
      ),
    ).toThrow(/cannot create a queue binding \(Q\)/);
  });
});

describe("unpackArtifact", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ci-unpack-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function zipWith(files: Record<string, string>) {
    let offset = 0;
    const parts: Buffer[] = [];
    const entries: Record<string, { path: string; size: number; sha256: string; offset: number }> =
      {};
    for (const [name, text] of Object.entries(files)) {
      const data = Buffer.from(text);
      entries[name] = {
        path: name,
        size: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
        offset,
      };
      parts.push(data);
      offset += data.length;
    }
    writeFileSync(path.join(dir, "a.zip"), Buffer.concat(parts));
    return entries;
  }

  it("writes modules, assets, and migrations after checking every hash", () => {
    const e = zipWith({
      main: "export default {}",
      page: "<h1>hi</h1>",
      sql: "CREATE TABLE t(x);",
    });
    const m = manifest((m) => {
      worker(m).modules = [{ name: "index.js", type: "esm", ...e.main }];
      m.assets = {
        config: {},
        binding: null,
        files: [{ route: "/docs/index.html", hash: "b".repeat(32), ...e.page }],
      };
      m.d1Migrations = { DB: [{ name: "0001_init.sql", ...e.sql }] };
    });
    const out = path.join(dir, "out");
    unpackArtifact(m, path.join(dir, "a.zip"), out);
    expect(readFileSync(path.join(out, "worker/index.js"), "utf8")).toBe("export default {}");
    expect(readFileSync(path.join(out, "assets/docs/index.html"), "utf8")).toBe("<h1>hi</h1>");
    expect(readFileSync(path.join(out, "d1/DB/0001_init.sql"), "utf8")).toBe("CREATE TABLE t(x);");
  });

  it("rejects a tampered file and a path escaping the output", () => {
    const e = zipWith({ main: "export default {}" });
    const bad = manifest((m) => {
      worker(m).modules = [{ name: "index.js", type: "esm", ...e.main, sha256: "0".repeat(64) }];
    });
    expect(() => unpackArtifact(bad, path.join(dir, "a.zip"), path.join(dir, "o1"))).toThrow(
      /sha256 mismatch/,
    );
    const escaping = manifest((m) => {
      worker(m).modules = [{ name: "../evil.js", type: "esm", ...e.main }];
    });
    expect(() => unpackArtifact(escaping, path.join(dir, "a.zip"), path.join(dir, "o2"))).toThrow(
      /unsafe path/,
    );
  });
});

describe("health", () => {
  it("classifies probes", () => {
    expect(classifyProbe({ status: 200, body: "" })).toBe("ok");
    expect(classifyProbe({ status: 302, body: "" })).toBe("ok");
    expect(classifyProbe({ status: 503, body: "" })).toBe("retry");
    expect(classifyProbe({ status: 404, body: "error code: 1042" })).toBe("retry");
    expect(classifyProbe({ status: 404, body: "Not found" })).toBe("soft-404");
    expect(classifyProbe({ error: "ECONNRESET" })).toBe("retry");
  });

  function clock(probes: Probe[]) {
    let t = 0;
    let i = 0;
    return {
      probe: async () => probes[Math.min(i++, probes.length - 1)] as Probe,
      options: {
        timeoutMs: 10,
        intervalMs: 3,
        sleep: async (ms: number) => {
          t += ms;
        },
        now: () => t,
      },
    };
  }

  it("retries through 1042 and 5xx until the Worker answers", async () => {
    const c = clock([
      { status: 404, body: "error code: 1042" },
      { status: 500, body: "" },
      { status: 200, body: "ok" },
    ]);
    expect(await waitForHealth(c.probe, c.options)).toEqual({ ok: true, detail: "HTTP 200" });
  });

  it("fails on a persistent 5xx and passes a persistent plain 404", async () => {
    const down = clock([{ status: 502, body: "bad gateway" }]);
    expect((await waitForHealth(down.probe, down.options)).ok).toBe(false);
    const notFound = clock([{ status: 404, body: "Not found" }]);
    expect((await waitForHealth(notFound.probe, notFound.options)).ok).toBe(true);
  });
});

/** A fake Cloudflare account holding named resources. */
function fakeAccount(state: {
  scripts: Set<string>;
  kv: { id: string; title: string }[];
  d1: { uuid: string; name: string }[];
  r2: Set<string>;
  workflows: Set<string>;
  failDelete?: string;
  /** Objects per bucket; a bucket with objects refuses deletion. */
  objects?: Map<string, string[]>;
  /** Object deletes answer 200 but nothing goes away. */
  stuckObjects?: boolean;
}): CfRequest & { calls: string[] } {
  const calls: string[] = [];
  const ok = (result: unknown): CfResponse => ({ status: 200, body: { success: true, result } });
  const missing: CfResponse = {
    status: 404,
    body: { success: false, errors: [{ code: 10007, message: "not found" }] },
  };
  const fn = (async (method: string, p: string) => {
    calls.push(`${method} ${p}`);
    if (method === "DELETE" && state.failDelete && p.includes(state.failDelete)) {
      return {
        status: 409,
        body: { success: false, errors: [{ code: 10008, message: "bucket not empty" }] },
      };
    }
    const script = p.match(/^\/workers\/scripts\/([^/?]+)(\?force=true|\/settings)$/);
    const kvItem = p.match(/^\/storage\/kv\/namespaces\/(.+)$/);
    const d1Item = p.match(/^\/d1\/database\/(.+)$/);
    if (script) {
      const m = script;
      const name = decodeURIComponent(m[1] as string);
      if (!state.scripts.has(name)) return missing;
      if (method === "DELETE") state.scripts.delete(name);
      return ok({});
    }
    if (p.startsWith("/storage/kv/namespaces?")) return ok(state.kv);
    if (kvItem) {
      state.kv = state.kv.filter((ns) => ns.id !== kvItem[1]);
      return ok(null);
    }
    if (p.startsWith("/d1/database?")) return ok(state.d1);
    if (d1Item) {
      state.d1 = state.d1.filter((db) => db.uuid !== d1Item[1]);
      return ok(null);
    }
    const objects = p.match(/^\/r2\/buckets\/([^/?]+)\/objects(?:\?per_page=1000|\/(.+))$/);
    if (objects) {
      const bucket = decodeURIComponent(objects[1] as string);
      const list = state.objects?.get(bucket) ?? [];
      if (method === "GET") {
        return ok(list.slice(0, 1000).map((key) => ({ key })));
      }
      const key = (objects[2] as string).split("/").map(decodeURIComponent).join("/");
      if (!state.stuckObjects) {
        state.objects?.set(
          bucket,
          list.filter((k) => k !== key),
        );
      }
      return ok(null);
    }
    const bucketDelete = method === "DELETE" && p.startsWith("/r2/buckets/");
    if (bucketDelete) {
      const bucket = decodeURIComponent(p.slice("/r2/buckets/".length));
      if ((state.objects?.get(bucket)?.length ?? 0) > 0) {
        return {
          status: 409,
          body: { success: false, errors: [{ code: 10008, message: "bucket not empty" }] },
        };
      }
    }
    for (const [prefix, set] of [
      ["/r2/buckets/", state.r2],
      ["/workflows/", state.workflows],
    ] as const) {
      if (p.startsWith(prefix)) {
        const name = decodeURIComponent(p.slice(prefix.length));
        if (!set.has(name)) return missing;
        if (method === "DELETE") set.delete(name);
        return ok({});
      }
    }
    if (p === "/workers/subdomain") return ok({ subdomain: "appflare-ci" });
    throw new Error(`unexpected ${method} ${p}`);
  }) as CfRequest & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe("cleanupCiInstall", () => {
  const plan: CiInstallPlan = {
    name: "ci-hello-pr1",
    config: {},
    secrets: [],
    d1Migrations: [],
    resources: [
      { type: "kv", name: "ci-hello-pr1-cut-kv", binding: "CUT_KV" },
      { type: "d1", name: "ci-hello-pr1-db", binding: "DB" },
      { type: "r2", name: "ci-hello-pr1-media", binding: "MEDIA" },
      { type: "workflow", name: "ci-hello-pr1-jobs", binding: "JOBS" },
    ],
  };

  function populated(failDelete?: string) {
    return {
      scripts: new Set(["ci-hello-pr1", "someone-else"]),
      kv: [
        { id: "kv1", title: "ci-hello-pr1-cut-kv" },
        { id: "kv2", title: "keep-me" },
      ],
      d1: [{ uuid: "db1", name: "ci-hello-pr1-db" }],
      r2: new Set(["ci-hello-pr1-media"]),
      workflows: new Set(["ci-hello-pr1-jobs"]),
      ...(failDelete ? { failDelete } : {}),
    };
  }

  it("deletes the Worker and every planned resource by name, and nothing else", async () => {
    const state = populated();
    expect(await cleanupCiInstall(fakeAccount(state), plan)).toEqual([]);
    expect([...state.scripts]).toEqual(["someone-else"]);
    expect(state.kv).toEqual([{ id: "kv2", title: "keep-me" }]);
    expect(state.d1).toEqual([]);
    expect(state.r2.size + state.workflows.size).toBe(0);
  });

  it("is a no-op on a clean account (a deploy that never got far)", async () => {
    const empty = {
      scripts: new Set<string>(),
      kv: [],
      d1: [],
      r2: new Set<string>(),
      workflows: new Set<string>(),
    };
    expect(await cleanupCiInstall(fakeAccount(empty), plan)).toEqual([]);
  });

  it("reports anything it could not delete", async () => {
    const problems = await cleanupCiInstall(fakeAccount(populated("/r2/buckets/")), plan);
    expect(problems).toEqual([
      "r2 ci-hello-pr1-media: delete failed: HTTP 409 (10008 bucket not empty)",
      "r2 ci-hello-pr1-media still exists",
    ]);
  });

  it("empties an R2 bucket (several pages, keys with slashes and spaces) before deleting it", async () => {
    const keys = Array.from({ length: 2500 }, (_, i) => `uploads/${i}/file name.txt`);
    const state = { ...populated(), objects: new Map([["ci-hello-pr1-media", keys]]) };
    const account = fakeAccount(state);
    expect(await cleanupCiInstall(account, plan)).toEqual([]);
    expect(state.r2.size).toBe(0);
    expect(state.objects.get("ci-hello-pr1-media")).toEqual([]);
    expect(account.calls).toContain(
      "DELETE /r2/buckets/ci-hello-pr1-media/objects/uploads/7/file%20name.txt",
    );
  });

  it("gives up on a bucket that never empties", async () => {
    const state = {
      ...populated(),
      objects: new Map([["ci-hello-pr1-media", ["stuck"]]]),
      stuckObjects: true,
    };
    const problems = await cleanupCiInstall(fakeAccount(state), plan);
    expect(problems[0]).toMatch(/still has objects after 100 rounds of deletes/);
    expect(problems).toContain("r2 ci-hello-pr1-media still exists");
  });

  it("reads the workers.dev subdomain", async () => {
    expect(await workersSubdomain(fakeAccount(populated()))).toBe("appflare-ci");
  });
});
