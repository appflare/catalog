import { copyFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { info, runMain } from "./lib/cli.ts";
import { appflarePaths, assertAppflareBuilt, resolveAppflareDir, schemaFile } from "./lib/paths.ts";

const USAGE = `Usage: pnpm sync-schema [--check]

Copies @appflare/schema's json-schema/v1.json (from APPFLARE_DIR) to schema/v1.json.
  --check   do not write; exit 1 if schema/v1.json differs from the source
`;

runMain(() => {
  const { values } = parseArgs({
    options: { check: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const appflareDir = resolveAppflareDir();
  assertAppflareBuilt(appflareDir);
  const source = appflarePaths(appflareDir).schemaJson;
  if (values.check) {
    const same = readFileSync(source).equals(readFileSync(schemaFile));
    if (!same) {
      process.stderr.write("error: schema/v1.json is out of date; run `pnpm sync-schema`\n");
      return 1;
    }
    info("schema/v1.json matches @appflare/schema");
    return 0;
  }
  copyFileSync(source, schemaFile);
  info(`copied ${source} -> ${schemaFile}`);
  return 0;
});
