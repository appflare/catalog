import { beforeAll, describe, expect, it } from "vitest";
import { appflareAvailable, testSchema } from "../fixtures/schema.ts";
import type { AppflareSchema } from "./appflare-schema.ts";
import { entryWarnings } from "./entry-warnings.ts";

let schema: AppflareSchema;

beforeAll(async () => {
  schema = await testSchema();
});

describe("entryWarnings", () => {
  it("passes the license to licenseWarning and lists what it says", () => {
    const seen: string[] = [];
    const warning = (license: string) => {
      seen.push(license);
      return license === "odd" ? "license is odd" : null;
    };
    expect(entryWarnings({ license: "odd" }, warning)).toEqual(["license is odd"]);
    expect(entryWarnings({ license: "MIT" }, warning)).toEqual([]);
    expect(seen).toEqual(["odd", "MIT"]);
  });

  it("warns with @appflare/schema's licenseWarning for text it cannot place", (ctx) => {
    if (!appflareAvailable) ctx.skip();
    for (const license of ["MIT", "MIT OR Apache-2.0", "NONE", "SEE LICENSE IN LICENSE.md"]) {
      expect(entryWarnings({ license }, schema.licenseWarning)).toEqual([]);
    }
    expect(entryWarnings({ license: "Custom terms" }, schema.licenseWarning)).toEqual([
      expect.stringMatching(/^license is not an SPDX expression: /),
    ]);
    expect(entryWarnings({ license: "none" }, schema.licenseWarning)).toEqual([
      expect.stringContaining('"NONE"'),
    ]);
  });
});
