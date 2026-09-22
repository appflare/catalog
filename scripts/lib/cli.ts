/** Shared helpers for the catalog's command-line scripts. */

/** Writes a warning to stderr. */
export function warn(message: string): void {
  process.stderr.write(`warning: ${message}\n`);
}

/** Writes progress to stderr so stdout stays machine-readable. */
export function info(message: string): void {
  process.stderr.write(`- ${message}\n`);
}

/** Runs a script's main, printing an error message (no stack) and exiting 1 on failure. */
export function runMain(main: () => Promise<number | undefined> | number | undefined): void {
  Promise.resolve()
    .then(main)
    .then(
      (code) => {
        process.exitCode = code ?? 0;
      },
      (err: unknown) => {
        process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
      },
    );
}

/** Catalog repository `owner/name` that hosts releases and Pages. */
export function catalogRepo(env: NodeJS.ProcessEnv = process.env): string {
  return env.CATALOG_REPO?.trim() || env.GITHUB_REPOSITORY?.trim() || "appflare/catalog";
}
