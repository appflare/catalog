/**
 * Builds a schema-valid artifact `manifest.json` for tests, modeled
 * on the packer's output for Cut.
 */
export function artifactManifestFixture(opts: {
  app: string;
  version: string;
  sha: string;
  ref?: string;
  keyId?: string;
}): Record<string, unknown> {
  const hex64 = "a".repeat(64);
  return {
    format: 1,
    app: opts.app,
    version: opts.version,
    source: { repo: `example/${opts.app}`, sha: opts.sha, ref: opts.ref ?? `v${opts.version}` },
    builtAt: "2026-09-22T12:00:00.000Z",
    builder: "@appflare/pack@0.0.0",
    keyId: opts.keyId ?? "unsigned",
    worker: {
      name: opts.app,
      mainModule: "index.js",
      compatibilityDate: "2024-12-30",
      compatibilityFlags: ["nodejs_compat"],
      modules: [
        {
          name: "index.js",
          type: "esm",
          path: "worker/index.js",
          size: 1,
          sha256: hex64,
          offset: 0,
        },
      ],
      bindings: [{ type: "kv_namespace", name: "KV" }],
      migrations: [],
      crons: [],
      observability: null,
      placement: null,
      limits: null,
    },
    assets: { config: {}, binding: null, files: [] },
    d1Migrations: {},
    catalog: {
      slug: opts.app,
      name: "Hello",
      summary: "Fixture.",
      homepage: "https://github.com/example/hello",
      repo: `example/${opts.app}`,
      license: "MIT",
      categories: [],
      maintainers: ["octocat"],
      source: { ref: opts.ref ?? `v${opts.version}`, sha: opts.sha },
      install: {
        tier: "artifact",
        packageManager: "pnpm",
        wranglerConfig: "wrangler.jsonc",
        workerName: opts.app,
      },
      plan: "free",
      requires: [],
      secrets: [],
      vars: [],
      postInstall: [],
      tokenPermissions: [],
    },
  };
}
