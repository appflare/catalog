import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadAppflareSchema } from "./lib/appflare-schema.ts";
import { findApp, loadManifest } from "./lib/apps.ts";
import { info, runMain } from "./lib/cli.ts";
import { parsePlan } from "./lib/manifest-plan.ts";
import { appsDir, resolveAppflareDir } from "./lib/paths.ts";
import { signRevisions } from "./lib/revision.ts";

const USAGE = `Usage: node scripts/sign-revisions.ts --plan <plan.json> --out <signatures.json>
         --sign-key-env <VAR> --key-id <id>

Signs the revised catalog manifest of every revision in the publish plan's
"revisions": the bytes build-site publishes at apps/<slug>/manifest.json, which
must still have the planned revision and sha256. The key id must be the one the
revised release was signed with. Each signature is checked against the keys
embedded in @appflare/schema before it is written. Runs no app code; needs
APPFLARE_DIR (the packer bundle) and the base64 PKCS#8 Ed25519 key in <VAR>.
Writes { "<slug>": { sha256, keyId, signature } } for build-index
--revision-signatures.
`;

runMain(async () => {
  const { values } = parseArgs({
    options: {
      plan: { type: "string" },
      out: { type: "string" },
      "sign-key-env": { type: "string" },
      "key-id": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || !values.plan || !values.out || !values["sign-key-env"] || !values["key-id"]) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 1;
  }
  const keyBase64 = process.env[values["sign-key-env"]]?.trim();
  if (!keyBase64) {
    throw new Error(`${values["sign-key-env"]} is not set`);
  }
  const plan = parsePlan(JSON.parse(readFileSync(path.resolve(values.plan), "utf8")));
  const schema = await loadAppflareSchema(resolveAppflareDir());
  const signatures = await signRevisions(
    plan.revisions ?? {},
    (slug) => loadManifest(findApp(appsDir, slug), schema.catalogManifest),
    {
      keyBase64,
      keyId: values["key-id"],
      verifySignature: schema.verifySignature,
      keys: schema.signingKeys,
    },
  );
  writeFileSync(path.resolve(values.out), `${JSON.stringify(signatures, null, 2)}\n`);
  info(
    `signed ${Object.keys(signatures).length} revised catalog manifest(s): ${
      Object.keys(signatures).join(", ") || "none"
    }`,
  );
  return 0;
});
