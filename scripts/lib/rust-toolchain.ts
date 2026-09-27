import path from "node:path";

/**
 * The Rust toolchain a catalog entry's build needs, for the pack jobs in CI.
 * An entry lists `"rust"` in `install.toolchains` when its build runs
 * `worker-build` (workers-rs). The toolchain is the one the checkout pins in a
 * `rust-toolchain.toml` (or a legacy `rust-toolchain`) at the entry's pinned
 * commit, found the way rustup finds it when the build runs cargo beside a
 * wrangler config: the nearest directory at or above the config's that has
 * one. Without one, CI's own pinned stable release (`RUST_TOOLCHAIN`) is used.
 * Either way the `wasm32-unknown-unknown` target is added, since that is what
 * `worker-build` compiles for.
 */

/** The target every Rust Worker compiles to. */
export const WASM_TARGET = "wasm32-unknown-unknown";

/** Toolchain, component and target names as rustup takes them; nothing a shell would expand. */
const RUSTUP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** An exact stable release, the only thing `RUST_TOOLCHAIN` may hold. */
const EXACT_RELEASE = /^\d+\.\d+\.\d+$/;

/** What `rustup toolchain install` is run with. */
export interface RustToolchainPlan {
  toolchain: string;
  targets: string[];
  components: string[];
  /** Where the toolchain came from, for the log. */
  source: string;
}

/** What a toolchain file asks for. */
export interface ToolchainFile {
  channel: string | null;
  targets: string[];
  components: string[];
}

/** The parts of a catalog manifest this module reads. */
export interface RustManifest {
  install: {
    wranglerConfig: string;
    toolchains?: readonly string[];
    workers?: readonly { wranglerConfig: string }[];
  };
}

/** Reads a file of the upstream checkout at the pinned commit; null when it does not exist. */
export type ReadUpstreamFile = (relativePath: string) => Promise<string | null>;

/** Whether the entry's build needs Rust (`install.toolchains` lists `rust`). */
export function needsRust(manifest: RustManifest): boolean {
  return manifest.install.toolchains?.includes("rust") ?? false;
}

/**
 * The toolchain files rustup would read for a build beside each of the
 * entry's wrangler configs, nearest first, as checkout-relative paths. In one
 * directory a legacy `rust-toolchain` wins over `rust-toolchain.toml`, as
 * rustup has it.
 */
export function toolchainFileCandidates(manifest: RustManifest): string[][] {
  const configs = [
    manifest.install.wranglerConfig,
    ...(manifest.install.workers ?? []).map((w) => w.wranglerConfig),
  ];
  const seen = new Set<string>();
  const perConfig: string[][] = [];
  for (const config of configs) {
    const start = path.posix.dirname(path.posix.normalize(config));
    if (seen.has(start)) continue;
    seen.add(start);
    const candidates: string[] = [];
    let dir = start;
    for (;;) {
      for (const name of ["rust-toolchain", "rust-toolchain.toml"]) {
        candidates.push(dir === "." ? name : `${dir}/${name}`);
      }
      if (dir === "." || dir === "/" || dir === "") break;
      dir = path.posix.dirname(dir);
    }
    perConfig.push(candidates);
  }
  return perConfig;
}

function checkedName(value: string, what: string, file: string): string {
  if (!RUSTUP_NAME.test(value)) {
    throw new Error(`${file}: ${what} ${JSON.stringify(value)} is not a rustup name`);
  }
  return value;
}

function stringList(section: string, key: string, file: string): string[] {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m").exec(section);
  if (!match?.[1]) return [];
  return [...match[1].matchAll(/["']([^"']*)["']/g)].map((m) =>
    checkedName(m[1] ?? "", key.replace(/s$/, ""), file),
  );
}

/**
 * Parses a `rust-toolchain.toml`, or a legacy `rust-toolchain` (either the
 * same TOML or a bare channel name). Reads `channel`, `targets` and
 * `components` of the `[toolchain]` table; refuses `path`, a custom
 * toolchain CI cannot install.
 */
