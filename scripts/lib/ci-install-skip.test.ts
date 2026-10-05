import { describe, expect, it } from "vitest";
import { artifactManifestFixture } from "../fixtures/artifact-manifest.ts";
import {
  analyticsEngineSkip,
  type CiSkip,
  type CiSkipReport,
  HYPERDRIVE_SKIP,
  hyperdriveSkip,
  paidPlanSkip,
  planCiApp,
  skipReport,
} from "./ci-install.ts";
import type { ArtifactManifest } from "./types.ts";

const PIN = "0123456789abcdef0123456789abcdef01234567";
const PASSWORD = "test-db-pass-NEVER-PRINTED";
const POSTGRES_URL = `postgres://ci:${PASSWORD}@db.example.com:6543/appflare_ci`;

/** The feedlog fixture binding Hyperdrive as POSTGRES, declared as a `protocol` database. */
function hyperdriveApp(protocol: "postgres" | "mysql") {
  const m = artifactManifestFixture({ app: "feedlog", version: "0.5.0", sha: PIN });
  (m.worker as Record<string, unknown>).bindings = [{ type: "hyperdrive", name: "POSTGRES" }];
  (m.catalog as Record<string, unknown>).resources = { hyperdrive: { POSTGRES: { protocol } } };
  return planCiApp(m as unknown as ArtifactManifest, "ci-feedlog-nightly");
}

/** What the feedlog fixture's deploy reports for `skip`, which must be one. */
function report(skip: CiSkip | null): CiSkipReport {
  if (skip === null) throw new Error("expected a skip");
  return skipReport({ app: "feedlog", version: "0.5.0" }, "ci-feedlog-nightly", skip);
}

describe("skipped deploys", () => {
  it("sets the step output skipped to a different kind for each reason to skip", async () => {
    const paid = paidPlanSkip({ plan: "paid" }, "free");
    const analytics = await analyticsEngineSkip(
      [{ config: { analytics_engine_datasets: [{ binding: "AE", dataset: "sink" }] } }],
      async () => "not-enabled",
    );
    const noDatabase = hyperdriveSkip(hyperdriveApp("postgres"), undefined);
    const otherProtocol = hyperdriveSkip(hyperdriveApp("mysql"), POSTGRES_URL);
    expect([paid, analytics, noDatabase, otherProtocol].map((s) => report(s).outputs[0])).toEqual([
      "skipped=paid-plan",
      "skipped=analytics-engine",
      "skipped=hyperdrive",
      "skipped=hyperdrive",
    ]);
  });

  it("reports a Hyperdrive app without a test database as skipped, never as passing", () => {
    expect(report(HYPERDRIVE_SKIP)).toEqual({
      notice:
        "::notice title=Install check skipped::feedlog@0.5.0: skipped: Hyperdrive binding and no HYPERDRIVE_TEST_URL",
      summary: [
        "SKIP feedlog@0.5.0 as ci-feedlog-nightly: skipped: Hyperdrive binding and no HYPERDRIVE_TEST_URL",
      ],
      outputs: [
        "skipped=hyperdrive",
        "skip-reason=skipped: Hyperdrive binding and no HYPERDRIVE_TEST_URL",
      ],
    });
  });

  it("gives the reason a test database could not stand in, without the URL", () => {
    const reported = report(hyperdriveSkip(hyperdriveApp("mysql"), POSTGRES_URL));
    expect(reported.outputs).toEqual([
      "skipped=hyperdrive",
      "skip-reason=skipped: HYPERDRIVE_TEST_URL is not a MySQL database",
    ]);
    expect(JSON.stringify(reported)).not.toContain(PASSWORD);
  });

  it("keeps the notice, the summary line and each output on one line", () => {
    const reported = report({ kind: "hyperdrive", reason: "skipped: first\n  second\r\nthird" });
    expect(reported.outputs).toEqual([
      "skipped=hyperdrive",
      "skip-reason=skipped: first second third",
    ]);
    for (const line of [reported.notice, ...reported.summary, ...reported.outputs]) {
      expect(line).not.toMatch(/[\r\n]/);
    }
  });
});
