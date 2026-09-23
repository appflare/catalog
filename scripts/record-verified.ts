import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadAppflareSchema, parseOrThrow } from "./lib/appflare-schema.ts";
import { info, runMain, warn } from "./lib/cli.ts";
import { serializeIndex } from "./lib/index-builder.ts";
import { indexFile, resolveAppflareDir } from "./lib/paths.ts";
import { patchLastVerified, verificationsSchema } from "./lib/record-verified.ts";

const USAGE = `Usage: pnpm record-verified --verified <checks.json> [--index index.json]

Sets lastVerified on the rows of index.json that match a passing install check
({ "<slug>": { version, digest, at } }) by slug, version, and digest. Changes
nothing else: rows are never added, removed, or rebuilt.
`;

runMain(async () => {
  const { values } = parseArgs({
    options: {
      verified: { type: "string" },
      index: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || !values.verified) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 1;
  }
  const indexPath = values.index ? path.resolve(values.index) : indexFile;
  const schema = await loadAppflareSchema(resolveAppflareDir());
  const index = parseOrThrow(
    schema.indexJson,
    JSON.parse(readFileSync(indexPath, "utf8")),
    indexPath,
  );
  const verified = verificationsSchema.parse(JSON.parse(readFileSync(values.verified, "utf8")));
  const result = patchLastVerified(index, verified, new Date());
  for (const slug of result.unmatched) {
    warn(`${slug}: the checked artifact is no longer the one in ${indexPath}; not recorded`);
  }
  const patched = parseOrThrow(schema.indexJson, result.index, "patched index.json");
  writeFileSync(indexPath, serializeIndex(patched));
  info(
    `lastVerified updated for ${result.updated.length} app(s): ${result.updated.join(", ") || "none"}`,
  );
  return 0;
});
