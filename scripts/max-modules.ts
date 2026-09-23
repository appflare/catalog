import { loadAppflareSchema } from "./lib/appflare-schema.ts";
import { runMain } from "./lib/cli.ts";
import { resolveAppflareDir } from "./lib/paths.ts";

// Prints MAX_WORKER_MODULES from @appflare/schema (APPFLARE_DIR), for
// `appflare-pack verify --max-modules` in the workflows. Needs no dependencies.
runMain(async () => {
  const schema = await loadAppflareSchema(resolveAppflareDir());
  process.stdout.write(`${schema.maxWorkerModules}\n`);
  return 0;
});
