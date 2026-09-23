import type { CatalogManifest } from "./types.ts";

/**
 * Catalog rules that depend on an entry's `install.tier`, beyond what the
 * catalog manifest schema checks.
 *
 * A `sandbox` tier entry is built in the user's own account, in a container
 * of the sandbox Worker, which needs Workers Paid. CI packs it once to show
 * that the pinned commit builds, but never installs it. So a sandbox entry:
 *
 * - must set `plan` to `"paid"`, so the catalog shows it as a paid-plan app;
 * - must declare `install.buildCommand`. The entry exists because the app has
 *   to be built, and that command is what the build runs, what the manager
 *   shows next to the cost, and what maintainers read when they look at the
 *   entry. The rule only reads the manifest, never the upstream wrangler config, so validation needs no
 *   network. Declaring the command here and in the wrangler config's
 *   `build.command` would run the build twice, so an app built only by its
 *   wrangler `build.command` does not qualify;
 * - must not set `bump.autoMerge`: a bump would merge itself without any
 *   install check, since CI does not install sandbox entries.
 *
 * `self-deploying` entries have no install check either, so they may not
 * set `bump.autoMerge` either.
 */
export function tierProblems(manifest: CatalogManifest): string[] {
  const { tier } = manifest.install;
  const problems: string[] = [];
  if (tier === "sandbox") {
    if (manifest.plan !== "paid") {
      problems.push(
        '- plan: must be "paid"; a sandbox tier entry is built in a container in the ' +
          "user's account, which needs Workers Paid",
      );
    }
    if (manifest.install.buildCommand === undefined) {
      problems.push(
        "- install.buildCommand: a sandbox tier entry must declare the command that builds " +
          "it; an app whose wrangler config builds it with build.command alone is not a " +
          "sandbox tier entry",
      );
    }
  }
  if (tier !== "artifact" && manifest.bump?.autoMerge === true) {
    problems.push(
      `- bump.autoMerge: not allowed on a ${tier} tier entry; CI does not install it, so a ` +
        "maintainer must merge each bump",
    );
  }
  return problems;
}
