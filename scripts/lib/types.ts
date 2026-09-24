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
export type SandboxInstanceType = "standard-1" | "standard-2";

/** `CatalogSelfDeploying`, in full. */
export interface CatalogSelfDeploying {
  tool: "alchemy";
  deployCommand: string[];
  destroyCommand: string[];
  stageArg?: string;
  stateStore: "cloudflare";
  /** Worker names with `{{stage}}` for the install's stage; the first serves the app. */
  workers: string[];
}

/** `CatalogAuthor`, in full: a person or organization that wrote the app upstream. */
export interface CatalogAuthor {
  name: string;
  /** An https:// website. */
  url?: string;
  /** A login, without `@`. */
  github?: string;
  /** An X handle, without `@`. */
  x?: string;
}

/** Subset of `CatalogManifest`. */
export interface CatalogManifest {
  $schema?: string;
  slug: string;
  name: string;
  summary: string;
  homepage: string;
  repo: string;
  license: string;
  categories: string[];
  /** Who wrote the app upstream; the index lists the owner of `repo` when omitted. */
  authors?: CatalogAuthor[];
  maintainers: string[];
  source: { ref: string; sha: string };
  install: {
    tier: InstallTier;
    packageManager: string;
    wranglerConfig: string;
    workerName: string;
    /** The app's version when the repository's tags do not describe it (monorepos). */
    version?: string;
    /** One command the packer runs after installing dependencies, before bundling. */
    buildCommand?: string;
    /** How a run in the sandbox Worker is sized (`sandbox` and `self-deploying` tiers). */
    sandbox?: { expectedMinutes?: number; instanceType?: SandboxInstanceType };
    /** How the sandbox Worker runs the app's own installer (`self-deploying` tier only). */
    selfDeploying?: CatalogSelfDeploying;
  };
  plan: Plan;
  requires: string[];
  /** Permissions of the Cloudflare API token the admin creates for the app itself. */
  tokenPermissions: { name: string; description?: string; scope?: "account" | "zone" | "user" }[];
  /** How the bump bot treats the entry. */
  bump?: { autoMerge: boolean };
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

/** A queue as the artifact names it: by its producer binding, or by its upstream name. */
export type QueueRef = { binding: string } | { name: string };

/** `QueueConsumer`: a queue consumer as the packer records it, in wrangler's names and units. */
export interface ArtifactQueueConsumer {
  queue: QueueRef;
  max_batch_size?: number;
  max_batch_timeout?: number;
  max_retries?: number;
  dead_letter_queue?: QueueRef;
  max_concurrency?: number | null;
  retry_delay?: number;
}

/** Subset of `ArtifactManifest`. */
export interface ArtifactManifest {
  format: 1;
  app: string;
  version: string;
  keyId: string;
  source: { repo: string; sha: string; ref: string };
  worker: {
    name: string;
    /**
     * The wrangler config the Worker was built from, relative to the checkout:
     * the manifest's `install.wranglerConfig`, and the config wrangler deploys
     * (another one when the build left a redirect beside it). Omitted by
     * packers that predate it.
     */
    wranglerConfig?: { declared: string; effective: string };
    mainModule: string;
    compatibilityDate: string;
    compatibilityFlags: string[];
    modules: (ArtifactFile & { name: string; type: string })[];
    bindings: ArtifactBinding[];
    migrations: Record<string, unknown>[];
    crons: string[];
    /** Queues the Worker consumes; omitted when there are none. */
    queueConsumers?: ArtifactQueueConsumer[];
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

/** `IndexArtifacts`: release-asset URLs of one app version. */
export interface IndexArtifacts {
  zip: string;
  manifest: string;
  sig: string;
}

/**
 * `IndexBuild`, in full: how a `sandbox` or `self-deploying` tier entry runs
 * in the user's account (its build, or its own installer).
 */
export interface IndexBuild {
  /** The commit the build checks out: the manifest's `source.sha`. */
  pin: string;
  /** URL of the entry's catalog manifest, published as JSON next to `index.json`. */
  manifest: string;
  /** sha256 of the exact bytes at `manifest`. */
  manifestDigest: string;
  buildCommand?: string;
  expectedMinutes?: number;
  instanceType?: SandboxInstanceType;
}

/**
 * `IndexApp`, in full: the catalog builds it. `artifact` tier rows carry
 * `artifacts` and `digest`; `sandbox` and `self-deploying` tier rows carry
 * `build` instead.
 */
export interface IndexApp {
  slug: string;
  name: string;
  summary: string;
  version: string;
  artifacts?: IndexArtifacts;
  digest?: string;
  tier: InstallTier;
  plan: Plan;
  requires: string[];
  lastVerified: string | null;
  /**
   * Who wrote the app (see `indexAuthors`). The schema keeps it optional for
   * indexes published before it existed; this catalog always writes it.
   */
  authors: CatalogAuthor[];
  maintainers: string[];
  build?: IndexBuild;
  /** The entry's images on the Pages site (see `media.ts`); omitted when it has none. */
  media?: IndexMedia;
  /**
   * The Cloudflare services the app uses (see `appServices`). The schema keeps
   * it optional for indexes published before it existed; this catalog always
   * writes it.
   */
  services: string[];
  /** The app declares key-value backed Durable Objects; written only when true. */
  keyValueDurableObjects?: true;
  /** The catalog manifest's `categories`; always written, like `services`. */
  categories: string[];
}

/** `AppServices`, in full: what `appServices` returns. */
export interface AppServices {
  /** Service ids, in the schema's display order. */
  ids: string[];
  keyValueDurableObjects: boolean;
}

/** `IndexMediaFile`, in full: an image on the Pages site, pinned by the sha256 of its bytes. */
export interface IndexMediaFile {
  url: string;
  sha256: string;
}

/** `IndexMedia`, in full. */
export interface IndexMedia {
  icon?: IndexMediaFile;
  cover?: IndexMediaFile;
  screenshots: (IndexMediaFile & { alt: string })[];
}

/** `FeaturedItem`, in full: one item of the sponsored slot (see `featured.ts`). */
export interface FeaturedItem {
  id: string;
  title: string;
  text: string;
  sponsor: { name: string; url?: string };
  image?: IndexMediaFile & { alt: string };
  link?: { url: string; label: string };
  slug?: string;
  startsAt?: string;
  endsAt?: string;
}

/** `IndexJson`, in full. */
export interface IndexJson {
  generatedAt: string;
  apps: IndexApp[];
  /** The sponsored slot; always written, empty while there is no sponsor. */
  featured: FeaturedItem[];
  /** URL of `stats.json` on the Pages site. */
  stats?: string;
}

/** `CatalogAppStats`, in full: one app's numbers in `stats.json`. */
export interface CatalogAppStats {
  stars: { count: number; fetchedAt: string } | null;
  installs: { last30d: number | null; active: number | null; fetchedAt: string } | null;
}

/** `CatalogStatsSource`, in full. */
export interface CatalogStatsSource {
  ok: boolean;
  at: string | null;
}

/** `CatalogStats`, in full: `stats.json`. */
export interface CatalogStats {
  generatedAt: string;
  apps: Record<string, CatalogAppStats>;
  sources: { github: CatalogStatsSource; telemetry: CatalogStatsSource };
}
