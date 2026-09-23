import { z } from "zod";
import type { IndexJson } from "./types.ts";

/**
 * Records nightly install checks in the published index. It only patches
 * `lastVerified` into rows that match a passing check by slug, version, and
 * digest. It never adds, removes, or rebuilds rows, so a failed or missing
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
      check.digest === row.digest &&
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
            row.slug === slug && row.version === check.version && row.digest === check.digest,
        ),
    )
    .map(([slug]) => slug)
    .sort();
  return {
    index: {
      generatedAt: updated.length > 0 ? now.toISOString() : index.generatedAt,
      apps,
    },
    updated,
    unmatched,
  };
}
