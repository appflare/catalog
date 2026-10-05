import { describe, expect, it } from "vitest";
import { artifactManifestFixture } from "../fixtures/artifact-manifest.ts";
import { appflareAvailable, appflareDir } from "../fixtures/schema.ts";
import { loadAppflareSchema } from "./appflare-schema.ts";
import { planCiInstall } from "./ci-install.ts";
import type { ArtifactManifest } from "./types.ts";

const PIN = "0123456789abcdef0123456789abcdef01234567";

/**
 * An artifact whose Worker declares a Durable Object and an
 * entrypoint in `exports`, a `cache` block, and a Worker Loader (a Workers
 * Paid binding, so the catalog manifest says `plan: "paid"`).
 */
function withSettings(): Record<string, unknown> {
  const m = artifactManifestFixture({ app: "sandboxed", version: "1.0.0", sha: PIN });
  const worker = m.worker as Record<string, unknown>;
  worker.bindings = [
    { type: "durable_object_namespace", name: "ROOMS", class_name: "Room" },
    { type: "worker_loader", name: "LOADER" },
  ];
  worker.exports = {
    Room: { type: "durable-object", storage: "sqlite" },
    Api: { type: "worker" },
  };
  worker.cacheOptions = { enabled: true, cross_version_cache: false };
  m.catalog = { ...(m.catalog as Record<string, unknown>), plan: "paid" };
  return m;
}

describe("planCiInstall with a Worker's exports, cache and Worker Loaders", () => {
  it("writes them into the config as wrangler reads them", () => {
    const plan = planCiInstall(withSettings() as unknown as ArtifactManifest, "ci-sandboxed-pr1");
    expect(plan.config.exports).toEqual({
      Room: { type: "durable-object", storage: "sqlite" },
      Api: { type: "worker" },
    });
    expect(plan.config.cache).toEqual({ enabled: true, cross_version_cache: false });
    expect(plan.config.worker_loaders).toEqual([{ binding: "LOADER" }]);
    // A Worker Loader is not a resource: nothing to create or delete.
    expect(plan.resources).toEqual([]);
  });

  it("writes none of them for a Worker without them", () => {
    const m = artifactManifestFixture({ app: "hello", version: "1.2.3", sha: PIN });
    const config = planCiInstall(m as unknown as ArtifactManifest, "ci-hello-pr1").config;
    expect(config).not.toHaveProperty("exports");
    expect(config).not.toHaveProperty("cache");
    expect(config).not.toHaveProperty("worker_loaders");
  });

  it("copies the exports, so the config never shares objects with the manifest", () => {
    const m = withSettings() as unknown as ArtifactManifest;
    const config = planCiInstall(m, "ci-sandboxed-pr1").config as {
      exports: Record<string, Record<string, unknown>>;
    };
    (config.exports.Room as Record<string, unknown>).storage = "kv";
    expect(m.worker.exports?.Room?.storage).toBe("sqlite");
  });
});

describe.skipIf(!appflareAvailable)(
  "exports, cache and loaders with the real @appflare/schema",
  () => {
    it("accepts them", async () => {
      const schema = await loadAppflareSchema(appflareDir);
      expect(schema.artifactManifest.safeParse(withSettings()).success).toBe(true);
    });

    it("refuses a Worker Loader in an app that does not say it needs Workers Paid", async () => {
      const schema = await loadAppflareSchema(appflareDir);
      const m = withSettings();
      m.catalog = { ...(m.catalog as Record<string, unknown>), plan: "free" };
      const got = schema.artifactManifest.safeParse(m);
      expect(got.success).toBe(false);
      if (!got.success) {
        expect(got.error.issues.map((i) => i.message).join("\n")).toMatch(/Workers Paid/);
      }
    });
  },
);
