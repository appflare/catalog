/**
 * Local views of the `@appflare/schema` types the catalog scripts touch.
 *
 * `@appflare/schema` is loaded at runtime from `APPFLARE_DIR` (it is not an npm
 * dependency yet), so its declarations are not visible to the typechecker. These
 * interfaces are deliberate SUBSETS of the real ones: every value typed with them
 * has been parsed by the real zod schema first (see `appflare-schema.ts`), so
 * the fields listed here are guaranteed present. When the packages are published
 * to npm, import the real types and delete this file.
 */

export type InstallTier = "artifact" | "sandbox" | "self-deploying";
export type Plan = "free" | "paid";

/** Subset of `CatalogManifest`. */
export interface CatalogManifest {
  $schema?: string;
  slug: string;
  name: string;
  summary: string;
  homepage: string;
  repo: string;
  license: string;
  maintainers: string[];
  source: { ref: string; sha: string };
  install: {
    tier: InstallTier;
    packageManager: string;
    wranglerConfig: string;
    workerName: string;
  };
  plan: Plan;
  requires: string[];
}

/** Subset of `ArtifactManifest`. */
export interface ArtifactManifest {
  format: 1;
  app: string;
  version: string;
  keyId: string;
  source: { repo: string; sha: string; ref: string };
  worker: { modules: unknown[] };
  assets: { files: unknown[] };
  d1Migrations: Record<string, unknown[]>;
  /** The catalog manifest the artifact was packed from, as parsed by the schema. */
  catalog: unknown;
}

/** `IndexApp`, in full: the catalog builds it. */
export interface IndexApp {
  slug: string;
  name: string;
  summary: string;
  version: string;
  artifacts: { zip: string; manifest: string; sig: string };
  digest: string;
  tier: InstallTier;
  plan: Plan;
  requires: string[];
  lastVerified: string | null;
  maintainers: string[];
}

/** `IndexJson`, in full. */
export interface IndexJson {
  generatedAt: string;
  apps: IndexApp[];
}
