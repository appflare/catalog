/** A sha256 hex digest that stands in for every file's. */
const HEX64 = "a".repeat(64);

/** A D1 SQL file of an artifact, as the packer records it. */
type D1File = { name: string; path: string; size: number; sha256: string; offset: number };

/** One binding's D1 SQL (`d1[binding]`), with the lists it leaves out empty. */
function d1Binding(sql: {
  migrations?: D1File[];
  schema?: D1File[];
  postDeploy?: D1File[];
  baseline?: D1File;
}): Record<string, unknown> {
  return {
    migrations: sql.migrations ?? [],
    schema: sql.schema ?? [],
    postDeploy: sql.postDeploy ?? [],
    ...(sql.baseline === undefined ? {} : { baseline: sql.baseline }),
  };
}

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
  const hex64 = HEX64;
  return {
    format: 1,
    app: opts.app,
    version: opts.version,
    builtAt: "2026-09-22T12:00:00.000Z",
    builder: "@appflare/pack@0.0.0",
    keyId: opts.keyId ?? "unsigned",
    worker: {
      name: opts.app,
      wranglerConfig: { declared: "wrangler.jsonc", effective: "wrangler.jsonc" },
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
    d1: {},
    catalog: {
      slug: opts.app,
      name: "Hello",
      summary: "Fixture.",
      tagline: "A fixture",
      homepage: "https://github.com/example/hello",
      repo: `example/${opts.app}`,
      license: "MIT",
      categories: ["utilities"],
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

/**
 * A schema-valid artifact `manifest.json` of an app of two Workers, shaped like the packer's output for its two-Worker fixture: the primary
 * Worker `web` binds the `jobs` Worker (a service binding with an entrypoint
 * and a Durable Object class it implements), sends to a queue `jobs`
 * consumes, and both share a D1 database, a KV namespace and a rate limit.
 */
export function duoArtifactManifestFixture(opts: { sha: string }): Record<string, unknown> {
  const m = artifactManifestFixture({ app: "duo", version: "0.2.0", sha: opts.sha });
  const hex64 = "a".repeat(64);
  const file = (path: string, offset: number) => ({ path, size: 1, sha256: hex64, offset });
  const worker = (name: string, modulePath: string, offset: number) => ({
    name,
    wranglerConfig: {
      declared: `${name.slice("duo-".length)}/wrangler.jsonc`,
      effective: `${name.slice("duo-".length)}/wrangler.jsonc`,
    },
    mainModule: "index.js",
    compatibilityDate: "2024-12-30",
    compatibilityFlags: [],
    modules: [{ name: "index.js", type: "esm", ...file(modulePath, offset) }],
    migrations: [],
    crons: [],
    observability: null,
    placement: null,
    limits: null,
  });
  const shared = [
    { type: "d1", name: "DB" },
    { type: "kv_namespace", name: "CACHE" },
    { type: "ratelimit", name: "LIMIT", namespace_id: "1001", simple: { limit: 10, period: 60 } },
  ];
  m.worker = {
    ...worker("duo-web", "worker/index.js", 0),
    bindings: [
      ...shared,
      { type: "queue", name: "TASKS" },
      { type: "service", name: "JOBS", service: "{{workerName:jobs}}", entrypoint: "Jobs" },
      { type: "service", name: "SELF", service: "self" },
      {
        type: "durable_object_namespace",
        name: "COUNTER",
        class_name: "Counter",
        script_name: "{{workerName:jobs}}",
      },
      { type: "plain_text", name: "JOBS_URL", text: "https://duo-jobs.example.workers.dev" },
    ],
  };
  m.assets = {
    config: {},
    binding: "ASSETS",
    files: [{ route: "/index.html", hash: "b".repeat(32), ...file("assets/index.html", 1) }],
  };
  m.workers = [
    {
      name: "jobs",
      worker: {
        ...worker("duo-jobs", "workers/jobs/worker/index.js", 2),
        bindings: [
          ...shared,
          { type: "durable_object_namespace", name: "COUNTER", class_name: "Counter" },
        ],
        migrations: [{ tag: "v1", new_sqlite_classes: ["Counter"] }],
        crons: ["*/30 * * * *"],
        queueConsumers: [{ queue: { binding: "TASKS" }, max_retries: 3 }],
      },
      assets: { config: {}, binding: null, files: [] },
    },
  ];
  m.d1 = {
    DB: d1Binding({ migrations: [{ name: "0001_init.sql", ...file("d1/DB/0001_init.sql", 3) }] }),
  };
  const catalog = m.catalog as Record<string, unknown>;
  m.catalog = {
    ...catalog,
    install: {
      ...(catalog.install as Record<string, unknown>),
      wranglerConfig: "web/wrangler.jsonc",
      workers: [
        { name: "web", wranglerConfig: "web/wrangler.jsonc", primary: true },
        { name: "jobs", wranglerConfig: "jobs/wrangler.jsonc" },
      ],
    },
    secrets: [
      { name: "SESSION_SECRET", label: "Session secret", generate: "password", workers: ["web"] },
      { name: "SHARED_KEY", label: "Shared key", generate: "password" },
    ],
    vars: [
      { name: "JOBS_URL", label: "Jobs URL", default: "{{workerUrl:jobs}}" },
      { name: "APP_URL", label: "App URL", default: "{{workerUrl}}", workers: ["jobs"] },
    ],
  };
  return m;
}

/**
 * A schema-valid artifact `manifest.json` whose D1 bindings cover
 * every layout the catalog manifest's `resources.d1` can declare: `DB` has
 * migrations from a glob (named by their path from the glob's folder, as
 * wrangler names them), a schema file and a post-deploy migration; `LOGS`
 * has a `migrationsDir`; `SEEDS` only schema files; `AUDIT` only a
 * post-deploy migration.
 */
export function d1ArtifactManifestFixture(opts: { sha: string }): Record<string, unknown> {
  const m = artifactManifestFixture({ app: "ledger", version: "1.0.0", sha: opts.sha });
  const hex64 = "a".repeat(64);
  let offset = 1;
  const file = (dir: string, binding: string, name: string) => ({
    name,
    path: `${dir}/${binding}/${name}`,
    size: 1,
    sha256: hex64,
    offset: offset++,
  });
  (m.worker as Record<string, unknown>).bindings = [
    { type: "d1", name: "DB" },
    { type: "d1", name: "LOGS" },
    { type: "d1", name: "SEEDS" },
    { type: "d1", name: "AUDIT" },
  ];
  // The packer records every D1 binding, one without migrations included.
  m.d1 = {
    DB: d1Binding({
      migrations: [
        file("d1", "DB", "20240101_init/migration.sql"),
        file("d1", "DB", "20240302_tags/migration.sql"),
      ],
      schema: [file("d1-schema", "DB", "db/views.sql")],
      postDeploy: [file("d1-post-deploy", "DB", "0100_drop_legacy.sql")],
    }),
    LOGS: d1Binding({ migrations: [file("d1", "LOGS", "0001_logs.sql")] }),
    SEEDS: d1Binding({
      schema: [
        file("d1-schema", "SEEDS", "db/seed.sql"),
        file("d1-schema", "SEEDS", "db/more.sql"),
      ],
    }),
    AUDIT: d1Binding({ postDeploy: [file("d1-post-deploy", "AUDIT", "0001_audit.sql")] }),
  };
  m.catalog = {
    ...(m.catalog as Record<string, unknown>),
    resources: {
      d1: {
        DB: {
          migrationsGlob: "prisma/migrations/*/migration.sql",
          schema: ["db/views.sql"],
          postDeployMigrationsDir: "db/post-deploy",
        },
        LOGS: { migrationsDir: "db/logs" },
        SEEDS: { schema: ["db/seed.sql", "db/more.sql"] },
        AUDIT: { postDeployMigrationsDir: "db/audit" },
      },
    },
  };
  return m;
}

/**
 * A schema-valid artifact `manifest.json` that seeds two D1
 * databases from the install form. `DB` has a migration, a schema file and a
 * post-deploy migration, and a seed that runs before its schema file
 * (`beforeSchema`), with a PBKDF2 hash and salt of the seed-only
 * `ADMIN_PASSWORD` and the seed-only vars `ADMIN_USERNAME` (required, no
 * default) and `ADMIN_EMAIL` (with a default). `AUTH` has nothing but a seed,
 * with a bcrypt hash, the ordinary var `SITE_NAME` and a literal value. The
 * Worker also gets an ordinary secret and a `base64-key-32` one.
 */
export function seedArtifactManifestFixture(opts: { sha: string }): Record<string, unknown> {
  const m = artifactManifestFixture({ app: "keep", version: "1.0.0", sha: opts.sha });
  const hex64 = "a".repeat(64);
  let offset = 1;
  const file = (dir: string, binding: string, name: string) => ({
    name,
    path: `${dir}/${binding}/${name}`,
    size: 1,
    sha256: hex64,
    offset: offset++,
  });
  (m.worker as Record<string, unknown>).bindings = [
    { type: "d1", name: "DB" },
    { type: "d1", name: "AUTH" },
    { type: "plain_text", name: "SITE_NAME", text: "Upstream" },
  ];
  m.d1 = {
    DB: d1Binding({
      migrations: [file("d1", "DB", "0001_init.sql")],
      schema: [file("d1-schema", "DB", "db/defaults.sql")],
      postDeploy: [file("d1-post-deploy", "DB", "0100_cleanup.sql")],
    }),
    AUTH: d1Binding({}),
  };
  m.catalog = {
    ...(m.catalog as Record<string, unknown>),
    secrets: [
      { name: "API_TOKEN", label: "API token" },
      { name: "SESSION_KEY", label: "Session key", generate: "base64-key-32" },
      { name: "ADMIN_PASSWORD", label: "Admin password", generate: "password", seedOnly: true },
    ],
    vars: [
      { name: "SITE_NAME", label: "Site name", default: "Seeded" },
      { name: "ADMIN_USERNAME", label: "Admin user name", seedOnly: true },
      {
        name: "ADMIN_EMAIL",
        label: "Admin email",
        default: "admin@example.com",
        seedOnly: true,
      },
    ],
    resources: {
      d1: {
        DB: {
          schema: ["db/defaults.sql"],
          postDeployMigrationsDir: "db/post-deploy",
          seed: {
            beforeSchema: true,
            hashes: {
              admin: {
                from: "ADMIN_PASSWORD",
                method: "pbkdf2-sha256",
                iterations: 1000,
                saltBytes: 16,
                keyBytes: 32,
                encoding: "base64url",
              },
            },
            statements: [
              {
                sql: "INSERT OR IGNORE INTO users (username, email, password_hash, password_salt) VALUES (?, ?, ?, ?)",
                params: [
                  { var: "ADMIN_USERNAME" },
                  { var: "ADMIN_EMAIL" },
                  { hash: "admin" },
                  { salt: "admin" },
                ],
              },
            ],
          },
        },
        AUTH: {
          seed: {
            hashes: { owner: { from: "ADMIN_PASSWORD", method: "bcrypt", cost: 4 } },
            statements: [
              {
                sql: "INSERT INTO admins (site, hash, role) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
                params: [{ var: "SITE_NAME" }, { hash: "owner" }, { value: "owner" }],
              },
            ],
          },
        },
      },
    },
  };
  return m;
}

/**
 * {@link duoArtifactManifestFixture} with its `jobs` Worker kept off
 * workers.dev (`install.workers[].workersDev: false`). Only `web` reaches `jobs`, through its bindings, so no var names the
 * URL of `jobs` any more, only its Worker name.
 */
export function privateDuoArtifactManifestFixture(opts: { sha: string }): Record<string, unknown> {
  const m = duoArtifactManifestFixture(opts);
  const catalog = m.catalog as Record<string, unknown>;
  const install = catalog.install as Record<string, unknown>;
  m.catalog = {
    ...catalog,
    install: {
      ...install,
      workers: [
        { name: "web", wranglerConfig: "web/wrangler.jsonc", primary: true },
        { name: "jobs", wranglerConfig: "jobs/wrangler.jsonc", workersDev: false },
      ],
    },
    vars: [
      { name: "JOBS_URL", label: "Jobs Worker", default: "{{workerName:jobs}}" },
      { name: "APP_URL", label: "App URL", default: "{{workerUrl}}", workers: ["jobs"] },
    ],
  };
  return m;
}

/**
 * A schema-valid artifact `manifest.json` whose D1 binding `DB`
 * has a baseline (`db/schema.sql`), two migrations and a post-deploy
 * migration: on a new database the baseline runs and the three are recorded
 * in `d1_migrations` without running.
 */
export function baselineArtifactManifestFixture(opts: { sha: string }): Record<string, unknown> {
  const m = artifactManifestFixture({ app: "notes", version: "2.0.0", sha: opts.sha });
  const hex64 = "a".repeat(64);
  let offset = 1;
  const file = (dir: string, name: string) => ({
    name,
    path: `${dir}/DB/${name}`,
    size: 1,
    sha256: hex64,
    offset: offset++,
  });
  (m.worker as Record<string, unknown>).bindings = [{ type: "d1", name: "DB" }];
  m.d1 = {
    DB: d1Binding({
      migrations: [file("d1", "0001_init.sql"), file("d1", "0002_add_o'clock.sql")],
      postDeploy: [file("d1-post-deploy", "0100_cleanup.sql")],
      baseline: file("d1-baseline", "db/schema.sql"),
    }),
  };
  m.catalog = {
    ...(m.catalog as Record<string, unknown>),
    resources: {
      d1: { DB: { baseline: "db/schema.sql", postDeployMigrationsDir: "db/post-deploy" } },
    },
  };
  return m;
}

/**
 * A schema-valid artifact `manifest.json` for a Worker of static
 * assets only: a wrangler config with `assets` and no `main`, so no modules,
 * no `mainModule`, no bindings, and two asset files.
 */
export function assetsOnlyArtifactManifestFixture(opts: { sha: string }): Record<string, unknown> {
  const m = artifactManifestFixture({ app: "site", version: "1.0.0", sha: opts.sha });
  const hex64 = "a".repeat(64);
  const worker = { ...(m.worker as Record<string, unknown>) };
  delete worker.mainModule;
  m.worker = { ...worker, modules: [], bindings: [] };
  m.assets = {
    config: { not_found_handling: "single-page-application" },
    binding: null,
    files: [
      {
        path: "assets/index.html",
        route: "/index.html",
        hash: "b".repeat(32),
        size: 1,
        sha256: hex64,
        offset: 0,
      },
      {
        path: "assets/app.css",
        route: "/app.css",
        hash: "c".repeat(32),
        size: 1,
        sha256: hex64,
        offset: 1,
      },
    ],
  };
  return m;
}

/**
 * A schema-valid artifact `manifest.json` with resource settings: a Vectorize binding
 * `VECTORS` with two metadata indexes and an R2 binding `FILES` with two
 * lifecycle rules, both declared in the catalog manifest's `resources` and
 * carried on the bindings as the packer records them, plus `_redirects` and
 * `_headers` in the assets config.
 */
export function resourcesArtifactManifestFixture(opts: { sha: string }): Record<string, unknown> {
  const m = artifactManifestFixture({ app: "search", version: "3.0.0", sha: opts.sha });
  const metadataIndexes = [
    { propertyName: "url", type: "string" },
    { propertyName: "published", type: "number" },
  ];
  const lifecycle = [
    { id: "Delete temporary files", prefix: "tmp/", deleteAfterDays: 7 },
    { id: "Archive exports", prefix: "exports/", infrequentAccessAfterDays: 30 },
  ];
  (m.worker as Record<string, unknown>).bindings = [
    { type: "vectorize", name: "VECTORS", dimensions: 768, metric: "cosine", metadataIndexes },
    { type: "r2_bucket", name: "FILES", lifecycle },
  ];
  m.assets = {
    config: {
      html_handling: "auto-trailing-slash",
      _redirects: "/old /new 301\n",
      _headers: "/*\n  X-Frame-Options: DENY\n",
    },
    binding: "ASSETS",
    files: [
      {
        path: "assets/index.html",
        route: "/index.html",
        hash: "b".repeat(32),
        size: 1,
        sha256: "a".repeat(64),
        offset: 1,
      },
    ],
  };
  m.catalog = {
    ...(m.catalog as Record<string, unknown>),
    install: {
      ...((m.catalog as Record<string, unknown>).install as Record<string, unknown>),
      buildEnv: { VITE_API_ORIGIN: "https://api.example.com" },
      installDirs: [{ path: ".", devDependencies: false }],
    },
    resources: {
      vectorize: { VECTORS: { dimensions: 768, metric: "cosine", metadataIndexes } },
      r2: { FILES: { lifecycle } },
    },
  };
  return m;
}
