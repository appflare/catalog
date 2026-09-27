import { describe, expect, it } from "vitest";
import {
  githubRawReader,
  needsRust,
  outputLines,
  parseToolchainFile,
  type RustManifest,
  resolveRustToolchain,
  toolchainFileCandidates,
  WASM_TARGET,
} from "./rust-toolchain.ts";

const rustApp = (install: Partial<RustManifest["install"]> = {}): RustManifest => ({
  install: { wranglerConfig: "wrangler.toml", toolchains: ["rust"], ...install },
});

function files(entries: Record<string, string>) {
  const read: string[] = [];
  return {
    read,
    reader: async (p: string) => {
      read.push(p);
      return entries[p] ?? null;
    },
  };
}

describe("needsRust", () => {
  it("is true only when install.toolchains lists rust", () => {
    expect(needsRust(rustApp())).toBe(true);
    expect(needsRust({ install: { wranglerConfig: "wrangler.toml" } })).toBe(false);
  });
});

describe("toolchainFileCandidates", () => {
  it("walks from each config's directory to the root, legacy name first", () => {
    expect(
      toolchainFileCandidates(
        rustApp({
          wranglerConfig: "packages/api/wrangler.jsonc",
          workers: [
            { wranglerConfig: "packages/api/wrangler.jsonc" },
            { wranglerConfig: "./worker/wrangler.toml" },
          ],
        }),
      ),
    ).toEqual([
      [
        "packages/api/rust-toolchain",
        "packages/api/rust-toolchain.toml",
        "packages/rust-toolchain",
        "packages/rust-toolchain.toml",
        "rust-toolchain",
        "rust-toolchain.toml",
      ],
      [
        "worker/rust-toolchain",
        "worker/rust-toolchain.toml",
        "rust-toolchain",
        "rust-toolchain.toml",
      ],
    ]);
  });
});

describe("parseToolchainFile", () => {
  it("reads channel, targets and components of [toolchain]", () => {
    const text = `# pinned for worker-build
[toolchain]
channel = "1.90.0" # the release CI tests
components = [
  "rustfmt",
  'clippy',
]
targets = ["wasm32-unknown-unknown"]
profile = "minimal"

[other]
channel = "nightly"
`;
    expect(parseToolchainFile("rust-toolchain.toml", text)).toEqual({
      channel: "1.90.0",
      components: ["rustfmt", "clippy"],
      targets: ["wasm32-unknown-unknown"],
    });
  });

  it("reads a legacy rust-toolchain holding a bare channel", () => {
    expect(parseToolchainFile("rust-toolchain", "nightly-2026-08-01\n")).toEqual({
      channel: "nightly-2026-08-01",
      components: [],
      targets: [],
    });
  });

  it("allows a [toolchain] without a channel", () => {
    expect(parseToolchainFile("rust-toolchain.toml", '[toolchain]\ntargets = ["x"]\n')).toEqual({
      channel: null,
      components: [],
      targets: ["x"],
    });
  });

  it("refuses a custom toolchain path, a missing table, and names a shell could expand", () => {
    expect(() =>
      parseToolchainFile("rust-toolchain.toml", '[toolchain]\npath = "/opt/rust"\n'),
    ).toThrow(/custom toolchain/);
    expect(() => parseToolchainFile("rust-toolchain.toml", 'channel = "stable"\n')).toThrow(
      /no \[toolchain\] table/,
    );
    expect(() =>
      parseToolchainFile("rust-toolchain.toml", '[toolchain]\nchannel = "$(curl x)"\n'),
    ).toThrow(/not a rustup name/);
    expect(() =>
      parseToolchainFile("rust-toolchain.toml", '[toolchain]\ncomponents = ["a b"]\n'),
    ).toThrow(/component "a b" is not a rustup name/);
  });
});

