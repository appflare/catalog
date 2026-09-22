import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { artifactManifestFixture } from "../fixtures/artifact-manifest.ts";
import {
  checkArtifactRoot,
  diffAgainstPlan,
  type PlannedArtifact,
  type PublishPlan,
  parsePlan,
  plannedArtifact,
} from "./manifest-plan.ts";

const PIN = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const KEY_ID = "catalog-2026-09";

/** A manifest as the packer writes it, and the plan entry it should match. */
function fixture(): { manifest: Record<string, unknown>; planned: PlannedArtifact } {
  const manifest = artifactManifestFixture({
    app: "hello",
    version: "1.2.3",
    sha: PIN,
    keyId: KEY_ID,
  });
  const catalog = manifest.catalog as {
    slug: string;
    repo: string;
    source: { sha: string; ref: string };
  };
  return { manifest, planned: plannedArtifact(catalog, "1.2.3", KEY_ID) };
}

describe("diffAgainstPlan", () => {
  it("accepts a manifest that matches the plan", () => {
    const { manifest, planned } = fixture();
    expect(diffAgainstPlan(manifest, planned)).toEqual([]);
  });

  it("reports a changed version", () => {
    const { manifest, planned } = fixture();
    manifest.version = "6.6.6";
    expect(diffAgainstPlan(manifest, planned)).toEqual(['version: planned "1.2.3", got "6.6.6"']);
  });

  it("reports a changed secrets form in the catalog block", () => {
    const { manifest, planned } = fixture();
    (manifest.catalog as Record<string, unknown>).secrets = [
      { name: "EXFIL_URL", label: "Where to send data", generate: false },
    ];
    expect(diffAgainstPlan(manifest, planned)).toEqual([
      'catalog.secrets: planned [], got [{"generate":false,"label":"Where to send data","name":"EXFIL_URL"}]',
    ]);
  });

  it("reports a changed source.sha (in source and in catalog.source)", () => {
    const { manifest, planned } = fixture();
    (manifest.source as Record<string, unknown>).sha = OTHER_SHA;
    (manifest.catalog as { source: Record<string, unknown> }).source.sha = OTHER_SHA;
    expect(diffAgainstPlan(manifest, planned)).toEqual([
      `source.sha: planned "${PIN}", got "${OTHER_SHA}"`,
      `catalog.source: planned {"ref":"v1.2.3","sha":"${PIN}"}, got {"ref":"v1.2.3","sha":"${OTHER_SHA}"}`,
    ]);
  });

  it("reports a changed keyId and a missing field", () => {
    const { manifest, planned } = fixture();
    manifest.keyId = "unsigned";
    delete manifest.app;
    expect(diffAgainstPlan(manifest, planned)).toEqual([
      'app: planned "hello", got (missing)',
      `keyId: planned "${KEY_ID}", got "unsigned"`,
    ]);
  });
});

describe("parsePlan", () => {
  it("round-trips a plan and rejects malformed entries", () => {
    const { planned } = fixture();
    const plan: PublishPlan = { format: 1, apps: { hello: planned } };
    expect(parsePlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect(() => parsePlan({ format: 1, apps: { other: planned } })).toThrow(
      /"other" is malformed/,
    );
    expect(() => parsePlan({ apps: {} })).toThrow(/format: 1/);
  });
});

describe("checkArtifactRoot", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "catalog-plan-test-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeArtifact(dir: string, manifest: unknown, files: string[]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
    for (const f of files) {
      writeFileSync(path.join(dir, f), "x");
    }
  }

  it("accepts exactly the planned artifact directories and files", () => {
    const { manifest, planned } = fixture();
    const plan: PublishPlan = { format: 1, apps: { hello: planned } };
    writeArtifact(path.join(root, "signed-hello"), manifest, ["hello-1.2.3.zip", "manifest.sig"]);
    expect(
      checkArtifactRoot({ root, plan, slugs: ["hello"], prefix: "signed-", signed: true }),
    ).toEqual([]);
  });

  it("rejects extra directories, extra files, missing signatures, and unplanned slugs", () => {
    const { manifest, planned } = fixture();
    const plan: PublishPlan = { format: 1, apps: { hello: planned } };
    writeArtifact(path.join(root, "hello"), manifest, ["hello-1.2.3.zip", "worker.js"]);
    mkdirSync(path.join(root, "sneaky"));
    const problems = checkArtifactRoot({
      root,
      plan,
      slugs: ["hello", "nope"],
      prefix: "",
      signed: true,
    });
    expect(problems).toEqual([
      `${root}: unexpected entry "sneaky"`,
      `${path.join(root, "hello")}: unexpected entry "worker.js"`,
      `${path.join(root, "hello")}: missing "manifest.sig"`,
      '"nope" is not in the publish plan',
    ]);
  });

  it("rejects a signature on an artifact that must still be unsigned", () => {
    const { manifest, planned } = fixture();
    const plan: PublishPlan = { format: 1, apps: { hello: planned } };
    writeArtifact(path.join(root, "hello"), manifest, ["hello-1.2.3.zip", "manifest.sig"]);
    expect(checkArtifactRoot({ root, plan, slugs: ["hello"], prefix: "", signed: false })).toEqual([
      `${path.join(root, "hello")}: unexpected entry "manifest.sig"`,
    ]);
  });
});
