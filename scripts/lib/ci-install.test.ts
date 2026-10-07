import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  artifactManifestFixture,
  duoArtifactManifestFixture,
} from "../fixtures/artifact-manifest.ts";
import { appflareAvailable, appflareDir } from "../fixtures/schema.ts";
import { loadAppflareSchema, loadEntryWorkerHelpers, parseOrThrow } from "./appflare-schema.ts";
import {
  appSecretValues,
  appSummaryLines,
  attachQueueConsumers,
  type CfRequest,
  type CfResponse,
  type CiAppPlan,
  type CiInstallPlan,
  catalogHealthMode,
  catalogHealthPath,
  ciWorkerName,
  classifyProbe,
  cleanupCiApp,
  cleanupCiInstall,
  createCfRequest,
  createKvNamespaces,
  createQueues,
  createVectorizeIndexes,
  cronNote,
  derivedVarValues,
  healthUrl,
  type JsonValue,
  needsPackerSecrets,
  type Probe,
  planCiApp,
  planCiInstall,
  randomNamespaceId,
  renderJsonPlaceholders,
  renderPlaceholders,
  SELF_SERVICE,
  summaryLines,
  unpackArtifact,
  waitForHealth,
  withKvIds,
  withVars,
  workersSubdomain,
} from "./ci-install.ts";
import { appflarePaths } from "./paths.ts";
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
        m.d1 = {
          DB: {
            migrations: [
              {
                name: "0001_init.sql",
                path: "d1/DB/0001_init.sql",
                size: 1,
                sha256: "a".repeat(64),
                offset: 0,
              },
            ],
            schema: [],
            postDeploy: [],
          },
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
    expect(plan.d1).toEqual([
      { database: "ci-hello-pr1-db", binding: "DB", migrations: true, schema: [], postDeploy: [] },
    ]);
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
    });
    expect(plan.config).not.toHaveProperty("triggers");
    expect(plan.notes).toEqual([]);
    expect(JSON.stringify(plan.config)).not.toMatch(/"id"|database_id|account_id/);
  });

  it("sets no cron triggers and notes how many the artifact declares", () => {
    const withCrons = manifest((m) => {
      worker(m).crons = ["*/5 * * * *", "0 3 * * *"];
      worker(m).bindings = [{ type: "kv_namespace", name: "CUT_KV" }];
    });
    const plan = planCiInstall(withCrons, "ci-hello-nightly", { subdomain: "appflare-ci" });
    expect(plan.config).not.toHaveProperty("triggers");
    expect(JSON.stringify(plan.config)).not.toMatch(/cron|\*\/5/);
    expect(plan.notes).toEqual([
      "the artifact declares 2 cron triggers (`*/5 * * * *`, `0 3 * * *`); " +
        "not set on the CI Worker, so scheduled runs are not exercised",
    ]);

    // Cleanup plans from the same manifest and finds the same things by name.
    const withoutCrons = manifest((m) => {
      worker(m).bindings = [{ type: "kv_namespace", name: "CUT_KV" }];
    });
    const cleanup = planCiInstall(withCrons, "ci-hello-nightly");
    expect(cleanup.name).toBe("ci-hello-nightly");
    expect(cleanup.resources).toEqual(planCiInstall(withoutCrons, "ci-hello-nightly").resources);
  });

  it("words the cron note for one trigger and for none", () => {
    expect(cronNote([])).toBeNull();
    expect(cronNote(["0 0 * * *"])).toBe(
      "the artifact declares 1 cron trigger (`0 0 * * *`); " +
        "not set on the CI Worker, so scheduled runs are not exercised",
    );
  });

  it("plans a Vectorize index with the recorded shape, created before the deploy", () => {
    const plan = planCiInstall(
      manifest((m) => {
        worker(m).bindings = [
          { type: "d1", name: "DB" },
          { type: "vectorize", name: "VECTORIZE", dimensions: 384, metric: "cosine" },
          { type: "ai", name: "AI" },
        ];
      }),
      "ci-second-brain-cloudflare-pr8",
    );
    expect(plan.vectorizeIndexes).toEqual([
      { name: "ci-second-brain-cloudflare-pr8-vectorize", dimensions: 384, metric: "cosine" },
    ]);
    expect(plan.resources).toContainEqual({
      type: "vectorize",
      name: "ci-second-brain-cloudflare-pr8-vectorize",
      binding: "VECTORIZE",
    });
    expect(plan.config).toMatchObject({
      vectorize: [{ binding: "VECTORIZE", index_name: "ci-second-brain-cloudflare-pr8-vectorize" }],
      ai: { binding: "AI" },
    });
    expect(planCiInstall(manifest(), "ci-hello-pr1").vectorizeIndexes).toEqual([]);
  });

  it("refuses a Vectorize binding without a usable shape, or with a name over 64 characters", () => {
    const withBinding =
      (binding: Record<string, unknown>, name = "ci-hello-pr1") =>
      () =>
        planCiInstall(
          manifest((m) => {
            worker(m).bindings = [{ type: "vectorize", name: "VECTORIZE", ...binding }];
          }),
          name,
        );
    expect(withBinding({ metric: "cosine" })).toThrow(/records no usable dimensions \(1-1536\)/);
    expect(withBinding({ dimensions: 2048, metric: "cosine" })).toThrow(/usable dimensions/);
    expect(withBinding({ dimensions: 384, metric: "manhattan" })).toThrow(/no usable metric/);
    expect(withBinding({ dimensions: 384, metric: "cosine" }, `ci-${"x".repeat(50)}-pr1`)).toThrow(
      /Vectorize index name ".*-vectorize" is longer than 64 characters/,
    );
  });

  it("takes secrets and var defaults from the catalog manifest", () => {
    const plan = planCiInstall(
      manifest((m) => {
        const catalog = m.catalog as Record<string, unknown>;
        catalog.secrets = [{ name: "ADMIN_PASSWORD", label: "Admin", generate: "password" }];
        catalog.vars = [
          { name: "HOME_PAGE", label: "Home", optional: true },
          { name: "REGION", label: "Region", default: "eu", optional: true },
          { name: "API_URL", label: "API" },
        ];
      }),
      "ci-hello-pr1",
    );
    expect(plan.secrets).toEqual(["ADMIN_PASSWORD"]);
    expect(plan.config.vars).toEqual({ REGION: "eu", API_URL: "ci" });
  });

  it("sets optional secrets too, and gives a required choice without a default its first option", () => {
    const options = [
      { value: "default", label: "Landing page" },
      { value: "404", label: "Empty 404" },
    ];
    const plan = planCiInstall(
      manifest((m) => {
        const catalog = m.catalog as Record<string, unknown>;
        catalog.secrets = [
          { name: "ADMIN_PASSWORD", label: "Admin", generate: "password" },
          { name: "SMTP_PASSWORD", label: "SMTP", optional: true },
        ];
        catalog.vars = [
          { name: "HOME_PAGE", label: "Home", type: "select", options },
          { name: "MODE", label: "Mode", optional: true, type: "select", options },
          { name: "SIZE", label: "Size", default: "404", type: "select", options },
        ];
      }),
      "ci-hello-pr1",
    );
    expect(plan.secrets).toEqual(["ADMIN_PASSWORD", "SMTP_PASSWORD"]);
    expect(plan.config.vars).toEqual({ HOME_PAGE: "default", SIZE: "404" });
  });

  it("keeps JSON vars typed and parses a JSON var's catalog default", () => {
    const plan = planCiInstall(
      manifest((m) => {
        worker(m).bindings = [
          { type: "json", name: "EMAIL_ADDRESSES", json: [] },
          { type: "json", name: "LIMITS", json: { max: 5, strict: true } },
          { type: "json", name: "RETRIES", json: 3 },
          { type: "json", name: "EMPTY", json: null },
          { type: "plain_text", name: "MODE", text: "prod" },
        ];
        (m.catalog as Record<string, unknown>).vars = [
          { name: "EMAIL_ADDRESSES", label: "Addresses", default: '["a@example.com"]' },
          { name: "RETRIES", label: "Retries" },
          { name: "MODE", label: "Mode", default: "[1]" },
        ];
      }),
      "ci-hello-pr1",
      { subdomain: "acme" },
    );
    expect(plan.config.vars).toEqual({
      EMAIL_ADDRESSES: ["a@example.com"],
      LIMITS: { max: 5, strict: true },
      RETRIES: 3,
      EMPTY: null,
      // A text var's default is text, whatever it looks like.
      MODE: "[1]",
    });
    expect(JSON.stringify(plan.config)).toContain('"EMAIL_ADDRESSES":["a@example.com"]');
  });

  it("refuses a JSON var's catalog default that is not JSON", () => {
    expect(() =>
      planCiInstall(
        manifest((m) => {
          worker(m).bindings = [{ type: "json", name: "EMAIL_ADDRESSES", json: [] }];
          (m.catalog as Record<string, unknown>).vars = [
            { name: "EMAIL_ADDRESSES", label: "Addresses", default: "a@example.com" },
          ];
        }),
        "ci-hello-pr1",
      ),
    ).toThrow(/catalog default of the var EMAIL_ADDRESSES is not valid JSON/);
  });

  it("fills in {{workerUrl}} and {{workerName}} in every var, as the manager does", () => {
    const edit = (m: Record<string, unknown>) => {
      worker(m).bindings = [
        { type: "plain_text", name: "PUBLIC_URL", text: "{{workerUrl}}" },
        { type: "plain_text", name: "OTHER", text: "{{ workerName }}/{{notMine}}" },
        {
          type: "json",
          name: "ORIGINS",
          json: { "{{workerName}}": ["{{workerUrl}}/a", 1], nested: { url: "{{workerUrl}}" } },
        },
        { type: "json", name: "TRUSTED", json: [] },
      ];
      (m.catalog as Record<string, unknown>).vars = [
        { name: "TRUSTED", label: "Trusted", default: '["{{workerUrl}}"]' },
        { name: "CALLBACK", label: "Callback", default: "{{workerUrl}}/cb?w={{workerName}}" },
      ];
    };
    const url = "https://ci-hello-pr1.acme.workers.dev";
    expect(
      planCiInstall(manifest(edit), "ci-hello-pr1", { subdomain: "acme" }).config.vars,
    ).toEqual({
      PUBLIC_URL: url,
      OTHER: "ci-hello-pr1/{{notMine}}",
      // Keys are filled in too, as managers from 0.4.0 fill them in.
      ORIGINS: { "ci-hello-pr1": [`${url}/a`, 1], nested: { url } },
      TRUSTED: [url],
      CALLBACK: `${url}/cb?w=ci-hello-pr1`,
    });
    // Without the subdomain (a plan for cleanup) {{workerUrl}} stays as written.
    expect(planCiInstall(manifest(edit), "ci-hello-pr1").config.vars).toMatchObject({
      PUBLIC_URL: "{{workerUrl}}",
      CALLBACK: "{{workerUrl}}/cb?w=ci-hello-pr1",
    });
  });

  it("fills in {{accountId}} with the CI account, and keeps it without one", () => {
    const account = "0123456789abcdef0123456789abcdef";
    const edit = (m: Record<string, unknown>) => {
      worker(m).bindings = [
        { type: "plain_text", name: "CF_ACCOUNT_ID", text: "{{accountId}}" },
        { type: "json", name: "ANALYTICS", json: { account: "{{ accountId }}" } },
      ];
      (m.catalog as Record<string, unknown>).vars = [
        { name: "NUXT_CF_ACCOUNT_ID", label: "Account", default: "{{accountId}}" },
      ];
    };
    expect(
      planCiInstall(manifest(edit), "ci-hello-pr1", { subdomain: "acme", accountId: account })
        .config.vars,
    ).toEqual({
      CF_ACCOUNT_ID: account,
      ANALYTICS: { account },
      NUXT_CF_ACCOUNT_ID: account,
    });
    expect(planCiInstall(manifest(edit), "ci-hello-pr1").config.vars).toMatchObject({
      CF_ACCOUNT_ID: "{{accountId}}",
    });
  });

  it("fills in the Cloudflare Access placeholders empty: the check never protects the app", () => {
    const edit = (m: Record<string, unknown>) => {
      worker(m).bindings = [
        { type: "plain_text", name: "TEAM_DOMAIN", text: "https://{{accessTeamDomain}}" },
        { type: "plain_text", name: "TEAM", text: "{{ accessTeamName }}" },
        { type: "json", name: "ACCESS", json: { certs: "{{ accessCertsUrl }}" } },
      ];
      const catalog = m.catalog as Record<string, unknown>;
      catalog.requires = ["access"];
      catalog.vars = [{ name: "POLICY_AUD", label: "Audience", default: "{{accessAud}}" }];
    };
    expect(
      planCiInstall(manifest(edit), "ci-hello-pr1", { subdomain: "acme" }).config.vars,
    ).toEqual({
      TEAM_DOMAIN: "https://",
      TEAM: "",
      ACCESS: { certs: "" },
      POLICY_AUD: "",
    });
  });

  it("fills in {{appUrl}} and the hostnames with the workers.dev address", () => {
    const edit = (m: Record<string, unknown>) => {
      worker(m).bindings = [{ type: "plain_text", name: "HOST", text: "{{appHostname}}" }];
      (m.catalog as Record<string, unknown>).vars = [
        { name: "APP_URL", label: "Address", default: "{{appUrl}}" },
        { name: "WORKER_HOST", label: "Worker host", default: "{{workerHostname}}" },
      ];
    };
    expect(
      planCiInstall(manifest(edit), "ci-hello-pr1", { subdomain: "acme" }).config.vars,
    ).toEqual({
      HOST: "ci-hello-pr1.acme.workers.dev",
      APP_URL: "https://ci-hello-pr1.acme.workers.dev",
      WORKER_HOST: "ci-hello-pr1.acme.workers.dev",
    });
    expect(planCiInstall(manifest(edit), "ci-hello-pr1").config.vars).toMatchObject({
      APP_URL: "{{appUrl}}",
    });
  });

  it("lists derived secrets apart, with the secret they are computed from", () => {
    const plan = planCiInstall(
      manifest((m) => {
        (m.catalog as Record<string, unknown>).secrets = [
          { name: "CF_PASSWORD", label: "Admin password" },
          {
            name: "CF_PASSWORD_HASH",
            label: "Admin password hash",
            derive: { from: "CF_PASSWORD", method: "bcrypt" },
          },
          { name: "CF_JWT_SECRET", label: "Session key", generate: "password" },
        ];
      }),
      "ci-hello-pr1",
    );
    expect(plan.secrets).toEqual(["CF_PASSWORD", "CF_JWT_SECRET"]);
    expect(plan.derivedSecrets).toEqual([
      { name: "CF_PASSWORD_HASH", from: "CF_PASSWORD", method: "bcrypt" },
    ]);
  });

  it("lists VAPID private keys, and keeps derived vars out of the planned vars", () => {
    const plan = planCiInstall(
      manifest((m) => {
        const catalog = m.catalog as Record<string, unknown>;
        catalog.secrets = [
          { name: "VAPID_PRIVATE_KEY", label: "Push key", generate: "vapid-private-key" },
          { name: "TOKEN", label: "Token", generate: "password" },
        ];
        catalog.vars = [
          {
            name: "VAPID_PUBLIC_KEY",
            label: "Push public key",
            derive: { from: "VAPID_PRIVATE_KEY", method: "vapid-public-key" },
          },
        ];
      }),
      "ci-hello-pr1",
    );
    expect(plan.secrets).toEqual(["VAPID_PRIVATE_KEY", "TOKEN"]);
    expect(plan.vapidPrivateKeys).toEqual(["VAPID_PRIVATE_KEY"]);
    expect(plan.derivedVars).toEqual([
      { name: "VAPID_PUBLIC_KEY", from: "VAPID_PRIVATE_KEY", method: "vapid-public-key" },
    ]);
    expect((plan.config.vars as Record<string, unknown> | undefined)?.VAPID_PUBLIC_KEY).toBe(
      undefined,
    );
  });

  it("probes the catalog's install.health.path, else /", () => {
    expect(planCiInstall(manifest(), "ci-hello-pr1").probePath).toBe("/");
    const plan = planCiInstall(
      manifest((m) => {
        const install = (m.catalog as { install: Record<string, unknown> }).install;
        install.health = { path: "/v1/chat/completions", mode: "no-server-errors" };
      }),
      "ci-hello-pr1",
    );
    expect(plan.probePath).toBe("/v1/chat/completions");
    expect(healthUrl(plan.name, "acme", plan.probePath)).toBe(
      "https://ci-hello-pr1.acme.workers.dev/v1/chat/completions",
    );
    expect(healthUrl("ci-cut-pr1", "acme", "/")).toBe("https://ci-cut-pr1.acme.workers.dev/");
  });

  it("refuses a health path the schema would reject", () => {
    for (const bad of ["health", "/a?b=1", "/a#b", "/a b", "", 42]) {
      expect(() => catalogHealthPath({ install: { health: { path: bad } } })).toThrow(
        /install\.health\.path .* is not a URL path/,
      );
    }
    expect(catalogHealthPath(null)).toBe("/");
    expect(catalogHealthPath({ install: {} })).toBe("/");
    expect(catalogHealthPath({ install: { health: {} } })).toBe("/");
  });

  it("reads install.health.mode, defaulting to no-server-errors", () => {
    expect(planCiInstall(manifest(), "ci-hello-pr1").probeMode).toBe("no-server-errors");
    const plan = planCiInstall(
      manifest((m) => {
        const install = (m.catalog as { install: Record<string, unknown> }).install;
        install.health = { path: "/", mode: "any-response" };
      }),
      "ci-hello-pr1",
    );
    expect(plan.probeMode).toBe("any-response");
    expect(catalogHealthMode(null)).toBe("no-server-errors");
    expect(catalogHealthMode({ install: { health: { mode: "no-server-errors" } } })).toBe(
      "no-server-errors",
    );
    for (const bad of ["status-only", "default", "", 1, null]) {
      expect(() => catalogHealthMode({ install: { health: { mode: bad } } })).toThrow(
        /install\.health\.mode .* is not "no-server-errors" or "any-response"/,
      );
    }
  });

  it("refuses bindings it cannot create and clean up", () => {
    expect(() =>
      planCiInstall(
        manifest((m) => {
          worker(m).bindings = [{ type: "mtls_certificate", name: "CERT" }];
        }),
        "ci-hello-pr1",
      ),
    ).toThrow(/cannot create a mtls_certificate binding \(CERT\)/);
  });

  it("plans queues for producers and consumers, dead-letter queues included", () => {
    const plan = planCiInstall(
      manifest((m) => {
        worker(m).bindings = [
          { type: "queue", name: "INGEST_QUEUE" },
          { type: "queue", name: "EMBED_QUEUE", delivery_delay: 5 },
        ];
        worker(m).queueConsumers = [
          {
            queue: { binding: "INGEST_QUEUE" },
            max_batch_size: 10,
            max_batch_timeout: 2.5,
            max_retries: 3,
            dead_letter_queue: { name: "flaremo-dlq" },
          },
          { queue: { binding: "EMBED_QUEUE" }, max_concurrency: null, retry_delay: 30 },
        ];
      }),
      "ci-flaremo-pr3",
    );
    expect(plan.queues).toEqual([
      "ci-flaremo-pr3-ingest-queue",
      "ci-flaremo-pr3-embed-queue",
      "ci-flaremo-pr3-flaremo-dlq",
    ]);
    expect(plan.resources).toEqual([
      { type: "queue", name: "ci-flaremo-pr3-ingest-queue", binding: "INGEST_QUEUE" },
      { type: "queue", name: "ci-flaremo-pr3-embed-queue", binding: "EMBED_QUEUE" },
      { type: "queue", name: "ci-flaremo-pr3-flaremo-dlq", binding: "flaremo-dlq" },
    ]);
    // Producers name their queue; consumers are attached through the API, not by wrangler.
    expect(plan.config.queues).toEqual({
      producers: [
        { binding: "INGEST_QUEUE", queue: "ci-flaremo-pr3-ingest-queue" },
        { binding: "EMBED_QUEUE", queue: "ci-flaremo-pr3-embed-queue", delivery_delay: 5 },
      ],
    });
    expect(plan.queueConsumers).toEqual([
      {
        queue: "ci-flaremo-pr3-ingest-queue",
        deadLetterQueue: "ci-flaremo-pr3-flaremo-dlq",
        settings: { batch_size: 10, max_wait_time_ms: 2500, max_retries: 3 },
      },
      {
        queue: "ci-flaremo-pr3-embed-queue",
        deadLetterQueue: null,
        settings: { max_concurrency: null, retry_delay: 30 },
      },
    ]);
    expect(planCiInstall(manifest(), "ci-hello-pr1")).toMatchObject({
      queues: [],
      queueConsumers: [],
    });
  });

  it("refuses queue consumers the manager would refuse, and queue names over 63 characters", () => {
    const withQueues =
      (consumers: unknown[], name = "ci-hello-pr1") =>
      () =>
        planCiInstall(
          manifest((m) => {
            worker(m).bindings = [
              { type: "queue", name: "JOBS" },
              { type: "kv_namespace", name: "CACHE" },
            ];
            worker(m).queueConsumers = consumers;
          }),
          name,
        );
    expect(withQueues([{ queue: { binding: "OTHER" } }])).toThrow(
      /names the queue binding OTHER, but the Worker has no queue binding/,
    );
    expect(withQueues([{ queue: { binding: "CACHE" } }])).toThrow(/no queue binding by that name/);
    expect(withQueues([{ queue: { name: "jobs" } }])).toThrow(
      /the queue "jobs" would share its name with a binding's resource/,
    );
    expect(withQueues([{ queue: { binding: "JOBS" } }, { queue: { binding: "JOBS" } }])).toThrow(
      /ci-hello-pr1-jobs has more than one consumer/,
    );
    expect(withQueues([], `ci-${"x".repeat(55)}-pr1`)).toThrow(
      /queue name ".*-jobs" is longer than 63 characters/,
    );
  });

  it("gives each rate limit a namespace id of the run's own", () => {
    const ratelimited = manifest((m) => {
      worker(m).bindings = [
        {
          type: "ratelimit",
          name: "RATE_LIMITER",
          namespace_id: "1001",
          simple: { limit: 100, period: 60 },
        },
      ];
    });
    const plan = planCiInstall(ratelimited, "ci-hello-pr1", { namespaceId: () => "424242" });
    expect(plan.config.ratelimits).toEqual([
      { name: "RATE_LIMITER", namespace_id: "424242", simple: { limit: 100, period: 60 } },
    ]);
    expect(plan.resources).toEqual([]);
    const random = (
      planCiInstall(ratelimited, "ci-hello-pr1").config.ratelimits as {
        namespace_id: string;
      }[]
    )[0]?.namespace_id;
    expect(random).not.toBe("1001");
    for (let i = 0; i < 200; i++) {
      const id = Number(randomNamespaceId());
      expect(Number.isInteger(id) && id >= 1 && id <= 2_147_483_647).toBe(true);
    }
  });

  it("refuses a rate limit without simple settings wrangler accepts", () => {
    for (const simple of [undefined, { limit: 10 }, { limit: 10, period: 30 }]) {
      expect(() =>
        planCiInstall(
          manifest((m) => {
            worker(m).bindings = [{ type: "ratelimit", name: "RL", namespace_id: "1", simple }];
          }),
          "ci-hello-pr1",
        ),
      ).toThrow(/ratelimit binding RL records no usable simple\.limit and simple\.period/);
    }
  });

  it("keeps an empty var and refuses a var without text", () => {
    const plan = planCiInstall(
      manifest((m) => {
        worker(m).bindings = [{ type: "plain_text", name: "TRUSTED_ORIGINS", text: "" }];
      }),
      "ci-hello-pr1",
    );
    expect(plan.config.vars).toEqual({ TRUSTED_ORIGINS: "" });
    expect(() =>
      planCiInstall(
        manifest((m) => {
          worker(m).bindings = [{ type: "plain_text", name: "MODE" }];
        }),
        "ci-hello-pr1",
      ),
    ).toThrow("binding MODE (plain_text) has no text");
  });

  it("aims a service binding to the app's own Worker at the CI Worker", () => {
    const plan = planCiInstall(
      manifest((m) => {
        worker(m).bindings = [
          { type: "service", name: "WORKER_SELF_REFERENCE", service: "self" },
          { type: "service", name: "UNITS", service: "self", entrypoint: "Units" },
        ];
      }),
      "ci-hello-pr1",
    );
    expect(plan.config.services).toEqual([
      { binding: "WORKER_SELF_REFERENCE", service: "ci-hello-pr1" },
      { binding: "UNITS", service: "ci-hello-pr1", entrypoint: "Units" },
    ]);
    expect(plan.resources).toEqual([]);
    expect(plan.notes).toEqual([]);
  });

  it("sends a service binding's props with their placeholders filled in", () => {
    const edit = (m: Record<string, unknown>) => {
      worker(m).bindings = [
        {
          type: "service",
          name: "AUTH",
          service: "self",
          entrypoint: "Auth",
          props: { origin: "{{appUrl}}", "{{workerName}}": [1, { admin: true }] },
        },
      ];
    };
    const url = "https://ci-hello-pr1.acme.workers.dev";
    expect(
      planCiInstall(manifest(edit), "ci-hello-pr1", { subdomain: "acme" }).config.services,
    ).toEqual([
      {
        binding: "AUTH",
        service: "ci-hello-pr1",
        entrypoint: "Auth",
        props: { origin: url, "ci-hello-pr1": [1, { admin: true }] },
      },
    ]);
  });

  it("refuses every other service binding", () => {
    const plan = (binding: Record<string, unknown>) => () =>
      planCiInstall(
        manifest((m) => {
          worker(m).bindings = [{ type: "service", name: "PEER", ...binding }];
        }),
        "ci-hello-pr1",
      );
    expect(plan({ service: "appflare" })).toThrow(
      /^service binding PEER points at the Worker "appflare"; an app may bind only to its own Worker/,
    );
    expect(plan({ service: "ci-hello-pr1" })).toThrow(/points at the Worker "ci-hello-pr1"/);
    expect(plan({})).toThrow(/points at no Worker/);
    expect(plan({ service: "self", environment: "production" })).toThrow(
      /service binding PEER also sets environment/,
    );
    expect(plan({ service: "self", props: [true] })).toThrow(
      /records props that are not a JSON object/,
    );
    expect(plan({ service: "self", props: null })).toThrow(
      /records props that are not a JSON object/,
    );
    expect(plan({ service: "self", entrypoint: "" })).toThrow(
      /records an entrypoint that is not a name/,
    );
    expect(plan({ service: "self", entrypoint: 1 })).toThrow(
      /records an entrypoint that is not a name/,
    );
  });

  it("passes images through", () => {
    const plan = planCiInstall(
      manifest((m) => {
        worker(m).bindings = [{ type: "images", name: "IMAGES" }];
      }),
      "ci-hello-pr1",
    );
    expect(plan.config.images).toEqual({ binding: "IMAGES" });
    expect(plan.resources).toEqual([]);
    expect(plan.notes).toEqual([]);
  });

  it("passes send_email through, noting restrictions it cannot exercise", () => {
    const open = planCiInstall(
      manifest((m) => {
        worker(m).bindings = [{ type: "send_email", name: "EMAIL" }];
      }),
      "ci-hello-pr1",
    );
    expect(open.config.send_email).toEqual([{ name: "EMAIL" }]);
    expect(open.notes).toEqual([]);

    const restricted = planCiInstall(
      manifest((m) => {
        worker(m).bindings = [
          { type: "send_email", name: "ALERTS", destination_address: "ops@example.com" },
          {
            type: "send_email",
            name: "REPLIES",
            allowed_destination_addresses: ["a@example.com"],
            allowed_sender_addresses: ["inbox@example.com"],
          },
        ];
      }),
      "ci-hello-pr1",
    );
    expect(restricted.config.send_email).toEqual([
      { name: "ALERTS", destination_address: "ops@example.com" },
      {
        name: "REPLIES",
        allowed_destination_addresses: ["a@example.com"],
        allowed_sender_addresses: ["inbox@example.com"],
      },
    ]);
    expect(restricted.notes).toEqual([
      expect.stringMatching(
        /^send_email binding ALERTS is deployed with its destination_address as recorded; sending is not exercised/,
      ),
      expect.stringMatching(
        /^send_email binding REPLIES is deployed with its allowed_destination_addresses, allowed_sender_addresses as recorded/,
      ),
    ]);
  });
});