describe("resolveRustToolchain", () => {
  it("uses the nearest toolchain file and always adds the wasm32 target", async () => {
    const { reader, read } = files({
      "rust-toolchain.toml": '[toolchain]\nchannel = "1.85.0"\ncomponents = ["rust-src"]\n',
      "api/rust-toolchain.toml": '[toolchain]\nchannel = "1.91.1"\n',
    });
    const plan = await resolveRustToolchain(
      rustApp({ wranglerConfig: "api/wrangler.toml" }),
      "1.98.1",
      reader,
    );
    expect(plan).toEqual({
      toolchain: "1.91.1",
      targets: [WASM_TARGET],
      components: [],
      source: "api/rust-toolchain.toml",
    });
    expect(read).toEqual(["api/rust-toolchain", "api/rust-toolchain.toml"]);
  });

  it("falls back to RUST_TOOLCHAIN when the checkout pins none", async () => {
    const plan = await resolveRustToolchain(rustApp(), " 1.98.1 ", files({}).reader);
    expect(plan).toEqual({
      toolchain: "1.98.1",
      targets: [WASM_TARGET],
      components: [],
      source: "RUST_TOOLCHAIN",
    });
  });

  it("keeps a channel-less file's targets and components with the fallback", async () => {
    const { reader } = files({
      "rust-toolchain.toml":
        '[toolchain]\ntargets = ["wasm32-wasip1"]\ncomponents = ["rust-src"]\n',
    });
    expect(await resolveRustToolchain(rustApp(), "1.98.1", reader)).toMatchObject({
      toolchain: "1.98.1",
      targets: [WASM_TARGET, "wasm32-wasip1"],
      components: ["rust-src"],
    });
  });

  it("refuses a missing or inexact RUST_TOOLCHAIN when it is needed", async () => {
    await expect(resolveRustToolchain(rustApp(), undefined, files({}).reader)).rejects.toThrow(
      /RUST_TOOLCHAIN is unset/,
    );
    await expect(resolveRustToolchain(rustApp(), "stable", files({}).reader)).rejects.toThrow(
      /exact stable release/,
    );
  });

  it("refuses configs whose toolchain files disagree", async () => {
    const { reader } = files({
      "a/rust-toolchain.toml": '[toolchain]\nchannel = "1.90.0"\n',
      "b/rust-toolchain": "1.91.0\n",
    });
    await expect(
      resolveRustToolchain(
        rustApp({
          wranglerConfig: "a/wrangler.toml",
          workers: [{ wranglerConfig: "b/wrangler.toml" }],
        }),
        "1.98.1",
        reader,
      ),
    ).rejects.toThrow(/different toolchains/);
  });
});

describe("outputLines", () => {
  it("prints rust=false, or the toolchain and its additions", () => {
    expect(outputLines(null)).toEqual(["rust=false"]);
    expect(
      outputLines({
        toolchain: "1.98.1",
        targets: [WASM_TARGET, "x"],
        components: [],
        source: "RUST_TOOLCHAIN",
      }),
    ).toEqual(["rust=true", "toolchain=1.98.1", `targets=${WASM_TARGET} x`, "components="]);
  });
});

describe("githubRawReader", () => {
  it("reads the file at the pinned commit, with null for 404", async () => {
    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      return url.endsWith(".toml")
        ? new Response('[toolchain]\nchannel = "1.90.0"\n')
        : new Response("Not Found", { status: 404 });
    }) as typeof fetch;
    const read = githubRawReader("owner/repo", "abc123", fake);
    expect(await read("rust-toolchain")).toBeNull();
    expect(await read("a b/rust-toolchain.toml")).toContain("1.90.0");
    expect(urls).toEqual([
      "https://raw.githubusercontent.com/owner/repo/abc123/rust-toolchain",
      "https://raw.githubusercontent.com/owner/repo/abc123/a%20b/rust-toolchain.toml",
    ]);
  });

  it("fails on any other status", async () => {
    const fake = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    await expect(githubRawReader("o/r", "s", fake)("rust-toolchain")).rejects.toThrow(/HTTP 500/);
  });
});
