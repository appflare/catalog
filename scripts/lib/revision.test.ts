import { webcrypto } from "node:crypto";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { appflareAvailable, testSchema } from "../fixtures/schema.ts";
import type { AppflareSchema, SigningKey } from "./appflare-schema.ts";
import { findApp, loadManifest } from "./apps.ts";
import { sha256Hex } from "./index-builder.ts";
import {
  parseRevisionSignatures,
  revisedManifestFile,
  revisedManifestFor,
  revisionOf,
  revisionSignatureLookup,
  signRevisions,
} from "./revision.ts";
import { publishedManifestBytes } from "./sandbox-entry.ts";
import type { CatalogManifest, IndexApp } from "./types.ts";

const fixtureApps = path.join(import.meta.dirname, "..", "fixtures", "apps");
const REPO = "appflare/catalog";
const KEY_ID = "catalog-test";

let schema: AppflareSchema;
let revised: CatalogManifest;
/** A throwaway signing key and the trusted keys that hold its public half. */
let keyBase64: string;
let keys: SigningKey[];

beforeAll(async () => {
  schema = await testSchema();
  const hello = loadManifest(findApp(fixtureApps, "hello"), schema.catalogManifest);
  revised = { ...hello, summary: "Revised.", revision: 2 };
  const pair = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as webcrypto.CryptoKeyPair;
  keyBase64 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", pair.privateKey)).toString(
    "base64",
  );
  const raw = Buffer.from(await webcrypto.subtle.exportKey("raw", pair.publicKey));
  keys = [{ keyId: KEY_ID, publicKeyBase64: raw.toString("base64") }];
});

const planFor = (manifest: CatalogManifest) => ({
  hello: {
    version: "1.2.3",
    revision: revisionOf(manifest),
    sha256: sha256Hex(publishedManifestBytes(manifest)),
    keyId: KEY_ID,
  },
});

describe("revisionOf", () => {
  it("reads an omitted revision as 1", () => {
    expect(revisionOf({})).toBe(1);
    expect(revisionOf({ revision: 4 })).toBe(4);
  });
});

describe.skipIf(!appflareAvailable)("signing and publishing a revision", () => {
  const signing = () => ({
    keyBase64,
    keyId: KEY_ID,
    verifySignature: schema.verifySignature,
    keys,
  });

  it("signs exactly the planned bytes, and build-site publishes them with the signature", async () => {
    const signed = await signRevisions(planFor(revised), () => revised, signing());
    expect(Object.keys(signed)).toEqual(["hello"]);
    expect(signed.hello?.sha256).toBe(sha256Hex(publishedManifestBytes(revised)));
    const row = {
      slug: "hello",
      catalogManifest: {
        ...revisedManifestFile(revised, REPO),
        keyId: KEY_ID,
        signature: signed.hello?.signature ?? "",
      },
    };
    const published = await revisedManifestFor(row, revised, REPO, {
      verifySignature: schema.verifySignature,
      keys,
    });
    expect(published.bytes).toEqual(publishedManifestBytes(revised));
    expect(published.signature).toBe(signed.hello?.signature);
    // The keys managers trust do not hold this throwaway key.
    await expect(
      revisedManifestFor(row, revised, REPO, {
        verifySignature: schema.verifySignature,
        keys: schema.signingKeys,
      }),
    ).rejects.toThrow(/refusing to publish .*no trusted signing key matches keyId "catalog-test"/);
  });

  it("refuses to sign bytes the plan did not approve, or with another key id", async () => {
    const edited = { ...revised, summary: "Edited after the plan." };
    await expect(signRevisions(planFor(revised), () => edited, signing())).rejects.toThrow(
      /the plan signs revision 2 \(sha256 [0-9a-f]{64}\), but apps\/hello\/appflare\.jsonc is revision 2/,
    );
    await expect(
      signRevisions(planFor(revised), () => revised, { ...signing(), keyId: "other" }),
    ).rejects.toThrow(/was released with key "catalog-test", not "other"/);
    await expect(
      signRevisions(planFor(revised), () => revised, { ...signing(), keyBase64: "bm90IGEga2V5" }),
    ).rejects.toThrow(/not a valid base64 PKCS#8 Ed25519 private key/);
  });

  it("refuses to publish a revision whose signature does not verify", async () => {
    const row = {
      slug: "hello",
      catalogManifest: { ...revisedManifestFile(revised, REPO), keyId: KEY_ID, signature: "AAAA" },
    };
    await expect(
      revisedManifestFor(row, revised, REPO, { verifySignature: schema.verifySignature, keys }),
    ).rejects.toThrow(/signature does not verify/);
  });
});

describe("revisedManifestFor", () => {
  const check = { verifySignature: async () => {}, keys: [] };

  it("refuses a row built from another manifest, another site, or with none", async () => {
    const row = {
      slug: "hello",
      catalogManifest: { ...revisedManifestFile(revised, REPO), keyId: KEY_ID, signature: "x" },
    };
    await expect(
      revisedManifestFor(row, { ...revised, summary: "Other." }, REPO, check),
    ).rejects.toThrow(/publishes as sha256 .* rebuild index\.json/);
    await expect(revisedManifestFor(row, revised, "someone/else", check)).rejects.toThrow(
      /the site serves/,
    );
    await expect(revisedManifestFor({ slug: "hello" }, revised, REPO, check)).rejects.toThrow(
      /lists no revised catalog manifest/,
    );
  });
});

describe("revision signatures", () => {
  it("come from this run's signing, else from the previous row with the same bytes", () => {
    const digest = sha256Hex(publishedManifestBytes(revised));
    const previous = [
      {
        slug: "hello",
        catalogManifest: { url: "u", sha256: digest, keyId: KEY_ID, signature: "old" },
      } as IndexApp,
    ];
    const fresh = { hello: { sha256: digest, keyId: KEY_ID, signature: "new" } };
    expect(revisionSignatureLookup(fresh, previous)("hello", digest)?.signature).toBe("new");
    expect(revisionSignatureLookup({}, previous)("hello", digest)?.signature).toBe("old");
    expect(revisionSignatureLookup({}, previous)("hello", "0".repeat(64))).toBeNull();
    expect(revisionSignatureLookup({}, [])("hello", digest)).toBeNull();
  });

  it("parse the file sign-revisions writes, and refuse a malformed one", () => {
    const ok = { hello: { sha256: "a".repeat(64), keyId: KEY_ID, signature: "c2ln" } };
    expect(parseRevisionSignatures(ok)).toEqual(ok);
    expect(() => parseRevisionSignatures({ hello: { sha256: "x" } })).toThrow(/malformed/);
    expect(() => parseRevisionSignatures([])).toThrow(/expected/);
  });
});
