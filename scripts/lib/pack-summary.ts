import type { ArtifactManifest, ArtifactWorker, CatalogManifest } from "./types.ts";

/** One Worker of an artifact as `pack-app` reports it. */
export interface PackedWorkerSummary {
  /** Its name within the entry, or null for an app of one Worker. */
  name: string | null;
  primary: boolean;
  worker: ArtifactWorker;
  assetCount: number;
}

/**
 * Every Worker of an artifact, the primary one first and the others in the
 * catalog entry's order (the order of `workers`). Format 1 has one, unnamed.
 */
export function packedWorkers(artifact: ArtifactManifest): PackedWorkerSummary[] {
  // Parsed by the real artifact manifest schema, so a full catalog manifest.
  const declared = (artifact.catalog as CatalogManifest).install.workers;
  const primary: PackedWorkerSummary = {
    name: artifact.format === 2 ? (declared?.find((w) => w.primary)?.name ?? null) : null,
    primary: true,
    worker: artifact.worker,
    assetCount: artifact.assets.files.length,
  };
  const others = artifact.format === 2 ? (artifact.workers ?? []) : [];
  return [
    primary,
    ...others.map((w) => ({
      name: w.name,
      primary: false,
      worker: w.worker,
      assetCount: w.assets.files.length,
    })),
  ];
}

function configLine(worker: ArtifactWorker, label: string): string[] {
  const configs = worker.wranglerConfig;
  if (configs === undefined) return [];
  const redirected =
    configs.effective === configs.declared ? "" : ` (redirected from ${configs.declared})`;
  return [`${label}${configs.effective}${redirected}`];
}

/**
 * The `config`, `worker` and `assets` lines of `pack-app`'s summary.
 * `sizeLine` describes one Worker's modules (size and count against the
 * limits). An app of one Worker gets the three lines it always had; an app of
 * several gets them once per Worker, under a line naming it.
 */
export function workerSummaryLines(
  artifact: ArtifactManifest,
  sizeLine: (worker: ArtifactWorker) => string,
): string[] {
  const workers = packedWorkers(artifact);
  const only = workers[0];
  if (workers.length === 1 && only !== undefined) {
    return [
      ...configLine(only.worker, "  config:     "),
      `  worker:     ${sizeLine(only.worker)}`,
      `  assets:     ${only.assetCount}`,
    ];
  }
  return workers.flatMap((w) => [
    `  Worker ${w.name ?? w.worker.name}${w.primary ? " (primary)" : ""}:`,
    ...configLine(w.worker, "    config:   "),
    `    worker:   ${sizeLine(w.worker)}`,
    `    assets:   ${w.assetCount}`,
  ]);
}
