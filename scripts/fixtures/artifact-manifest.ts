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

/**
 * A schema-valid artifact `manifest.json` of an app of two Workers (format
 * 2), shaped like the packer's output for its two-Worker fixture: the primary
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
  m.format = 2;
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
  m.d1Migrations = { DB: [{ name: "0001_init.sql", ...file("d1/DB/0001_init.sql", 3) }] };
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
      { name: "SESSION_SECRET", label: "Session secret", generate: true, workers: ["web"] },
      { name: "SHARED_KEY", label: "Shared key", generate: true },
    ],
    vars: [
      { name: "JOBS_URL", label: "Jobs URL", default: "{{workerUrl:jobs}}" },
      { name: "APP_URL", label: "App URL", default: "{{workerUrl}}", workers: ["jobs"] },
    ],
  };
  return m;
}

/**
 * A schema-valid artifact `manifest.json` of format 3 whose D1 bindings cover
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
  m.format = 3;
  (m.worker as Record<string, unknown>).bindings = [
    { type: "d1", name: "DB" },
    { type: "d1", name: "LOGS" },
    { type: "d1", name: "SEEDS" },
    { type: "d1", name: "AUDIT" },
  ];
  // The packer records every D1 binding's migrations, an empty list included.
  m.d1Migrations = {
    DB: [
      file("d1", "DB", "20240101_init/migration.sql"),
      file("d1", "DB", "20240302_tags/migration.sql"),
    ],
    LOGS: [file("d1", "LOGS", "0001_logs.sql")],
    SEEDS: [],
    AUDIT: [],
  };
  m.d1Schema = {
    DB: [file("d1-schema", "DB", "db/views.sql")],
    SEEDS: [file("d1-schema", "SEEDS", "db/seed.sql"), file("d1-schema", "SEEDS", "db/more.sql")],
  };
  m.d1PostDeploy = {
    DB: [file("d1-post-deploy", "DB", "0100_drop_legacy.sql")],
    AUDIT: [file("d1-post-deploy", "AUDIT", "0001_audit.sql")],
  };
  m.catalog = {
    ...(m.catalog as Record<string, unknown>),
    resources: {
      d1: {
        DB: {
          migrations: "prisma/migrations/*/migration.sql",
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
 * A schema-valid artifact `manifest.json` of format 4 that seeds two D1
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
  m.format = 4;
  (m.worker as Record<string, unknown>).bindings = [
    { type: "d1", name: "DB" },
    { type: "d1", name: "AUTH" },
    { type: "plain_text", name: "SITE_NAME", text: "Upstream" },
  ];
  m.d1Migrations = { DB: [file("d1", "DB", "0001_init.sql")], AUTH: [] };
  m.d1Schema = { DB: [file("d1-schema", "DB", "db/defaults.sql")] };
  m.d1PostDeploy = { DB: [file("d1-post-deploy", "DB", "0100_cleanup.sql")] };
  m.catalog = {
    ...(m.catalog as Record<string, unknown>),
    secrets: [
      { name: "API_TOKEN", label: "API token" },
      { name: "SESSION_KEY", label: "Session key", generate: "base64-key-32" },
      { name: "ADMIN_PASSWORD", label: "Admin password", generate: true, seedOnly: true },
    ],
    vars: [
      { name: "SITE_NAME", label: "Site name", default: "Seeded" },
      { name: "ADMIN_USERNAME", label: "Admin user name", required: true, seedOnly: true },
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
 * workers.dev (`install.workers[].workersDev: false`), which makes it format
 * 4. Only `web` reaches `jobs`, through its bindings, so no var names the
 * URL of `jobs` any more, only its Worker name.
 */
export function privateDuoArtifactManifestFixture(opts: { sha: string }): Record<string, unknown> {
  const m = duoArtifactManifestFixture(opts);
  const catalog = m.catalog as Record<string, unknown>;
  const install = catalog.install as Record<string, unknown>;
  m.format = 4;
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
 * A schema-valid artifact `manifest.json` of format 5 whose D1 binding `DB`
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
  m.format = 5;
  (m.worker as Record<string, unknown>).bindings = [{ type: "d1", name: "DB" }];
  m.d1Migrations = {
    DB: [file("d1", "0001_init.sql"), file("d1", "0002_add_o'clock.sql")],
  };
  m.d1PostDeploy = { DB: [file("d1-post-deploy", "0100_cleanup.sql")] };
  m.d1Baseline = { DB: [file("d1-baseline", "db/schema.sql")] };
  m.catalog = {
    ...(m.catalog as Record<string, unknown>),
    resources: {
      d1: { DB: { baseline: "db/schema.sql", postDeployMigrationsDir: "db/post-deploy" } },
    },
  };
  return m;
}

/**
 * A schema-valid artifact `manifest.json` of format 5 for a Worker of static
 * assets only: a wrangler config with `assets` and no `main`, so no modules,
 * no `mainModule`, no bindings, and two asset files.
 */
export function assetsOnlyArtifactManifestFixture(opts: { sha: string }): Record<string, unknown> {
  const m = artifactManifestFixture({ app: "site", version: "1.0.0", sha: opts.sha });
  const hex64 = "a".repeat(64);
  const worker = { ...(m.worker as Record<string, unknown>) };
  delete worker.mainModule;
  m.format = 5;
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
