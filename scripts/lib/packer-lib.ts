import { pathToFileURL } from "node:url";
import { appflarePaths, assertAppflareBuilt } from "./paths.ts";

/**
 * Functions the catalog scripts take from the packer build in APPFLARE_DIR
 * (`@appflare/pack`'s `dist/index.js`), so they compute what the packer and
 * the manager compute rather than a copy that could drift.
 */

/** A Worker's size, as wrangler measures it: every module's bytes, and those gzipped. */
export interface WorkerSize {
  size: number;
  gzipSize: number;
}

/** The slice of `@appflare/pack` that measures a packed Worker. */
export interface PackerWorkerSize {
  /** The size of the Worker in an artifact zip, read from each module's byte range. */
  artifactWorkerSize(
    zipPath: string,
    modules: ReadonlyArray<{ offset: number; size: number }>,
  ): WorkerSize;
  /** One line on the size and module count against Cloudflare's and the manager's limits. */
  workerSizeLine(size: WorkerSize, moduleCount: number, maxModules?: number): string;
}

/** The slice of `@appflare/pack` that computes a derived secret as the manager does. */
export interface PackerSecrets {
  deriveSecretValue(method: string, value: string): string;
}

async function packLib(appflareDir: string, names: readonly string[]): Promise<unknown> {
  assertAppflareBuilt(appflareDir);
  const mod = (await import(pathToFileURL(appflarePaths(appflareDir).packLib).href)) as Record<
    string,
    unknown
  >;
  for (const name of names) {
    if (typeof mod[name] !== "function") {
      throw new Error(
        `@appflare/pack in ${appflareDir} does not export ${name}(); build a newer appflare checkout`,
      );
    }
  }
  return mod;
}

/** `artifactWorkerSize` and `workerSizeLine` from the packer build in `appflareDir`. */
export async function loadPackerWorkerSize(appflareDir: string): Promise<PackerWorkerSize> {
  // Checked by packLib: both are functions with these signatures.
  return (await packLib(appflareDir, ["artifactWorkerSize", "workerSizeLine"])) as PackerWorkerSize;
}

/** `deriveSecretValue` from the packer build in `appflareDir`. */
export async function loadPackerSecrets(appflareDir: string): Promise<PackerSecrets> {
  // Checked by packLib: a function with this signature.
  return (await packLib(appflareDir, ["deriveSecretValue"])) as PackerSecrets;
}
