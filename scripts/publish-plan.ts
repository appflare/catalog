import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadAppflareSchema } from "./lib/appflare-schema.ts";
import { listApps, loadManifest, selectApps } from "./lib/apps.ts";
import { catalogRepo, info, runMain } from "./lib/cli.ts";
import { createGhReleaseLookup } from "./lib/github-releases.ts";
import type { PublishPlan } from "./lib/manifest-plan.ts";
import { SIGNING_KEY_ID } from "./lib/pack-env.ts";
import { appsDir, resolveAppflareDir } from "./lib/paths.ts";
import { decide } from "./lib/publish-plan.ts";
import { createVersionResolver, loadPackerVersioning } from "./lib/versions.ts";

const USAGE = `Usage: pnpm -s publish-plan [--out <plan.json>] [--only <slug,...>]

Prints a JSON array of the app slugs publish CI must pack: every artifact tier
app whose current pin packs to a version <v> with no GitHub Release <slug>@<v>
yet. Sandbox and self-deploying entries are never packed or released.
Fails when a release exists for the pin but appflare.jsonc changed since, or
when the release for the tag is a draft, a prerelease, or incomplete.
Needs gh (read-only) and APPFLARE_DIR.

  --out <file>   also write the plan (expected app, version, source, keyId, and
                 catalog per slug) for scripts/check-manifest-plan.ts
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
  const plan: PublishPlan = { format: 1, apps: {} };
  const errors: string[] = [];
  const apps = selectApps(listApps(appsDir), values.only);
  for (const app of apps) {
    const manifest = loadManifest(app, schema.catalogManifest);
    try {
      const decision = decide(
        manifest,
        versions,
        releases,
        schema.artifactManifest,
        SIGNING_KEY_ID,
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
      } else if (decision.action === "skip") {
        info(`${decision.tag}: already released; skipping`);
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
  if (values.out) {
    writeFileSync(path.resolve(values.out), `${JSON.stringify(plan, null, 2)}\n`);
    info(`wrote ${path.resolve(values.out)}`);
  }
  process.stdout.write(`${JSON.stringify(Object.keys(plan.apps).sort())}\n`);
  return 0;
});
