import { type AppflareSchema, loadAppflareSchema, type Parser } from "../lib/appflare-schema.ts";
import { isAppflareBuilt, resolveAppflareDir } from "../lib/paths.ts";
import type { CatalogManifest } from "../lib/types.ts";

/** Whether a built appflare checkout is available (`APPFLARE_DIR` or `../appflare`). */
export const appflareDir = resolveAppflareDir();
export const appflareAvailable = isAppflareBuilt(appflareDir);

/** Accepts anything unchanged; stands in for zod when no appflare checkout is built. */
function passthrough<T>(): Parser<T> {
  return { safeParse: (input) => ({ success: true, data: input as T }) };
}

/**
 * Stands in for the catalog manifest schema: accepts anything, and fills in
 * the defaults the catalog scripts read (the tier, the revision, the empty
 * lists and the health check), as the schema's parse would.
 */
function catalogPassthrough(): Parser<CatalogManifest> {
  return {
    safeParse: (input) => {
      const m = input as Partial<CatalogManifest> & {
        install?: Partial<CatalogManifest["install"]>;
      };
      const data = {
        requires: [],
        secrets: [],
        vars: [],
        postInstall: [],
        tokenPermissions: [],
        maintainers: [],
        revision: 1,
        ...m,
        install: {
          tier: "artifact",
          health: { path: "/", mode: "no-server-errors" },
          ...m.install,
        },
      };
      return { success: true, data: data as CatalogManifest };
    },
  };
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
    catalogManifest: catalogPassthrough(),
    artifactManifest: passthrough(),
    indexJson: passthrough(),
    featuredItem: passthrough(),
    catalogStats: passthrough(),
    sandboxDefaults: { expectedMinutes: 10, instanceType: "standard-1" },
    // No stand-in for the real derivation: tests that check services inject
    // their own or run only with the real schema.
    appServices: () => ({ ids: [], keyValueDurableObjects: false }),
    // The primary Worker only: tests of apps of several Workers run only
    // with the real schema.
    appWorkerFacts: (manifest) => manifest.worker,
    // The entry's own `requires` only: tests of the manager features an
    // index row adds run only with the real schema.
    indexRequires: (manifest) => [...manifest.requires],
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
