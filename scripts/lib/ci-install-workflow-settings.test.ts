import { describe, expect, it } from "vitest";
import { artifactManifestFixture } from "../fixtures/artifact-manifest.ts";
import { planCiInstall, workflowSettingsOf } from "./ci-install.ts";
import type { ArtifactManifest, WorkflowSettings } from "./types.ts";

const PIN = "0123456789abcdef0123456789abcdef01234567";

const SETTINGS: WorkflowSettings = {
  limits: { steps: 500 },
  concurrency: { limit: 3 },
  schedules: ["0 3 * * *"],
  default_retention: { success_retention: "3 days", error_retention: 604_800_000 },
};

/** An artifact whose Worker defines the Workflow of JOBS and runs another Worker's through REPORTS. */
function withWorkflows(settings: Record<string, WorkflowSettings> | undefined): ArtifactManifest {
  const m = artifactManifestFixture({ app: "hello", version: "1.2.3", sha: PIN });
  const worker = m.worker as Record<string, unknown>;
  worker.bindings = [
    { type: "workflow", name: "JOBS", workflow_name: "jobs", class_name: "JobWorkflow" },
    {
      type: "workflow",
      name: "REPORTS",
      workflow_name: "reports",
      class_name: "ReportWorkflow",
      script_name: "reporter",
    },
  ];
  if (settings !== undefined) worker.workflowSettings = settings;
  m.catalog = { ...(m.catalog as Record<string, unknown>), plan: "paid" };
  return m as unknown as ArtifactManifest;
}

describe("planCiInstall with Workflow settings", () => {
  it("gives each Workflow the settings the artifact records for its binding", () => {
    const plan = planCiInstall(withWorkflows({ JOBS: SETTINGS }), "ci-hello-pr1");
    expect(plan.config.workflows).toEqual([
      {
        binding: "JOBS",
        name: "ci-hello-pr1-jobs",
        class_name: "JobWorkflow",
        limits: { steps: 500 },
        concurrency: { limit: 3 },
        schedules: ["0 3 * * *"],
        default_retention: { success_retention: "3 days", error_retention: 604_800_000 },
      },
      {
        binding: "REPORTS",
        name: "ci-hello-pr1-reports",
        class_name: "ReportWorkflow",
        script_name: "reporter",
      },
    ]);
  });

  it("writes only the settings that are recorded", () => {
    const plan = planCiInstall(withWorkflows({ JOBS: { concurrency: { limit: 2 } } }), "ci-x");
    expect((plan.config.workflows as unknown[])[0]).toEqual({
      binding: "JOBS",
      name: "ci-x-jobs",
      class_name: "JobWorkflow",
      concurrency: { limit: 2 },
    });
  });

  it("writes the Workflow as before when the artifact records no settings", () => {
    for (const settings of [undefined, {}]) {
      const plan = planCiInstall(withWorkflows(settings), "ci-hello-pr1");
      expect((plan.config.workflows as unknown[])[0]).toEqual({
        binding: "JOBS",
        name: "ci-hello-pr1-jobs",
        class_name: "JobWorkflow",
      });
    }
  });

  it("copies the schedules, so the config never shares them with the manifest", () => {
    const m = withWorkflows({ JOBS: SETTINGS });
    const workflows = planCiInstall(m, "ci-hello-pr1").config.workflows as {
      schedules?: string[];
    }[];
    workflows[0]?.schedules?.push("*/5 * * * *");
    expect(m.worker.workflowSettings?.JOBS?.schedules).toEqual(["0 3 * * *"]);
  });
});

describe("workflowSettingsOf", () => {
  it("reads a binding's own settings only, never an inherited key", () => {
    const worker = { workflowSettings: { JOBS: SETTINGS } };
    expect(workflowSettingsOf(worker, "JOBS")).toEqual(SETTINGS);
    expect(workflowSettingsOf(worker, "OTHER")).toEqual({});
    expect(workflowSettingsOf(worker, "toString")).toEqual({});
    expect(workflowSettingsOf({}, "JOBS")).toEqual({});
  });
});
