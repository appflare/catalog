import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appflareAvailable, appflareDir } from "../fixtures/schema.ts";
import { appflarePaths, schemaFile } from "./paths.ts";

describe.skipIf(!appflareAvailable)("schema/v1.json", () => {
  it("equals @appflare/schema's json-schema/v1.json byte for byte (run `pnpm sync-schema`)", () => {
    const source = readFileSync(appflarePaths(appflareDir).schemaJson, "utf8");
    expect(readFileSync(schemaFile, "utf8")).toBe(source);
  });
});

describe("schema/v1.json (always)", () => {
  it("is the catalog manifest schema published at the $schema URL", () => {
    const schema = JSON.parse(readFileSync(schemaFile, "utf8")) as { $id?: string };
    expect(schema.$id).toBe("https://appflare.github.io/catalog/schema/v1.json");
  });
});
