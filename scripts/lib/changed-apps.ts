/**
 * Which apps a push or pull request changed: the slugs of `apps/<slug>/appflare.jsonc`
 * files among the changed paths that still exist (a deleted app is not packed).
 */
export function slugsFromChangedPaths(
  changedPaths: readonly string[],
  exists: (slug: string) => boolean,
): string[] {
  const slugs = new Set<string>();
  for (const p of changedPaths) {
    const match = /^apps\/([^/]+)\/appflare\.jsonc$/.exec(p.trim());
    if (match?.[1] && exists(match[1])) {
      slugs.add(match[1]);
    }
  }
  return [...slugs].sort();
}

/** True for a base SHA that cannot be diffed against (new branch or first push). */
export function isNullSha(sha: string | undefined): boolean {
  return !sha || /^0+$/.test(sha);
}

/**
 * The `install.tier` a raw (unvalidated) manifest declares. A missing or
 * malformed tier counts as `artifact`, so the entry gets the full checks and
 * its validate step reports the problem.
 */
export function declaredTier(raw: unknown): string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return "artifact";
  }
  const install = (raw as { install?: unknown }).install;
  const tier =
    typeof install === "object" && install !== null
      ? (install as { tier?: unknown }).tier
      : undefined;
  return tier === "sandbox" || tier === "self-deploying" ? tier : "artifact";
}

/** The slugs whose tier is one of `tiers`, in their original order. */
export function filterByTier(
  slugs: readonly string[],
  tierOf: (slug: string) => string,
  tiers: readonly string[],
): string[] {
  return slugs.filter((slug) => tiers.includes(tierOf(slug)));
}
