import type { CatalogManifest } from "./types.ts";

/** A license id of the author's own naming, anywhere in an SPDX expression. */
const LICENSE_REF = /(?:^|[\s(])(?:DocumentRef-[A-Za-z0-9.-]+:)?LicenseRef-[A-Za-z0-9.-]+/;

/**
 * What the catalog asks of an entry's `license` beyond the schema, one
 * `- field: message` line each. A `LicenseRef-<name>` tells people nothing
 * on its own, so it comes with a `licenseNote` saying what the license
 * allows; managers show the note next to it.
 */
export function licenseProblems(
  manifest: Pick<CatalogManifest, "license" | "licenseNote">,
): string[] {
  if (!LICENSE_REF.test(manifest.license) || manifest.licenseNote !== undefined) return [];
  return [
    `- licenseNote: license ${manifest.license} is not an SPDX id, so add a licenseNote that says what it allows, such as "Source-available: production use restricted; see the license"`,
  ];
}
