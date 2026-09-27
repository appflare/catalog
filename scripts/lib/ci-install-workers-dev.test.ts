import { describe, expect, it } from "vitest";
import {
  artifactManifestFixture,
  privateDuoArtifactManifestFixture,
} from "../fixtures/artifact-manifest.ts";
import { appflareAvailable, appflareDir } from "../fixtures/schema.ts";
import { loadAppflareSchema, loadEntryWorkerHelpers, parseOrThrow } from "./appflare-schema.ts";
import {
  type CiAppPlan,
  healthProbes,
  NOT_ON_WORKERS_DEV,
  OTHER_WORKER_PROBE,
  PRIMARY_PROBE_TIMEOUT_MS,
  planCiApp,
  planCiInstall,
} from "./ci-install.ts";
import type { ArtifactManifest } from "./types.ts";

const PIN = "0123456789abcdef0123456789abcdef01234567";

const worker = (name: string, primary: boolean, workersDev: boolean) => ({
  primary,
  plan: { name, workersDev },
});

describe("healthProbes", () => {
  it("probes the primary at its health path and every other Worker at /", () => {
    const probes = healthProbes(
      {
        workers: [worker("ci-duo-pr1-jobs", false, true), worker("ci-duo-pr1", true, true)],
        healthPath: "/healthz",
      },
      "acme",
    );
    expect(probes.map((p) => ("url" in p ? [p.url, p.timeoutMs] : p.skipped))).toEqual([
      ["https://ci-duo-pr1.acme.workers.dev/healthz", PRIMARY_PROBE_TIMEOUT_MS],
      ["https://ci-duo-pr1-jobs.acme.workers.dev/", OTHER_WORKER_PROBE.timeoutMs],
    ]);
  });

  it("skips a Worker kept off workers.dev, which then counts as passing", () => {
    const jobs = worker("ci-duo-pr1-jobs", false, false);
    const probes = healthProbes(
      { workers: [jobs, worker("ci-duo-pr1", true, true)], healthPath: "/" },
      "acme",
    );
    expect(probes).toEqual([
      {
        worker: expect.objectContaining({ primary: true }),
        url: "https://ci-duo-pr1.acme.workers.dev/",
        timeoutMs: PRIMARY_PROBE_TIMEOUT_MS,
      },
      { worker: jobs, skipped: { ok: true, detail: NOT_ON_WORKERS_DEV } },
    ]);
  });
});

describe("planCiInstall's workers.dev setting", () => {
  it("puts a Worker on workers.dev unless told to keep it off", () => {
    const one = artifactManifestFixture({
      app: "hello",
      version: "1.0.0",
      sha: PIN,
    }) as unknown as ArtifactManifest;
    const on = planCiInstall(one, "ci-duo-pr1");
    expect(on.config.workers_dev).toBe(true);
    expect(on.workersDev).toBe(true);
    const off = planCiInstall(one, "ci-duo-pr1", { workersDev: false });
    expect(off.config.workers_dev).toBe(false);
    expect(off.config.preview_urls).toBe(false);
    expect(off.workersDev).toBe(false);
  });
});

const entryHelpers = appflareAvailable
  ? await loadEntryWorkerHelpers(appflareDir).catch(() => null)
  : null;

describe.skipIf(entryHelpers === null)("an app with a Worker kept off workers.dev", () => {
  async function plan(): Promise<CiAppPlan> {
    const schema = await loadAppflareSchema(appflareDir);
    const parsed = parseOrThrow(
      schema.artifactManifest,
      privateDuoArtifactManifestFixture({ sha: PIN }),
      "private duo",
    );
    return planCiApp(parsed, "ci-duo-pr1", {
      subdomain: "acme",
      namespaceId: (binding) => `id-${binding}`,
      ...(entryHelpers === null ? {} : { helpers: entryHelpers }),
    });
  }

  it("is format 4, which the schema refuses as format 3", async () => {
    const schema = await loadAppflareSchema(appflareDir);
    const fixture = privateDuoArtifactManifestFixture({ sha: PIN });
    expect(parseOrThrow(schema.artifactManifest, fixture, "private duo").format).toBe(4);
    const old = schema.artifactManifest.safeParse({ ...fixture, format: 3 });
    expect(old.success).toBe(false);
    if (!old.success) {
      expect(old.error.issues.map((i) => i.message).join("\n")).toMatch(/needs format 4/);
    }
  });

  it("deploys that Worker with workers.dev off, and the primary with it on", async () => {
    const app = await plan();
    expect(
      app.workers.map((w) => [w.entryName, w.plan.workersDev, w.plan.config.workers_dev]),
    ).toEqual([
      ["jobs", false, false],
      ["web", true, true],
    ]);
    // Bindings still reach it by its Worker name.
    expect(app.workers[1]?.plan.config.services).toEqual([
      { binding: "JOBS", service: "ci-duo-pr1-jobs", entrypoint: "Jobs" },
      { binding: "SELF", service: "ci-duo-pr1" },
    ]);
    expect(app.workers[1]?.plan.config.vars).toEqual({ JOBS_URL: "ci-duo-pr1-jobs" });
  });

  it("probes only the primary", async () => {
    const probes = healthProbes(await plan(), "acme");
    expect(probes.map((p) => [p.worker.plan.name, "url" in p ? p.url : p.skipped.detail])).toEqual([
      ["ci-duo-pr1", "https://ci-duo-pr1.acme.workers.dev/"],
      ["ci-duo-pr1-jobs", NOT_ON_WORKERS_DEV],
    ]);
  });
});
