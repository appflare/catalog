import { pbkdf2Sync } from "node:crypto";
import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { seedArtifactManifestFixture } from "../fixtures/artifact-manifest.ts";
import { appflareAvailable, appflareDir } from "../fixtures/schema.ts";
import { loadAppflareSchema, loadSeedHelpers, parseOrThrow } from "./appflare-schema.ts";
import {
  appSecretValues,
  type CfRequest,
  type CfResponse,
  type CiSeedFunctions,
  type CiSeedValues,
  catalogForms,
  d1Steps,
  isSeedStep,
  needsSeedHelpers,
  planCiApp,
  planCiInstall,
  randomBase64Key32,
  runSeed,
  SEED_VAR_PLACEHOLDER,
  seedFunctions,
  seedValues,
} from "./ci-install.ts";
import type { ArtifactManifest, CatalogD1Seed, SeedParam } from "./types.ts";

const PIN = "0123456789abcdef0123456789abcdef01234567";

const keep = () => seedArtifactManifestFixture({ sha: PIN }) as unknown as ArtifactManifest;

const noPacker = { deriveSecretValue: null, generateVapidPrivateKey: null };

/** Padded base64 of exactly 32 bytes, as `generate: "base64-key-32"` makes it. */
function isBase64Key32(value: string): boolean {
  return /^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, "base64").length === 32;
}

describe("catalogForms with seed-only secrets and vars", () => {
  it("keeps them out of what the Worker gets, and lists base64 keys", () => {
    const forms = catalogForms(keep().catalog);
    expect(forms.secrets).toEqual(["API_TOKEN", "SESSION_KEY"]);
    expect(forms.seedOnlySecrets).toEqual(["ADMIN_PASSWORD"]);
    expect(forms.base64Keys).toEqual(["SESSION_KEY"]);
    expect(forms.vars.map((v) => v.name)).toEqual(["SITE_NAME"]);
    expect(forms.seedOnlyVars).toEqual([
      { name: "ADMIN_USERNAME", required: true },
      { name: "ADMIN_EMAIL", default: "admin@example.com", required: true },
    ]);
  });

  it("lists a seed-only base64 key among the keys to generate", () => {
    const forms = catalogForms({
      secrets: [{ name: "SEED_KEY", generate: "base64-key-32", seedOnly: true }],
    });
    expect(forms.secrets).toEqual([]);
    expect(forms.seedOnlySecrets).toEqual(["SEED_KEY"]);
    expect(forms.base64Keys).toEqual(["SEED_KEY"]);
  });
});

describe("planCiInstall with seeds", () => {
  const plan = () => planCiInstall(keep(), "ci-keep-pr1", { subdomain: "acme" });

  it("sets no seed-only var on the Worker, and gives each one a value", () => {
    const p = plan();
    expect(p.config.vars).toEqual({ SITE_NAME: "Seeded" });
    expect(p.seedVars).toEqual({
      ADMIN_USERNAME: SEED_VAR_PLACEHOLDER,
      ADMIN_EMAIL: "admin@example.com",
    });
    expect(p.secrets).toEqual(["API_TOKEN", "SESSION_KEY"]);
    expect(p.seedOnlySecrets).toEqual(["ADMIN_PASSWORD"]);
  });

  it("fills placeholders into a seed-only var's default", () => {
    const m = keep();
    const catalog = m.catalog as { vars: Record<string, unknown>[] };
    catalog.vars = catalog.vars.map((v) =>
      v.name === "ADMIN_EMAIL" ? { ...v, default: "admin@{{workerName}}.example" } : v,
    );
    expect(planCiInstall(m, "ci-keep-pr1").seedVars.ADMIN_EMAIL).toBe("admin@ci-keep-pr1.example");
  });

  it("lists each database's seed, a database with nothing but a seed included", () => {
    const d1 = plan().d1;
    expect(d1.map((d) => [d.binding, d.migrations, d.schema, d.postDeploy])).toEqual([
      ["DB", true, ["d1-schema/DB/db/defaults.sql"], ["0100_cleanup.sql"]],
      ["AUTH", false, [], []],
    ]);
    expect(d1[0]?.seed?.beforeSchema).toBe(true);
    expect(d1[1]?.seed?.statements).toHaveLength(1);
    expect(needsSeedHelpers({ d1 })).toBe(true);
    expect(needsSeedHelpers({ d1: [] })).toBe(false);
  });
});

