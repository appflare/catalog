import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const ARTIFACT_FILE = /^(?:manifest\.json|manifest\.sig|[^/]+\.zip)$/;

/**
 * Empties a previous artifact directory so a stale zip or `manifest.sig` from an
 * earlier pack cannot be published next to a new manifest. Refuses to touch a
 * directory that holds anything other than artifact files.
 */
export function clearArtifactDir(dir: string): void {
  if (!existsSync(dir)) {
    return;
  }
  if (!statSync(dir).isDirectory()) {
    throw new Error(`--out ${dir} exists and is not a directory`);
  }
  const entries = readdirSync(dir);
  const foreign = entries.filter((name) => !ARTIFACT_FILE.test(name));
  if (foreign.length > 0) {
    throw new Error(
      `refusing to overwrite ${dir}: it contains non-artifact files (${foreign.join(", ")})`,
    );
  }
  for (const name of entries) {
    rmSync(path.join(dir, name), { force: true });
  }
}
