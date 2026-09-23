import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { findApp, listApps, selectApps } from "./lib/apps.ts";
import {
  applyBump,
  type Bump,
  gateBump,
  planBumps,
  readPin,
  renderBumpBody,
  shortSha,
} from "./lib/bump.ts";
import { createGhBumpHistory } from "./lib/bump-history.ts";
import { catalogRepo, info, runMain, warn } from "./lib/cli.ts";
import { parseJsonc } from "./lib/jsonc.ts";
import { appsDir } from "./lib/paths.ts";
import { createGhUpstream } from "./lib/upstream.ts";

const USAGE = `Usage:
  pnpm -s bump plan [--only <slug,...>] --out <dir>
  pnpm -s bump apply <slug> --ref <ref> --sha <sha>

plan   Resolves each app's upstream with read-only gh api calls (newest stable
       semver tag, else the default branch head) and keeps only moves forward.
       Skips targets already proposed, and branch-tracked apps with a bump pull
       request opened in the last week. Prints { bumps, failed } as JSON (each
       bump with the open pull requests it supersedes, and autoMerge: true when
       its entry sets bump.autoMerge without install.version) and writes the
       pull request body for each bump to <dir>/<slug>.md.
apply  Sets source.ref and source.sha in apps/<slug>/appflare.jsonc, keeping
       its comments and layout.
`;

runMain(() => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      only: { type: "string" },
      out: { type: "string" },
      ref: { type: "string" },
      sha: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, slug] = positionals;
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 1;
  }

  if (command === "plan") {
    if (!values.out) {
      throw new Error("plan needs --out <dir>");
    }
    const upstream = createGhUpstream();
    const history = createGhBumpHistory(catalogRepo());
    const apps = selectApps(listApps(appsDir), values.only);
    const plan = planBumps(apps, upstream);
    const now = new Date();
    mkdirSync(values.out, { recursive: true });
    const bumps: (Bump & { supersedes: number[] })[] = [];
    for (const bump of plan.bumps) {
      const gate = gateBump(bump, history.existing(bump.slug), now);
      if (gate.action === "skip") {
        plan.skipped.push({ slug: bump.slug, reason: gate.reason });
        continue;
      }
      let changes: { total: number; subjects: string[] } | null = null;
      try {
        changes = upstream.compare(bump.repo, bump.from.sha, bump.to.sha);
      } catch (err) {
        warn(`${bump.slug}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const pin = readPin(findApp(appsDir, bump.slug));
      writeFileSync(path.join(values.out, `${bump.slug}.md`), renderBumpBody(pin, bump, changes));
      bumps.push({ ...bump, supersedes: gate.supersedes });
    }
    const summary = [
      ...bumps.map(
        (b) =>
          `- ${b.slug}: bump ${b.from.ref}@${shortSha(b.from.sha)} to ${b.to.ref}@${shortSha(b.to.sha)}${b.note ? ` (${b.note})` : ""}`,
      ),
      ...plan.skipped.map((s) => `- ${s.slug}: skipped, ${s.reason}`),
      ...plan.failed.map((f) => `- ${f.slug}: **failed**, ${f.error}`),
    ];
    for (const line of summary) {
      info(line.slice(2));
    }
    if (summary.length === 0) {
      info("no apps");
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### Bump check\n\n${summary.join("\n")}\n\n`,
      );
    }
    for (const f of plan.failed) {
      warn(`${f.slug}: could not read upstream: ${f.error}`);
    }
    process.stdout.write(`${JSON.stringify({ bumps, failed: plan.failed })}\n`);
    return 0;
  }

  if (command === "apply") {
    if (!slug || !values.ref || !values.sha || !/^[0-9a-f]{40}$/.test(values.sha)) {
      throw new Error("apply needs <slug>, --ref, and a 40-character --sha");
    }
    const app = findApp(appsDir, slug);
    const updated = applyBump(readFileSync(app.manifestPath, "utf8"), {
      ref: values.ref,
      sha: values.sha,
    });
    const parsed = parseJsonc(updated) as { source?: { ref?: string; sha?: string } };
    if (parsed.source?.ref !== values.ref || parsed.source?.sha !== values.sha) {
      throw new Error(`${app.manifestPath}: the edit did not produce the expected source`);
    }
    writeFileSync(app.manifestPath, updated);
    info(`${slug}: source is now ${values.ref}@${values.sha}`);
    return 0;
  }

  throw new Error(`unknown command "${command}"\n\n${USAGE}`);
});
