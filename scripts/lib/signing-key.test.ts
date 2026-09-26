import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { catalogRoot } from "./paths.ts";
import { catalogKey, OFFICIAL_KEY_ID, PUBLIC_KEY_ENV, trustedKeys } from "./signing-key.ts";

const OWN = { keyId: "acme-2026-09", publicKeyBase64: Buffer.alloc(32, 7).toString("base64") };
const EMBEDDED = [
  { keyId: "appflare-2026-09", publicKeyBase64: Buffer.alloc(32, 1).toString("base64") },
  { keyId: OFFICIAL_KEY_ID, publicKeyBase64: Buffer.alloc(32, 1).toString("base64") },
];

describe("catalogKey", () => {
  it("is the official key id and the embedded keys when the variable is unset or empty", () => {
    for (const env of [{}, { [PUBLIC_KEY_ENV]: "" }, { [PUBLIC_KEY_ENV]: "  \n" }]) {
      const key = catalogKey(env);
      expect(key).toEqual({ keyId: "catalog-2026-09", own: null });
      expect(trustedKeys(key, EMBEDDED)).toBe(EMBEDDED);
    }
  });

  it("is the catalog's own key, and only that key, when the variable holds a key line", () => {
    const key = catalogKey({ [PUBLIC_KEY_ENV]: ` ${JSON.stringify(OWN)}\n` });
    expect(key).toEqual({ keyId: OWN.keyId, own: OWN });
    expect(trustedKeys(key, EMBEDDED)).toEqual([OWN]);
  });

  it.each([
    ["not JSON", "acme-2026-09", /is not JSON/],
    ["a list", JSON.stringify([OWN]), /one key, not a list/],
    ["no key id", JSON.stringify({ publicKeyBase64: OWN.publicKeyBase64 }), /"keyId"/],
    ["an unsigned key id", JSON.stringify({ ...OWN, keyId: "unsigned" }), /"keyId"/],
    ["an upper-case key id", JSON.stringify({ ...OWN, keyId: "Acme" }), /"keyId"/],
    ["a short key", JSON.stringify({ ...OWN, publicKeyBase64: "AAAA" }), /32-byte/],
    [
      "a key that is not base64",
      JSON.stringify({ ...OWN, publicKeyBase64: "!".repeat(44) }),
      /32-byte/,
    ],
  ])("refuses %s, naming the variable", (_, value, message) => {
    expect(() => catalogKey({ [PUBLIC_KEY_ENV]: value })).toThrow(message);
    expect(() => catalogKey({ [PUBLIC_KEY_ENV]: value })).toThrow(PUBLIC_KEY_ENV);
  });
});

describe("scripts/signing-key.ts", () => {
  const run = (arg: string, env: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, [path.join(catalogRoot, "scripts", "signing-key.ts"), arg], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...env },
    });

  it("prints the official key id and no public key by default", () => {
    expect(run("key-id", {}).stdout).toBe("catalog-2026-09\n");
    expect(run("public-key", {}).stdout).toBe("\n");
  });

  it("prints the catalog's own key id and public key", () => {
    const env = { [PUBLIC_KEY_ENV]: JSON.stringify(OWN) };
    expect(run("key-id", env).stdout).toBe("acme-2026-09\n");
    expect(run("public-key", env).stdout).toBe(`${OWN.publicKeyBase64}\n`);
  });

  it("fails on a malformed variable", () => {
    const res = run("key-id", { [PUBLIC_KEY_ENV]: "[]" });
    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain(PUBLIC_KEY_ENV);
  });
});
