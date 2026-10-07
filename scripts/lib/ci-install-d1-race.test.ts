import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { type CiWranglerStep, runD1WranglerStep } from "./ci-install.ts";

const step: CiWranglerStep = {
  worker: "ci-shrtnr-pr111",
  config: "wrangler.json",
  args: ["d1", "migrations", "apply", "ci-shrtnr-pr111-db", "--remote"],
};

describe("D1 migrations shared with an app's own migration runner", () => {
  it("rereads the ledger after the Worker applies a migration from the CLI's pending list", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE clicks (channel TEXT);
        CREATE TABLE d1_migrations (name TEXT UNIQUE);
      `);
      const migration = "0002_analytics_schema.sql";
      const apply = () => {
        try {
          db.exec(`
            BEGIN;
            ALTER TABLE clicks RENAME COLUMN channel TO link_mode;
            ALTER TABLE clicks ADD COLUMN channel TEXT;
            INSERT INTO d1_migrations (name) VALUES ('${migration}');
            COMMIT;
          `);
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      };
      const failures: string[] = [];
      let calls = 0;
      const cli = () => {
        calls++;
        const pending = db.prepare("SELECT name FROM d1_migrations WHERE name = ?").get(migration);
        if (pending !== undefined) return;
        // A request lets the app apply it after the CLI has read its ledger.
        if (calls === 1) apply();
        try {
          apply();
        } catch (error) {
          failures.push((error as Error).message);
          throw error;
        }
      };

      runD1WranglerStep(step, cli);

      expect(calls).toBe(2);
      expect(failures).toEqual([
        "error in table clicks after rename: duplicate column name: link_mode",
      ]);
      expect(db.prepare("SELECT name FROM d1_migrations").all()).toEqual([{ name: migration }]);
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

  it("still fails if the migration cannot be applied after rereading the ledger", () => {
    const error = new Error("no such table: missing");
    const cli = vi.fn(() => {
      throw error;
    });
    expect(() => runD1WranglerStep(step, cli)).toThrow(error);
    expect(cli).toHaveBeenCalledTimes(2);
  });

  it("does not retry untracked schema, baseline or seed SQL", () => {
    const error = new Error("SQL failed");
    const cli = vi.fn(() => {
      throw error;
    });
    expect(() =>
      runD1WranglerStep(
        { ...step, args: ["d1", "execute", "db", "--remote", "--file", "schema.sql"] },
        cli,
      ),
    ).toThrow(error);
    expect(cli).toHaveBeenCalledTimes(1);
  });
});
