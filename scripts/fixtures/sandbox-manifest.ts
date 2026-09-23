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
