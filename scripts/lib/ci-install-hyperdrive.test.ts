import { describe, expect, it } from "vitest";
import { artifactManifestFixture } from "../fixtures/artifact-manifest.ts";
import {
  type CfRequest,
  type CfResponse,
  cleanupCiInstall,
  createHyperdriveConfigs,
  declaredProtocol,
  HYPERDRIVE_SKIP,
  hyperdriveSkip,
  planCiApp,
  planCiInstall,
  skipReport,
  testDatabaseOrigin,
  withHyperdriveIds,
} from "./ci-install.ts";
import type { ArtifactManifest } from "./types.ts";

const PIN = "0123456789abcdef0123456789abcdef01234567";
const PASSWORD = "test-db-pass-NEVER-PRINTED";
const TEST_URL = `postgres://ci:${PASSWORD}@db.example.com:6543/appflare_ci`;
const MYSQL_URL = `mysql://ci:${PASSWORD}@db.example.com/appflare_ci`;

/** The hello fixture binding Hyperdrive as HYPERDRIVE, declared with `protocol`. */
function manifest(protocol?: "postgres" | "mysql"): ArtifactManifest {
  const m = artifactManifestFixture({ app: "hello", version: "1.2.3", sha: PIN });
  (m.worker as Record<string, unknown>).bindings = [
    { type: "hyperdrive", name: "HYPERDRIVE" },
    { type: "kv_namespace", name: "CUT_KV" },
  ];
  if (protocol !== undefined) {
    const catalog = m.catalog as Record<string, unknown>;
    catalog.resources = { hyperdrive: { HYPERDRIVE: { protocol } } };
  }
  return m as unknown as ArtifactManifest;
}

/** A fake account with Hyperdrive configurations by id, recording every call. */
function fakeAccount(options: { refuse?: string } = {}) {
  const configs = new Map<string, string>();
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const ok = (result: unknown): CfResponse => ({
    status: 200,
    body: { success: true, result, errors: [] },
  });
  const request: CfRequest = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    if (method === "GET" && path.startsWith("/hyperdrive/configs")) {
      return ok([...configs].map(([id, name]) => ({ id, name })));
    }
    if (method === "POST" && path === "/hyperdrive/configs") {
      bodies.push(body);
      if (options.refuse !== undefined) {
        return {
          status: 400,
          body: { success: false, errors: [{ code: 2008, message: options.refuse }] },
        };
      }
      const id = `hd-${configs.size + 1}`;
      configs.set(id, (body as { name: string }).name);
      return ok({ id, name: (body as { name: string }).name });
    }
    const del = /^DELETE \/hyperdrive\/configs\/(.+)$/.exec(`${method} ${path}`);
    if (del?.[1] !== undefined) {
      return configs.delete(del[1])
        ? ok(null)
        : { status: 404, body: { success: false, errors: [] } };
    }
    if (method === "DELETE") return ok(null);
    // Everything else (Workers, KV) is already gone.
    if (path.startsWith("/storage/kv/namespaces")) return ok([]);
    return { status: 404, body: { success: false, errors: [] } };
  };
  return { request, configs, calls, bodies };
}

