import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  artifactManifestFixture,
  d1ArtifactManifestFixture,
  duoArtifactManifestFixture,
} from "../fixtures/artifact-manifest.ts";
import { appflareAvailable, appflareDir } from "../fixtures/schema.ts";
import { loadAppflareSchema, loadEntryWorkerHelpers, parseOrThrow } from "./appflare-schema.ts";
import {
  type CiD1Database,
  d1Steps,
  isSeedStep,
  migrationsLayout,
  planCiApp,
  planCiInstall,
  postDeployConfig,
  unpackArtifact,
} from "./ci-install.ts";
import type { ArtifactManifest } from "./types.ts";

const PIN = "0123456789abcdef0123456789abcdef01234567";

const ledger = () => d1ArtifactManifestFixture({ sha: PIN }) as unknown as ArtifactManifest;

describe("migrationsLayout", () => {
  it("leaves wrangler's default pattern for flat .sql names", () => {
    expect(migrationsLayout("d1/DB", ["0001_init.sql", "0002_more.sql"])).toEqual({
      migrations_dir: "d1/DB",
    });
  });

  it("matches every file under the folder when a name is a path or not .sql", () => {
    expect(migrationsLayout("d1/DB", ["20240101_init/migration.sql"])).toEqual({
      migrations_dir: "d1/DB",
      migrations_pattern: "d1/DB/**",
    });
    expect(migrationsLayout("d1/DB", ["0001_init.up"])).toEqual({
      migrations_dir: "d1/DB",
      migrations_pattern: "d1/DB/**",
    });
  });

  it("sets nothing for a binding without migrations", () => {
    expect(migrationsLayout("d1/DB", [])).toEqual({});
  });
});

describe("planCiInstall with resources.d1", () => {
  const plan = () => planCiInstall(ledger(), "ci-ledger-pr1");

  it("points each database's migrations_dir at its unpacked migrations", () => {
    expect(plan().config.d1_databases).toEqual([
      {
        binding: "DB",
        database_name: "ci-ledger-pr1-db",
        migrations_dir: "d1/DB",
        migrations_pattern: "d1/DB/**",
      },
      { binding: "LOGS", database_name: "ci-ledger-pr1-logs", migrations_dir: "d1/LOGS" },
      { binding: "SEEDS", database_name: "ci-ledger-pr1-seeds" },
      { binding: "AUDIT", database_name: "ci-ledger-pr1-audit" },
    ]);
  });

  it("lists each database's migrations, schema files and post-deploy migrations", () => {
    expect(plan().d1).toEqual([
      {
        database: "ci-ledger-pr1-db",
        binding: "DB",
        migrations: true,
        schema: ["d1-schema/DB/db/views.sql"],
        postDeploy: ["0100_drop_legacy.sql"],
      },
      {
        database: "ci-ledger-pr1-logs",
        binding: "LOGS",
        migrations: true,
        schema: [],
        postDeploy: [],
      },
      {
        database: "ci-ledger-pr1-seeds",
        binding: "SEEDS",
        migrations: false,
        schema: ["d1-schema/SEEDS/db/seed.sql", "d1-schema/SEEDS/db/more.sql"],
        postDeploy: [],
      },
      {
        database: "ci-ledger-pr1-audit",
        binding: "AUDIT",
        migrations: false,
        schema: [],
        postDeploy: ["0001_audit.sql"],
      },
    ]);
  });

  it("leaves out a database with no SQL at all", () => {
    const m = artifactManifestFixture({ app: "hello", version: "1.2.3", sha: PIN });
    (m.worker as Record<string, unknown>).bindings = [{ type: "d1", name: "DB" }];
    m.d1 = { DB: { migrations: [], schema: [], postDeploy: [] } };
    const bare = planCiInstall(m as unknown as ArtifactManifest, "ci-hello-pr1");
    expect(bare.d1).toEqual([]);
    expect(bare.config.d1_databases).toEqual([{ binding: "DB", database_name: "ci-hello-pr1-db" }]);
  });
});

describe("postDeployConfig", () => {
  it("points only the databases with post-deploy migrations at them", () => {
    const plan = planCiInstall(ledger(), "ci-ledger-pr1");
    const config = postDeployConfig(plan.config, plan.d1);
    expect(config?.d1_databases).toEqual([
      { binding: "DB", database_name: "ci-ledger-pr1-db", migrations_dir: "d1-post-deploy/DB" },
      { binding: "LOGS", database_name: "ci-ledger-pr1-logs", migrations_dir: "d1/LOGS" },
      { binding: "SEEDS", database_name: "ci-ledger-pr1-seeds" },
      {
        binding: "AUDIT",
        database_name: "ci-ledger-pr1-audit",
        migrations_dir: "d1-post-deploy/AUDIT",
      },
    ]);
    // Everything else is the deploy config's.
    expect({ ...config, d1_databases: undefined }).toEqual({
      ...plan.config,
      d1_databases: undefined,
    });
  });

  it("is null when no database has post-deploy migrations", () => {
    const only: CiD1Database = {
      database: "db",
      binding: "DB",
      migrations: true,
      schema: [],
      postDeploy: [],
    };
    expect(postDeployConfig({ d1_databases: [{ binding: "DB" }] }, [only])).toBeNull();
  });
});

