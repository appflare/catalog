import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appflareAvailable, appflareDir } from "../fixtures/schema.ts";
import { loadPackerSecrets, loadPackerWorkerSize } from "./packer-lib.ts";

describe.skipIf(!appflareAvailable)("the packer's functions", () => {
  it("derive a secret as the manager does", async () => {
    const { deriveSecretValue } = await loadPackerSecrets(appflareDir);
    expect(deriveSecretValue("bcrypt", "correct horse")).toMatch(/^\$2b\$10\$[./A-Za-z0-9]{53}$/);
  });

  it("generate a VAPID private key and derive its public key", async () => {
    const { deriveSecretValue, generateVapidPrivateKey } = await loadPackerSecrets(appflareDir);
    const privateKey = generateVapidPrivateKey();
    expect(privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(deriveSecretValue("vapid-public-key", privateKey)).toMatch(/^[A-Za-z0-9_-]{87}$/);
  });

  it("measure a packed Worker and state it against the upload budget", async () => {
    const { artifactWorkerSize, workerSizeLine } = await loadPackerWorkerSize(appflareDir);
    const dir = mkdtempSync(path.join(tmpdir(), "catalog-size-"));
    try {
      const zip = path.join(dir, "x.zip");
      writeFileSync(zip, "headerexport default {};tail");
      const size = artifactWorkerSize(zip, [{ offset: 6, size: 18 }]);
      expect(size.size).toBe(18);
      expect(size.ranges).toBe(1);
      expect(workerSizeLine(size, 1)).toMatch(
        /^1 module in 1 range, 0\.02 KiB of at most 32\.00 MiB \(gzip [\d.]+ KiB, not limited\)$/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
