import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { canonicalize, canonicalJson, changedFields } from "./canonical.ts";

/**
 * The publish plan: for each app publish CI will pack, what its artifact
 * manifest must say. `plan` computes it from the catalog manifests alone (no app
 * code); `sign` and `release` refuse any artifact that deviates from it, so a
 * compromised `pack` job cannot get a different app, version, pin, key id, or
 * catalog manifest (secrets form, vars, postInstall) signed or released.
 *
 * Deliberately dependency-free (node builtins only): the `sign` job runs it with
 * plain `node`, without installing anything.
 */

export interface PlannedArtifact {
  app: string;
  version: string;
  source: { repo: string; sha: string; ref: string };
  keyId: string;
  /** The schema-parsed catalog manifest, key-sorted. */
  catalog: unknown;
}

export interface PublishPlan {
  format: 1;
  apps: Record<string, PlannedArtifact>;
}

/** The fields of an artifact manifest checked against the plan. */
export const PLANNED_FIELDS = ["app", "version", "source", "keyId", "catalog"] as const;

/** A plan entry for a schema-parsed catalog manifest. */
export function plannedArtifact(
  catalog: { slug: string; repo: string; source: { sha: string; ref: string } },
  version: string,
  keyId: string,
): PlannedArtifact {
  return {
    app: catalog.slug,
    version,
    source: { repo: catalog.repo, sha: catalog.source.sha, ref: catalog.source.ref },
    keyId,
    catalog: canonicalize(catalog),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Validates a plan file's shape. */
export function parsePlan(json: unknown): PublishPlan {
  if (!isRecord(json) || json.format !== 1 || !isRecord(json.apps)) {
    throw new Error("publish plan: expected { format: 1, apps: { ... } }");
  }
  for (const [slug, entry] of Object.entries(json.apps)) {
    const e = entry as Partial<PlannedArtifact> | undefined;
    const ok =
      isRecord(e) &&
      e.app === slug &&
      typeof e.version === "string" &&
      typeof e.keyId === "string" &&
      isRecord(e.source) &&
      typeof e.source.repo === "string" &&
      typeof e.source.sha === "string" &&
      typeof e.source.ref === "string" &&
      isRecord(e.catalog);
    if (!ok) {
      throw new Error(`publish plan: entry "${slug}" is malformed`);
    }
  }
  return json as unknown as PublishPlan;
}

function show(value: unknown): string {
  const text = canonicalJson(value);
  return text === undefined ? "(missing)" : text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/** Differences between an artifact `manifest.json` and its plan entry; empty when it matches. */
export function diffAgainstPlan(manifest: unknown, planned: PlannedArtifact): string[] {
  const m = isRecord(manifest) ? manifest : {};
  const diffs: string[] = [];
  for (const field of PLANNED_FIELDS) {
    if (canonicalJson(m[field]) === canonicalJson(planned[field])) {
      continue;
    }
    if (field === "catalog" || field === "source") {
      for (const key of changedFields(m[field], planned[field])) {
        const got = isRecord(m[field]) ? (m[field] as Record<string, unknown>)[key] : undefined;
        const want = (planned[field] as Record<string, unknown>)[key];
        diffs.push(`${field}.${key}: planned ${show(want)}, got ${show(got)}`);
      }
      if (!isRecord(m[field])) {
        diffs.push(`${field}: planned an object, got ${show(m[field])}`);
      }
    } else {
      diffs.push(`${field}: planned ${show(planned[field])}, got ${show(m[field])}`);
    }
  }
  return diffs;
}

/**
 * Checks one artifact directory: exactly `<slug>-<version>.zip`, `manifest.json`,
 * and (`signed`) `manifest.sig`, nothing else, and a manifest matching the plan.
 */
export function checkArtifactDir(dir: string, planned: PlannedArtifact, signed: boolean): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return [`${dir}: missing`];
  }
  const expected = [`${planned.app}-${planned.version}.zip`, "manifest.json"];
  if (signed) {
    expected.push("manifest.sig");
  }
  const present = readdirSync(dir).sort();
  const problems: string[] = [];
  for (const name of present.filter((n) => !expected.includes(n))) {
    problems.push(`${dir}: unexpected entry "${name}"`);
  }
  for (const name of expected.filter((n) => !present.includes(n))) {
    problems.push(`${dir}: missing "${name}"`);
  }
  const manifestPath = path.join(dir, "manifest.json");
  if (present.includes("manifest.json")) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (err) {
      return [...problems, `${manifestPath}: ${err instanceof Error ? err.message : String(err)}`];
    }
    problems.push(...diffAgainstPlan(manifest, planned).map((d) => `${manifestPath}: ${d}`));
  }
  return problems;
}

/**
 * Checks that `root` holds exactly one `<prefix><slug>` directory per slug and
 * nothing else, then checks each with {@link checkArtifactDir}.
 */
export function checkArtifactRoot(options: {
  root: string;
  plan: PublishPlan;
  slugs: readonly string[];
  prefix: string;
  signed: boolean;
}): string[] {
  const { root, plan, slugs, prefix, signed } = options;
  const problems: string[] = [];
  const expected = slugs.map((s) => `${prefix}${s}`);
  const present = existsSync(root) ? readdirSync(root).sort() : [];
  for (const name of present.filter((n) => !expected.includes(n))) {
    problems.push(`${root}: unexpected entry "${name}"`);
  }
  for (const slug of slugs) {
    const planned = plan.apps[slug];
    if (!planned) {
      problems.push(`"${slug}" is not in the publish plan`);
      continue;
    }
    problems.push(...checkArtifactDir(path.join(root, `${prefix}${slug}`), planned, signed));
  }
  return problems;
}