describe("appSecretValues with seed-only secrets and base64 keys", () => {
  it("gives seed-only secrets a 32-character password and base64 keys 32 bytes", () => {
    const app = planCiApp(keep(), "ci-keep-pr1");
    const values = appSecretValues(app, noPacker);
    expect([...values.keys()]).toEqual(["API_TOKEN", "SESSION_KEY", "ADMIN_PASSWORD"]);
    expect(values.get("ADMIN_PASSWORD")).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(isBase64Key32(values.get("SESSION_KEY") as string)).toBe(true);
    // Only what the Worker gets is set on it.
    expect(app.workers[0]?.plan.secrets).not.toContain("ADMIN_PASSWORD");
  });

  it("makes a new key every time", () => {
    const key = randomBase64Key32();
    expect(isBase64Key32(key)).toBe(true);
    expect(randomBase64Key32()).not.toBe(key);
  });
});

describe("d1Steps with seeds", () => {
  it("seeds before the schema files when asked, and every other seed last", () => {
    const app = planCiApp(keep(), "ci-keep-pr1");
    const steps = d1Steps(app.d1).map((s) =>
      isSeedStep(s) ? `seed ${s.database} (${s.binding})` : [s.config, ...s.args].join(" "),
    );
    expect(steps).toEqual([
      "wrangler.json d1 migrations apply ci-keep-pr1-db --remote",
      "seed ci-keep-pr1-db (DB)",
      "wrangler.json d1 execute ci-keep-pr1-db --remote --yes --file d1-schema/DB/db/defaults.sql",
      "wrangler.post-deploy.json d1 migrations apply ci-keep-pr1-db --remote",
      "seed ci-keep-pr1-auth (AUTH)",
    ]);
  });
});

describe("seedValues", () => {
  it("reads vars as the Workers get them, the primary's first, and every secret", () => {
    const values = seedValues(
      [
        {
          primary: false,
          plan: { seedVars: { ADMIN_USERNAME: "other" } },
          config: { vars: { SITE_NAME: "other", ONLY_HERE: "x" } },
        },
        {
          primary: true,
          plan: { seedVars: { ADMIN_USERNAME: "ci-admin" } },
          config: { vars: { SITE_NAME: "Seeded", LIST: ["a", 1] } },
        },
      ],
      new Map([["ADMIN_PASSWORD", "pw"]]),
    );
    expect(values).toEqual({
      vars: {
        SITE_NAME: "Seeded",
        LIST: '["a",1]',
        ADMIN_USERNAME: "ci-admin",
        ONLY_HERE: "x",
      },
      secrets: { ADMIN_PASSWORD: "pw" },
    });
  });
});

/** Stand-ins for the schema's seed functions, so the flow is tested without a build. */
const fakeSeedFunctions = (): CiSeedFunctions => ({
  pbkdf2SeedHash: async (hash, value) => ({
    hash: `pbkdf2-${hash.iterations}:${value.length}`,
    salt: "salt",
  }),
  seedStatementProblems: (sql, params) =>
    sql.split("?").length - 1 === params ? [] : ["one param per ?"],
  seedStatementParams: (statement, inputs) =>
    statement.params.map((param: SeedParam) => {
      const value =
        "var" in param
          ? inputs.vars[param.var]
          : "secret" in param
            ? inputs.secrets[param.secret]
            : "hash" in param
              ? inputs.hashes[param.hash]?.hash
              : "salt" in param
                ? inputs.hashes[param.salt]?.salt
                : param.value;
      if (value === undefined) throw new Error("the seed has no value for a param");
      return value;
    }),
  bcryptInputProblem: (label, value) => (value.length > 72 ? `${label} is too long` : null),
  bcryptHash: (value, cost) => `bcrypt-${cost}:${value.length}`,
});

interface FakeD1 {
  request: CfRequest;
  queries: { path: string; body: { sql: string; params: string[] } }[];
}

