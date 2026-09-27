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

/**
 * `CatalogEntryWorker`, in full: one Worker of an entry that installs as
 * several. The primary one runs under the install's Worker name, every other
 * one as `<install Worker name>-<name>`.
 */
export interface CatalogEntryWorker {
  name: string;
  wranglerConfig: string;
  buildCommand?: string | string[];
  primary?: true;
  /** False for a Worker only the entry's other Workers reach: kept off workers.dev. */
  workersDev?: boolean;
}

/** Subset of `CatalogManifest`. */
export interface CatalogManifest {
  $schema?: string;
  slug: string;
  name: string;
  summary: string;
  /** One plain line for catalog tiles; managers shorten `summary` when it is omitted. */
  tagline?: string;
  homepage: string;
  repo: string;
  /** Any text; `licenseWarning` in `@appflare/schema` says when it is not an SPDX expression. */
  license: string;
  /** One short line shown next to the license. */
  licenseNote?: string;
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
    /**
     * The command, or the commands in order, the packer runs after installing
     * dependencies, before bundling.
     */
    buildCommand?: string | string[];
    /** How a run in the sandbox Worker is sized (`sandbox` and `self-deploying` tiers). */
    sandbox?: { expectedMinutes?: number; instanceType?: SandboxInstanceType };
    /** How the sandbox Worker runs the app's own installer (`self-deploying` tier only). */
    selfDeploying?: CatalogSelfDeploying;
    /** The Workers of an app that installs as several (artifact tier only). */
    workers?: CatalogEntryWorker[];
    /** Toolchains beyond Node.js the build needs; catalog CI installs them (artifact tier only). */
    toolchains?: "rust"[];
  };
  plan: Plan;
  requires: string[];
  /**
   * The install form: secrets and vars, as the schema parses them. On an entry
   * with `install.workers`, `workers` names the Workers that get the value.
   */
  secrets: (Record<string, unknown> & { workers?: string[] })[];
  vars: (Record<string, unknown> & { workers?: string[] })[];
  /** Permissions of the Cloudflare API token the admin creates for the app itself. */
  tokenPermissions: { name: string; description?: string; scope?: "account" | "zone" | "user" }[];
  /** How the bump bot treats the entry. */
  bump?: { autoMerge: boolean };
  /** Which edit of the entry's form and copy this is for its build; omitted means 1. */
  revision?: number;
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

/** One Worker's section of an artifact manifest (subset of `ArtifactWorker`). */
export type ArtifactWorker = ArtifactManifest["worker"];

/** One Worker's static assets (subset of `ArtifactAssets`). */
export type ArtifactAssets = ArtifactManifest["assets"];

/** `AppWorker`, in full: one Worker of an app, whatever the manifest's format. */
export interface AppWorker {
  /** Its name within the entry (`install.workers[].name`); null for an app of one Worker. */
  name: string | null;
  primary: boolean;
  /**
   * Whether it answers on its workers.dev URL: false only for a Worker other
   * than the primary one whose `install.workers[].workersDev` is false.
   */
  workersDev: boolean;
  worker: ArtifactWorker;
  assets: ArtifactAssets;
}

/** What `appServices` reads of a Worker, or of every Worker of an app together. */
export type WorkerFacts = Pick<
  ArtifactWorker,
  "bindings" | "migrations" | "crons" | "queueConsumers"
>;

/**
 * `ArtifactEntryWorker`: a Worker of an app of several other than the
 * primary one. Its files sit under `workers/<name>/` in the zip.
 */
export interface ArtifactEntryWorker {
  name: string;
  worker: ArtifactWorker;
  assets: ArtifactAssets;
}

/**
 * Subset of `ArtifactManifest`. Format 1 is an app of one Worker. Format 2 is
 * an app of several: `worker` and `assets` are the primary Worker's, and
 * `workers` lists the others in the catalog entry's order. Format 3 is either
 * shape, and carries D1 schema files or post-deploy migrations
 * (`d1Schema`, `d1PostDeploy`), which managers that read only formats 1 and
 * 2 refuse. Format 4 is either shape too, and its catalog manifest keeps a
 * Worker off workers.dev (`install.workers[].workersDev: false`) or seeds a
 * D1 database (`resources.d1[binding].seed`), which managers that read only
 * formats 1 to 3 refuse. Format 5 is either shape too, and carries a D1
 * baseline (`d1Baseline`) or a Worker of static assets only (no modules and
 * no `mainModule`), which managers that read only formats 1 to 4 refuse.
 * Whether an artifact has several Workers is whether it has `workers`,
 * whatever its format.
 */
