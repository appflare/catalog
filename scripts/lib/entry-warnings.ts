import type { LicenseWarningOf } from "./appflare-schema.ts";
import type { CatalogManifest } from "./types.ts";

/**
 * What `pnpm validate` warns about in an entry that is otherwise valid: for
 * now, a `license` managers cannot place (not an SPDX expression, `NONE` or
 * `SEE LICENSE IN <file>`). The entry is still listed and shows the text as
 * it is written; the warning asks for the form managers can badge.
 */
export function entryWarnings(
  manifest: Pick<CatalogManifest, "license">,
  licenseWarning: LicenseWarningOf,
): string[] {
  const license = licenseWarning(manifest.license);
  return license === null ? [] : [license];
}