export function parseToolchainFile(file: string, text: string): ToolchainFile {
  const uncommented = text
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trimEnd())
    .join("\n");
  if (!/^\s*\[toolchain\]\s*$/m.test(uncommented)) {
    const channel = uncommented.trim();
    if (
      path.posix.basename(file) === "rust-toolchain" &&
      channel !== "" &&
      !channel.includes("\n")
    ) {
      return { channel: checkedName(channel, "channel", file), targets: [], components: [] };
    }
    throw new Error(`${file}: no [toolchain] table`);
  }
  const start = uncommented.search(/^\s*\[toolchain\]\s*$/m);
  const rest = uncommented.slice(start).replace(/^\s*\[toolchain\]\s*$/m, "");
  const next = rest.search(/^\s*\[/m);
  const section = next === -1 ? rest : rest.slice(0, next);
  if (/^\s*path\s*=/m.test(section)) {
    throw new Error(
      `${file}: a toolchain "path" names a custom toolchain, which CI cannot install`,
    );
  }
  const channel = /^\s*channel\s*=\s*["']([^"']*)["']/m.exec(section)?.[1];
  return {
    channel: channel === undefined ? null : checkedName(channel, "channel", file),
    targets: stringList(section, "targets", file),
    components: stringList(section, "components", file),
  };
}

/**
 * The toolchain to install for an entry that needs Rust: the channel of the
 * toolchain file nearest each wrangler config, which must agree across
 * configs, else `fallback` (`RUST_TOOLCHAIN`, an exact stable release). The
 * files' targets and components are installed too, with
 * {@link WASM_TARGET} always among the targets.
 */
export async function resolveRustToolchain(
  manifest: RustManifest,
  fallback: string | undefined,
  readFile: ReadUpstreamFile,
): Promise<RustToolchainPlan> {
  const found: { file: string; parsed: ToolchainFile }[] = [];
  for (const candidates of toolchainFileCandidates(manifest)) {
    for (const file of candidates) {
      const text = await readFile(file);
      if (text === null) continue;
      if (!found.some((f) => f.file === file)) {
        found.push({ file, parsed: parseToolchainFile(file, text) });
      }
      break;
    }
  }
  const channels = [...new Set(found.map((f) => f.parsed.channel).filter((c) => c !== null))];
  if (channels.length > 1) {
    throw new Error(
      `the checkout's toolchain files ask for different toolchains (${found
        .map((f) => `${f.file}: ${f.parsed.channel ?? "none"}`)
        .join(", ")}); CI installs one`,
    );
  }
  const targets = new Set([WASM_TARGET, ...found.flatMap((f) => f.parsed.targets)]);
  const components = new Set(found.flatMap((f) => f.parsed.components));
  const channel = channels[0];
  if (channel !== undefined) {
    const files = found.filter((f) => f.parsed.channel !== null).map((f) => f.file);
    return {
      toolchain: channel,
      targets: [...targets],
      components: [...components],
      source: files.join(", "),
    };
  }
  const pinned = fallback?.trim() ?? "";
  if (!EXACT_RELEASE.test(pinned)) {
    throw new Error(
      `the checkout pins no Rust toolchain, and RUST_TOOLCHAIN is ${pinned === "" ? "unset" : JSON.stringify(pinned)}; set it to an exact stable release such as 1.98.1`,
    );
  }
  return {
    toolchain: pinned,
    targets: [...targets],
    components: [...components],
    source: "RUST_TOOLCHAIN",
  };
}

/** `key=value` lines for `$GITHUB_OUTPUT`: `rust=false`, or the toolchain and what to add to it. */
export function outputLines(plan: RustToolchainPlan | null): string[] {
  if (plan === null) return ["rust=false"];
  return [
    "rust=true",
    `toolchain=${plan.toolchain}`,
    `targets=${plan.targets.join(" ")}`,
    `components=${plan.components.join(" ")}`,
  ];
}

/**
 * Reads a file of `repo` at `sha` from raw.githubusercontent.com: null on
 * 404, an error on any other failure.
 */
export function githubRawReader(
  repo: string,
  sha: string,
  fetchImpl: typeof fetch = fetch,
): ReadUpstreamFile {
  return async (relativePath) => {
    const url = `https://raw.githubusercontent.com/${repo}/${sha}/${relativePath
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
    const res = await fetchImpl(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`reading ${url} failed with HTTP ${res.status}`);
    return res.text();
  };
}
