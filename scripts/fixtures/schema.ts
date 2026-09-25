import { type AppflareSchema, loadAppflareSchema, type Parser } from "../lib/appflare-schema.ts";
import { isAppflareBuilt, resolveAppflareDir } from "../lib/paths.ts";

/** Whether a built appflare checkout is available (`APPFLARE_DIR` or `../appflare`). */
export const appflareDir = resolveAppflareDir();
export const appflareAvailable = isAppflareBuilt(appflareDir);

/** Accepts anything unchanged; stands in for zod when no appflare checkout is built. */
function passthrough<T>(): Parser<T> {
  return { safeParse: (input) => ({ success: true, data: input as T }) };
}

/**
 * The real `@appflare/schema` validators when a built checkout is available,
 * otherwise pass-through parsers so the catalog's own logic is still tested.
 */
export async function testSchema(): Promise<AppflareSchema> {
  if (appflareAvailable) {
    return loadAppflareSchema(appflareDir);
  }
  return {
    catalogManifest: passthrough(),
    artifactManifest: passthrough(),
    indexJson: passthrough(),
    featuredItem: passthrough(),
    catalogStats: passthrough(),
    // The value @appflare/schema exports; only used when it is not available.
    maxWorkerModules: 21,
    sandboxDefaults: { expectedMinutes: 10, instanceType: "standard-1" },
    // No stand-in for the real derivation: tests that check services inject
    // their own or run only with the real schema.
    appServices: () => ({ ids: [], keyValueDurableObjects: false }),
    // Accepts every revision: tests that check which revisions are refused
    // run only with the real schema.
    revisionProblem: () => null,
    // No stand-in for signature checks: tests that verify signatures inject
    // their own keys and run only with the real schema.
    verifySignature: async () => {
      throw new Error("no @appflare/schema build to verify signatures with");
    },
    signingKeys: [],
  };
}
