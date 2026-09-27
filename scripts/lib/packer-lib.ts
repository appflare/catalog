import { pathToFileURL } from "node:url";
import { appflarePaths, assertAppflareBuilt } from "./paths.ts";

/**
 * Functions the catalog scripts take from the packer build in APPFLARE_DIR
 * (`@appflare/pack`'s `dist/index.js`), so they compute what the packer and
 * the manager compute rather than a copy that could drift.
 */

/**
 * A Worker's size: every module's bytes and those gzipped, as wrangler
 * measures it, and the Range requests the manager reads the modules with.
 */
export interface WorkerSize {
  size: number;
  gzipSize: number;
  ranges: number;
}

/** The slice of `@appflare/pack` that measures a packed Worker. */
export interface PackerWorkerSize {
  /** The size of the Worker in an artifact zip, read from each module's byte range. */
  artifactWorkerSize(
    zipPath: string,
    modules: ReadonlyArray<{ offset: number; size: number }>,
  ): WorkerSize;
  /** One line on the modules, their ranges, and their size against the manager's upload budget. */
  workerSizeLine(size: WorkerSize, moduleCount: number): string;
}

/**
 * The slice of `@appflare/pack` that computes secret values as the manager
 * does: a derived secret or var, and a new VAPID private key.
 */
export interface PackerSecrets {
  deriveSecretValue(method: string, value: string): string;
  generateVapidPrivateKey(): string;
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

/** `deriveSecretValue` and `generateVapidPrivateKey` from the packer build in `appflareDir`. */
export async function loadPackerSecrets(appflareDir: string): Promise<PackerSecrets> {
  // Checked by packLib: both are functions with these signatures.
  return (await packLib(appflareDir, [
    "deriveSecretValue",
    "generateVapidPrivateKey",
  ])) as PackerSecrets;
}
