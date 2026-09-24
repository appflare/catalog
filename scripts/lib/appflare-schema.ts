import { pathToFileURL } from "node:url";
import { appflarePaths, assertAppflareBuilt } from "./paths.ts";
import type { SandboxDefaults } from "./sandbox-entry.ts";
import type {
  AppServices,
  ArtifactManifest,
  CatalogManifest,
  CatalogStats,
  FeaturedItem,
  IndexJson,
  SandboxInstanceType,
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
  /**
   * Most Worker modules the manager can install: it uploads each module as its
   * own subrequest, within the free plan's per-invocation subrequest limit.
   */
  maxWorkerModules: number;
  /** What a sandbox tier entry's `install.sandbox` defaults to. */
  sandboxDefaults: SandboxDefaults;
  /**
   * The Cloudflare services an app uses (`appServices`), from its catalog
   * manifest and, for an artifact tier entry, its artifact's Worker. The
   * manager works them out with the same function when an index row lacks them.
   */
  appServices: AppServicesOf;
}

/** `appServices` from `@appflare/schema`: the arguments are schema-parsed manifests. */
export type AppServicesOf = (
  catalog: CatalogManifest,
  worker: ArtifactManifest["worker"] | null,
) => AppServices;

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
    maxWorkerModules: pickPositiveInt(mod, "MAX_WORKER_MODULES"),
    sandboxDefaults: {
      expectedMinutes: pickPositiveInt(mod, "DEFAULT_EXPECTED_BUILD_MINUTES"),
      instanceType: pickInstanceType(mod, "DEFAULT_SANDBOX_INSTANCE_TYPE"),
    },
    appServices: pickFunction<AppServicesOf>(mod, "appServices"),
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
