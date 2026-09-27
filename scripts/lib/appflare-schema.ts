import { pathToFileURL } from "node:url";
import { appflarePaths, assertAppflareBuilt } from "./paths.ts";
import type { SandboxDefaults } from "./sandbox-entry.ts";
import type {
  AppServices,
  AppWorker,
  ArtifactManifest,
  CatalogManifest,
  CatalogStats,
  FeaturedItem,
  IndexJson,
  SandboxInstanceType,
  WorkerFacts,
} from "./types.ts";

/** One validation problem, in the shape zod 4 reports it. */
export interface ParseIssue {
  path: ReadonlyArray<PropertyKey>;
  message: string;
}

export type SafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: { issues: readonly ParseIssue[] } };

/** The slice of a zod schema the catalog uses. */
export interface Parser<T> {
  safeParse(input: unknown): SafeParseResult<T>;
}

/** The `@appflare/schema` validators the catalog scripts need. */
export interface AppflareSchema {
  catalogManifest: Parser<CatalogManifest>;
  artifactManifest: Parser<ArtifactManifest>;
  indexJson: Parser<IndexJson>;
  /** One item of the sponsored slot. */
  featuredItem: Parser<FeaturedItem>;
  /** `stats.json`. */
  catalogStats: Parser<CatalogStats>;
  /** What a sandbox tier entry's `install.sandbox` defaults to. */
  sandboxDefaults: SandboxDefaults;
  /**
   * The Cloudflare services an app uses (`appServices`), from its catalog
   * manifest and, for an artifact tier entry, its artifact's Worker. The
   * manager works them out with the same function when an index row lacks them.
   */
  appServices: AppServicesOf;
  /**
   * What `appServices` reads of an artifact: the bindings, Durable Object
   * migrations, crons and queue consumers of every Worker of the app together
   * (`combinedWorkerFacts`), so an app of several Workers lists what each of
   * them uses.
   */
  appWorkerFacts: WorkerFactsOf;
  /**
   * Why a catalog manifest cannot stand in for the one inside a release as a
   * revision (`revisedArtifactProblem`), or null when it can: its revision is
   * above the release's, and it changes only the fields a revision may change.
   * The manager holds a revised catalog manifest to the same function.
   */
  revisionProblem: RevisionProblemOf;
  /**
   * `verifySignature` from `@appflare/schema`: the Ed25519 check the manager
   * runs on a revised catalog manifest, over the exact bytes with a key id.
   */
  verifySignature: VerifySignatureOf;
  /** The trusted signing keys embedded in `@appflare/schema` (the ones managers trust). */
  signingKeys: readonly SigningKey[];
}

/** A trusted signing key: its id and base64 raw Ed25519 public key. */
export interface SigningKey {
  keyId: string;
  publicKeyBase64: string;
}

/** `verifySignature` from `@appflare/schema`; rejects when the signature does not verify. */
export type VerifySignatureOf = (
  bytes: Uint8Array,
  signatureBase64: string,
  keyId: string,
  keys: readonly SigningKey[],
  labels?: { signature: string; subject: string },
) => Promise<void>;

/** `revisedArtifactProblem` from `@appflare/schema`: the arguments are schema-parsed manifests. */
export type RevisionProblemOf = (
  artifact: Pick<ArtifactManifest, "catalog" | "worker">,
  revised: CatalogManifest,
) => string | null;

/** `appServices` from `@appflare/schema`: the arguments are schema-parsed manifests. */
export type AppServicesOf = (catalog: CatalogManifest, worker: WorkerFacts | null) => AppServices;

/** `combinedWorkerFacts` from `@appflare/schema`: the argument is a schema-parsed manifest. */
export type WorkerFactsOf = (manifest: ArtifactManifest) => WorkerFacts;

/**
 * The `@appflare/schema` functions for apps of several Workers (a catalog
 * entry's `install.workers`, an artifact manifest of format 2), so the
 * install check deploys them as the manager does. Every argument is a
 * schema-parsed manifest.
 */
export interface EntryWorkerHelpers {
  /** Every Worker of the app, each after the Workers it binds to, the primary one as late as it can be. */
  appWorkersInDeployOrder(manifest: ArtifactManifest): AppWorker[];
  /** The manifest as one Worker sees it: its own worker and assets, and the secrets and vars that go to it. */
  workerManifest(manifest: ArtifactManifest, worker: AppWorker): ArtifactManifest;
  /** The Worker name an entry Worker runs under: the install's for the primary, `<install>-<name>` otherwise. */
  entryScriptName(installWorkerName: string, name: string, primary: boolean): string;
  /** The entry Worker `{{workerName:<name>}}` names, or null. */
  entryWorkerRefName(value: unknown): string | null;
  /** `text` with `{{workerUrl:<name>}}` and `{{workerName:<name>}}` filled in. */
  renderEntryWorkerPlaceholders(
    text: string,
    workers: Readonly<Record<string, { workerName: string; workerUrl: string | null }>>,
  ): string;
}

const ENTRY_WORKER_HELPERS = [
  "appWorkersInDeployOrder",
  "workerManifest",
  "entryScriptName",
  "entryWorkerRefName",
  "renderEntryWorkerPlaceholders",
] as const;

/**
 * The functions for apps of several Workers from `@appflare/schema` in
 * `appflareDir`. Loaded apart from {@link loadAppflareSchema}, only for an
 * artifact of several Workers, so every other script keeps working with a
 * build that predates them; throws, naming what is missing, with such a build.
 */
