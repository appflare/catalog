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
    // The value @appflare/schema exports; only used when it is not available.
    maxWorkerModules: 21,
  };
}
