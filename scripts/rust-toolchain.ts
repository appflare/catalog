import { parseArgs } from "node:util";
import { loadAppflareSchema } from "./lib/appflare-schema.ts";
import { findApp, loadManifest } from "./lib/apps.ts";
import { info, runMain } from "./lib/cli.ts";
import { appsDir, resolveAppflareDir } from "./lib/paths.ts";
import {
  githubRawReader,
  needsRust,
  outputLines,
  resolveRustToolchain,
} from "./lib/rust-toolchain.ts";

const USAGE = `Usage: node scripts/rust-toolchain.ts <slug>

Prints, as key=value lines for $GITHUB_OUTPUT, the Rust toolchain the app's
build needs: "rust=false" when its install.toolchains does not list rust;
otherwise "rust=true", "toolchain=<name>", "targets=<names>" (always with
wasm32-unknown-unknown) and "components=<names>". The toolchain is the one the
upstream checkout pins in rust-toolchain.toml (or rust-toolchain) at the
entry's pinned commit, nearest the wrangler config; without one, the exact
stable release in RUST_TOOLCHAIN. APPFLARE_DIR points at a built appflare
checkout or packer bundle.
`;

runMain(async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" } },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const slug = positionals[0];
  if (!slug || positionals.length > 1) {
    process.stderr.write(`error: expected exactly one <slug>\n\n${USAGE}`);
    return 1;
  }
  const schema = await loadAppflareSchema(resolveAppflareDir());
  const manifest = loadManifest(findApp(appsDir, slug), schema.catalogManifest);
  if (!needsRust(manifest)) {
    info(`${slug} lists no rust toolchain`);
    process.stdout.write(`${outputLines(null).join("\n")}\n`);
    return 0;
  }
  const plan = await resolveRustToolchain(
    manifest,
    process.env.RUST_TOOLCHAIN,
    githubRawReader(manifest.repo, manifest.source.sha),
  );
  info(`${slug} builds with Rust ${plan.toolchain} (from ${plan.source})`);
  process.stdout.write(`${outputLines(plan).join("\n")}\n`);
  return 0;
});