export async function loadEntryWorkerHelpers(appflareDir: string): Promise<EntryWorkerHelpers> {
  assertAppflareBuilt(appflareDir);
  const mod: unknown = await import(pathToFileURL(appflarePaths(appflareDir).schemaDist).href);
  for (const name of ENTRY_WORKER_HELPERS) {
    if (typeof (mod as Record<string, unknown> | null)?.[name] !== "function") {
      throw new Error(
        `@appflare/schema in ${appflareDir} does not export ${name}(); build a newer appflare checkout`,
      );
    }
  }
  // Checked above: each is a function; the signatures are the ones
  // @appflare/schema declares, mirrored by EntryWorkerHelpers.
  return mod as EntryWorkerHelpers;
}

/**
 * `combinedWorkerFacts` when the schema build has it. A build that predates
 * it cannot parse an artifact of several Workers at all, so every manifest
 * it hands over is of one Worker, whose own facts are all the app's; a
 * format 2 manifest here means the parser and this function disagree.
 */
function workerFactsOf(mod: unknown): WorkerFactsOf {
  const value = (mod as Record<string, unknown> | null)?.combinedWorkerFacts;
  // A function; its signature is the one @appflare/schema declares.
  return typeof value === "function" ? (value as WorkerFactsOf) : oneWorkerFacts;
}

/**
 * The facts of an app of one Worker: its Worker's own. Throws for an artifact
 * of several Workers, whose facts only `combinedWorkerFacts` works out.
 */
export const oneWorkerFacts: WorkerFactsOf = (manifest) => {
  if (manifest.format !== 1) {
    throw new Error(
      `${manifest.app}@${manifest.version} has several Workers, and this @appflare/schema build ` +
        "does not export combinedWorkerFacts(); build a newer appflare checkout",
    );
  }
  return manifest.worker;
};

/**
 * Loads `@appflare/schema` from a built appflare checkout
 * (`<appflareDir>/packages/schema/dist/index.js`). It is not an npm dependency
 * yet, so it is imported by file URL; zod resolves from that checkout's own
 * `node_modules`.
 */
export async function loadAppflareSchema(appflareDir: string): Promise<AppflareSchema> {
  assertAppflareBuilt(appflareDir);
  const mod: unknown = await import(pathToFileURL(appflarePaths(appflareDir).schemaDist).href);
  return {
    catalogManifest: pickParser<CatalogManifest>(mod, "catalogManifestSchema"),
    artifactManifest: pickParser<ArtifactManifest>(mod, "artifactManifestSchema"),
    indexJson: pickParser<IndexJson>(mod, "indexJsonSchema"),
    featuredItem: pickParser<FeaturedItem>(mod, "featuredItemSchema"),
    catalogStats: pickParser<CatalogStats>(mod, "catalogStatsSchema"),
    sandboxDefaults: {
      expectedMinutes: pickPositiveInt(mod, "DEFAULT_EXPECTED_BUILD_MINUTES"),
      instanceType: pickInstanceType(mod, "DEFAULT_SANDBOX_INSTANCE_TYPE"),
    },
    appServices: pickFunction<AppServicesOf>(mod, "appServices"),
    appWorkerFacts: workerFactsOf(mod),
    revisionProblem: pickFunction<RevisionProblemOf>(mod, "revisedArtifactProblem"),
    verifySignature: pickFunction<VerifySignatureOf>(mod, "verifySignature"),
    signingKeys: pickSigningKeys(mod, "signingKeys"),
  };
}

function pickFunction<T extends (...args: never[]) => unknown>(
  mod: unknown,
  exportName: string,
): T {
  const value = (mod as Record<string, unknown> | null)?.[exportName];
  if (typeof value !== "function") {
    throw new Error(`@appflare/schema does not export a function named ${exportName}`);
  }
  // The runtime check above establishes a function; its signature is the one
  // @appflare/schema declares, mirrored by T.
  return value as T;
}

function pickSigningKeys(mod: unknown, exportName: string): readonly SigningKey[] {
  const value = (mod as Record<string, unknown> | null)?.[exportName];
  const ok =
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (k) =>
        typeof (k as SigningKey | null)?.keyId === "string" &&
        typeof (k as SigningKey | null)?.publicKeyBase64 === "string",
    );
  if (!ok) {
    throw new Error(`@appflare/schema does not export signing keys named ${exportName}`);
  }
  return value as SigningKey[];
}

function pickParser<T>(mod: unknown, exportName: string): Parser<T> {
  const value = (mod as Record<string, unknown> | null)?.[exportName];
  if (typeof (value as { safeParse?: unknown } | undefined)?.safeParse !== "function") {
    throw new Error(`@appflare/schema does not export a zod schema named ${exportName}`);
  }
  // The runtime check above establishes the Parser shape; the output type T is
  // the local subset view from types.ts of what this schema produces.
  return value as Parser<T>;
}

function pickPositiveInt(mod: unknown, exportName: string): number {
  const value = (mod as Record<string, unknown> | null)?.[exportName];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`@appflare/schema does not export a positive integer named ${exportName}`);
  }
  return value;
}

function pickInstanceType(mod: unknown, exportName: string): SandboxInstanceType {
  const value = (mod as Record<string, unknown> | null)?.[exportName];
  if (value !== "standard-1" && value !== "standard-2") {
    throw new Error(
      `@appflare/schema does not export a container instance type named ${exportName}`,
    );
  }
  return value;
}

/** Formats issues as `- path.to.field: message` lines. */
export function formatIssues(issues: readonly ParseIssue[]): string {
  return issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
      return `- ${where}: ${issue.message}`;
    })
    .join("\n");
}

/** Parses `input` or throws an error naming `what` and listing every issue. */
export function parseOrThrow<T>(parser: Parser<T>, input: unknown, what: string): T {
  const result = parser.safeParse(input);
  if (!result.success) {
    throw new Error(`${what} is invalid:\n${formatIssues(result.error.issues)}`);
  }
  return result.data;
}
