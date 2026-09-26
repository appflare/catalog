import { describe, expect, it } from "vitest";
import {
  artifactManifestFixture,
  duoArtifactManifestFixture,
} from "../fixtures/artifact-manifest.ts";
import { packedWorkers, workerSummaryLines } from "./pack-summary.ts";
import type { ArtifactManifest } from "./types.ts";

const PIN = "0123456789abcdef0123456789abcdef01234567";
const sizeLine = (w: ArtifactManifest["worker"]) => `${w.modules.length} module(s) of ${w.name}`;

describe("workerSummaryLines", () => {
  it("keeps the three lines of an app of one Worker", () => {
    const m = artifactManifestFixture({ app: "hello", version: "1.2.3", sha: PIN });
    (m.worker as Record<string, unknown>).wranglerConfig = {
      declared: "wrangler.jsonc",
      effective: "dist/wrangler.json",
    };
    expect(workerSummaryLines(m as unknown as ArtifactManifest, sizeLine)).toEqual([
      "  config:     dist/wrangler.json (redirected from wrangler.jsonc)",
      "  worker:     1 module(s) of hello",
      "  assets:     0",
    ]);
  });

  it("measures every Worker of an app of several on its own, primary first", () => {
    const m = duoArtifactManifestFixture({ sha: PIN }) as unknown as ArtifactManifest;
    expect(packedWorkers(m).map((w) => [w.name, w.primary, w.assetCount])).toEqual([
      ["web", true, 1],
      ["jobs", false, 0],
    ]);
    expect(workerSummaryLines(m, sizeLine)).toEqual([
      "  Worker web (primary):",
      "    worker:   1 module(s) of duo-web",
      "    assets:   1",
      "  Worker jobs:",
      "    worker:   1 module(s) of duo-jobs",
      "    assets:   0",
    ]);
  });
});
