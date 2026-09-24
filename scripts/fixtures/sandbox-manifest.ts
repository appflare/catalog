import type { AppflareSchema } from "../lib/appflare-schema.ts";
import { parseOrThrow } from "../lib/appflare-schema.ts";
import type { CatalogManifest } from "../lib/types.ts";

/**
 * The `hello` fixture turned into a `sandbox` tier entry that passes the tier
 * rules, parsed by the schema in use (the real one when available).
 */
export function sandboxFixture(
  hello: CatalogManifest,
  schema: AppflareSchema,
  install: Record<string, unknown> = {},
): CatalogManifest {
  return parseOrThrow(
    schema.catalogManifest,
    {
      ...hello,
      slug: "built",
      plan: "paid",
      install: {
        ...hello.install,
        tier: "sandbox",
        workerName: "built",
        buildCommand: "pnpm run build",
        ...install,
      },
    },
    "sandbox fixture",
  );
}

/**
 * The `hello` fixture turned into a `self-deploying` tier entry that passes
 * the tier rules, parsed by the schema in use (the real one when available).
 */
export function selfDeployingFixture(
  hello: CatalogManifest,
  schema: AppflareSchema,
  over: Record<string, unknown> = {},
): CatalogManifest {
  return parseOrThrow(
    schema.catalogManifest,
    {
      ...hello,
      slug: "seo",
      plan: "paid",
      install: {
        ...hello.install,
        tier: "self-deploying",
        workerName: "seo",
        selfDeploying: {
          tool: "alchemy",
          deployCommand: ["pnpm", "alchemy", "deploy", "--yes"],
          destroyCommand: ["pnpm", "alchemy", "destroy", "--yes"],
          stateStore: "cloudflare",
          workers: ["seo-{{stage}}", "seo-{{stage}}-worker"],
        },
        sandbox: { expectedMinutes: 15, instanceType: "standard-2" },
      },
      tokenPermissions: [{ name: "Workers Scripts", scope: "account" }],
      ...over,
    },
    "self-deploying fixture",
  );
}
