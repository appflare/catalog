import { describe, expect, it } from "vitest";
import {
  CI_ACCOUNT_PLAN,
  ciAccountPlan,
  PAID_PLAN_SKIP,
  paidPlanSkip,
  skipReport,
} from "./ci-install.ts";

describe("Workers plan in the install check", () => {
  it("reads the CI account's plan, free when it is not set", () => {
    expect(ciAccountPlan(undefined)).toBe("free");
    expect(ciAccountPlan("")).toBe("free");
    expect(ciAccountPlan("  ")).toBe("free");
    expect(ciAccountPlan("free")).toBe("free");
    expect(ciAccountPlan(" paid\n")).toBe("paid");
  });

  it("refuses any other plan rather than guessing", () => {
    expect(() => ciAccountPlan("Paid")).toThrow(
      `${CI_ACCOUNT_PLAN} "Paid" is not "free" or "paid"`,
    );
    expect(() => ciAccountPlan("enterprise")).toThrow(CI_ACCOUNT_PLAN);
  });

  it("skips a paid-plan entry on a free account only", () => {
    expect(paidPlanSkip({ plan: "paid" }, "free")).toBe(PAID_PLAN_SKIP);
    expect(paidPlanSkip({ plan: "paid" }, "paid")).toBeNull();
    expect(paidPlanSkip({ plan: "free" }, "free")).toBeNull();
    expect(paidPlanSkip({ plan: "free" }, "paid")).toBeNull();
    expect(paidPlanSkip({}, "free")).toBeNull();
    expect(paidPlanSkip(null, "free")).toBeNull();
  });

  it("names the app and the reason in the notice, the summary and the step outputs", () => {
    expect(skipReport({ app: "dgit", version: "0.0.8" }, "ci-dgit-pr1", PAID_PLAN_SKIP)).toEqual({
      notice:
        "::notice title=Install check skipped::dgit@0.0.8: skipped: the entry needs Workers Paid and CI_ACCOUNT_PLAN is free",
      summary: [
        "SKIP dgit@0.0.8 as ci-dgit-pr1: skipped: the entry needs Workers Paid and CI_ACCOUNT_PLAN is free",
      ],
      outputs: [
        "skipped=paid-plan",
        "skip-reason=skipped: the entry needs Workers Paid and CI_ACCOUNT_PLAN is free",
      ],
    });
  });
});
