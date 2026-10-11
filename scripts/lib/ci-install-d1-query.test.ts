import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appflareAvailable, appflareDir } from "../fixtures/schema.ts";
import { type D1QueryHelpers, loadD1QueryHelpers } from "./appflare-schema.ts";
import {
  type CfRequest,
  type CfResponse,
  type CiMigrationsStep,
  type CiQueryStep,
  CREATE_MIGRATIONS_TABLE_SQL,
  d1QueryBody,
  LIST_APPLIED_MIGRATIONS_SQL,
  migrationQueryBody,
  runD1Migrations,
  runD1Query,
} from "./ci-install.ts";
import { appflarePaths } from "./paths.ts";

/** A trigger whose body holds `CASE ... END;`, where D1's `/query` would end the body. */
const TRIGGER = `CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, uses INTEGER);
CREATE TRIGGER IF NOT EXISTS check_invite
BEFORE INSERT ON invites
BEGIN
  SELECT CASE
    WHEN NEW.uses < 0 THEN RAISE(ABORT, 'negative uses')
  END;
END;
`;

/**
 * Stand-ins for the schema's functions; the normalizer marks the SQL, so a
 * test sees it ran, and names sort by their leading number, as wrangler's do.
 */
const helpers = (normalize = true): D1QueryHelpers => ({
  normalizeForD1Query: normalize ? (sql) => `-- normalized\n${sql}` : null,
  endsInsideStatement: (sql) => !sql.trimEnd().endsWith(";"),
  compareMigrationNames: (a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10),
});

const schema: CiQueryStep = {
  worker: "ci-chat-pr1",
  database: "ci-chat-pr1-db",
  binding: "DB",
  file: "d1-schema/DB/worker/schema.sql",
  query: "schema",
};

const baseline: CiQueryStep = {
  worker: "ci-chat-pr1",
  database: "ci-chat-pr1-db",
  binding: "DB",
  file: "d1-baseline/DB/db/schema.sql",
  query: "baseline",
  recorded: ["0001_init.sql", "0002_add_o'clock.sql"],
};

const RECORD = `INSERT OR IGNORE INTO "d1_migrations" (name)
values ('0001_init.sql'),
('0002_add_o''clock.sql');`;

describe("d1QueryBody", () => {
  it("is a schema file's SQL as normalizeForD1Query writes it, and nothing else", () => {
    expect(d1QueryBody(schema, TRIGGER, helpers())).toBe(`-- normalized\n${TRIGGER}`);
  });

  it("is the file as it is with a schema build that predates normalizeForD1Query", () => {
    expect(d1QueryBody(schema, TRIGGER, helpers(false))).toBe(TRIGGER);
  });

  it("is a baseline's normalized SQL, then the rows that record its migrations", () => {
    expect(d1QueryBody(baseline, TRIGGER, helpers())).toBe(`-- normalized\n${TRIGGER}\n${RECORD}`);
  });

  it("closes a baseline's last statement before the rows", () => {
    expect(d1QueryBody(baseline, "CREATE TABLE t (id INTEGER)", helpers(false))).toBe(
      `CREATE TABLE t (id INTEGER)\n;\n${RECORD}`,
    );
  });

  it("is the baseline alone when it records nothing", () => {
    expect(d1QueryBody({ ...baseline, recorded: [] }, TRIGGER, helpers(false))).toBe(TRIGGER);
  });
});

interface FakeD1 {
  request: CfRequest;
  queries: { path: string; body: unknown }[];
}

/** One statement's result, as D1's `/query` lists it. */
const statement = { results: [], success: true, meta: { changes: 0 } };

