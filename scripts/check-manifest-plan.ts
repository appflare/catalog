import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { info, runMain } from "./lib/cli.ts";
import { checkArtifactRoot, parsePlan } from "./lib/manifest-plan.ts";

const USAGE = `Usage: node scripts/check-manifest-plan.ts --plan <plan.json> --root <dir>
         [--slug <slug>] [--prefix <prefix>] (--unsigned | --signed)

Checks artifacts against the publish plan written by \`publish-plan --out\`:
<root> must hold exactly one <prefix><slug>/ per slug (the one --slug, or every
planned app) and nothing else; each must hold exactly <slug>-<version>.zip,
manifest.json, and with --signed manifest.sig; and each manifest.json's app,
version, source, keyId, and catalog must equal the plan. Prints every
difference and exits 1 on any. Needs no dependencies (plain node).
`;

runMain(() => {
  const { values } = parseArgs({
    options: {
      plan: { type: "string" },
      root: { type: "string" },
      slug: { type: "string" },
      prefix: { type: "string", default: "" },
      signed: { type: "boolean" },
      unsigned: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!values.plan || !values.root || values.signed === values.unsigned) {
    process.stderr.write(
      `error: --plan, --root, and one of --signed/--unsigned are required\n\n${USAGE}`,
    );
    return 1;
  }
  const plan = parsePlan(JSON.parse(readFileSync(values.plan, "utf8")));
  const slugs = values.slug ? [values.slug] : Object.keys(plan.apps).sort();
  const problems = checkArtifactRoot({
    root: values.root,
    plan,
    slugs,
    prefix: values.prefix ?? "",
    signed: values.signed === true,
  });
  if (problems.length > 0) {
    throw new Error(
      `artifacts do not match the publish plan:\n${problems.map((p) => `- ${p}`).join("\n")}`,
    );
  }
  info(`${slugs.join(", ")}: match the publish plan (${values.signed ? "signed" : "unsigned"})`);
  return 0;
});
