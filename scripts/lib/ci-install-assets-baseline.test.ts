import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assetsOnlyArtifactManifestFixture,
  baselineArtifactManifestFixture,
} from "../fixtures/artifact-manifest.ts";
import { appflareAvailable, appflareDir } from "../fixtures/schema.ts";
import { loadAppflareSchema } from "./appflare-schema.ts";
import {
  CREATE_MIGRATIONS_TABLE_SQL,
  d1Steps,
  planCiApp,
  planCiInstall,
  recordMigrationsQuery,
  unpackArtifact,
} from "./ci-install.ts";
import type { ArtifactManifest } from "./types.ts";

const PIN = "0123456789abcdef0123456789abcdef01234567";

const notes = () => baselineArtifactManifestFixture({ sha: PIN }) as unknown as ArtifactManifest;
const site = () => assetsOnlyArtifactManifestFixture({ sha: PIN }) as unknown as ArtifactManifest;

describe("a D1 baseline", () => {
  it("is planned with the names of every migration it records", () => {
    expect(planCiInstall(notes(), "ci-notes-pr1").d1).toEqual([
      {
        database: "ci-notes-pr1-db",
        binding: "DB",
        migrations: ["0001_init.sql", "0002_add_o'clock.sql"],
        schema: [],
        postDeploy: ["0100_cleanup.sql"],
        baseline: {
          file: "d1-baseline/DB/db/schema.sql",
          recorded: ["0001_init.sql", "0002_add_o'clock.sql", "0100_cleanup.sql"],
        },
      },
    ]);
  });

  it("runs the baseline through /query with the migrations it records, applying none", () => {
    expect(d1Steps(planCiApp(notes(), "ci-notes-pr1").d1)).toEqual([
      {
        worker: "ci-notes-pr1",
        database: "ci-notes-pr1-db",
        binding: "DB",
        file: "d1-baseline/DB/db/schema.sql",
        query: "baseline",
        recorded: ["0001_init.sql", "0002_add_o'clock.sql", "0100_cleanup.sql"],
      },
    ]);
  });

  it("records names as wrangler's d1_migrations table holds them, quotes escaped", () => {
    expect(CREATE_MIGRATIONS_TABLE_SQL).toContain('CREATE TABLE IF NOT EXISTS "d1_migrations"(');
    expect(CREATE_MIGRATIONS_TABLE_SQL).toContain("name       TEXT UNIQUE,");
    expect(recordMigrationsQuery(["0001_init.sql", "0002_add_o'clock.sql"])).toBe(
      `INSERT OR IGNORE INTO "d1_migrations" (name)\nvalues ('0001_init.sql'),\n('0002_add_o''clock.sql');`,
    );
    expect(recordMigrationsQuery([])).toBe("");
  });

  it("runs just the baseline when the version ships no migrations", () => {
    const m = notes();
    const db = m.d1.DB;
    if (db === undefined) throw new Error("the fixture binds DB");
    m.d1.DB = { ...db, migrations: [], postDeploy: [] };
    const steps = d1Steps(planCiApp(m, "ci-notes-pr1").d1);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      file: "d1-baseline/DB/db/schema.sql",
      query: "baseline",
      recorded: [],
    });
  });
});

describe("a Worker of static assets only", () => {
  it("is deployed with assets and compatibility settings, and no module settings", () => {
    const plan = planCiInstall(site(), "ci-site-pr1");
    expect(plan.config).toEqual({
      name: "ci-site-pr1",
      compatibility_date: "2024-12-30",
      compatibility_flags: ["nodejs_compat"],
      workers_dev: true,
      preview_urls: false,
      send_metrics: false,
      assets: { not_found_handling: "single-page-application", directory: "assets" },
    });
    expect(plan.notes).toEqual(["static assets only: deployed without Worker code"]);
    expect(plan.secrets).toEqual([]);
  });

  it("refuses modules without a main module", () => {
    const m = site();
    m.worker.modules = [
      { name: "index.js", type: "esm", path: "worker/index.js", size: 1, sha256: "a", offset: 0 },
    ];
    expect(() => planCiInstall(m, "ci-site-pr1")).toThrow(/has modules but no main module/);
  });
});

describe("unpackArtifact with a baseline or static assets only", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ci-unpack-assets-baseline-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Writes the texts as one STORE-like zip and returns each one's byte range, by key. */
  const zipOf = <K extends string>(
    texts: Record<K, string>,
  ): Record<K, { size: number; sha256: string; offset: number }> => {
    let offset = 0;
    const parts: Buffer[] = [];
    const entries = {} as Record<K, { size: number; sha256: string; offset: number }>;
    for (const key of Object.keys(texts) as K[]) {
      const data = Buffer.from(texts[key]);
      entries[key] = {
        size: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
        offset,
      };
      parts.push(data);
      offset += data.length;
    }
    writeFileSync(path.join(dir, "a.zip"), Buffer.concat(parts));
    return entries;
  };

  it("writes the baseline under d1-baseline/<binding>/<name>", () => {
    const { main, init, baseline } = zipOf({
      main: "export default {}",
      init: "ALTER TABLE t ADD x;",
      baseline: "CREATE TABLE t(x);",
    });
    const m = notes();
    m.worker.modules = [{ name: "index.js", type: "esm", path: "worker/index.js", ...main }];
    m.d1 = {
      DB: {
        migrations: [{ name: "0001_init.sql", path: "d1/DB/0001_init.sql", ...init }],
        schema: [],
        postDeploy: [],
        baseline: { name: "db/schema.sql", path: "d1-baseline/DB/db/schema.sql", ...baseline },
      },
    };
    const out = path.join(dir, "out");
    unpackArtifact(m, path.join(dir, "a.zip"), out);
    expect(readFileSync(path.join(out, "d1-baseline/DB/db/schema.sql"), "utf8")).toBe(
      "CREATE TABLE t(x);",
    );
    expect(readFileSync(path.join(out, "d1/DB/0001_init.sql"), "utf8")).toBe(
      "ALTER TABLE t ADD x;",
    );
  });

  it("writes an assets-only Worker's assets and no worker folder", () => {
    const { page, css } = zipOf({ page: "<h1>hi</h1>", css: "h1{}" });
    const m = site();
    m.assets.files = [
      { path: "assets/index.html", route: "/index.html", ...page },
      { path: "assets/app.css", route: "/app.css", ...css },
    ];
    const out = path.join(dir, "out");
    unpackArtifact(m, path.join(dir, "a.zip"), out);
    expect(readFileSync(path.join(out, "assets/index.html"), "utf8")).toBe("<h1>hi</h1>");
    expect(existsSync(path.join(out, "worker"))).toBe(false);
  });
});

describe.skipIf(!appflareAvailable)(
  "a baseline and static assets with the real @appflare/schema",
  () => {
    it("accepts both fixtures, and refuses them in a format it does not read", async () => {
      const schema = await loadAppflareSchema(appflareDir);
      for (const fixture of [baselineArtifactManifestFixture, assetsOnlyArtifactManifestFixture]) {
        const m = fixture({ sha: PIN });
        expect(schema.artifactManifest.safeParse(m).success).toBe(true);
        expect(schema.artifactManifest.safeParse({ ...m, format: 2 }).success).toBe(false);
      }
    });
  },
);
