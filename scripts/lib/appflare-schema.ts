import { pathToFileURL } from "node:url";
import { appflarePaths, assertAppflareBuilt } from "./paths.ts";
import type { ArtifactManifest, CatalogManifest, IndexJson } from "./types.ts";

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
}

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
  };
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