describe("summaryLines", () => {
  const hello = { app: "hello", version: "1.2.3" };

  it("puts the plan's notes under the result line, the cron note included", () => {
    const plan = planCiInstall(
      manifest((m) => {
        worker(m).crons = ["*/15 * * * *"];
      }),
      "ci-hello-nightly",
    );
    expect(summaryLines(hello, plan, true, "HTTP 200")).toEqual([
      "PASS hello@1.2.3 as ci-hello-nightly: HTTP 200",
      "- note: the artifact declares 1 cron trigger (`*/15 * * * *`); " +
        "not set on the CI Worker, so scheduled runs are not exercised",
    ]);
  });

  it("keeps the notes for a failed deploy", () => {
    const plan = { name: "ci-hello-pr1", notes: ["something not exercised"] };
    expect(summaryLines(hello, plan, false, "wrangler deploy --strict failed (exit 1)")).toEqual([
      "FAIL hello@1.2.3 as ci-hello-pr1: wrangler deploy --strict failed (exit 1)",
      "- note: something not exercised",
    ]);
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
      m.d1 = {
        DB: { migrations: [{ name: "0001_init.sql", ...e.sql }], schema: [], postDeploy: [] },
      };
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

  it("counts any answer of the Worker itself under any-response", () => {
    const own = { status: 500, body: "Cloudflare Access must be configured in production." };
    expect(classifyProbe(own)).toBe("retry");
    expect(classifyProbe(own, "any-response")).toBe("ok");
    expect(classifyProbe({ status: 403, body: "Missing JWT" }, "any-response")).toBe("ok");
    // Cloudflare's own pages and connection errors are still not an answer.
    expect(classifyProbe({ status: 500, body: "error code: 1101" }, "any-response")).toBe("retry");
    expect(classifyProbe({ status: 404, body: "error code: 1042" }, "any-response")).toBe("retry");
    expect(classifyProbe({ status: 404, body: "Not found" }, "any-response")).toBe("soft-404");
    expect(classifyProbe({ error: "ECONNRESET" }, "any-response")).toBe("retry");
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

  it("passes a Worker behind a sign-in that answers 5xx under any-response", async () => {
    const c = clock([
      { status: 404, body: "error code: 1042" },
      { status: 500, body: "sign-in not configured" },
    ]);
    expect(await waitForHealth(c.probe, { ...c.options, mode: "any-response" })).toEqual({
      ok: true,
      detail: "HTTP 500",
    });
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
  /** Cron schedules by script; they go with the script. */
  schedules?: Map<string, string[]>;
  kv: { id: string; title: string }[];
  d1: { uuid: string; name: string }[];
  r2: Set<string>;
  workflows: Set<string>;
  vectorize?: Set<string>;
  /** Queues by name; a queue with consumers refuses deletion. */
  queues?: Map<string, { id: string; consumers: { consumer_id: string; script?: string }[] }>;
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
      if (method === "DELETE") {
        state.scripts.delete(name);
        state.schedules?.delete(name);
      }
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
    if (p === "/vectorize/v2/indexes") {
      return ok([...(state.vectorize ?? [])].map((name) => ({ name })));
    }
    if (p.startsWith("/vectorize/v2/indexes/") && method === "DELETE") {
      const name = decodeURIComponent(p.slice("/vectorize/v2/indexes/".length));
      if (!state.vectorize?.has(name)) return missing;
      state.vectorize.delete(name);
      return ok(null);
    }
    const queueList = p.match(/^\/queues\?page=1&name=(.+)$/);
    if (queueList) {
      // Like the API, the name filter is not an exact match.
      const wanted = decodeURIComponent(queueList[1] as string);
      return ok(
        [...(state.queues ?? [])]
          .filter(([name]) => name.startsWith(wanted))
          .map(([queue_name, q]) => ({ queue_id: q.id, queue_name })),
      );
    }
    const queueItem = p.match(/^\/queues\/([^/]+)(?:\/consumers(?:\/([^/]+))?)?$/);
    if (queueItem) {
      const entry = [...(state.queues ?? [])].find(([, q]) => q.id === queueItem[1]);
      if (!entry) return missing;
      const [name, queue] = entry;
      if (queueItem[2]) {
        queue.consumers = queue.consumers.filter((c) => c.consumer_id !== queueItem[2]);
        return ok(null);
      }
      if (p.endsWith("/consumers")) return ok(queue.consumers);
      if (queue.consumers.length > 0) {
        return {
          status: 400,
          body: { success: false, errors: [{ code: 11005, message: "queue has consumers" }] },
        };
      }
      state.queues?.delete(name);
      return ok(null);
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
    secretNames: {},
    seedOnlySecrets: [],
    vapidPrivateKeys: [],
    base64Keys: [],
    seedVars: {},
    workersDev: true,
    derivedSecrets: [],
    derivedVars: [],
    d1: [],
    vectorizeIndexes: [{ name: "ci-hello-pr1-vectors", dimensions: 384, metric: "cosine" }],
    r2Lifecycles: [],
    hyperdriveConfigs: [],
    queues: ["ci-hello-pr1-tasks", "ci-hello-pr1-dlq"],
    queueConsumers: [
      { queue: "ci-hello-pr1-tasks", deadLetterQueue: "ci-hello-pr1-dlq", settings: {} },
    ],
    notes: [],
    probePath: "/",
    probeMode: "no-server-errors",
    resources: [
      { type: "kv", name: "ci-hello-pr1-cut-kv", binding: "CUT_KV" },
      { type: "d1", name: "ci-hello-pr1-db", binding: "DB" },
      { type: "r2", name: "ci-hello-pr1-media", binding: "MEDIA" },
      { type: "workflow", name: "ci-hello-pr1-jobs", binding: "JOBS" },
      { type: "vectorize", name: "ci-hello-pr1-vectors", binding: "VECTORS" },
      { type: "queue", name: "ci-hello-pr1-tasks", binding: "TASKS" },
      { type: "queue", name: "ci-hello-pr1-dlq", binding: "dlq" },
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
      vectorize: new Set(["ci-hello-pr1-vectors", "someone-elses-index"]),
      queues: new Map([
        [
          "ci-hello-pr1-tasks",
          {
            id: "q1",
            consumers: [{ consumer_id: "c1", script: "ci-hello-pr1" }],
          },
        ],
        ["ci-hello-pr1-dlq", { id: "q2", consumers: [] }],
        ["ci-hello-pr1-tasks-archive", { id: "q3", consumers: [] }],
      ]),
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
    expect([...state.vectorize]).toEqual(["someone-elses-index"]);
    expect([...state.queues.keys()]).toEqual(["ci-hello-pr1-tasks-archive"]);
  });

  it("removes the Worker's queue consumers before the Worker and its queues", async () => {
    const account = fakeAccount(populated());
    expect(await cleanupCiInstall(account, plan)).toEqual([]);
    const at = (call: string) => account.calls.indexOf(call);
    expect(at("DELETE /queues/q1/consumers/c1")).toBeGreaterThan(-1);
    expect(at("DELETE /queues/q1/consumers/c1")).toBeLessThan(
      at("DELETE /workers/scripts/ci-hello-pr1?force=true"),
    );
    expect(at("DELETE /queues/q1")).toBeGreaterThan(at("DELETE /queues/q1/consumers/c1"));
    expect(account.calls).not.toContain("DELETE /queues/q3");
  });

  it("reports a queue another Worker still consumes", async () => {
    const state = populated();
    state.queues.get("ci-hello-pr1-tasks")?.consumers.push({
      consumer_id: "c2",
      script: "someone-else",
    });
    const problems = await cleanupCiInstall(fakeAccount(state), plan);
    expect(state.queues.get("ci-hello-pr1-tasks")?.consumers).toEqual([
      { consumer_id: "c2", script: "someone-else" },
    ]);
    expect(problems).toEqual([
      "queue ci-hello-pr1-tasks: delete failed: HTTP 400 (11005 queue has consumers)",
      "queue ci-hello-pr1-tasks still exists",
    ]);
  });

  it("reports a Vectorize index it could not delete", async () => {
    const problems = await cleanupCiInstall(fakeAccount(populated("/vectorize/v2/indexes/")), plan);
    expect(problems).toEqual([
      "vectorize ci-hello-pr1-vectors: delete failed: HTTP 409 (10008 bucket not empty)",
      "vectorize ci-hello-pr1-vectors still exists",
    ]);
  });

  it("deletes a Worker a deploy uploaded before failing on its triggers", async () => {
    // wrangler uploads the script, then fails on a cron schedule over the
    // account's limit; the Worker stays with whatever schedules got through.
    const state = {
      ...populated(),
      schedules: new Map([
        ["ci-hello-pr1", ["*/5 * * * *"]],
        ["someone-else", ["0 0 * * *"]],
      ]),
    };
    const account = fakeAccount(state);
    expect(await cleanupCiInstall(account, plan)).toEqual([]);
    expect([...state.scripts]).toEqual(["someone-else"]);
    expect([...state.schedules.keys()]).toEqual(["someone-else"]);
    expect(account.calls).toContain("GET /workers/scripts/ci-hello-pr1/settings");
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

describe("createVectorizeIndexes", () => {
  it("creates each index with its recorded dimensions and metric", async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const request: CfRequest = async (method, p, body) => {
      calls.push({ method, path: p, body });
      // What Cloudflare answers for a new index.
      return { status: 201, body: { success: true, result: {} } };
    };
    await createVectorizeIndexes(request, {
      vectorizeIndexes: [
        { name: "ci-sb-pr8-vectorize", dimensions: 384, metric: "cosine" },
        { name: "ci-sb-pr8-images", dimensions: 768, metric: "euclidean" },
      ],
    });
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/vectorize/v2/indexes",
        body: { name: "ci-sb-pr8-vectorize", config: { dimensions: 384, metric: "cosine" } },
      },
      {
        method: "POST",
        path: "/vectorize/v2/indexes",
        body: { name: "ci-sb-pr8-images", config: { dimensions: 768, metric: "euclidean" } },
      },
    ]);
  });

  it("fails on a 2xx whose envelope does not report success", async () => {
    for (const body of [{ success: false, errors: [] }, null]) {
      const request: CfRequest = async () => ({ status: 200, body });
      await expect(
        createVectorizeIndexes(request, {
          vectorizeIndexes: [{ name: "ci-sb-pr8-vectorize", dimensions: 384, metric: "cosine" }],
        }),
      ).rejects.toThrow("creating Vectorize index ci-sb-pr8-vectorize failed: HTTP 200");
    }
  });

  it("fails with Cloudflare's error when a create is refused", async () => {
    const request: CfRequest = async () => ({
      status: 409,
      body: { success: false, errors: [{ code: 3002, message: "index already exists" }] },
    });
    await expect(
      createVectorizeIndexes(request, {
        vectorizeIndexes: [{ name: "ci-sb-pr8-vectorize", dimensions: 384, metric: "cosine" }],
      }),
    ).rejects.toThrow(
      "creating Vectorize index ci-sb-pr8-vectorize failed: HTTP 409 (3002 index already exists)",
    );
  });
});

describe("createQueues", () => {
  it("creates each planned queue by name", async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const request: CfRequest = async (method, p, body) => {
      calls.push({ method, path: p, body });
      return { status: 200, body: { success: true, result: { queue_id: "q" } } };
    };
    await createQueues(request, { queues: ["ci-fm-pr3-ingest-queue", "ci-fm-pr3-dlq"] });
    expect(calls).toEqual([
      { method: "POST", path: "/queues", body: { queue_name: "ci-fm-pr3-ingest-queue" } },
      { method: "POST", path: "/queues", body: { queue_name: "ci-fm-pr3-dlq" } },
    ]);
  });

  it("fails with Cloudflare's error when a create is refused", async () => {
    const request: CfRequest = async () => ({
      status: 409,
      body: { success: false, errors: [{ code: 11009, message: "queue name already taken" }] },
    });
    await expect(createQueues(request, { queues: ["ci-fm-pr3-dlq"] })).rejects.toThrow(
      "creating queue ci-fm-pr3-dlq failed: HTTP 409 (11009 queue name already taken)",
    );
  });
});

describe("attachQueueConsumers", () => {
  function account(queues: Record<string, string>) {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const request: CfRequest = async (method, p, body) => {
      calls.push({ method, path: p, body });
      const list = p.match(/^\/queues\?page=1&name=(.+)$/);
      if (list) {
        const wanted = decodeURIComponent(list[1] as string);
        const result = Object.entries(queues)
          .filter(([name]) => name.startsWith(wanted))
          .map(([queue_name, queue_id]) => ({ queue_id, queue_name }));
        return { status: 200, body: { success: true, result } };
      }
      return { status: 200, body: { success: true, result: { consumer_id: "c" } } };
    };
    return { request, calls };
  }

  it("points each queue at the Worker with its settings and dead-letter queue by name", async () => {
    const { request, calls } = account({
      "ci-fm-pr3-ingest-queue": "q1",
      "ci-fm-pr3-ingest-queue-2": "q9",
      "ci-fm-pr3-embed-queue": "q2",
    });
    await attachQueueConsumers(request, {
      name: "ci-fm-pr3",
      queueConsumers: [
        {
          queue: "ci-fm-pr3-ingest-queue",
          deadLetterQueue: "ci-fm-pr3-dlq",
          settings: { batch_size: 10, max_wait_time_ms: 2000 },
        },
        { queue: "ci-fm-pr3-embed-queue", deadLetterQueue: null, settings: {} },
      ],
    });
    expect(calls.filter((c) => c.method === "POST")).toEqual([
      {
        method: "POST",
        path: "/queues/q1/consumers",
        body: {
          type: "worker",
          script_name: "ci-fm-pr3",
          dead_letter_queue: "ci-fm-pr3-dlq",
          settings: { batch_size: 10, max_wait_time_ms: 2000 },
        },
      },
      {
        method: "POST",
        path: "/queues/q2/consumers",
        body: { type: "worker", script_name: "ci-fm-pr3" },
      },
    ]);
  });

  it("fails when the queue is missing or the attach is refused", async () => {
    const consumers = [{ queue: "ci-fm-pr3-jobs", deadLetterQueue: null, settings: {} }];
    await expect(
      attachQueueConsumers(account({}).request, { name: "ci-fm-pr3", queueConsumers: consumers }),
    ).rejects.toThrow("the queue ci-fm-pr3-jobs does not exist, so no consumer can be attached");
    const refusing: CfRequest = async (method) =>
      method === "GET"
        ? {
            status: 200,
            body: { success: true, result: [{ queue_id: "q1", queue_name: "ci-fm-pr3-jobs" }] },
          }
        : {
            status: 400,
            body: { success: false, errors: [{ code: 11003, message: "script not found" }] },
          };
    await expect(
      attachQueueConsumers(refusing, { name: "ci-fm-pr3", queueConsumers: consumers }),
    ).rejects.toThrow(
      "attaching a consumer to queue ci-fm-pr3-jobs failed: HTTP 400 (11003 script not found)",
    );
  });
});

describe("createCfRequest", () => {
  it("sends a body as JSON and none without one", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return Response.json({ success: true, result: [] });
    }) as unknown as typeof fetch;
    const request = createCfRequest("test-token", "acct", fetchFn);
    await request("POST", "/vectorize/v2/indexes", { name: "x" });
    await request("GET", "/vectorize/v2/indexes");
    expect(seen[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct/vectorize/v2/indexes",
    );
    expect(seen[0]?.init.body).toBe('{"name":"x"}');
    expect(seen[0]?.init.headers).toEqual({
      authorization: "Bearer test-token",
      "content-type": "application/json",
    });
    expect(seen[1]?.init.body).toBeUndefined();
    expect(seen[1]?.init.headers).toEqual({ authorization: "Bearer test-token" });
  });
});

describe.skipIf(!appflareAvailable)("placeholders match @appflare/schema", () => {
  it("renders text and JSON values like the manager's own functions", async () => {
    const schema = (await import(pathToFileURL(appflarePaths(appflareDir).schemaDist).href)) as {
      renderPlaceholders: typeof renderPlaceholders;
      renderJsonPlaceholders: typeof renderJsonPlaceholders;
    };
    const texts = [
      "{{workerUrl}}",
      "{{ workerName }}-{{workerUrl}}/x",
      "{{workerurl}} {{other}} {workerName} {{{workerName}}}",
      "",
    ];
    const jsons: JsonValue[] = [
      ["{{workerUrl}}", 1, null, true],
      { "{{workerName}}": { deep: ["{{ workerUrl }}"] }, n: 2 },
      JSON.parse('{"__proto__": "{{workerName}}"}') as JsonValue,
      "{{workerName}}",
      7,
    ];
    texts.push("{{accountId}}/{{ accountId }}", "{{accountid}}");
    texts.push("{{appUrl}}/x {{ appHostname }} {{workerHostname}}", "{{wildcardHostname}}");
    jsons.push({ a: ["{{accountId}}"] }, { b: ["{{appUrl}}", "{{appHostname}}"] });
    texts.push(
      "https://{{accessTeamDomain}} {{ accessAud }} {{accessCertsUrl}}",
      "https://{{accessTeamName}}.cloudflareaccess.com",
      "{{accessaud}}",
    );
    jsons.push({ c: ["{{accessAud}}", "{{ accessCertsUrl }}", "{{ accessTeamName }}"] });
    const url = "https://w.acme.workers.dev";
    const access = {
      teamDomain: "acme.cloudflareaccess.com",
      teamName: "acme",
      aud: "0".repeat(64),
      certsUrl: "https://acme.cloudflareaccess.com/cdn-cgi/access/certs",
    };
    for (const values of [
      { workerUrl: url, appUrl: url, workerName: "w", access },
      { workerUrl: url, appUrl: url, workerName: "w", access: null },
      { workerUrl: url, appUrl: url, workerName: "w" },
      { workerUrl: null, appUrl: null, workerName: "w" },
      { workerUrl: url, appUrl: "https://links.example.com", workerName: "w" },
      {
        workerUrl: url,
        appUrl: url,
        workerName: "w",
        accountId: "0123456789abcdef0123456789abcdef",
      },
      { workerUrl: null, appUrl: null, workerName: "w", accountId: null },
    ]) {
      for (const text of texts) {
        expect(renderPlaceholders(text, values)).toBe(schema.renderPlaceholders(text, values));
      }
      for (const json of jsons) {
        expect(JSON.stringify(renderJsonPlaceholders(json, values))).toBe(
          JSON.stringify(schema.renderJsonPlaceholders(json, values)),
        );
      }
    }
  });
});

describe.skipIf(!appflareAvailable)("service bindings match @appflare/schema", () => {
  it("accepts exactly the service bindings the manager accepts", async () => {
    const schema = (await import(pathToFileURL(appflarePaths(appflareDir).schemaDist).href)) as {
      SELF_SERVICE: string;
      isSelfServiceBinding: (binding: Record<string, unknown>) => boolean;
    };
    expect(SELF_SERVICE).toBe(schema.SELF_SERVICE);
    const bindings: Record<string, unknown>[] = [
      { type: "service", name: "SELF", service: "self" },
      { type: "service", name: "SELF", service: "self", entrypoint: "Units" },
      { type: "service", name: "SELF", service: "self", entrypoint: "" },
      { type: "service", name: "SELF", service: "self", environment: "production" },
      { type: "service", name: "SELF", service: "self", props: {} },
      { type: "service", name: "SELF", service: "appflare" },
      { type: "service", name: "SELF" },
    ];
    for (const binding of bindings) {
      const plan = () =>
        planCiInstall(
          manifest((m) => {
            worker(m).bindings = [binding];
          }),
          "ci-hello-pr1",
        );
      if (schema.isSelfServiceBinding(binding)) {
        expect(plan).not.toThrow();
      } else {
        expect(plan).toThrow(/an app may bind only to its own Worker/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Apps of several Workers

describe("planCiApp for an app of one Worker", () => {
  it("is planCiInstall's plan, deployed alone, with wrangler provisioning its KV", () => {
    const m = manifest((m) => {
      worker(m).bindings = [
        { type: "kv_namespace", name: "CUT_KV" },
        { type: "d1", name: "DB" },
        { type: "ratelimit", name: "LIMIT", simple: { limit: 1, period: 10 } },
      ];
      m.d1 = {
        DB: {
          migrations: [
            {
              name: "0001.sql",
              path: "d1/DB/0001.sql",
              size: 1,
              sha256: "a".repeat(64),
              offset: 0,
            },
          ],
          schema: [],
          postDeploy: [],
        },
      };
    });
    const options = { subdomain: "acme", accountId: "abc", namespaceId: () => "7" };
    const app = planCiApp(m, "ci-hello-pr1", options);
    const plan = planCiInstall(m, "ci-hello-pr1", options);
    expect(app.workers).toEqual([{ entryName: null, primary: true, plan, manifest: m }]);
    expect(app.resources).toEqual(plan.resources);
    expect(app.kvNamespaces).toEqual([]);
    expect(app.d1).toEqual([{ ...plan.d1[0], worker: "ci-hello-pr1" }]);
  });

  it("refuses an artifact of several Workers without the schema's functions for them", () => {
    const duo = duoArtifactManifestFixture({ sha: PIN }) as unknown as ArtifactManifest;
    expect(() => planCiApp(duo, "ci-duo-pr1")).toThrow(/has several Workers/);
  });
});

describe("appSummaryLines", () => {
  const duo = { app: "duo", version: "0.2.0" };
  const jobs = {
    entryName: "jobs",
    primary: false,
    plan: { name: "ci-duo-pr1-jobs", notes: ["Worker jobs: a note"] },
  };
  const web = { entryName: "web", primary: true, plan: { name: "ci-duo-pr1", notes: [] } };

  it("is summaryLines for an app of one Worker", () => {
    const plan = { name: "ci-hello-pr1", notes: ["n"] };
    const app = { name: plan.name, workers: [{ entryName: null, primary: true, plan }] };
    expect(appSummaryLines(duo, app, true, "HTTP 200")).toEqual(
      summaryLines(duo, plan, true, "HTTP 200"),
    );
  });

  it("names every Worker with what it answered, then every note", () => {
    const app = { name: "ci-duo-pr1", workers: [jobs, web] };
    const lines = appSummaryLines(duo, app, false, "ci-duo-pr1-jobs did not answer", [
      { worker: web, health: { ok: true, detail: "HTTP 200" } },
      { worker: jobs, health: { ok: false, detail: "HTTP 500: boom" } },
    ]);
    expect(lines).toEqual([
      "FAIL duo@0.2.0 as ci-duo-pr1 (2 Workers): ci-duo-pr1-jobs did not answer",
      "- Worker jobs as ci-duo-pr1-jobs: FAIL HTTP 500: boom",
      "- Worker web (primary) as ci-duo-pr1: HTTP 200",
      "- note: Worker jobs: a note",
    ]);
  });

  it("marks Workers a failed deploy never got to", () => {
    const app = { name: "ci-duo-pr1", workers: [jobs, web] };
    expect(appSummaryLines(duo, app, false, "wrangler deploy --strict failed (exit 1)")).toEqual([
      "FAIL duo@0.2.0 as ci-duo-pr1 (2 Workers): wrangler deploy --strict failed (exit 1)",
      "- Worker jobs as ci-duo-pr1-jobs: not checked",
      "- Worker web (primary) as ci-duo-pr1: not checked",
      "- note: Worker jobs: a note",
    ]);
  });
});

describe("appSecretValues", () => {
  const worker = (
    name: string,
    secrets: string[],
    derivedSecrets: CiInstallPlan["derivedSecrets"],
    more: Partial<CiInstallPlan> = {},
  ) => ({
    plan: {
      name,
      secrets,
      seedOnlySecrets: [],
      vapidPrivateKeys: [],
      base64Keys: [],
      seedVars: {},
      workersDev: true,
      derivedSecrets,
      derivedVars: [],
      ...more,
    } as CiInstallPlan,
    entryName: name,
    primary: false,
    manifest: {} as ArtifactManifest,
  });
  const fns = (vapid: (() => string) | null = null) => ({
    deriveSecretValue: (method: string, value: string) => `${method}(${value})`,
    generateVapidPrivateKey: vapid,
  });

  it("gives a secret several Workers get one value, and derives from it once", () => {
    let n = 0;
    const app = {
      workers: [
        worker("a", ["SHARED", "A_ONLY"], []),
        worker("b", ["SHARED"], [{ name: "HASH", from: "SHARED", method: "bcrypt" }]),
        worker("c", [], [{ name: "HASH", from: "SHARED", method: "bcrypt" }]),
      ],
    };
    const values = appSecretValues(app, fns(), () => `v${++n}`);
    expect([...values]).toEqual([
      ["SHARED", "v1"],
      ["A_ONLY", "v2"],
      ["HASH", "bcrypt(v1)"],
    ]);
  });

  it("refuses a derived secret whose source no Worker gets", () => {
    const app = { workers: [worker("a", [], [{ name: "HASH", from: "PW", method: "bcrypt" }])] };
    expect(() => appSecretValues(app, fns())).toThrow(/derives from PW/);
  });

  it("generates a VAPID private key where the manifest asks for one, and derives vars from it", () => {
    const w = worker("a", ["VAPID", "OTHER"], [], {
      vapidPrivateKeys: ["VAPID"],
      derivedVars: [{ name: "VAPID_PUBLIC", from: "VAPID", method: "vapid-public-key" }],
    });
    const values = appSecretValues(
      { workers: [w] },
      fns(() => "vapid-key"),
      () => "random",
    );
    expect([...values]).toEqual([
      ["VAPID", "vapid-key"],
      ["OTHER", "random"],
    ]);
    expect(derivedVarValues(w.plan, values, fns().deriveSecretValue)).toEqual({
      VAPID_PUBLIC: "vapid-public-key(vapid-key)",
    });
    expect(() => appSecretValues({ workers: [w] }, fns(null))).toThrow(/no generator was loaded/);
    expect(() => derivedVarValues(w.plan, values, null)).toThrow(/no derivation was loaded/);
  });

  it("tells when the packer's functions are needed", () => {
    expect(needsPackerSecrets({ workers: [worker("a", ["X"], [])] })).toBe(false);
    expect(
      needsPackerSecrets({ workers: [worker("a", ["X"], [], { vapidPrivateKeys: ["X"] })] }),
    ).toBe(true);
  });
});

describe("withVars", () => {
  it("adds vars to a config's own, and leaves a config alone when there are none", () => {
    const config = { name: "w", vars: { A: "1" } };
    expect(withVars(config, {})).toBe(config);
    expect(withVars(config, { B: "2" })).toEqual({ name: "w", vars: { A: "1", B: "2" } });
    expect(withVars({ name: "w" }, { B: "2" })).toEqual({ name: "w", vars: { B: "2" } });
  });
});

describe("withKvIds and createKvNamespaces", () => {
  it("writes each KV binding's namespace id into a config, and refuses one without", () => {
    const config = { name: "w", kv_namespaces: [{ binding: "CACHE" }] };
    expect(withKvIds(config, { CACHE: "id1" })).toEqual({
      name: "w",
      kv_namespaces: [{ binding: "CACHE", id: "id1" }],
    });
    expect(withKvIds({ name: "w" }, {})).toEqual({ name: "w" });
    expect(() => withKvIds(config, {})).toThrow(
      /no KV namespace was created for the binding CACHE/,
    );
  });

  it("creates each namespace by title and returns the ids by binding", async () => {
    const calls: unknown[] = [];
    const request: CfRequest = async (method, p, body) => {
      calls.push([method, p, body]);
      return { status: 200, body: { success: true, result: { id: "kv-1", title: "t" } } };
    };
    const ids = await createKvNamespaces(request, {
      kvNamespaces: [{ type: "kv", name: "ci-duo-pr1-cache", binding: "CACHE" }],
    });
    expect(ids).toEqual({ CACHE: "kv-1" });
    expect(calls).toEqual([["POST", "/storage/kv/namespaces", { title: "ci-duo-pr1-cache" }]]);
    const refused: CfRequest = async () => ({
      status: 400,
      body: { success: false, errors: [{ code: 10014, message: "exists" }] },
    });
    await expect(
      createKvNamespaces(refused, {
        kvNamespaces: [{ type: "kv", name: "x", binding: "X" }],
      }),
    ).rejects.toThrow(/creating KV namespace x failed: HTTP 400 \(10014 exists\)/);
  });
});

describe("cleanupCiApp", () => {
  it("deletes every Worker, the last deployed first, and every shared resource once", async () => {
    const state = {
      scripts: new Set(["ci-duo-pr1", "ci-duo-pr1-jobs", "someone-else"]),
      kv: [{ id: "kv1", title: "ci-duo-pr1-cache" }],
      d1: [{ uuid: "db1", name: "ci-duo-pr1-db" }],
      r2: new Set<string>(),
      workflows: new Set<string>(),
      queues: new Map([
        [
          "ci-duo-pr1-tasks",
          { id: "q1", consumers: [{ consumer_id: "c1", script: "ci-duo-pr1-jobs" }] },
        ],
      ]),
    };
    const account = fakeAccount(state);
    const app = {
      workers: [{ plan: { name: "ci-duo-pr1-jobs" } }, { plan: { name: "ci-duo-pr1" } }],
      resources: [
        { type: "d1" as const, name: "ci-duo-pr1-db", binding: "DB" },
        { type: "kv" as const, name: "ci-duo-pr1-cache", binding: "CACHE" },
        { type: "queue" as const, name: "ci-duo-pr1-tasks", binding: "TASKS" },
      ],
    };
    expect(await cleanupCiApp(account, app)).toEqual([]);
    expect([...state.scripts]).toEqual(["someone-else"]);
    expect(state.kv).toEqual([]);
    expect(state.d1).toEqual([]);
    expect(state.queues.size).toBe(0);
    const deletes = account.calls.filter((c) => c.startsWith("DELETE /workers/scripts/"));
    expect(deletes).toEqual([
      "DELETE /workers/scripts/ci-duo-pr1?force=true",
      "DELETE /workers/scripts/ci-duo-pr1-jobs?force=true",
    ]);
  });

  it("reports a Worker of the app that is still there", async () => {
    const state = {
      scripts: new Set(["ci-duo-pr1-jobs"]),
      kv: [],
      d1: [],
      r2: new Set<string>(),
      workflows: new Set<string>(),
      failDelete: "ci-duo-pr1-jobs",
    };
    const app = {
      workers: [{ plan: { name: "ci-duo-pr1-jobs" } }, { plan: { name: "ci-duo-pr1" } }],
      resources: [],
    };
    const problems = await cleanupCiApp(fakeAccount(state), app);
    expect(problems).toEqual([
      "Worker ci-duo-pr1-jobs: delete failed: HTTP 409 (10008 bucket not empty)",
      expect.stringMatching(/^Worker ci-duo-pr1-jobs still exists/),
    ]);
  });
});

// The functions for apps of several Workers come from @appflare/schema; these
// tests run with a build that has them.
const entryHelpers = appflareAvailable
  ? await loadEntryWorkerHelpers(appflareDir).catch(() => null)
  : null;

describe.skipIf(entryHelpers === null)("planCiApp for an app of several Workers", () => {
  async function duoPlan(): Promise<CiAppPlan> {
    const schema = await loadAppflareSchema(appflareDir);
    const parsed = parseOrThrow(
      schema.artifactManifest,
      duoArtifactManifestFixture({ sha: PIN }),
      "duo",
    );
    return planCiApp(parsed, "ci-duo-pr1", {
      subdomain: "acme",
      accountId: "abc",
      namespaceId: (binding) => `id-${binding}`,
      ...(entryHelpers === null ? {} : { helpers: entryHelpers }),
    });
  }

  it("deploys each Worker after the Workers it binds to, under the manager's names", async () => {
    const app = await duoPlan();
    expect(app.workers.map((w) => [w.entryName, w.primary, w.plan.name])).toEqual([
      ["jobs", false, "ci-duo-pr1-jobs"],
      ["web", true, "ci-duo-pr1"],
    ]);
    expect(app.workers.map((w) => w.plan.config.name)).toEqual(["ci-duo-pr1-jobs", "ci-duo-pr1"]);
  });

  it("points bindings between the Workers at the CI Workers, and self at itself", async () => {
    const web = (await duoPlan()).workers[1]?.plan.config;
    expect(web?.services).toEqual([
      { binding: "JOBS", service: "ci-duo-pr1-jobs", entrypoint: "Jobs" },
      { binding: "SELF", service: "ci-duo-pr1" },
    ]);
    expect(web?.durable_objects).toEqual({
      bindings: [{ name: "COUNTER", class_name: "Counter", script_name: "ci-duo-pr1-jobs" }],
    });
  });

  it("shares resources by binding name, named after the primary Worker", async () => {
    const app = await duoPlan();
    const [jobs, web] = app.workers.map((w) => w.plan.config);
    for (const config of [jobs, web]) {
      expect(config?.d1_databases).toEqual([
        { binding: "DB", database_name: "ci-duo-pr1-db", migrations_dir: "d1/DB" },
      ]);
      expect(config?.kv_namespaces).toEqual([{ binding: "CACHE" }]);
      // One rate limit namespace for the app, not one per Worker.
      expect(config?.ratelimits).toEqual([
        { name: "LIMIT", namespace_id: "id-LIMIT", simple: { limit: 10, period: 60 } },
      ]);
    }
    expect(app.resources).toEqual([
      { type: "d1", name: "ci-duo-pr1-db", binding: "DB" },
      { type: "kv", name: "ci-duo-pr1-cache", binding: "CACHE" },
      { type: "queue", name: "ci-duo-pr1-tasks", binding: "TASKS" },
    ]);
    expect(app.kvNamespaces).toEqual([{ type: "kv", name: "ci-duo-pr1-cache", binding: "CACHE" }]);
    expect(app.queues).toEqual(["ci-duo-pr1-tasks"]);
    // Once, from the first Worker deployed that binds the database.
    expect(app.d1).toEqual([
      {
        database: "ci-duo-pr1-db",
        binding: "DB",
        migrations: true,
        schema: [],
        postDeploy: [],
        worker: "ci-duo-pr1-jobs",
      },
    ]);
  });

  it("attaches a queue one Worker sends to and another consumes to the consumer, once", async () => {
    const [jobs, web] = (await duoPlan()).workers;
    expect(jobs?.plan.queueConsumers).toEqual([
      { queue: "ci-duo-pr1-tasks", deadLetterQueue: null, settings: { max_retries: 3 } },
    ]);
    expect(jobs?.plan.config.queues).toBeUndefined();
    expect(web?.plan.config.queues).toEqual({
      producers: [{ binding: "TASKS", queue: "ci-duo-pr1-tasks" }],
    });
    expect(web?.plan.queueConsumers).toEqual([]);
  });

  it("gives each Worker the secrets and vars that go to it, placeholders filled in", async () => {
    const [jobs, web] = (await duoPlan()).workers;
    expect(web?.plan.secrets).toEqual(["SESSION_SECRET", "SHARED_KEY"]);
    expect(jobs?.plan.secrets).toEqual(["SHARED_KEY"]);
    // JOBS_URL goes to the Worker whose config declares it; APP_URL to the one named.
    expect(web?.plan.config.vars).toEqual({ JOBS_URL: "https://ci-duo-pr1-jobs.acme.workers.dev" });
    expect(jobs?.plan.config.vars).toEqual({ APP_URL: "https://ci-duo-pr1.acme.workers.dev" });
  });

  it("names the Worker in each note, and unpacks each Worker's own files", async () => {
    const [jobs, web] = (await duoPlan()).workers;
    expect(jobs?.plan.notes).toEqual([
      "Worker jobs: the artifact declares 1 cron trigger (`*/30 * * * *`); " +
        "not set on the CI Worker, so scheduled runs are not exercised",
    ]);
    expect(jobs?.manifest.worker.modules[0]?.path).toBe("workers/jobs/worker/index.js");
    expect(jobs?.manifest.assets.files).toEqual([]);
    expect(web?.manifest.assets.files.map((f) => f.route)).toEqual(["/index.html"]);
  });

  it("refuses a CI Worker name longer than 63 characters", async () => {
    const schema = await loadAppflareSchema(appflareDir);
    const parsed = parseOrThrow(
      schema.artifactManifest,
      duoArtifactManifestFixture({ sha: PIN }),
      "duo",
    );
    expect(() =>
      planCiApp(parsed, `ci-${"d".repeat(55)}`, {
        ...(entryHelpers === null ? {} : { helpers: entryHelpers }),
      }),
    ).toThrow(/longer than 63 characters/);
  });
});
