import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { catalogRepo, info, runMain } from "./lib/cli.ts";
import {
  addedApps,
  belowMinimum,
  countStars,
  MIN_STARS,
  type PullFile,
  rejectionComment,
  starsRepo,
} from "./lib/min-stars.ts";

const USAGE = `Usage: node scripts/check-stars.ts --pr <number> --head <sha> --comment <file>

Checks that every app a pull request adds has at least ${MIN_STARS} GitHub stars on
its upstream repository (upstreamRepo, else repo). Reads the pull request's
files and new manifests through the GitHub API and never checks them out.

Prints "rejected=true" or "rejected=false" for $GITHUB_OUTPUT; when true, writes
the comment to leave on the pull request to <file>. Fails when a new manifest
names no repository GitHub can find.

Environment:
  GITHUB_TOKEN   token for the GitHub API (the workflow token)
`;

const API = "https://api.github.com";

async function get(url: string, token: string, accept: string): Promise<Response> {
  const response = await fetch(url, {
    headers: {
      accept,
      authorization: `Bearer ${token}`,
      "user-agent": "appflare-catalog-min-stars",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GET ${url} answered HTTP ${response.status}`);
  }
  return response;
}

/** Every file of the pull request (GitHub lists at most 3,000). */
async function pullFiles(repo: string, pr: number, token: string): Promise<PullFile[]> {
  const files: PullFile[] = [];
  for (let page = 1; page <= 30; page++) {
    const url = `${API}/repos/${repo}/pulls/${pr}/files?per_page=100&page=${page}`;
    const batch = (await (
      await get(url, token, "application/vnd.github+json")
    ).json()) as PullFile[];
    files.push(...batch);
    if (batch.length < 100) break;
  }
  return files;
}

runMain(async () => {
  const { values } = parseArgs({
    options: {
      pr: { type: "string" },
      head: { type: "string" },
      comment: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const pr = Number(values.pr);
  if (
    !Number.isInteger(pr) ||
    pr < 1 ||
    !/^[0-9a-f]{40}$/.test(values.head ?? "") ||
    !values.comment
  ) {
    process.stderr.write(`error: expected --pr, --head and --comment\n\n${USAGE}`);
    return 1;
  }
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  const repo = catalogRepo();

  const added = addedApps(await pullFiles(repo, pr, token));
  if (added.length === 0) {
    info("the pull request adds no app");
    process.stdout.write("rejected=false\n");
    return 0;
  }
  const apps = [];
  for (const app of added) {
    const url = `${API}/repos/${repo}/contents/${app.path}?ref=${values.head}`;
    const text = await (await get(url, token, "application/vnd.github.raw")).text();
    apps.push({ slug: app.slug, repo: starsRepo(text) });
  }
  const results = await countStars(apps, token, fetch);
  for (const r of results) info(`${r.slug}: ${r.repo} has ${r.stars ?? "?"} star(s)`);
  const missing = results.filter((r) => r.stars === null);
  if (missing.length > 0) {
    throw new Error(`GitHub cannot find ${missing.map((r) => `${r.slug} (${r.repo})`).join(", ")}`);
  }
  const below = belowMinimum(results);
  if (below.length > 0) {
    writeFileSync(path.resolve(values.comment), `${rejectionComment(below, repo)}\n`);
  }
  info(
    below.length > 0
      ? `under ${MIN_STARS} stars: ${below.map((r) => r.slug).join(", ")}`
      : `every new app has at least ${MIN_STARS} stars`,
  );
  process.stdout.write(`rejected=${below.length > 0}\n`);
  return 0;
});
