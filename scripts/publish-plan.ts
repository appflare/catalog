import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadAppflareSchema } from "./lib/appflare-schema.ts";
import { listApps, loadManifest, selectApps } from "./lib/apps.ts";
import { catalogRepo, info, runMain } from "./lib/cli.ts";
import { createGhReleaseLookup } from "./lib/github-releases.ts";
import { previousRows } from "./lib/index-builder.ts";
import type { PublishPlan } from "./lib/manifest-plan.ts";
import { SIGNING_KEY_ID } from "./lib/pack-env.ts";
import { appsDir, indexFile, resolveAppflareDir } from "./lib/paths.ts";
import { decide } from "./lib/publish-plan.ts";
import { createVersionResolver, loadPackerVersioning } from "./lib/versions.ts";

const USAGE = `Usage: pnpm -s publish-plan [--out <plan.json>] [--only <slug,...>]

Prints a JSON array of the app slugs publish CI must pack: every artifact tier
app whose current pin packs to a version <v> with no GitHub Release <slug>@<v>
yet. Sandbox and self-deploying entries are never packed or released.
An app whose release exists but whose appflare.jsonc raises revision above the
release's is a revision: it is never packed (sign-revisions signs the revised
catalog manifest, build-index and build-site publish it), and is reported on
stderr and in the plan's "revisions".
Fails when a release exists for the pin but appflare.jsonc changed since
without a revision that may publish the change, when a revision goes down or
changes after it was published, or when the release for the tag is a draft, a
prerelease, or incomplete. Needs gh (read-only) and APPFLARE_DIR; reads
index.json for the revisions it publishes already.

  --out <file>   also write the plan (expected app, version, source, keyId, and
                 catalog per slug, and each revision's version, revision,
                 sha256 and key id) for check-manifest-plan and sign-revisions
  --only <slugs> consider only these comma-separated apps (an unknown slug is an
                 error); each is still skipped when its release exists
`;

runMain(async () => {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      only: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const appflareDir = resolveAppflareDir();
  const schema = await loadAppflareSchema(appflareDir);
  const versions = createVersionResolver(await loadPackerVersioning(appflareDir));
  const releases = createGhReleaseLookup(catalogRepo());
  const previous = previousRows(existsSync(indexFile) ? readFileSync(indexFile, "utf8") : null);
  const plan: PublishPlan = { format: 1, apps: {} };
  const revisions: NonNullable<PublishPlan["revisions"]> = {};
  const errors: string[] = [];
  const apps = selectApps(listApps(appsDir), values.only);
  for (const app of apps) {
    const manifest = loadManifest(app, schema.catalogManifest);
    try {
      const decision = await decide(
        manifest,
        versions,
        releases,
        schema.artifactManifest,
        SIGNING_KEY_ID,
        {
          previous: previous.find((row) => row.slug === app.slug),
          revisionProblem: schema.revisionProblem,
        },
      );
      if (decision.action === "not-released") {
        info(
          decision.tier === "self-deploying"
            ? `${decision.slug}: self-deploying tier; its installer runs in the user's account, no release`
            : `${decision.slug}: ${decision.tier} tier; built in the user's account, no release`,
        );
      } else if (decision.action === "publish") {
        info(`${decision.tag}: not released yet; publishing`);
        plan.apps[decision.slug] = decision.planned;
      } else if (decision.action === "revise") {
        info(
          `${decision.tag}: revision ${decision.planned.revision} of the released build; nothing ` +
            `to pack, sign-revisions signs the revised catalog manifest (sha256 ${decision.planned.sha256}) ` +
            "and index.json and the Pages site publish it",
        );
        revisions[decision.slug] = decision.planned;
      } else if (decision.action === "skip") {
        info(
          decision.revision === undefined
            ? `${decision.tag}: already released; skipping`
            : `${decision.tag}: already released and published at revision ${decision.revision}; skipping`,
        );
      } else {
        errors.push(`${decision.tag}: ${decision.message}`);
      }
    } catch (err) {
      errors.push(`${app.slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  plan.revisions = revisions;
  if (values.out) {
    writeFileSync(path.resolve(values.out), `${JSON.stringify(plan, null, 2)}\n`);
    info(`wrote ${path.resolve(values.out)}`);
  }
  process.stdout.write(`${JSON.stringify(Object.keys(plan.apps).sort())}\n`);
  return 0;
});
