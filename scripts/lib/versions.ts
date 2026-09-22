import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { packerEnv } from "./pack-env.ts";
import { appflarePaths, assertAppflareBuilt } from "./paths.ts";
import type { CatalogManifest } from "./types.ts";

/**
 * The version an app's current pin packs to, computed before packing with the
 * packer's own `deriveVersion`. The release tag
 * `<slug>@<version>` is what publish and the index key on.
 */

/** The slice of `@appflare/pack` used to derive versions. */
export interface PackerVersioning {
  deriveVersion(input: {
    ref: string;
    sha: string;
    commitDate: string | null;
    buildDate: string;
  }): string;
  semverFromRef(ref: string): string | null;
  formatBuildDate(date: Date): string;
}

/** Loads the versioning functions from the packer build in `appflareDir`. */
export async function loadPackerVersioning(appflareDir: string): Promise<PackerVersioning> {
  assertAppflareBuilt(appflareDir);
  const mod = (await import(pathToFileURL(appflarePaths(appflareDir).packLib).href)) as Record<
    string,
    unknown
  >;
  for (const name of ["deriveVersion", "semverFromRef", "formatBuildDate"]) {
    if (typeof mod[name] !== "function") {
      throw new Error(`@appflare/pack does not export ${name}()`);
    }
  }
  // Checked above: all three exports are functions with these signatures.
  return mod as unknown as PackerVersioning;
}

/** `YYYYMMDD` commit date of `sha` in `repo`, as the packer computes it. */
export type CommitDateLookup = (repo: string, sha: string) => string;

/**
 * Fetches only the commit object (depth 1, no trees or blobs) into a temp repo
 * and formats its committer date the way the packer does
 * (`git show -s --format=%cd --date=format:%Y%m%d`, in the commit's own zone).
 * Runs no code from the app.
 */
export const gitCommitDate: CommitDateLookup = (repo, sha) => {
  const dir = mkdtempSync(path.join(tmpdir(), "appflare-commit-date-"));
  const env = { ...packerEnv(process.env), GIT_TERMINAL_PROMPT: "0" };
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    git(["init", "-q"]);
    git(["fetch", "-q", "--depth=1", "--filter=tree:0", `https://github.com/${repo}.git`, sha]);
    const date = git(["show", "-s", "--format=%cd", "--date=format:%Y%m%d", "FETCH_HEAD"]).trim();
    if (!/^\d{8}$/.test(date)) {
      throw new Error(`unexpected commit date "${date}"`);
    }
    return date;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new Error(
      `could not read the commit date of ${repo}@${sha}${stderr ? `: ${stderr}` : ""}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Computes (and caches) each manifest's packed version. */
export interface VersionResolver {
  versionOf(manifest: CatalogManifest): string;
}

export function createVersionResolver(
  packer: PackerVersioning,
  commitDate: CommitDateLookup = gitCommitDate,
): VersionResolver {
  const cache = new Map<string, string>();
  return {
    versionOf(manifest) {
      const { ref, sha } = manifest.source;
      const key = `${manifest.repo}@${sha}@${ref}`;
      let version = cache.get(key);
      if (version === undefined) {
        // A semver ref never needs the commit date; skip the fetch.
        const date = packer.semverFromRef(ref) ? null : commitDate(manifest.repo, sha);
        version = packer.deriveVersion({
          ref,
          sha,
          commitDate: date,
          buildDate: packer.formatBuildDate(new Date()),
        });
        cache.set(key, version);
      }
      return version;
    },
  };
}