export interface ArtifactManifest {
  format: 1 | 2 | 3 | 4 | 5;
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
    /**
     * The module the Worker starts from. Omitted, with `modules` empty, for a
     * Worker that serves its static assets only (format 5).
     */
    mainModule?: string;
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
    /**
     * Declarative Durable Object and entrypoint exports, keyed by name, as the
     * wrangler config's `exports` block has them (entries of type
     * `durable-object` or `worker` only). Omitted when there are none.
     */
    exports?: Record<string, { type: string; [key: string]: unknown }>;
    /** The wrangler config's `cache` block. Omitted when unset. */
    cacheOptions?: { enabled: boolean; [key: string]: unknown };
  };
  assets: {
    config: Record<string, unknown>;
    binding: string | null;
    files: (ArtifactFile & { route: string })[];
  };
  /** Every D1 migration of the app, by binding; shared by the Workers that bind it. */
  d1Migrations: Record<string, (ArtifactFile & { name: string })[]>;
  /**
   * SQL files run on every install and update after the migrations, never
   * recorded in `d1_migrations`, by binding, in the catalog manifest's order
   * (`resources.d1[binding].schema`); each is named by its path in the
   * app's repository. Formats 3 and 4; omitted when there are none.
   */
  d1Schema?: Record<string, (ArtifactFile & { name: string })[]>;
  /**
   * Migrations run once the new version serves all traffic, recorded in
   * `d1_migrations` like the others, by binding
   * (`resources.d1[binding].postDeployMigrationsDir`). Formats 3 and 4.
   */
  d1PostDeploy?: Record<string, (ArtifactFile & { name: string })[]>;
  /**
   * One SQL file per binding with the database's whole current schema
   * (`resources.d1[binding].baseline`), run once on a new database before
   * the migrations, which are then recorded in `d1_migrations` without
   * running. Format 5; omitted when there is none.
   */
  d1Baseline?: Record<string, (ArtifactFile & { name: string })[]>;
  /** Formats 2 to 5, for an app of several Workers: every Worker but the primary one. */
  workers?: ArtifactEntryWorker[];
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
  /** The entry's build command for display; a list of commands on one line. */
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
  /** The catalog manifest's `tagline`; omitted when it has none. */
  tagline?: string;
  /**
   * When the entry first appeared in the catalog: the committer time of the
   * commit that added its `appflare.jsonc` (see `added-at.ts`). Omitted when
   * that is unknown.
   */
  addedAt?: string;
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
  /**
   * The catalog manifest's `license`. The schema keeps it optional for
   * indexes published before it existed; `build-index` always writes it.
   */
  license?: string;
  /** The catalog manifest's `licenseNote`; omitted when it has none. */
  licenseNote?: string;
  /**
   * The catalog manifest's revision (see `revision.ts`); omitted means 1. The
   * schema keeps it optional for indexes published before it existed;
   * `build-index` always writes it.
   */
  revision?: number;
  /**
   * An `artifact` tier row whose revision is above its release's: the revised
   * catalog manifest on the Pages site, signed with the release's key, which
   * managers use in place of the release's copy for the forms and copy.
   */
  catalogManifest?: IndexCatalogManifest;
}

/** `IndexCatalogManifest`, in full: a signed revised catalog manifest on the Pages site. */
export interface IndexCatalogManifest extends IndexMediaFile, RevisionSignature {}

/** The signature of a revised catalog manifest: the release's key id and a base64 Ed25519 signature. */
export interface RevisionSignature {
  keyId: string;
  signature: string;
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

/** `SeedPbkdf2Hash`, in full: a PBKDF2-SHA-256 hash of a secret with a fresh random salt. */
export interface SeedPbkdf2Hash {
  from: string;
  method: "pbkdf2-sha256";
  iterations: number;
  saltBytes: number;
  keyBytes: number;
  encoding: "base64url" | "base64" | "hex";
}

/** `SeedBcryptHash`, in full: a `$2b$` hash of a secret; its salt is part of the hash. */
export interface SeedBcryptHash {
  from: string;
  method: "bcrypt";
  cost?: number;
}

export type SeedHash = SeedPbkdf2Hash | SeedBcryptHash;

/** `SeedParam`, in full: one bound value of a seed statement. */
export type SeedParam =
  | { var: string }
  | { secret: string }
  | { hash: string }
  | { salt: string }
  | { value: string };

/** `SeedStatement`, in full: one guarded INSERT and its params, in placeholder order. */
export interface SeedStatement {
  sql: string;
  params: SeedParam[];
}

/**
 * `CatalogD1Seed`, in full: the rows one D1 binding gets once, at install
 * (`resources.d1[binding].seed` of the catalog manifest).
 */
export interface CatalogD1Seed {
  hashes?: Record<string, SeedHash>;
  statements: SeedStatement[];
  beforeSchema?: boolean;
}