describe("d1Steps", () => {
  it("runs migrations then schema files per database, then every post-deploy step", () => {
    const app = planCiApp(ledger(), "ci-ledger-pr1");
    const steps = d1Steps(app.d1).map((s) =>
      isSeedStep(s) ? `seed ${s.database}` : [s.config, ...s.args].join(" "),
    );
    expect(steps).toEqual([
      "wrangler.json d1 migrations apply ci-ledger-pr1-db --remote",
      "wrangler.json d1 execute ci-ledger-pr1-db --remote --yes --file d1-schema/DB/db/views.sql",
      "wrangler.json d1 migrations apply ci-ledger-pr1-logs --remote",
      "wrangler.json d1 execute ci-ledger-pr1-seeds --remote --yes --file d1-schema/SEEDS/db/seed.sql",
      "wrangler.json d1 execute ci-ledger-pr1-seeds --remote --yes --file d1-schema/SEEDS/db/more.sql",
      "wrangler.post-deploy.json d1 migrations apply ci-ledger-pr1-db --remote",
      "wrangler.post-deploy.json d1 migrations apply ci-ledger-pr1-audit --remote",
    ]);
    expect(new Set(d1Steps(app.d1).map((s) => s.worker))).toEqual(new Set(["ci-ledger-pr1"]));
  });

  it("is empty without D1 SQL", () => {
    expect(d1Steps([])).toEqual([]);
  });
});

describe("unpackArtifact with D1 schema files and post-deploy migrations", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ci-unpack-d1-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes each list under its folder, by binding and name", () => {
    const texts = {
      main: "export default {}",
      init: "CREATE TABLE a(x);",
      tags: "CREATE TABLE b(x);",
      views: "CREATE VIEW IF NOT EXISTS v AS SELECT 1;",
      drop: "DROP TABLE legacy;",
    };
    let offset = 0;
    const parts: Buffer[] = [];
    const entry = (key: keyof typeof texts) => {
      const data = Buffer.from(texts[key]);
      const e = {
        path: key,
        size: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
        offset,
      };
      parts.push(data);
      offset += data.length;
      return e;
    };
    const m = artifactManifestFixture({ app: "ledger", version: "1.0.0", sha: PIN });
    const worker = m.worker as Record<string, unknown>;
    worker.modules = [{ name: "index.js", type: "esm", ...entry("main") }];
    m.d1 = {
      DB: {
        migrations: [
          { name: "20240101_init/migration.sql", ...entry("init") },
          { name: "20240302_tags/migration.sql", ...entry("tags") },
        ],
        schema: [{ name: "db/views.sql", ...entry("views") }],
        postDeploy: [{ name: "0100_drop_legacy.sql", ...entry("drop") }],
      },
    };
    writeFileSync(path.join(dir, "a.zip"), Buffer.concat(parts));
    const out = path.join(dir, "out");
    unpackArtifact(m as unknown as ArtifactManifest, path.join(dir, "a.zip"), out);
    const at = (p: string) => readFileSync(path.join(out, p), "utf8");
    expect(at("d1/DB/20240101_init/migration.sql")).toBe(texts.init);
    expect(at("d1/DB/20240302_tags/migration.sql")).toBe(texts.tags);
    expect(at("d1-schema/DB/db/views.sql")).toBe(texts.views);
    expect(at("d1-post-deploy/DB/0100_drop_legacy.sql")).toBe(texts.drop);
    // The migrations folder holds only the artifact's migrations, so `<dir>/**` finds just them.
    expect(readdirSync(path.join(out, "d1/DB"), { recursive: true }).sort()).toEqual([
      "20240101_init",
      "20240101_init/migration.sql",
      "20240302_tags",
      "20240302_tags/migration.sql",
    ]);
  });
});

describe.skipIf(!appflareAvailable)("D1 SQL with the real @appflare/schema", () => {
  it("accepts the D1 artifact", async () => {
    const schema = await loadAppflareSchema(appflareDir);
    const parsed = schema.artifactManifest.safeParse(d1ArtifactManifestFixture({ sha: PIN }));
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });

  it("runs the SQL of an app of several Workers once, from the first Worker that binds it", async (ctx) => {
    const helpers = await loadEntryWorkerHelpers(appflareDir).catch(() => null);
    if (helpers === null) ctx.skip();
    const schema = await loadAppflareSchema(appflareDir);
    const duo = duoArtifactManifestFixture({ sha: PIN });
    const hex64 = "a".repeat(64);
    const d1 = duo.d1 as Record<string, Record<string, unknown>>;
    d1.DB = {
      ...d1.DB,
      schema: [
        {
          name: "db/views.sql",
          path: "d1-schema/DB/db/views.sql",
          size: 1,
          sha256: hex64,
          offset: 4,
        },
      ],
    };
    duo.catalog = {
      ...(duo.catalog as Record<string, unknown>),
      resources: { d1: { DB: { schema: ["db/views.sql"] } } },
    };
    const parsed = parseOrThrow(schema.artifactManifest, duo, "duo");
    const app = planCiApp(parsed, "ci-duo-pr1", {
      namespaceId: (b) => `id-${b}`,
      ...(helpers === null ? {} : { helpers }),
    });
    expect(app.d1).toEqual([
      {
        database: "ci-duo-pr1-db",
        binding: "DB",
        migrations: true,
        schema: ["d1-schema/DB/db/views.sql"],
        postDeploy: [],
        worker: "ci-duo-pr1-jobs",
      },
    ]);
  });
});