/** An account with the D1 databases `names` (uuid `uuid-<name>`); `answer` answers each query. */
function fakeD1(
  names: string[],
  answer: (sql: string) => CfResponse = () => ({
    status: 200,
    body: { success: true, result: [statement, statement, statement] },
  }),
): FakeD1 {
  const queries: FakeD1["queries"] = [];
  const request: CfRequest = async (method, apiPath, body) => {
    const list = /^\/d1\/database\?name=([^&]+)&per_page=100$/.exec(apiPath);
    if (method === "GET" && list !== null) {
      const name = decodeURIComponent(list[1] as string);
      return {
        status: 200,
        body: {
          success: true,
          result: names.filter((n) => n === name).map((n) => ({ name: n, uuid: `uuid-${n}` })),
        },
      };
    }
    if (method === "POST" && /^\/d1\/database\/[^/]+\/query$/.test(apiPath)) {
      queries.push({ path: apiPath, body });
      return answer((body as { sql: string }).sql);
    }
    throw new Error(`unexpected ${method} ${apiPath}`);
  };
  return { request, queries };
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("runD1Query", () => {
  it("sends a schema file as the body of one /query call, without params", async () => {
    const d1 = fakeD1(["ci-chat-pr1-db"]);
    await expect(runD1Query(d1.request, schema, bytes(TRIGGER), helpers())).resolves.toBe(3);
    expect(d1.queries).toEqual([
      {
        path: "/d1/database/uuid-ci-chat-pr1-db/query",
        body: { sql: `-- normalized\n${TRIGGER}` },
      },
    ]);
  });

  it("decodes the file as the manager does, dropping a byte order mark", async () => {
    const d1 = fakeD1(["ci-chat-pr1-db"]);
    const file = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("SELECT 1;")]);
    await runD1Query(d1.request, schema, file, helpers(false));
    expect(d1.queries.map((q) => q.body)).toEqual([{ sql: "SELECT 1;" }]);
  });

  it("creates d1_migrations, then runs a baseline with its rows in one query", async () => {
    const d1 = fakeD1(["ci-chat-pr1-db"]);
    await runD1Query(d1.request, baseline, bytes(TRIGGER), helpers());
    expect(d1.queries.map((q) => q.body)).toEqual([
      { sql: CREATE_MIGRATIONS_TABLE_SQL },
      { sql: d1QueryBody(baseline, TRIGGER, helpers()) },
    ]);
  });

  it("fails with D1's message, naming the file and the database", async () => {
    const d1 = fakeD1(["ci-chat-pr1-db"], () => ({
      status: 400,
      body: { success: false, errors: [{ code: 7500, message: "incomplete input: SQLITE_ERROR" }] },
    }));
    await expect(runD1Query(d1.request, schema, bytes(TRIGGER), helpers(false))).rejects.toThrow(
      "d1-schema/DB/worker/schema.sql on ci-chat-pr1-db failed: HTTP 400 (7500 incomplete input: SQLITE_ERROR)",
    );
  });

  it("does not run a baseline when d1_migrations cannot be created", async () => {
    const d1 = fakeD1(["ci-chat-pr1-db"], () => ({
      status: 500,
      body: { success: false, errors: [{ code: 7500, message: "internal error" }] },
    }));
    await expect(runD1Query(d1.request, baseline, bytes(TRIGGER), helpers())).rejects.toThrow(
      "creating d1_migrations on ci-chat-pr1-db failed: HTTP 500 (7500 internal error)",
    );
    expect(d1.queries).toHaveLength(1);
  });

  it("fails when the database does not exist", async () => {
    const d1 = fakeD1([]);
    await expect(runD1Query(d1.request, schema, bytes(TRIGGER), helpers())).rejects.toThrow(
      "the database ci-chat-pr1-db does not exist, so d1-schema/DB/worker/schema.sql cannot run",
    );
    expect(d1.queries).toEqual([]);
  });
});

describe("migrationQueryBody", () => {
  it("is the file as normalizeForD1Query writes it, then the row that records it", () => {
    expect(migrationQueryBody(TRIGGER, "0002_add_o'clock.sql", helpers())).toBe(
      `-- normalized\n${TRIGGER}\nINSERT INTO "d1_migrations" (name)\nvalues ('0002_add_o''clock.sql');`,
    );
  });

  it("is the file as it is with a schema build that predates normalizeForD1Query", () => {
    expect(migrationQueryBody(TRIGGER, "0001_init.sql", helpers(false))).toBe(
      `${TRIGGER}\nINSERT INTO "d1_migrations" (name)\nvalues ('0001_init.sql');`,
    );
  });
});

const migrations: CiMigrationsStep = {
  worker: "ci-chat-pr1",
  database: "ci-chat-pr1-db",
  binding: "DB",
  tracked: "migrations",
  files: ["10_tags.sql", "0001_init.sql", "9_rooms.sql"].map((name) => ({
    name,
    file: `d1/DB/${name}`,
  })),
  shipped: ["0001_init.sql", "9_rooms.sql", "10_tags.sql", "0100_cleanup.sql"],
};

/** The name a migration's query records, from the row at its end. */
const recordedBy = (sql: string): string | null => {
  const row = /\nvalues \('((?:[^']|'')*)'\);$/.exec(sql);
  return row === null ? null : (row[1] as string).replace(/''/g, "'");
};

/**
 * A database whose `d1_migrations` holds `recorded`, and records each
 * migration that does not fail; `fail` gives D1's message for one that does.
 */