describe("Hyperdrive in the install check", () => {
  it("plans a configuration per binding, named like any resource, with the declared protocol", () => {
    const plan = planCiInstall(manifest("postgres"), "ci-hello-pr1");
    expect(plan.hyperdriveConfigs).toEqual([
      { name: "ci-hello-pr1-hyperdrive", binding: "HYPERDRIVE", protocol: "postgres" },
    ]);
    expect(plan.resources).toContainEqual({
      type: "hyperdrive",
      name: "ci-hello-pr1-hyperdrive",
      binding: "HYPERDRIVE",
    });
    expect(plan.config.hyperdrive).toEqual([{ binding: "HYPERDRIVE", id: "" }]);
    expect(planCiApp(manifest("mysql"), "ci-hello-pr1").hyperdriveConfigs).toEqual([
      { name: "ci-hello-pr1-hyperdrive", binding: "HYPERDRIVE", protocol: "mysql" },
    ]);
    expect(declaredProtocol({}, "HYPERDRIVE")).toBe("postgres");
  });

  it("reads each binding's protocol from resources.hyperdrive, keyed by the binding's name", () => {
    const m = artifactManifestFixture({ app: "hello", version: "1.2.3", sha: PIN });
    (m.worker as Record<string, unknown>).bindings = [
      { type: "hyperdrive", name: "MAIN" },
      { type: "hyperdrive", name: "LEGACY" },
    ];
    (m.catalog as Record<string, unknown>).resources = {
      hyperdrive: {
        MAIN: { protocol: "postgres", label: "Main database" },
        LEGACY: { protocol: "mysql", help: "MySQL 8 or later." },
      },
    };
    expect(declaredProtocol(m.catalog, "LEGACY")).toBe("mysql");
    expect(declaredProtocol(m.catalog, "OTHER")).toBe("postgres");
    const app = planCiApp(m as unknown as ArtifactManifest, "ci-hello-pr1");
    expect(app.hyperdriveConfigs.map((c) => [c.binding, c.protocol])).toEqual([
      ["MAIN", "postgres"],
      ["LEGACY", "mysql"],
    ]);
    // One test database cannot stand in for both.
    expect(hyperdriveSkip(app, TEST_URL)?.reason).toBe(
      "skipped: HYPERDRIVE_TEST_URL is not a MySQL database",
    );
    expect(hyperdriveSkip(app, MYSQL_URL)?.reason).toBe(
      "skipped: HYPERDRIVE_TEST_URL is not a PostgreSQL database",
    );
  });

  it("skips a MySQL binding on a PostgreSQL test database, and installs it on a MySQL one", async () => {
    const app = planCiApp(manifest("mysql"), "ci-hello-pr1");
    expect(hyperdriveSkip(app, TEST_URL)?.kind).toBe("hyperdrive");
    expect(hyperdriveSkip(app, MYSQL_URL)).toBeNull();
    const account = fakeAccount();
    expect(await createHyperdriveConfigs(account.request, app, MYSQL_URL)).toEqual({
      HYPERDRIVE: "hd-1",
    });
    expect(account.bodies).toEqual([
      {
        name: "ci-hello-pr1-hyperdrive",
        origin: {
          scheme: "mysql",
          host: "db.example.com",
          port: 3306,
          database: "appflare_ci",
          user: "ci",
          password: PASSWORD,
        },
      },
    ]);
  });

  it("skips without HYPERDRIVE_TEST_URL, or with a database of another protocol", () => {
    const app = planCiApp(manifest("postgres"), "ci-hello-pr1");
    expect(hyperdriveSkip(app, undefined)).toBe(HYPERDRIVE_SKIP);
    expect(hyperdriveSkip(app, "  ")).toBe(HYPERDRIVE_SKIP);
    expect(hyperdriveSkip(app, TEST_URL)).toBeNull();
    const mysql = planCiApp(manifest("mysql"), "ci-hello-pr1");
    expect(hyperdriveSkip(mysql, TEST_URL)).toEqual({
      kind: "hyperdrive",
      reason: "skipped: HYPERDRIVE_TEST_URL is not a MySQL database",
    });
    // An app without Hyperdrive never skips for it.
    const plain = artifactManifestFixture({ app: "hello", version: "1.2.3", sha: PIN });
    expect(
      hyperdriveSkip(planCiApp(plain as unknown as ArtifactManifest, "ci-hello-pr1"), undefined),
    ).toBeNull();
    expect(
      skipReport({ app: "hello", version: "1.2.3" }, "ci-hello-pr1", HYPERDRIVE_SKIP).summary,
    ).toEqual([
      "SKIP hello@1.2.3 as ci-hello-pr1: skipped: Hyperdrive binding and no HYPERDRIVE_TEST_URL",
    ]);
  });

  it("reads the test URL into an origin, and never repeats it in a reason", () => {
    expect(testDatabaseOrigin(TEST_URL, "postgres")).toEqual({
      ok: true,
      origin: {
        scheme: "postgres",
        host: "db.example.com",
        port: 6543,
        database: "appflare_ci",
        user: "ci",
        password: PASSWORD,
      },
    });
    for (const bad of [`nonsense ${PASSWORD}`, `postgres://ci:${PASSWORD}@db.example.com`]) {
      const result = testDatabaseOrigin(bad, "postgres");
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(PASSWORD);
    }
  });

  it("creates each configuration from the test URL and fills the ids into the config", async () => {
    const app = planCiApp(manifest("postgres"), "ci-hello-pr1");
    const account = fakeAccount();
    const ids = await createHyperdriveConfigs(account.request, app, TEST_URL);
    expect(ids).toEqual({ HYPERDRIVE: "hd-1" });
    expect(account.bodies).toEqual([
      {
        name: "ci-hello-pr1-hyperdrive",
        origin: {
          scheme: "postgres",
          host: "db.example.com",
          port: 6543,
          database: "appflare_ci",
          user: "ci",
          password: PASSWORD,
        },
      },
    ]);
    const config = withHyperdriveIds(app.workers[0]?.plan.config ?? {}, ids);
    expect(config.hyperdrive).toEqual([{ binding: "HYPERDRIVE", id: "hd-1" }]);
    expect(() => withHyperdriveIds(app.workers[0]?.plan.config ?? {}, {})).toThrow(
      /no Hyperdrive configuration was created for the binding HYPERDRIVE/,
    );
  });

  it("fails with Cloudflare's reason when it cannot reach the test database", async () => {
    const app = planCiApp(manifest("postgres"), "ci-hello-pr1");
    const account = fakeAccount({ refuse: "Failed to connect to the origin database" });
    const error = await createHyperdriveConfigs(account.request, app, TEST_URL).catch(
      (e: unknown) => e as Error,
    );
    expect(error?.message).toBe(
      "creating Hyperdrive configuration ci-hello-pr1-hyperdrive failed: HTTP 400 (2008 Failed to connect to the origin database)",
    );
    expect(error?.message).not.toContain(PASSWORD);
  });

  it("deletes the configuration in cleanup, found by name", async () => {
    const plan = planCiInstall(manifest("postgres"), "ci-hello-pr1");
    const account = fakeAccount();
    account.configs.set("hd-9", "ci-hello-pr1-hyperdrive");
    account.configs.set("hd-other", "someone-else");
    expect(await cleanupCiInstall(account.request, plan)).toEqual([]);
    expect(account.calls).toContain("DELETE /hyperdrive/configs/hd-9");
    expect([...account.configs.keys()]).toEqual(["hd-other"]);
  });
});
