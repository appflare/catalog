/**
 * Environment for the packer, which runs third-party install and build code
 * (`pnpm install --ignore-scripts`, then the app's wrangler `build.command`
 * during `wrangler deploy --dry-run`). The packer scrubs its children's
 * environment too; this removes GitHub credentials and the signing key before
 * the packer even starts. Packing never signs: signing is a separate step
 * (`appflare-pack sign`) that runs no app code.
 */
export const SIGNING_KEY_ENV = "APPFLARE_SIGNING_KEY";
export const SIGNING_KEY_ID = "catalog-2026-09";

const SECRET_VARS = [
  SIGNING_KEY_ENV,
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "APPFLARE_DEPLOY_KEY",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
];

export function packerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of SECRET_VARS) {
    delete out[name];
  }
  return out;
}