function ledgerD1(recorded: string[], fail: (name: string) => string | null = () => null) {
  return fakeD1(["ci-chat-pr1-db"], (sql) => {
    if (sql === LIST_APPLIED_MIGRATIONS_SQL) {
      const results = recorded.map((name, i) => ({ id: i + 1, name, applied_at: "now" }));
      return { status: 200, body: { success: true, result: [{ results, success: true }] } };
    }
    const name = recordedBy(sql);
    const message = name === null ? null : fail(name);
    if (message !== null) {
      return { status: 400, body: { success: false, errors: [{ code: 7500, message }] } };
    }
    if (name !== null) recorded.push(name);
    return { status: 200, body: { success: true, result: [statement, statement, statement] } };
  });
}

/** Each file's SQL, by its path in the work dir. */
const read = (file: string): Uint8Array => bytes(`CREATE TABLE IF NOT EXISTS "${file}" (x);`);

describe("runD1Migrations", () => {
  it("creates and lists d1_migrations, then applies each file it lacks in order, one /query each", async () => {
    const d1 = ledgerD1(["0001_init.sql"]);
    const lines: string[] = [];
    await expect(
      runD1Migrations(d1.request, migrations, read, helpers(), (line) => lines.push(line)),
    ).resolves.toBe(2);
    expect(d1.queries).toEqual(
      [
        CREATE_MIGRATIONS_TABLE_SQL,
        LIST_APPLIED_MIGRATIONS_SQL,
        migrationQueryBody(
          new TextDecoder().decode(read("d1/DB/9_rooms.sql")),
          "9_rooms.sql",
          helpers(),
        ),
        migrationQueryBody(
          new TextDecoder().decode(read("d1/DB/10_tags.sql")),
          "10_tags.sql",
          helpers(),
        ),
      ].map((sql) => ({ path: "/d1/database/uuid-ci-chat-pr1-db/query", body: { sql } })),
    );
    expect(lines).toEqual([
      "ci-chat-pr1-db (DB) records 1 migration(s); applying 2 migrations through /query",
      "applied 9_rooms.sql to ci-chat-pr1-db (DB): 3 statement(s), the last recording it",
      "applied 10_tags.sql to ci-chat-pr1-db (DB): 3 statement(s), the last recording it",
    ]);
  });

  it("sends a file as the manager reads it: UTF-8 without its byte order mark", async () => {
    const d1 = ledgerD1([]);
    const step = { ...migrations, files: [{ name: "0001_init.sql", file: "d1/DB/0001_init.sql" }] };
    const file = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("SELECT 1;")]);
    await runD1Migrations(
      d1.request,
      step,
      () => file,
      helpers(false),
      () => {},
    );
    expect(d1.queries.at(-1)?.body).toEqual({
      sql: `SELECT 1;\nINSERT INTO "d1_migrations" (name)\nvalues ('0001_init.sql');`,
    });
  });

  it("applies nothing when d1_migrations records every file", async () => {
    const d1 = ledgerD1(["0001_init.sql", "9_rooms.sql", "10_tags.sql"]);
    const lines: string[] = [];
    await expect(
      runD1Migrations(d1.request, migrations, read, helpers(), (line) => lines.push(line)),
    ).resolves.toBe(0);
    expect(d1.queries).toHaveLength(2);
    expect(lines).toEqual(["ci-chat-pr1-db (DB) already records all 3 of its migrations"]);
  });

  it("says which recorded names the version does not ship, and leaves them", async () => {
    const d1 = ledgerD1(["0000_legacy.sql", "0001_init.sql", "9_rooms.sql", "10_tags.sql"]);
    const lines: string[] = [];
    await runD1Migrations(d1.request, migrations, read, helpers(), (line) => lines.push(line));
    expect(lines[0]).toBe(
      "d1_migrations of ci-chat-pr1-db (DB) records 1 migration(s) this version does not ship: 0000_legacy.sql",
    );
  });

  it("lists again and tries once more after a failure, then fails with D1's message", async () => {
    const d1 = ledgerD1([], (name) => (name === "9_rooms.sql" ? "no such table: users" : null));
    const lines: string[] = [];
    await expect(
      runD1Migrations(d1.request, migrations, read, helpers(), (line) => lines.push(line)),
    ).rejects.toThrow("9_rooms.sql on ci-chat-pr1-db failed: HTTP 400 (7500 no such table: users)");
    // The file before it ran once and stays recorded; nothing after it ran.
    expect(d1.queries.map((q) => recordedBy((q.body as { sql: string }).sql))).toEqual([
      null,
      null,
      "0001_init.sql",
      "9_rooms.sql",
      null,
      null,
      "9_rooms.sql",
    ]);
    expect(lines).toContain(
      "9_rooms.sql on ci-chat-pr1-db failed: HTTP 400 (7500 no such table: users); listing d1_migrations again and retrying once, since the app may have applied it itself",
    );
  });

  it("fails when the database does not exist", async () => {
    const d1 = fakeD1([]);
    await expect(
      runD1Migrations(
        d1.request,
        { ...migrations, tracked: "post-deploy migrations" },
        read,
        helpers(),
        () => {},
      ),
    ).rejects.toThrow(
      "the database ci-chat-pr1-db does not exist, so its post-deploy migrations cannot run",
    );
    expect(d1.queries).toEqual([]);
  });
});

