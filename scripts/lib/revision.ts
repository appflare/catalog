import { createHash, webcrypto } from "node:crypto";
import type { RevisionProblemOf, SigningKey, VerifySignatureOf } from "./appflare-schema.ts";
import { publishedManifestBytes, publishedManifestUrl } from "./sandbox-entry.ts";
import type {
  ArtifactManifest,
  CatalogManifest,
  IndexApp,
  IndexMediaFile,
  RevisionSignature,
} from "./types.ts";

/**
 * Catalog manifest revisions of `artifact` tier entries.
 *
 * A release `<slug>@<version>` is immutable, and its signed `manifest.json`
 * carries the catalog manifest it was built from. An edit of the form or copy
 * only (labels, a `select` var, a secret the app already reads) raises
 * `revision` in `appflare.jsonc` instead of moving `source`. Publishing it
 * builds nothing: the release stays as it is, and:
 *
 * - `publish-plan` plans the revision (slug, version, revision, the sha256 of
 *   the bytes to publish, and the release's key id);
 * - the `sign-revisions` job, which holds the signing key and runs no app
 *   code, signs those exact bytes with the release's key and key id, the same
 *   scheme as `manifest.sig`, and checks the signature against the keys
 *   embedded in `@appflare/schema`;
 * - `build-index` lists the row's `revision` and, above the release's,
 *   `catalogManifest`: the URL, sha256, key id and signature of the revised
 *   manifest (carried over from the previous index while the bytes are the
 *   same);
 * - `build-site` checks the signature again and serves the bytes at
 *   `apps/<slug>/manifest.json`, with the signature at
 *   `apps/<slug>/manifest.json.sig`.
 *
 * Which copy is authoritative: the Worker, and every field a revision may not
 * change, always come from the signed `manifest.json` inside the release. The
 * install and settings forms and the copy come from the revised catalog
 * manifest when the row lists one. A revision may change only form fields and
 * copy (`REVISABLE_CATALOG_FIELDS` in `@appflare/schema`, enforced here by
 * `revisionProblem` and again by the manager), but var defaults and generated
 * secrets do reach the Worker, which is why the file is signed like the
 * release. A manager refuses an unsigned or badly signed revision, and while a
 * release lists one, installing it needs the revised file: when the file is
 * unreachable, installs and updates to that release fail.
 */

/** A catalog manifest's revision; omitted means 1. */
export function revisionOf(manifest: { revision?: number }): number {
  return manifest.revision ?? 1;
}

/** The catalog manifest a release was built from (parsed by the artifact schema). */
export function releasedCatalog(artifact: ArtifactManifest): CatalogManifest {
  return artifact.catalog as CatalogManifest;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The sha256 of the bytes `manifest` is published in as a revised catalog manifest. */
export function revisedManifestDigest(manifest: CatalogManifest): string {
  return sha256(publishedManifestBytes(manifest));
}

/** Where the revised catalog manifest of `manifest` is published, and its digest. */
export function revisedManifestFile(manifest: CatalogManifest, repo: string): IndexMediaFile {
  return {
    url: publishedManifestUrl(repo, manifest.slug),
    sha256: revisedManifestDigest(manifest),
  };
}

/** The signature of each planned revision, by slug, as `sign-revisions` writes it. */
export type RevisionSignatures = Record<string, RevisionSignature & { sha256: string }>;

/** Finds the signature of the revised manifest of `slug` with these bytes, or null. */
export type RevisionSignatureLookup = (slug: string, sha256: string) => RevisionSignature | null;

/**
 * Where a row's signature comes from: the signatures this run made, else the
 * previous index's row when it lists the same bytes (a signature is over the
 * bytes, so it stays valid while they do).
 */
export function revisionSignatureLookup(
  signed: RevisionSignatures,
  previous: readonly IndexApp[],
): RevisionSignatureLookup {
  return (slug, digest) => {
    const fresh = signed[slug];
    if (fresh !== undefined && fresh.sha256 === digest) {
      return { keyId: fresh.keyId, signature: fresh.signature };
    }
    const before = previous.find((row) => row.slug === slug)?.catalogManifest;
    return before !== undefined && before.sha256 === digest
      ? { keyId: before.keyId, signature: before.signature }
      : null;
  };
}

/** Parses the file `sign-revisions` writes. */
export function parseRevisionSignatures(json: unknown): RevisionSignatures {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("revision signatures: expected { <slug>: { sha256, keyId, signature } }");
  }
  for (const [slug, entry] of Object.entries(json)) {
    const e = entry as Partial<RevisionSignatures[string]> | null;
    if (
      typeof e?.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(e.sha256) ||
      typeof e.keyId !== "string" ||
      typeof e.signature !== "string"
    ) {
      throw new Error(`revision signatures: entry "${slug}" is malformed`);
    }
  }
  return json as RevisionSignatures;
}

/**
 * The `revision` and `catalogManifest` of an artifact tier row whose release
 * is `artifact`. Throws when the manifest raises its revision but cannot
 * stand in for the release's copy (it changes something only a new build can
 * change), or when no signature by the release's key id is known for its
 * bytes: managers would refuse the revised manifest either way.
 */
