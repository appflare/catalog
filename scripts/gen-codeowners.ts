import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { listApps } from "./lib/apps.ts";
import { info, runMain } from "./lib/cli.ts";
import { readOwnership, renderCodeowners } from "./lib/codeowners.ts";
import { appsDir, codeownersFile } from "./lib/paths.ts";

const USAGE = `Usage: pnpm gen-codeowners [--check]

Writes CODEOWNERS from each apps/<slug>/appflare.jsonc "maintainers".
  --check   do not write; exit 1 if CODEOWNERS is out of date
`;

runMain(() => {
  const { values } = parseArgs({
    options: { check: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const rendered = renderCodeowners(readOwnership(listApps(appsDir)));
  if (values.check) {
    const current = existsSync(codeownersFile) ? readFileSync(codeownersFile, "utf8") : "";
    if (current !== rendered) {
      process.stderr.write("error: CODEOWNERS is out of date; run `pnpm gen-codeowners`\n");
      return 1;
    }
    info("CODEOWNERS is up to date");
    return 0;
  }
  writeFileSync(codeownersFile, rendered);
  info(`wrote ${codeownersFile}`);
  return 0;
});
