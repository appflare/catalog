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