export function rowRevision(
  manifest: CatalogManifest,
  artifact: ArtifactManifest,
  repo: string,
  revisionProblem: RevisionProblemOf,
  signatureFor: RevisionSignatureLookup,
): Pick<IndexApp, "revision" | "catalogManifest"> {
  const revision = revisionOf(manifest);
  if (revision <= revisionOf(releasedCatalog(artifact))) {
    return { revision };
  }
  const what = `apps/${manifest.slug}/appflare.jsonc is revision ${revision} of ${manifest.slug}@${artifact.version}`;
  const problem = revisionProblem(artifact, manifest);
  if (problem !== null) {
    throw new Error(`${what}, but ${problem}`);
  }
  const file = revisedManifestFile(manifest, repo);
  const signature = signatureFor(manifest.slug, file.sha256);
  if (signature === null) {
    throw new Error(
      `${what}, but no signature is known for its bytes (sha256 ${file.sha256}); publish CI signs it in the sign-revisions job`,
    );
  }
  if (signature.keyId !== artifact.keyId) {
    throw new Error(
      `${what}, but it is signed with key "${signature.keyId}", not the release's "${artifact.keyId}"`,
    );
  }
  return { revision, catalogManifest: { ...file, ...signature } };
}

/**
 * The bytes to publish at a row's `catalogManifest.url`, from the entry's
 * current catalog manifest, after checking them against the row: the URL, the
 * sha256, and the signature against `keys` (the keys embedded in
 * `@appflare/schema`, which managers trust). Throws when they differ:
 * `index.json` was built from another version of `appflare.jsonc`, or the
 * signature would not verify, and publishing would make every manager refuse
 * the file. Rebuild the index first.
 */
export async function revisedManifestFor(
  row: Pick<IndexApp, "slug" | "catalogManifest">,
  manifest: CatalogManifest,
  repo: string,
  check: { verifySignature: VerifySignatureOf; keys: readonly SigningKey[] },
): Promise<{ bytes: Buffer; signature: string }> {
  const listed = row.catalogManifest;
  if (listed === undefined) {
    throw new Error(`${row.slug}: the index row lists no revised catalog manifest`);
  }
  const url = publishedManifestUrl(repo, row.slug);
  if (listed.url !== url) {
    throw new Error(`${row.slug}: index.json points at ${listed.url}, the site serves ${url}`);
  }
  const bytes = publishedManifestBytes(manifest);
  const digest = sha256(bytes);
  if (digest !== listed.sha256) {
    throw new Error(
      `${row.slug}: apps/${row.slug}/appflare.jsonc publishes as sha256 ${digest}, but index.json ` +
        `lists ${listed.sha256} for its revised catalog manifest; rebuild index.json from the same manifests`,
    );
  }
  try {
    await check.verifySignature(bytes, listed.signature, listed.keyId, check.keys, {
      signature: "the revised catalog manifest's signature",
      subject: "the revised catalog manifest's",
    });
  } catch (err) {
    throw new Error(
      `${row.slug}: refusing to publish the revised catalog manifest: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { bytes, signature: listed.signature };
}

/** A revision `publish-plan` planned; `sign-revisions` signs exactly these bytes. */
export interface PlannedRevision {
  version: string;
  revision: number;
  /** sha256 of the bytes to sign and publish. */
  sha256: string;
  /** The key id of the release it revises; the signature must use it. */
  keyId: string;
}

/** The signing key, base64 PKCS#8 Ed25519 (never logged or echoed). */
async function importSigningKey(keyBase64: string) {
  try {
    return await webcrypto.subtle.importKey(
      "pkcs8",
      Buffer.from(keyBase64, "base64"),
      { name: "Ed25519" },
      false,
      ["sign"],
    );
  } catch {
    // Deliberately generic: the underlying error could quote key material.
    throw new Error("the signing key is not a valid base64 PKCS#8 Ed25519 private key");
  }
}

/**
 * Signs each planned revision: the current manifest of the slug must publish
 * as exactly the planned bytes (same revision and sha256) and the key id must
 * be the release's; each signature is checked against `keys` before it is
 * returned. Runs no app code.
 */
export async function signRevisions(
  planned: Readonly<Record<string, PlannedRevision>>,
  manifestOf: (slug: string) => CatalogManifest,
  signing: {
    keyBase64: string;
    keyId: string;
    verifySignature: VerifySignatureOf;
    keys: readonly SigningKey[];
  },
): Promise<RevisionSignatures> {
  const key = await importSigningKey(signing.keyBase64);
  const out: RevisionSignatures = {};
  for (const [slug, plan] of Object.entries(planned).sort(([a], [b]) => a.localeCompare(b))) {
    if (plan.keyId !== signing.keyId) {
      throw new Error(
        `${slug}: ${slug}@${plan.version} was released with key "${plan.keyId}", not "${signing.keyId}"`,
      );
    }
    const manifest = manifestOf(slug);
    const bytes = publishedManifestBytes(manifest);
    const digest = sha256(bytes);
    if (revisionOf(manifest) !== plan.revision || digest !== plan.sha256) {
      throw new Error(
        `${slug}: the plan signs revision ${plan.revision} (sha256 ${plan.sha256}), but ` +
          `apps/${slug}/appflare.jsonc is revision ${revisionOf(manifest)} (sha256 ${digest})`,
      );
    }
    const signature = Buffer.from(
      new Uint8Array(await webcrypto.subtle.sign({ name: "Ed25519" }, key, bytes)),
    ).toString("base64");
    await signing.verifySignature(bytes, signature, signing.keyId, signing.keys, {
      signature: `${slug}'s revised catalog manifest signature`,
      subject: `${slug}'s revised catalog manifest`,
    });
    out[slug] = { sha256: digest, keyId: signing.keyId, signature };
  }
  return out;
}
