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

/** A file stored in the artifact zip, addressed by byte range. */
export interface ArtifactFile {
  path: string;
  size: number;
  sha256: string;
  offset: number;
}

/** A Worker binding as the packer records it: wrangler's shape without account ids. */
export type ArtifactBinding = { type: string; name: string } & Record<string, unknown>;

/** Subset of `ArtifactManifest`. */
export interface ArtifactManifest {
  format: 1;
  app: string;
  version: string;
  keyId: string;
  source: { repo: string; sha: string; ref: string };
  worker: {
    name: string;
    mainModule: string;
    compatibilityDate: string;
    compatibilityFlags: string[];
    modules: (ArtifactFile & { name: string; type: string })[];
    bindings: ArtifactBinding[];
    migrations: Record<string, unknown>[];
    crons: string[];
    observability: Record<string, unknown> | null;
    placement: Record<string, unknown> | null;
    limits: Record<string, unknown> | null;
  };
  assets: {
    config: Record<string, unknown>;
    binding: string | null;
    files: (ArtifactFile & { route: string })[];
  };
  d1Migrations: Record<string, (ArtifactFile & { name: string })[]>;
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
