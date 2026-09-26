import type { SigningKey } from "./appflare-schema.ts";

/**
 * The key this catalog signs with, and the keys its own checks trust.
 *
 * The official catalog signs with key id `catalog-2026-09`, whose public key
 * is embedded in `@appflare/schema`, so every check here verifies against those
 * embedded keys, exactly as a manager does. A catalog run from a copy of this
 * repository signs with a key of its own: its repository variable
 * `APPFLARE_PUBLIC_KEY` holds the public key line `appflare-pack keygen`
 * printed (`{"keyId":"...","publicKeyBase64":"..."}`, the line its users paste
 * into Appflare), the workflows pass it on in the environment variable of the
 * same name, and the catalog then signs with that key id and every check
 * trusts that one key and nothing else.
 */

/** Key id of the official catalog's signing key. */
export const OFFICIAL_KEY_ID = "catalog-2026-09";

/** The environment variable (and repository variable) holding a catalog's own public key. */
export const PUBLIC_KEY_ENV = "APPFLARE_PUBLIC_KEY";

/** Key ids: lowercase letters, digits and dashes, as `@appflare/schema` accepts them. */
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface CatalogKey {
  /** The key id recorded in every manifest this catalog signs. */
  keyId: string;
  /** The catalog's own public key, or null to trust the keys embedded in `@appflare/schema`. */
  own: SigningKey | null;
}

/** Reads {@link PUBLIC_KEY_ENV}; throws a message naming the variable when it is malformed. */
export function catalogKey(env: NodeJS.ProcessEnv = process.env): CatalogKey {
  const text = env[PUBLIC_KEY_ENV]?.trim();
  if (!text) {
    return { keyId: OFFICIAL_KEY_ID, own: null };
  }
  const problem = (why: string) =>
    new Error(
      `${PUBLIC_KEY_ENV} ${why}. Set it to the one line appflare-pack keygen printed as the ` +
        'public key: {"keyId":"...","publicKeyBase64":"..."}.',
    );
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw problem("is not JSON");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw problem("must be one key, not a list");
  }
  const { keyId, publicKeyBase64 } = json as Record<string, unknown>;
  if (typeof keyId !== "string" || !KEY_ID_PATTERN.test(keyId) || keyId === "unsigned") {
    throw problem('needs a "keyId" of lowercase letters, digits and dashes, not "unsigned"');
  }
  if (typeof publicKeyBase64 !== "string" || !isRawEd25519Key(publicKeyBase64.trim())) {
    throw problem('needs a "publicKeyBase64" holding the base64 of a 32-byte Ed25519 public key');
  }
  return { keyId, own: { keyId, publicKeyBase64: publicKeyBase64.trim() } };
}

function isRawEd25519Key(base64: string): boolean {
  const bytes = Buffer.from(base64, "base64");
  return bytes.length === 32 && bytes.toString("base64") === base64;
}

/** The keys this catalog's checks verify with: its own key, or the embedded ones. */
export function trustedKeys(
  key: CatalogKey,
  embedded: readonly SigningKey[],
): readonly SigningKey[] {
  return key.own ? [key.own] : embedded;
}
