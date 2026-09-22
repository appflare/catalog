import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { findApp, listApps } from "./lib/apps.ts";
import { isNullSha, slugsFromChangedPaths } from "./lib/changed-apps.ts";
import { runMain, warn } from "./lib/cli.ts";
import { appsDir, catalogRoot } from "./lib/paths.ts";

const USAGE = `Usage: pnpm -s changed-apps (--base <sha> [--head <sha>] | --all)

Prints a JSON array of app slugs whose apps/<slug>/appflare.jsonc changed between
<base> and <head> (default HEAD). With --all, or when <base> is missing or not
in the local history, prints every app.
`;

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
  process.stdout.write(`${JSON.stringify(slugs)}\n`);
  return 0;
});
