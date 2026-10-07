import { describe, expect, it } from "vitest";
import { duoArtifactManifestFixture } from "../fixtures/artifact-manifest.ts";
import { appflareAvailable, appflareDir } from "../fixtures/schema.ts";
import { loadAppflareSchema, loadEntryWorkerHelpers, parseOrThrow } from "./appflare-schema.ts";
import {
  appSecretValues,
  type CiAppPlan,
  catalogForms,
  derivedVarValues,
  planCiApp,
  workerSecretValues,
} from "./ci-install.ts";

const PIN = "0123456789abcdef0123456789abcdef01234567";

const entryHelpers = appflareAvailable
  ? await loadEntryWorkerHelpers(appflareDir).catch(() => null)
  : null;

const fns = {
  deriveSecretValue: (method: string, value: string) => `${method}(${value})`,
  generateVapidPrivateKey: () => "vapid-key",
};

/**
 * The duo fixture where each Worker reads its own `CLIENT_ID`, under the keys
 * WEB_CLIENT_ID and JOBS_CLIENT_ID; the web Worker also gets a hash derived
 * from WEB_CLIENT_ID, and a VAPID public key derived from the private key it
 * reads as PUSH_KEY under the key WEB_PUSH_KEY.
 */
function keyed(): Record<string, unknown> {
  const m = duoArtifactManifestFixture({ sha: PIN });
  const catalog = m.catalog as Record<string, unknown>;
  catalog.requires = [...((catalog.requires as string[] | undefined) ?? []), "secret-keys"];
  catalog.secrets = [
    ...(catalog.secrets as unknown[]),
    { name: "CLIENT_ID", key: "WEB_CLIENT_ID", label: "Web client", workers: ["web"] },
    { name: "CLIENT_ID", key: "JOBS_CLIENT_ID", label: "Jobs client", workers: ["jobs"] },
    {
      name: "CLIENT_HASH",
      label: "Web client hash",
      derive: { from: "WEB_CLIENT_ID", method: "bcrypt" },
      workers: ["web"],
    },
    {
      name: "PUSH_KEY",
      key: "WEB_PUSH_KEY",
      label: "Push key",
      generate: "vapid-private-key",
      workers: ["web"],
    },
  ];
  catalog.vars = [
    ...(catalog.vars as unknown[]),
    {
      name: "PUSH_PUBLIC_KEY",
      label: "Push public key",
      derive: { from: "WEB_PUSH_KEY", method: "vapid-public-key" },
      workers: ["web"],
    },
  ];
  return m;
}

describe("catalogForms with secret keys", () => {
  it("lists secrets by key and the name each is set under", () => {
    const forms = catalogForms({
      secrets: [
        { name: "CLIENT_ID", key: "GITHUB_CLIENT_ID", label: "GitHub" },
        { name: "TOKEN", label: "Token" },
        {
          name: "HASH",
          key: "GITHUB_HASH",
          derive: { from: "GITHUB_CLIENT_ID", method: "bcrypt" },
        },
      ],
    });
    expect(forms.secrets).toEqual(["GITHUB_CLIENT_ID", "TOKEN"]);
    expect(forms.secretNames).toEqual({ GITHUB_CLIENT_ID: "CLIENT_ID", GITHUB_HASH: "HASH" });
    expect(forms.derivedSecrets).toEqual([
      { name: "HASH", key: "GITHUB_HASH", from: "GITHUB_CLIENT_ID", method: "bcrypt" },
    ]);
  });
});

describe.skipIf(entryHelpers === null)("secrets of one name and different keys", () => {
  async function plan(): Promise<CiAppPlan> {
    const schema = await loadAppflareSchema(appflareDir);
    const parsed = parseOrThrow(schema.artifactManifest, keyed(), "keyed duo");
    return planCiApp(parsed, "ci-duo-pr1", {
      subdomain: "acme",
      namespaceId: (binding) => `id-${binding}`,
      ...(entryHelpers === null ? {} : { helpers: entryHelpers }),
    });
  }

  it("give each Worker its own value under the name it reads", async () => {
    const app = await plan();
    let n = 0;
    const values = appSecretValues(app, fns, () => `v${++n}`);
    const set = (entry: string) => {
      const w = app.workers.find((x) => x.entryName === entry);
      if (w === undefined) throw new Error(`no Worker ${entry}`);
      return Object.fromEntries(workerSecretValues(w.plan, values).map((s) => [s.name, s.value]));
    };
    const web = set("web");
    const jobs = set("jobs");
    expect(web.CLIENT_ID).toBe(values.get("WEB_CLIENT_ID"));
    expect(jobs.CLIENT_ID).toBe(values.get("JOBS_CLIENT_ID"));
    expect(web.CLIENT_ID).not.toBe(jobs.CLIENT_ID);
    // A secret without a key still shares one value across the Workers.
    expect(web.SHARED_KEY).toBe(jobs.SHARED_KEY);
    expect(Object.keys(jobs).sort()).toEqual(["CLIENT_ID", "SHARED_KEY"]);
    expect(web.PUSH_KEY).toBe("vapid-key");
  });

  it("derive a secret and a var from a key that is not a name", async () => {
    const app = await plan();
    const values = appSecretValues(app, fns, () => "web-client");
    const web = app.workers.find((w) => w.entryName === "web");
    if (web === undefined) throw new Error("no web Worker");
    const set = Object.fromEntries(
      workerSecretValues(web.plan, values).map((s) => [s.name, s.value]),
    );
    expect(set.CLIENT_HASH).toBe("bcrypt(web-client)");
    expect(derivedVarValues(web.plan, values, fns.deriveSecretValue)).toEqual({
      PUSH_PUBLIC_KEY: "vapid-public-key(vapid-key)",
    });
  });
});