/** An account with the D1 databases `names` (uuid `uuid-<name>`) whose queries change `changes` rows. */
function fakeD1(names: string[], changes: number | ((i: number) => CfResponse) = 1): FakeD1 {
  const queries: FakeD1["queries"] = [];
  const request: CfRequest = async (method, path, body) => {
    const list = /^\/d1\/database\?name=([^&]+)&per_page=100$/.exec(path);
    if (method === "GET" && list !== null) {
      const name = decodeURIComponent(list[1] as string);
      return {
        status: 200,
        body: {
          success: true,
          result: names.filter((n) => n === name).map((n) => ({ name: n, uuid: `uuid-${n}` })),
        },
      };
    }
    if (method === "POST" && /^\/d1\/database\/[^/]+\/query$/.test(path)) {
      queries.push({ path, body: body as { sql: string; params: string[] } });
      if (typeof changes === "function") return changes(queries.length - 1);
      return {
        status: 200,
        body: { success: true, result: [{ results: [], success: true, meta: { changes } }] },
      };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { request, queries };
}

const PASSWORD = "correct-horse-battery-staple-0001";

const inputs = (): CiSeedValues => ({
  vars: { ADMIN_USERNAME: "ci-admin", ADMIN_EMAIL: "admin@example.com", SITE_NAME: "Seeded" },
  secrets: { ADMIN_PASSWORD: PASSWORD },
});

const seedOf = (binding: "DB" | "AUTH"): CatalogD1Seed => {
  const d1 = planCiInstall(keep(), "ci-keep-pr1").d1.find((d) => d.binding === binding);
  if (d1?.seed === undefined) throw new Error(`no seed for ${binding}`);
  return d1.seed;
};

describe("runSeed", () => {
  it("sends each statement as one /query call with its values as params", async () => {
    const d1 = fakeD1(["ci-keep-pr1-db"]);
    const count = await runSeed(
      d1.request,
      { database: "ci-keep-pr1-db", seed: seedOf("DB") },
      inputs(),
      fakeSeedFunctions(),
    );
    expect(count).toBe(1);
    expect(d1.queries).toEqual([
      {
        path: "/d1/database/uuid-ci-keep-pr1-db/query",
        body: {
          sql: "INSERT OR IGNORE INTO users (username, email, password_hash, password_salt) VALUES (?, ?, ?, ?)",
          params: ["ci-admin", "admin@example.com", `pbkdf2-1000:${PASSWORD.length}`, "salt"],
        },
      },
    ]);
  });

  it("hashes bcrypt at the cost the seed names", async () => {
    const d1 = fakeD1(["ci-keep-pr1-auth"]);
    await runSeed(
      d1.request,
      { database: "ci-keep-pr1-auth", seed: seedOf("AUTH") },
      inputs(),
      fakeSeedFunctions(),
    );
    expect(d1.queries[0]?.body.params).toEqual(["Seeded", `bcrypt-4:${PASSWORD.length}`, "owner"]);
    const seed = seedOf("AUTH");
    const owner = seed.hashes?.owner;
    if (owner?.method !== "bcrypt") throw new Error("expected a bcrypt hash");
    delete owner.cost;
    await runSeed(d1.request, { database: "ci-keep-pr1-auth", seed }, inputs(), {
      ...fakeSeedFunctions(),
    });
    expect(d1.queries[1]?.body.params[1]).toBe(`bcrypt-10:${PASSWORD.length}`);
  });

  it("fails unless every statement adds exactly one row, naming no value", async () => {
    for (const changes of [0, 2]) {
      const d1 = fakeD1(["ci-keep-pr1-db"], changes);
      const run = runSeed(
        d1.request,
        { database: "ci-keep-pr1-db", seed: seedOf("DB") },
        inputs(),
        fakeSeedFunctions(),
      );
      await expect(run).rejects.toThrow(
        new RegExp(`seed statement 1 of 1 on ci-keep-pr1-db added ${changes} rows`),
      );
      await run.catch((error: Error) => {
        expect(error.message).not.toContain(PASSWORD);
        expect(error.message).not.toContain("ci-admin");
      });
    }
  });

  it("fails on D1's refusal with its message", async () => {
    const d1 = fakeD1(["ci-keep-pr1-db"], () => ({
      status: 400,
      body: { success: false, errors: [{ code: 7500, message: "no such table: users" }] },
    }));
    await expect(
      runSeed(
        d1.request,
        { database: "ci-keep-pr1-db", seed: seedOf("DB") },
        inputs(),
        fakeSeedFunctions(),
      ),
    ).rejects.toThrow(
      "seed statement 1 of 1 on ci-keep-pr1-db failed: HTTP 400 (7500 no such table: users)",
    );
  });

  it("sends nothing when a statement fails the check, a value is missing, or the database is gone", async () => {
    const d1 = fakeD1(["ci-keep-pr1-db"]);
    const bad = seedOf("DB");
    bad.statements[0] = { sql: "INSERT OR IGNORE INTO t (a) VALUES (?, ?)", params: [] };
    await expect(
      runSeed(d1.request, { database: "ci-keep-pr1-db", seed: bad }, inputs(), fakeSeedFunctions()),
    ).rejects.toThrow("seed statement 1 cannot run: one param per ?");
    await expect(
      runSeed(
        d1.request,
        { database: "ci-keep-pr1-db", seed: seedOf("DB") },
        { vars: {}, secrets: {} },
        fakeSeedFunctions(),
      ),
    ).rejects.toThrow(/the seed's hash "admin" is of ADMIN_PASSWORD, which the check did not set/);
    await expect(
      runSeed(
        d1.request,
        { database: "ci-keep-pr1-db", seed: seedOf("DB") },
        { ...inputs(), vars: {} },
        fakeSeedFunctions(),
      ),
    ).rejects.toThrow(/seed statement 1 of 1 on ci-keep-pr1-db: the seed has no value/);
    await expect(
      runSeed(
        d1.request,
        { database: "ci-keep-pr1-gone", seed: seedOf("DB") },
        inputs(),
        fakeSeedFunctions(),
      ),
    ).rejects.toThrow("the database ci-keep-pr1-gone does not exist");
    expect(d1.queries).toEqual([]);
  });
});

describe.skipIf(!appflareAvailable)("seeds with the real @appflare/schema", () => {
  it("accepts the seeded artifact", async () => {
    const schema = await loadAppflareSchema(appflareDir);
    expect(parseOrThrow(schema.artifactManifest, keep(), "keep").format).toBe(1);
  });

  it("stores hashes the app can check: PBKDF2 with its salt, and bcrypt", async (ctx) => {
    const helpers = await loadSeedHelpers(appflareDir).catch(() => null);
    if (helpers === null) return ctx.skip();
    const fns = seedFunctions(helpers);
    const d1 = fakeD1(["ci-keep-pr1-db", "ci-keep-pr1-auth"]);
    await runSeed(d1.request, { database: "ci-keep-pr1-db", seed: seedOf("DB") }, inputs(), fns);
    await runSeed(
      d1.request,
      { database: "ci-keep-pr1-auth", seed: seedOf("AUTH") },
      inputs(),
      fns,
    );
    const [users, admins] = d1.queries.map((q) => q.body.params);
    const [username, email, hash, salt] = users ?? [];
    expect([username, email]).toEqual(["ci-admin", "admin@example.com"]);
    const expected = pbkdf2Sync(
      PASSWORD,
      Buffer.from(salt as string, "base64url"),
      1000,
      32,
      "sha256",
    );
    expect(hash).toBe(expected.toString("base64url"));
    expect(Buffer.from(salt as string, "base64url")).toHaveLength(16);
    const bcryptHash = admins?.[1] as string;
    expect(bcryptHash).toMatch(/^\$2b\$04\$/);
    expect(bcrypt.compareSync(PASSWORD, bcryptHash)).toBe(true);
  });

  it("refuses a statement the manager's guard refuses, before any call", async (ctx) => {
    const helpers = await loadSeedHelpers(appflareDir).catch(() => null);
    if (helpers === null) return ctx.skip();
    const d1 = fakeD1(["ci-keep-pr1-db"]);
    const seed = seedOf("DB");
    seed.statements[0] = { sql: "DELETE FROM users WHERE username = ?", params: [{ value: "x" }] };
    await expect(
      runSeed(d1.request, { database: "ci-keep-pr1-db", seed }, inputs(), seedFunctions(helpers)),
    ).rejects.toThrow(/seed statement 1 cannot run/);
    expect(d1.queries).toEqual([]);
  });

  it("refuses a bcrypt source longer than 72 bytes without repeating it", async (ctx) => {
    const helpers = await loadSeedHelpers(appflareDir).catch(() => null);
    if (helpers === null) return ctx.skip();
    const d1 = fakeD1(["ci-keep-pr1-auth"]);
    const long = "p".repeat(80);
    const run = runSeed(
      d1.request,
      { database: "ci-keep-pr1-auth", seed: seedOf("AUTH") },
      { ...inputs(), secrets: { ADMIN_PASSWORD: long } },
      seedFunctions(helpers),
    );
    await expect(run).rejects.toThrow(/80 bytes long; bcrypt reads at most 72/);
    await run.catch((error: Error) => expect(error.message).not.toContain(long));
    expect(d1.queries).toEqual([]);
  });
});
