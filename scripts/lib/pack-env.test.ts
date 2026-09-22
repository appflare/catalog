import { describe, expect, it } from "vitest";
import { packerEnv, SIGNING_KEY_ENV } from "./pack-env.ts";

describe("packerEnv", () => {
  it("drops GitHub credentials and the signing key", () => {
    expect(
      packerEnv({
        PATH: "/usr/bin",
        [SIGNING_KEY_ENV]: "k",
        GITHUB_TOKEN: "t",
        GH_TOKEN: "t",
        APPFLARE_REPO_TOKEN: "t",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t",
      }),
    ).toEqual({ PATH: "/usr/bin" });
  });
});
