import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { D1QueryHelpers } from "./appflare-schema.ts";
import { type CfRequest, type CiMigrationsStep, runD1Migrations } from "./ci-install.ts";

const MIGRATION = "0002_analytics_schema.sql";

/** The migration an app of this kind also applies itself, when a request reaches it. */
const RENAME = `ALTER TABLE clicks RENAME COLUMN channel TO link_mode;
ALTER TABLE clicks ADD COLUMN channel TEXT;`;

const step: CiMigrationsStep = {
  worker: "ci-shrtnr-pr111",
  database: "ci-shrtnr-pr111-db",
  binding: "DB",
  tracked: "migrations",
  files: [{ name: MIGRATION, file: `d1/DB/${MIGRATION}` }],
  shipped: [MIGRATION],
};

const helpers: D1QueryHelpers = {
  normalizeForD1Query: null,
  endsInsideStatement: () => false,
  compareMigrationNames: (a, b) => (a < b ? -1 : a > b ? 1 : 0),
};

/**
 * The D1 API over a database in memory: each query runs as one transaction,
 * as D1 runs it, after `before` has seen its SQL.
 */
function sqliteD1(db: DatabaseSync, before: (sql: string) => void = () => {}): CfRequest {
  return async (method, apiPath, body) => {
    if (method === "GET" && apiPath.startsWith("/d1/database?name=")) {
      return {
        status: 200,
        body: { success: true, result: [{ name: step.database, uuid: "uuid-db" }] },
      };
    }
    const { sql } = body as { sql: string };
    before(sql);
    if (sql.startsWith("SELECT")) {
      const results = db.prepare(sql).all();
      return { status: 200, body: { success: true, result: [{ results, success: true }] } };
    }
    try {
      db.exec(`BEGIN;\n${sql}\nCOMMIT;`);
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      const message = error instanceof Error ? error.message : String(error);
      return { status: 400, body: { success: false, errors: [{ code: 7500, message }] } };
    }
    return { status: 200, body: { success: true, result: [] } };
  };
}

describe("D1 migrations shared with an app's own migration runner", () => {
  it("lists d1_migrations again after the app applies a migration the list still had", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE clicks (channel TEXT);");
      let raced = false;
      // A request lets the app apply the migration once the check has listed it as pending.
      const request = sqliteD1(db, (sql) => {
        if (raced || !sql.includes(`values ('${MIGRATION}')`)) return;
        raced = true;
        db.exec(
          `BEGIN;\n${RENAME}\nINSERT INTO d1_migrations (name) VALUES ('${MIGRATION}');\nCOMMIT;`,
        );
      });
      const lines: string[] = [];
      const applied = await runD1Migrations(
        request,
        step,
        () => new TextEncoder().encode(RENAME),
        helpers,
        (line) => lines.push(line),
      );

      expect(applied).toBe(0);
      expect(lines).toEqual([
        "ci-shrtnr-pr111-db (DB) records 0 migration(s); applying 1 migrations through /query",
        `${MIGRATION} on ci-shrtnr-pr111-db failed: HTTP 400 (7500 error in table clicks after rename: duplicate column name: link_mode); listing d1_migrations again and retrying once, since the app may have applied it itself`,
        "ci-shrtnr-pr111-db (DB) already records all 1 of its migrations",
      ]);
      expect(db.prepare("SELECT name FROM d1_migrations").all()).toEqual([{ name: MIGRATION }]);
      expect(
        db
          .prepare("PRAGMA table_info(clicks)")
          .all()
          .map((column) => column.name),
      ).toEqual(["link_mode", "channel"]);
    } finally {
      db.close();
    }
  });

  it("still fails when the migration fails again after the second list", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const sent: string[] = [];
      const request = sqliteD1(db, (sql) => {
        if (sql.includes("INSERT INTO")) sent.push(sql);
      });
      await expect(
        runD1Migrations(
          request,
          step,
          () => new TextEncoder().encode("INSERT INTO missing VALUES (1);"),
          helpers,
          () => {},
        ),
      ).rejects.toThrow(
        `${MIGRATION} on ci-shrtnr-pr111-db failed: HTTP 400 (7500 no such table: missing)`,
      );
      expect(sent).toHaveLength(2);
      expect(db.prepare("SELECT name FROM d1_migrations").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
