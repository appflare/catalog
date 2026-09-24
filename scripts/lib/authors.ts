import type { CatalogAuthor, CatalogManifest } from "./types.ts";

/**
 * Who the index lists as an app's authors: the manifest's `authors`, or, when
 * it lists none, the owner of its upstream repository, linked to their GitHub
 * profile. The same rule as `catalogAuthors()` in `@appflare/schema`, which the
 * manager uses for indexes published before authors existed; a test checks the
 * two agree whenever a built appflare checkout is available.
 *
 * Authors are read from the current manifest every time the index is built,
 * never from a release, so an edit to `authors` alone needs no new release
 * (see `INDEX_ONLY_FIELDS` in `publish-plan.ts`).
 */
export function indexAuthors(manifest: Pick<CatalogManifest, "authors" | "repo">): CatalogAuthor[] {
  if (manifest.authors !== undefined) {
    return manifest.authors.map((author) => ({ ...author }));
  }
  const owner = manifest.repo.split("/")[0] ?? "";
  if (owner === "") {
    return [];
  }
  return GITHUB_LOGIN.test(owner) ? [{ name: owner, github: owner }] : [{ name: owner }];
}

/** A GitHub login: letters, digits, and single hyphens between them, at most 39 characters. */
const GITHUB_LOGIN = /^(?=.{1,39}$)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
