import { describe, expect, it } from "vitest";
import { licenseProblems } from "./license-rules.ts";

describe("licenseProblems", () => {
  it("asks for a licenseNote next to a LicenseRef license", () => {
    expect(licenseProblems({ license: "LicenseRef-Acme-Source-Available" })).toEqual([
      expect.stringMatching(/^- licenseNote: license LicenseRef-Acme-Source-Available is not/),
    ]);
    expect(licenseProblems({ license: "MIT OR LicenseRef-Acme" })).toHaveLength(1);
  });

  it("accepts a LicenseRef license with a note, and SPDX ids without one", () => {
    expect(
      licenseProblems({ license: "LicenseRef-Acme", licenseNote: "Source-available" }),
    ).toEqual([]);
    for (const license of ["MIT", "GPL-3.0-or-later", "NONE", "BUSL-1.1"]) {
      expect(licenseProblems({ license })).toEqual([]);
    }
  });
});
