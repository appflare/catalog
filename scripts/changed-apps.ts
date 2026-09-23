import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { findApp, listApps, readManifestFile } from "./lib/apps.ts";
import {
  declaredTier,
  filterByTier,
  isNullSha,
  slugsFromChangedPaths,
} from "./lib/changed-apps.ts";
import { runMain, warn } from "./lib/cli.ts";
import { appsDir, catalogRoot } from "./lib/paths.ts";

const USAGE = `Usage: pnpm -s changed-apps (--base <sha> [--head <sha>] | --all) [--tiers <t,...>]

Prints a JSON array of app slugs whose apps/<slug>/appflare.jsonc changed between
<base> and <head> (default HEAD). With --all, or when <base> is missing or not
in the local history, prints every app.

  --tiers <t,...>  only apps whose install.tier is one of these (artifact,
                   sandbox, self-deploying); a missing or unreadable tier
                   counts as artifact
`;

const TIERS = ["artifact", "sandbox", "self-deploying"];

function tierOf(slug: string): string {
  try {
    return declaredTier(readManifestFile(findApp(appsDir, slug).manifestPath));
  } catch {
    return "artifact";
  }
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: catalogRoot, encoding: "utf8" });
}

function hasCommit(sha: string): boolean {
  try {
    git(["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

runMain(() => {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      head: { type: "string" },
      all: { type: "boolean" },
      tiers: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const all = listApps(appsDir).map((a) => a.slug);
  let slugs: string[];
  if (values.all) {
    slugs = all;
  } else if (isNullSha(values.base) || !hasCommit(values.base as string)) {
    warn(
      `base ${values.base ?? "(none)"} is not in the local history; treating every app as changed`,
    );
    slugs = all;
  } else {
    const head = values.head ?? "HEAD";
    const diff = git(["diff", "--name-only", `${values.base}...${head}`, "--", "apps/"]);
    slugs = slugsFromChangedPaths(diff.split("\n"), (slug) => {
      try {
        findApp(appsDir, slug);
        return true;
      } catch {
        return false;
      }
    });
  }
  if (values.tiers !== undefined) {
    const tiers = values.tiers
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const unknown = tiers.filter((t) => !TIERS.includes(t));
    if (unknown.length > 0) {
      throw new Error(`unknown tier(s): ${unknown.join(", ")}; expected ${TIERS.join(", ")}`);
    }
    slugs = filterByTier(slugs, tierOf, tiers);
  }
  process.stdout.write(`${JSON.stringify(slugs)}\n`);
  return 0;
});
