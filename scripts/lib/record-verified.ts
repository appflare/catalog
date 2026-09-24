import { z } from "zod";
import { verifiedDigest } from "./index-builder.ts";
import type { IndexJson } from "./types.ts";

/**
 * Records install checks in the published index: the nightly ones of
 * artifact tier apps, and the ones a maintainer runs for sandbox and
 * self-deploying tier apps (verify-tier.yml). It only patches `lastVerified`
 * into rows that match a passing check by slug, version, and digest (the
 * `build.manifestDigest` of a row with a build block). It never adds, removes, or rebuilds rows, so a failed or missing
 * check can never drop an app from the catalog.
 */

export const verificationsSchema = z.record(
  z.string(),
  z.object({
    version: z.string().min(1),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    at: z.iso.datetime(),
  }),
);
export type Verifications = z.infer<typeof verificationsSchema>;

export interface PatchResult {
  index: IndexJson;
  /** Slugs whose row got a new lastVerified. */
  updated: string[];
  /** Checks with no matching row (the index moved on to another artifact). */
  unmatched: string[];
}

export function patchLastVerified(
  index: IndexJson,
  verified: Verifications,
  now: Date,
): PatchResult {
  const updated: string[] = [];
  const apps = index.apps.map((row) => {
    const check = verified[row.slug];
    if (
      check &&
      check.version === row.version &&
      check.digest === verifiedDigest(row) &&
      check.at !== row.lastVerified
    ) {
      updated.push(row.slug);
      return { ...row, lastVerified: check.at };
    }
    return row;
  });
  const unmatched = Object.entries(verified)
    .filter(
      ([slug, check]) =>
        !index.apps.some(
          (row) =>
            row.slug === slug &&
            row.version === check.version &&
            verifiedDigest(row) === check.digest,
        ),
    )
    .map(([slug]) => slug)
    .sort();
  return {
    // Everything but the rows (featured items, the stats URL) is kept as it was.
    index: {
      ...index,
      generatedAt: updated.length > 0 ? now.toISOString() : index.generatedAt,
      apps,
    },
    updated,
    unmatched,
  };
}
