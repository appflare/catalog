import { describe, expect, it } from "vitest";
import {
  ANALYTICS_ENGINE_SKIP,
  analyticsEngineSkip,
  analyticsEngineState,
  needsAnalyticsEngine,
  skippedSummaryLines,
} from "./ci-install.ts";

const withDataset = { config: { analytics_engine_datasets: [{ binding: "AE", dataset: "sink" }] } };
const without = { config: { kv_namespaces: [{ binding: "KV" }] } };

function answering(status: number, body: string, contentType: string): typeof fetch {
  return (async () =>
    new Response(body, { status, headers: { "content-type": contentType } })) as typeof fetch;
}

describe("Analytics Engine in the install check", () => {
  it("needs it when any Worker binds a dataset", () => {
    expect(needsAnalyticsEngine([without, withDataset])).toBe(true);
    expect(needsAnalyticsEngine([without])).toBe(false);
    expect(needsAnalyticsEngine([{ config: { analytics_engine_datasets: [] } }])).toBe(false);
  });

  it("reads the state with a SHOW TABLES query", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return new Response('{"meta":[],"data":[],"rows":0}', { status: 200 });
    }) as typeof fetch;
    expect(await analyticsEngineState("tok", "acc", fetchFn)).toBe("enabled");
    expect(seen[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc/analytics_engine/sql",
    );
    expect(seen[0]?.init?.method).toBe("POST");
    expect(seen[0]?.init?.body).toBe("SHOW TABLES");
  });

  it("reads the SQL service's plain-text 403 as not enabled, and nothing else", async () => {
    expect(
      await analyticsEngineState("t", "a", answering(403, "Authorization error", "text/plain")),
    ).toBe("not-enabled");
    const apiRefusal =
      '{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}';
    expect(
      await analyticsEngineState("t", "a", answering(403, apiRefusal, "application/json")),
    ).toBe("unknown");
    expect(await analyticsEngineState("t", "a", answering(500, "oops", "text/plain"))).toBe(
      "unknown",
    );
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await analyticsEngineState("t", "a", offline)).toBe("unknown");
  });

  it("skips a deploy that needs it only when the account has it off", async () => {
    let asked = 0;
    const off = async () => {
      asked++;
      return "not-enabled" as const;
    };
    expect(await analyticsEngineSkip([withDataset], off)).toBe(ANALYTICS_ENGINE_SKIP);
    expect(await analyticsEngineSkip([without], off)).toBeNull();
    // A Worker without a dataset never asks the account.
    expect(asked).toBe(1);
    expect(await analyticsEngineSkip([withDataset], async () => "unknown")).toBeNull();
    expect(await analyticsEngineSkip([withDataset], async () => "enabled")).toBeNull();
  });

  it("reports the skip in the run summary", () => {
    expect(
      skippedSummaryLines({ app: "sink", version: "0.3.0" }, "ci-sink-pr1", ANALYTICS_ENGINE_SKIP),
    ).toEqual(["SKIP sink@0.3.0 as ci-sink-pr1: skipped: Analytics Engine not enabled"]);
  });
});
