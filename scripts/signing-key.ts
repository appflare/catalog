import { runMain } from "./lib/cli.ts";
import { catalogKey, PUBLIC_KEY_ENV } from "./lib/signing-key.ts";

const USAGE = `Usage: node scripts/signing-key.ts key-id | public-key

Prints what this catalog signs with, read from ${PUBLIC_KEY_ENV} (unset for the
official catalog). Needs no dependencies.

  key-id       the key id recorded in every manifest this catalog signs
  public-key   the catalog's own base64 public key, for appflare-pack verify
               --public-key; an empty line when the catalog signs with the
               official key, which verify finds among its embedded keys
`;

runMain(() => {
  const what = process.argv[2];
  if (what === "key-id") {
    process.stdout.write(`${catalogKey().keyId}\n`);
    return 0;
  }
  if (what === "public-key") {
    process.stdout.write(`${catalogKey().own?.publicKeyBase64 ?? ""}\n`);
    return 0;
  }
  process.stdout.write(USAGE);
  return what === "-h" || what === "--help" ? 0 : 1;
});