describe("loadD1QueryHelpers", () => {
  const COMPARE =
    "export function compareMigrationNames(a, b) { return a < b ? -1 : a > b ? 1 : 0; }";
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "appflare-d1-query-test-"));
    for (const file of Object.values(appflarePaths(dir))) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "");
    }
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns both functions of a build that has them", async () => {
    writeFileSync(
      appflarePaths(dir).schemaDist,
      [
        "export function normalizeForD1Query(sql) { return 'n:' + sql; }",
        "export function endsInsideStatement(sql) { return !sql.endsWith(';'); }",
        COMPARE,
      ].join("\n"),
    );
    const loaded = await loadD1QueryHelpers(dir);
    expect(loaded.normalizeForD1Query?.("SELECT 1;")).toBe("n:SELECT 1;");
    expect(loaded.endsInsideStatement("SELECT 1")).toBe(true);
    expect(loaded.compareMigrationNames("b", "a")).toBe(1);
  });

  it("has no normalizer with a build that predates it, so the SQL goes as it is", async () => {
    writeFileSync(
      appflarePaths(dir).schemaDist,
      `export function endsInsideStatement(sql) { return !sql.endsWith(';'); }\n${COMPARE}\n`,
    );
    const loaded = await loadD1QueryHelpers(dir);
    expect(loaded.normalizeForD1Query).toBeNull();
    expect(d1QueryBody(schema, TRIGGER, loaded)).toBe(TRIGGER);
  });

  it("names endsInsideStatement when a build lacks it", async () => {
    writeFileSync(
      appflarePaths(dir).schemaDist,
      `export const endsInsideStatement = 1;\n${COMPARE}\n`,
    );
    await expect(loadD1QueryHelpers(dir)).rejects.toThrow(
      /does not export endsInsideStatement\(\); build a newer appflare checkout/,
    );
  });

  it("names compareMigrationNames when a build lacks it", async () => {
    writeFileSync(
      appflarePaths(dir).schemaDist,
      "export function endsInsideStatement(sql) { return !sql.endsWith(';'); }\n",
    );
    await expect(loadD1QueryHelpers(dir)).rejects.toThrow(
      /does not export compareMigrationNames\(\); build a newer appflare checkout/,
    );
  });
});

describe.skipIf(!appflareAvailable)("D1 query bodies with the built @appflare/schema", () => {
  it("writes a CASE ... END; inside a trigger so /query reads the trigger whole, when it can", async () => {
    const loaded = await loadD1QueryHelpers(appflareDir);
    expect(d1QueryBody(schema, TRIGGER, loaded)).toBe(
      loaded.normalizeForD1Query === null ? TRIGGER : TRIGGER.replace("  END;", "  END ;"),
    );
    expect(d1QueryBody({ ...baseline, recorded: ["0001_init.sql"] }, "SELECT 1", loaded)).toBe(
      `SELECT 1\n;\nINSERT OR IGNORE INTO "d1_migrations" (name)\nvalues ('0001_init.sql');`,
    );
    expect(migrationQueryBody(TRIGGER, "0001_init.sql", loaded)).toBe(
      `${d1QueryBody(schema, TRIGGER, loaded)}\nINSERT INTO "d1_migrations" (name)\nvalues ('0001_init.sql');`,
    );
  });

  it("orders migrations as wrangler does, by leading number first", async () => {
    const loaded = await loadD1QueryHelpers(appflareDir);
    expect(
      ["10_a.sql", "9_b.sql", "0001_c/migration.sql"].sort(loaded.compareMigrationNames),
    ).toEqual(["0001_c/migration.sql", "9_b.sql", "10_a.sql"]);
  });
});
