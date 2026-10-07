import { describe, expect, it } from "vitest";
import { duoArtifactManifestFixture } from "../fixtures/artifact-manifest.ts";
import { appflareAvailable, appflareDir } from "../fixtures/schema.ts";
import { loadAppflareSchema, loadEntryWorkerHelpers, parseOrThrow } from "./appflare-schema.ts";
import { planCiApp } from "./ci-install.ts";

const PIN = "0123456789abcdef0123456789abcdef01234567";

const entryHelpers = appflareAvailable
  ? await loadEntryWorkerHelpers(appflareDir).catch(() => null)
  : null;

/** The duo fixture, its binding to the jobs Worker carrying props. */
function withProps(): Record<string, unknown> {
  const m = duoArtifactManifestFixture({ sha: PIN });
  const worker = m.worker as { bindings: Record<string, unknown>[] };
  worker.bindings = worker.bindings.map((b) =>
    b.name === "JOBS"
      ? { ...b, props: { origin: "{{appUrl}}", jobs: "{{workerName:jobs}}", "{{workerName}}": 1 } }
      : b,
  );
  const catalog = m.catalog as { requires?: string[] };
  // A placeholder in a key needs "email-placeholders" as well.
  catalog.requires = [...(catalog.requires ?? []), "service-props", "email-placeholders"];
  return m;
}

describe.skipIf(entryHelpers === null)("service binding props in an app of several Workers", () => {
  it("are accepted by the schema", async () => {
    const schema = await loadAppflareSchema(appflareDir);
    expect(parseOrThrow(schema.artifactManifest, withProps(), "duo").app).toBe("duo");
  });

  it("go to the Worker of the entry with every placeholder filled in, as the manager sends them", async () => {
    const schema = await loadAppflareSchema(appflareDir);
    const parsed = parseOrThrow(schema.artifactManifest, withProps(), "duo");
    const app = planCiApp(parsed, "ci-duo-pr1", {
      subdomain: "acme",
      namespaceId: (binding) => `id-${binding}`,
      ...(entryHelpers === null ? {} : { helpers: entryHelpers }),
    });
    const web = app.workers.find((w) => w.entryName === "web");
    expect(web?.plan.config.services).toContainEqual({
      binding: "JOBS",
      service: "ci-duo-pr1-jobs",
      entrypoint: "Jobs",
      props: {
        origin: "https://ci-duo-pr1.acme.workers.dev",
        jobs: "ci-duo-pr1-jobs",
        // Keys get the placeholders of the whole app; the per-Worker ones
        // only in values, as the manager fills them in.
        "ci-duo-pr1": 1,
      },
    });
  });
});
