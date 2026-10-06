import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type AppEntry, findApp } from "./apps.ts";
import {
  type AppPin,
  appDirectories,
  appDirectory,
  applyBump,
  type Bump,
  decideBump,
  gateBump,
  gateOnAppDirectories,
  outstandingBumps,
  planBumps,
  readAutoMerge,
  readPin,
  renderBumpBody,
  TAG_PIN_NOTE,
  type UpstreamState,
} from "./bump.ts";
import { parseJsonc } from "./jsonc.ts";
import type { ChangedFiles, UpstreamSource } from "./upstream.ts";

const fixtureApps = path.join(import.meta.dirname, "..", "fixtures", "apps");
const hello = findApp(fixtureApps, "hello");
const PIN = "0123456789abcdef0123456789abcdef01234567";
const NEW = "89abcdef0123456789abcdef0123456789abcdef";

const tagPin = readPin(hello); // source.ref v1.2.3
const branchPin: AppPin = { ...tagPin, source: { ref: "main", sha: PIN } };
const rcPin: AppPin = { ...tagPin, source: { ref: "v2.0.0-rc.1", sha: PIN } };
const never = () => {
  throw new Error("must not compare");
};
const noBranch = () => {
  throw new Error("must not read the default branch");
};
/** Upstream with one tag and a branch main at the pinned commit; its default branch must not be read. */
const tag = (name: string, sha = NEW): UpstreamState => ({
  tags: [{ name, sha }],
  branch: (b) => (b === "main" ? { name: b, sha: PIN } : null),
  defaultBranch: noBranch,
});
/** Upstream without tags, its default branch `name` at `sha`. */
const head = (sha = NEW, name = "main"): UpstreamState => ({
  tags: [],
  branch: (b) => (b === name ? { name, sha } : null),
  defaultBranch: () => ({ name, sha }),
});

function bumped(decision: ReturnType<typeof decideBump>): Bump {
  if (decision.action !== "bump") {
    throw new Error(`expected a bump, got: ${decision.reason}`);
  }
  return decision.bump;
}

describe("decideBump for a tag pin", () => {
  it("moves to a newer stable tag", () => {
    expect(bumped(decideBump(tagPin, tag("v1.3.0"), never))).toEqual({
      slug: "hello",
      repo: "example/hello",
      from: { ref: "v1.2.3", sha: PIN },
      to: { ref: "v1.3.0", sha: NEW, kind: "tag" },
      branch: "bump/hello/89abcde",
      title: "chore(hello): bump to v1.3.0",
      autoMerge: true,
    });
  });

  it("never downgrades or moves sideways", () => {
    expect(decideBump(tagPin, tag("v1.2.2"), never)).toEqual({
      action: "skip",
      reason: "newest tag v1.2.2 is not newer than v1.2.3",
    });
    expect(decideBump(tagPin, tag("1.2.3"), never).action).toBe("skip");
  });

  it("does not fall back to a branch head", () => {
    expect(decideBump(tagPin, head(), never).action).toBe("skip");
  });

  it("is up to date when nothing moved", () => {
    expect(decideBump(tagPin, tag("v1.2.3", PIN), never)).toEqual({
      action: "skip",
      reason: "up to date",
    });
  });
});

describe("decideBump for other pins", () => {
  it("leaves a prerelease pin alone", () => {
    expect(decideBump(rcPin, tag("v2.0.0"), never)).toEqual({
      action: "skip",
      reason: "pinned to prerelease v2.0.0-rc.1; left alone",
    });
  });

  it("leaves a pin on a tag that is not a semver release alone", () => {
    const monorepoTag: AppPin = { ...tagPin, source: { ref: "app-v0.42.1", sha: PIN } };
    const upstream: UpstreamState = {
      tags: [
        { name: "app-v0.43.0", sha: NEW },
        { name: "app-v0.42.1", sha: PIN },
      ],
      branch: () => null,
      defaultBranch: noBranch,
    };
    expect(decideBump(monorepoTag, upstream, never)).toEqual({
      action: "skip",
      reason: "pinned to tag app-v0.42.1, which is not a semver release; left alone",
    });
  });

  it("keeps a semver pin on tags after upstream deleted its tag", () => {
    expect(decideBump(tagPin, head(), never)).toEqual({
      action: "skip",
      reason: "pinned to tag v1.2.3, but upstream has no stable tag now; not moving to a branch",
    });
  });

  it("moves a branch pin only when the new head is ahead of it", () => {
    const asked: string[] = [];
    const ahead = (n: number) => (base: string, h: string) => {
      asked.push(`${base}...${h}`);
      return { ahead: n, behind: 0 };
    };
    expect(bumped(decideBump(branchPin, head(), ahead(3))).title).toBe(
      "chore(hello): bump to main@89abcde",
    );
    expect(asked).toEqual([`${PIN}...${NEW}`]);
    expect(decideBump(branchPin, head(), ahead(0)).action).toBe("skip");
    expect(decideBump(branchPin, head(PIN), never).action).toBe("skip");
  });

  it("moves a branch pin to a stable tag on the pinned commit, without comparing", () => {
    const b = bumped(decideBump(branchPin, tag("v0.1.0", PIN), never));
    expect(b).toMatchObject({
      from: { ref: "main", sha: PIN },
      to: { ref: "v0.1.0", sha: PIN, kind: "tag" },
      title: "chore(hello): bump to v0.1.0",
      note: TAG_PIN_NOTE,
    });
    expect(renderBumpBody(branchPin, b, null)).toContain(`Why: ${TAG_PIN_NOTE}.`);
    expect(renderBumpBody(branchPin, b, { total: 0, subjects: [] })).toContain(
      "No new commits: the target is the pinned commit.",
    );
  });

  it("moves a branch pin to a stable tag on a later commit", () => {
    const b = bumped(decideBump(branchPin, tag("v1.0.0"), () => ({ ahead: 5, behind: 0 })));
    expect(b.to).toEqual({ ref: "v1.0.0", sha: NEW, kind: "tag" });
  });

  it("does not move a branch pin to a tag on an older or unrelated commit", () => {
    const olderTag = (sha: string): UpstreamState => ({
      ...tag("v1.0.0"),
      branch: (name) => ({ name, sha }),
    });
    expect(decideBump(branchPin, olderTag(PIN), () => ({ ahead: 0, behind: 3 }))).toEqual({
      action: "skip",
      reason: "up to date; tag v1.0.0@89abcde does not contain the pinned 0123456",
    });
    expect(decideBump(branchPin, olderTag(PIN), () => ({ ahead: 2, behind: 4 })).action).toBe(
      "skip",
    );
    // A tag left on history upstream later rewrote (apps/clist): no common ancestor.
    expect(decideBump(branchPin, olderTag(PIN), () => null)).toEqual({
      action: "skip",
      reason: "up to date; tag v1.0.0@89abcde shares no history with the pinned 0123456",
    });
  });

  describe("when upstream's newest tag predates the branch pin", () => {
    const RENAMED =
      "upstream has no branch main now (it was renamed or deleted), so the pin follows trunk, " +
      "the default branch";
    const TAG = "fedcba9876543210fedcba9876543210fedcba98";
    const HEAD = "4444444444444444444444444444444444444444";
    // Tags from before the pinned commit, and a default branch renamed from main to trunk.
    const upstream = (sha: string): UpstreamState => ({
      tags: [
        { name: "v2.0.2", sha: TAG },
        { name: "v2.0.1", sha: TAG },
      ],
      branch: (name) => (name === "trunk" ? { name, sha } : null),
      defaultBranch: () => ({ name: "trunk", sha }),
    });
    const relation = (base: string, head: string) => {
      expect(base).toBe(PIN);
      return head === TAG ? { ahead: 0, behind: 12 } : { ahead: 3, behind: 0 };
    };

    it("follows the default branch head, under the branch's new name, without merging itself", () => {
      const b = bumped(decideBump(branchPin, upstream(HEAD), relation));
      expect(b).toMatchObject({
        from: { ref: "main", sha: PIN },
        to: { ref: "trunk", sha: HEAD, kind: "branch" },
        title: "chore(hello): bump to trunk@4444444",
        refChange: RENAMED,
        autoMerge: false,
      });
      expect(b.note).toBeUndefined();
      const body = renderBumpBody(branchPin, b, null);
      expect(body).toContain(
        `The ref changes from \`main\` to \`trunk\`: ${RENAMED}. A bump that changes ` +
          "`source.ref` to another branch never merges itself.",
      );
      expect(body).toContain(
        "**A maintainer merges this pull request.** It moves `source.ref` to another branch",
      );
      expect(body).not.toContain("merges itself.**");
    });

    it("stays while the renamed branch still points at the pinned commit", () => {
      expect(decideBump(branchPin, upstream(PIN), relation)).toEqual({
        action: "skip",
        reason:
          `${RENAMED}, which still points at the pinned commit; ` +
          "tag v2.0.2@fedcba9 does not contain the pinned 0123456",
      });
    });

    it("still prefers a later tag that contains the pinned commit", () => {
      const tagged: UpstreamState = {
        ...upstream(HEAD),
        tags: [{ name: "v2.1.0", sha: HEAD }],
        defaultBranch: noBranch,
      };
      expect(bumped(decideBump(branchPin, tagged, relation))).toMatchObject({
        to: { ref: "v2.1.0", sha: HEAD, kind: "tag" },
        note: TAG_PIN_NOTE,
      });
    });
  });

  it("follows a branch that is not the default one, and merges itself", () => {
    const nextPin: AppPin = { ...tagPin, source: { ref: "next", sha: PIN } };
    const upstream: UpstreamState = {
      tags: [],
      branch: (name) => (name === "next" ? { name, sha: NEW } : null),
      defaultBranch: noBranch,
    };
    const b = bumped(decideBump(nextPin, upstream, () => ({ ahead: 2, behind: 0 })));
    expect(b).toMatchObject({ to: { ref: "next", sha: NEW, kind: "branch" }, autoMerge: true });
    expect(b.refChange).toBeUndefined();
    expect(renderBumpBody(nextPin, b, null)).not.toContain("The ref changes");
  });

  it("treats a ref upstream has as both a branch and a tag as the branch", () => {
    const pin: AppPin = { ...tagPin, source: { ref: "stable", sha: PIN } };
    const upstream = (branch: boolean): UpstreamState => ({
      tags: [{ name: "stable", sha: PIN }],
      branch: (name) => (branch ? { name, sha: NEW } : null),
      defaultBranch: noBranch,
    });
    expect(bumped(decideBump(pin, upstream(true), () => ({ ahead: 1, behind: 0 }))).to).toEqual({
      ref: "stable",
      sha: NEW,
      kind: "branch",
    });
    expect(decideBump(pin, upstream(false), never)).toEqual({
      action: "skip",
      reason: "pinned to tag stable, which is not a semver release; left alone",
    });
  });

  describe("when upstream has the pinned ref neither as a branch nor as a tag", () => {
    const gone = (lastBumpTag: string | null = null): UpstreamState => ({
      tags: [{ name: "app-v0.43.0", sha: NEW }],
      branch: () => null,
      defaultBranch: () => ({ name: "main", sha: NEW }),
      lastBumpTag: () => lastBumpTag,
    });

    it("never moves a pin that looks like a tag to a branch", () => {
      for (const ref of ["app-v0.42.1", "deepcrawl@0.5.5", "web-v0.1.1", "release-1.2"]) {
        const pin: AppPin = { ...tagPin, source: { ref, sha: PIN } };
        expect(decideBump(pin, gone(), never)).toEqual({
          action: "skip",
          reason:
            `pinned to ${ref}, which upstream has neither as a branch nor as a tag now, and ` +
            "it looks like a tag; not moving to a branch, choose the new pin by hand",
        });
      }
    });

    it("never moves a pin its last bump put on that tag to a branch", () => {
      const pin: AppPin = { ...tagPin, source: { ref: "stable", sha: PIN } };
      expect(decideBump(pin, gone("stable"), never)).toEqual({
        action: "skip",
        reason:
          "pinned to stable, which upstream has neither as a branch nor as a tag now, and " +
          "the last bump moved the app to that tag; not moving to a branch, choose the new pin by hand",
      });
    });

    it("moves any other pin to the default branch, leaving the merge to a maintainer", () => {
      const pin: AppPin = { ...tagPin, source: { ref: "stable", sha: PIN } };
      const b = bumped(decideBump(pin, gone("v1.0.0"), () => ({ ahead: 1, behind: 0 })));
      expect(b).toMatchObject({
        to: { ref: "main", sha: NEW, kind: "branch" },
        refChange:
          "upstream has no branch stable now (it was renamed or deleted), so the pin follows " +
          "main, the default branch",
        autoMerge: false,
      });
    });
  });

  it("refuses to choose for a branch pin whose new head shares no history with it", () => {
    expect(() => decideBump(branchPin, head(), () => null)).toThrow(
      "main@89abcde shares no history with the pinned 0123456 (upstream rewrote its history)",
    );
  });

  it("does not bump a branch pin to a head that is behind or diverged without new commits", () => {
    expect(decideBump(branchPin, head(), () => ({ ahead: 0, behind: 2 })).action).toBe("skip");
  });

  it("keeps the title within the commit header limit", () => {
    const long = tag(`v1.3.0+${"x".repeat(80)}`);
    expect(bumped(decideBump(tagPin, long, never)).title).toBe("chore(hello): bump to 89abcde");
  });
});

describe("appDirectory", () => {
  it("is the wrangler config's directory, or null at the repository root", () => {
    expect(appDirectory("wrangler.jsonc")).toBeNull();
    expect(appDirectory("./wrangler.toml")).toBeNull();
    expect(appDirectory("r2-explorer-template/wrangler.json")).toBe("r2-explorer-template");
    expect(appDirectory("./apps/web/wrangler.jsonc")).toBe("apps/web");
  });
});

describe("appDirectories", () => {
  const withWorkers = (primary: string, ...others: string[]): AppPin => ({
    ...tagPin,
    install: {
      wranglerConfig: primary,
      workers: [primary, ...others].map((wranglerConfig) => ({ wranglerConfig })),
    },
  });

  it("is the primary config's directory for a single-Worker entry", () => {
    expect(appDirectories(tagPin)).toBeNull();
    expect(
      appDirectories({ ...tagPin, install: { wranglerConfig: "apps/web/wrangler.jsonc" } }),
    ).toEqual(["apps/web"]);
  });

  it("lists every Worker's directory once, sorted", () => {
    expect(
      appDirectories(
        withWorkers(
          "services/email-worker/wrangler.jsonc",
          "services/inbox-worker/wrangler.jsonc",
          "services/email-worker/wrangler.cron.jsonc",
        ),
      ),
    ).toEqual(["services/email-worker", "services/inbox-worker"]);
  });

  it("drops a directory inside another Worker's", () => {
    expect(
      appDirectories(withWorkers("apps/web/wrangler.jsonc", "apps/web/worker/wrangler.jsonc")),
    ).toEqual(["apps/web"]);
  });

  it("adds the directories installDirs declares", () => {
    const pin: AppPin = {
      ...tagPin,
      install: {
        wranglerConfig: "web/wrangler.jsonc",
        installDirs: [{ path: "web" }, { path: "./server/" }, { path: "web/ui" }],
      },
    };
    expect(appDirectories(pin)).toEqual(["server", "web"]);
  });

  it("is null when installDirs declares the repository root", () => {
    const pin: AppPin = {
      ...tagPin,
      install: {
        wranglerConfig: "dashboard/wrangler.jsonc",
        installDirs: [{ path: "." }, { path: "dashboard" }],
      },
    };
    expect(appDirectories(pin)).toBeNull();
  });

  it("is null when any Worker's config is at the repository root", () => {
    expect(appDirectories(withWorkers("agents/db/wrangler.jsonc", "wrangler.jsonc"))).toBeNull();
    expect(appDirectories(withWorkers("wrangler.jsonc", "agents/db/wrangler.jsonc"))).toBeNull();
  });
});

describe("gateOnAppDirectories", () => {
  const monoPin: AppPin = {
    ...tagPin,
    install: { wranglerConfig: "r2-explorer-template/wrangler.json" },
  };
  const bump = bumped(decideBump(monoPin, tag("v1.3.0"), never));
  const files =
    (paths: string[], complete = true) =>
    (): ChangedFiles => ({ paths, complete });

  it("never lists files for an app at the repository root", () => {
    expect(
      gateOnAppDirectories(tagPin, bump, () => {
        throw new Error("must not list files");
      }),
    ).toEqual({ action: "bump", bump });
  });

  it("skips a target that changes nothing under the app's directory", () => {
    const decision = gateOnAppDirectories(
      monoPin,
      bump,
      files(["other-template/src/index.ts", "r2-explorer-template.md", "package.json"]),
    );
    expect(decision).toEqual({
      action: "skip",
      reason:
        "v1.3.0@89abcde changes nothing under r2-explorer-template/ since v1.2.3@0123456; " +
        "not bumping",
    });
  });

  it("keeps a target that changes the app's directory, including a rename out of it", () => {
    expect(
      gateOnAppDirectories(monoPin, bump, files(["r2-explorer-template/package.json"])).action,
    ).toBe("bump");
    expect(
      gateOnAppDirectories(
        monoPin,
        bump,
        files(["elsewhere/wrangler.json", "r2-explorer-template/wrangler.json"]),
      ).action,
    ).toBe("bump");
  });

  it("keeps a target that changes only a Worker other than the primary", () => {
    const multiPin: AppPin = {
      ...tagPin,
      install: {
        wranglerConfig: "apps/web/wrangler.jsonc",
        workers: [
          { wranglerConfig: "apps/web/wrangler.jsonc" },
          { wranglerConfig: "apps/worker/wrangler.jsonc" },
        ],
      },
    };
    expect(gateOnAppDirectories(multiPin, bump, files(["apps/worker/src/check.ts"])).action).toBe(
      "bump",
    );
    expect(gateOnAppDirectories(multiPin, bump, files(["apps/docs/index.md"]))).toEqual({
      action: "skip",
      reason:
        "v1.3.0@89abcde changes nothing under apps/web/ or apps/worker/ since v1.2.3@0123456; " +
        "not bumping",
    });
  });

  it("keeps a target that changes only a directory installDirs declares", () => {
    const installPin: AppPin = {
      ...monoPin,
      install: {
        ...monoPin.install,
        installDirs: [{ path: "r2-explorer-template" }, { path: "packages/shared" }],
      },
    };
    expect(gateOnAppDirectories(installPin, bump, files(["packages/shared/src/x.ts"])).action).toBe(
      "bump",
    );
    expect(gateOnAppDirectories(installPin, bump, files(["pnpm-lock.yaml"]))).toEqual({
      action: "skip",
      reason:
        "v1.3.0@89abcde changes nothing under packages/shared/ or r2-explorer-template/ " +
        "since v1.2.3@0123456; not bumping",
    });
  });

  it("never lists files when one of the Workers is at the repository root", () => {
    const rootWorker: AppPin = {
      ...monoPin,
      install: {
        ...monoPin.install,
        workers: [
          { wranglerConfig: "r2-explorer-template/wrangler.json" },
          { wranglerConfig: "wrangler.jsonc" },
        ],
      },
    };
    expect(
      gateOnAppDirectories(rootWorker, bump, () => {
        throw new Error("must not list files");
      }),
    ).toEqual({ action: "bump", bump });
  });

  it("keeps the bump when GitHub's file list may be cut short", () => {
    expect(gateOnAppDirectories(monoPin, bump, files(["other/x.ts"], false)).action).toBe("bump");
  });

  it("passes the pinned and target commits to the file listing", () => {
    const asked: string[] = [];
    gateOnAppDirectories(monoPin, bump, (base, head) => {
      asked.push(`${base}...${head}`);
      return { paths: [], complete: true };
    });
    expect(asked).toEqual([`${PIN}...${NEW}`]);
  });
});

describe("planBumps", () => {
  const upstream = (
    resolve: () => UpstreamState,
    changedFiles: UpstreamSource["changedFiles"] = () => {
      throw new Error("must not list files");
    },
  ): UpstreamSource => ({
    tags: () => [...resolve().tags],
    branch: (_repo, name) => resolve().branch(name),
    defaultBranch: noBranch,
    compare: () => ({ total: 0, subjects: [] }),
    relation: () => ({ ahead: 1, behind: 0 }),
    changedFiles,
  });

  it("keeps only moves forward", () => {
    const plan = planBumps(
      [hello],
      upstream(() => tag("v1.3.0")),
    );
    expect(plan.bumps.map((b) => b.branch)).toEqual(["bump/hello/89abcde"]);
    expect(plan.failed).toEqual([]);
  });

  it("reports an app whose upstream cannot be read and keeps going", () => {
    const plan = planBumps(
      [hello, { ...hello, slug: "hello-again" }, hello],
      upstream(
        (() => {
          let n = 0;
          return () => {
            n++;
            if (n === 2) {
              throw new Error("HTTP 404: repository gone");
            }
            return tag("v1.3.0");
          };
        })(),
      ),
    );
    expect(plan.failed).toEqual([{ slug: "hello-again", error: "HTTP 404: repository gone" }]);
    expect(plan.bumps).toHaveLength(2);
  });

  it("reads the default branch for a branch pin whose tags predate it", () => {
    const root = mkdtempSync(path.join(tmpdir(), "appflare-bump-branch-"));
    try {
      const dir = path.join(root, "hello");
      mkdirSync(dir);
      const text = readFileSync(hello.manifestPath, "utf8").replace('"v1.2.3"', '"main"');
      writeFileSync(path.join(dir, "appflare.jsonc"), text);
      const read: string[] = [];
      const plan = planBumps([findApp(root, "hello")], {
        tags: () => [{ name: "v1.0.0", sha: NEW }],
        branch: () => null,
        defaultBranch: (repo) => {
          read.push(repo);
          return { name: "trunk", sha: "4444444444444444444444444444444444444444" };
        },
        compare: never,
        relation: (_repo, _base, head) =>
          head === NEW ? { ahead: 0, behind: 2 } : { ahead: 1, behind: 0 },
        changedFiles: never,
      });
      expect(plan.failed).toEqual([]);
      expect(read).toEqual(["example/hello"]);
      expect(plan.bumps.map((b) => [b.to.ref, b.title, b.autoMerge])).toEqual([
        ["trunk", "chore(hello): bump to trunk@4444444", false],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails the app, never falls back, when the pinned branch cannot be read", () => {
    const root = mkdtempSync(path.join(tmpdir(), "appflare-bump-branch-error-"));
    try {
      const dir = path.join(root, "hello");
      mkdirSync(dir);
      const text = readFileSync(hello.manifestPath, "utf8").replace('"v1.2.3"', '"main"');
      writeFileSync(path.join(dir, "appflare.jsonc"), text);
      const plan = planBumps([findApp(root, "hello")], {
        tags: () => [],
        branch: () => {
          throw new Error("gh api GET repos/example/hello/branches/main: HTTP 502");
        },
        defaultBranch: noBranch,
        compare: never,
        relation: never,
        changedFiles: never,
      });
      expect(plan.bumps).toEqual([]);
      expect(plan.failed).toEqual([
        { slug: "hello", error: "gh api GET repos/example/hello/branches/main: HTTP 502" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("asks for the app's last bump only for a ref upstream no longer has", () => {
    const root = mkdtempSync(path.join(tmpdir(), "appflare-bump-last-"));
    try {
      const dir = path.join(root, "hello");
      mkdirSync(dir);
      const text = readFileSync(hello.manifestPath, "utf8").replace('"v1.2.3"', '"stable"');
      writeFileSync(path.join(dir, "appflare.jsonc"), text);
      const asked: string[] = [];
      const plan = planBumps(
        [findApp(root, "hello")],
        {
          tags: () => [],
          branch: () => null,
          defaultBranch: noBranch,
          compare: never,
          relation: never,
          changedFiles: never,
        },
        (slug) => {
          asked.push(slug);
          return "stable";
        },
      );
      expect(asked).toEqual(["hello"]);
      expect(plan.skipped.map((s) => s.reason)).toEqual([
        "pinned to stable, which upstream has neither as a branch nor as a tag now, and " +
          "the last bump moved the app to that tag; not moving to a branch, choose the new pin by hand",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips an app in a subdirectory when the target leaves that directory alone", () => {
    const root = mkdtempSync(path.join(tmpdir(), "appflare-bump-mono-"));
    try {
      const dir = path.join(root, "hello");
      mkdirSync(dir);
      const text = readFileSync(hello.manifestPath, "utf8").replace(
        '"wranglerConfig": "wrangler.jsonc"',
        '"wranglerConfig": "hello-template/wrangler.jsonc"',
      );
      writeFileSync(path.join(dir, "appflare.jsonc"), text);
      const app = findApp(root, "hello");
      const untouched = planBumps(
        [app],
        upstream(
          () => tag("v1.3.0"),
          () => ({ paths: ["other-template/index.ts"], complete: true }),
        ),
      );
      expect(untouched.bumps).toEqual([]);
      expect(untouched.skipped).toEqual([
        {
          slug: "hello",
          reason:
            "v1.3.0@89abcde changes nothing under hello-template/ since v1.2.3@0123456; not bumping",
        },
      ]);
      const touched = planBumps(
        [app],
        upstream(
          () => tag("v1.3.0"),
          () => ({ paths: ["hello-template/src/index.ts"], complete: true }),
        ),
      );
      expect(touched.bumps.map((b) => b.branch)).toEqual(["bump/hello/89abcde"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bumps a multi-Worker app when only a Worker other than the primary changed", () => {
    const root = mkdtempSync(path.join(tmpdir(), "appflare-bump-workers-"));
    try {
      const dir = path.join(root, "hello");
      mkdirSync(dir);
      const text = readFileSync(hello.manifestPath, "utf8").replace(
        '"wranglerConfig": "wrangler.jsonc"',
        '"wranglerConfig": "apps/web/wrangler.jsonc",\n' +
          '    "workers": [\n' +
          '      { "name": "web", "wranglerConfig": "apps/web/wrangler.jsonc", "primary": true },\n' +
          '      { "name": "checker", "wranglerConfig": "apps/worker/wrangler.jsonc" }\n' +
          "    ]",
      );
      writeFileSync(path.join(dir, "appflare.jsonc"), text);
      const app = findApp(root, "hello");
      const touched = planBumps(
        [app],
        upstream(
          () => tag("v1.3.0"),
          () => ({ paths: ["apps/worker/src/index.ts"], complete: true }),
        ),
      );
      expect(touched.failed).toEqual([]);
      expect(touched.bumps.map((b) => b.branch)).toEqual(["bump/hello/89abcde"]);
      const untouched = planBumps(
        [app],
        upstream(
          () => tag("v1.3.0"),
          () => ({ paths: ["apps/docs/index.md"], complete: true }),
        ),
      );
      expect(untouched.skipped).toEqual([
        {
          slug: "hello",
          reason:
            "v1.3.0@89abcde changes nothing under apps/web/ or apps/worker/ since " +
            "v1.2.3@0123456; not bumping",
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("gateBump", () => {
  const now = new Date("2026-09-24T00:00:00Z");
  const tagBump = bumped(decideBump(tagPin, tag("v1.3.0"), never));
  const branchBump = bumped(decideBump(branchPin, head(), () => ({ ahead: 1, behind: 0 })));
  const pr = (number: number, head: string, state: "open" | "closed", createdAt: string) => ({
    number,
    head,
    headSha: NEW,
    state,
    createdAt,
  });

  it("skips a target that already has a branch or any pull request", () => {
    expect(gateBump(tagBump, { branches: [tagBump.branch], prs: [] }, now).action).toBe("skip");
    expect(
      gateBump(
        tagBump,
        { branches: [], prs: [pr(4, tagBump.branch, "closed", "2026-01-01T00:00:00Z")] },
        now,
      ),
    ).toEqual({ action: "skip", reason: `${tagBump.branch} was already proposed` });
  });

  it("holds a branch-tracked app while a bump from the last week is open", () => {
    const recent = pr(7, "bump/hello/1111111", "open", "2026-09-20T00:00:00Z");
    expect(gateBump(branchBump, { branches: [], prs: [recent] }, now).action).toBe("skip");
  });

  it("supersedes older open bumps for the same app only", () => {
    const old = pr(3, "bump/hello/1111111", "open", "2026-09-01T00:00:00Z");
    const closed = pr(2, "bump/hello/2222222", "closed", "2026-08-01T00:00:00Z");
    const other = pr(5, "bump/hello-world/3333333", "open", "2026-09-01T00:00:00Z");
    expect(gateBump(branchBump, { branches: [], prs: [old, closed, other] }, now)).toEqual({
      action: "open",
      supersedes: [3],
    });
    const recentForTag = pr(8, "bump/hello/4444444", "open", "2026-09-23T00:00:00Z");
    expect(gateBump(tagBump, { branches: [], prs: [recentForTag] }, now)).toEqual({
      action: "open",
      supersedes: [8],
    });
  });
});

describe("outstandingBumps", () => {
  const now = new Date("2026-10-06T12:00:00Z");
  const pr = (
    number: number,
    head: string,
    state: "open" | "closed",
    createdAt: string,
    headSha = NEW,
  ) => ({ number, head, headSha, state, createdAt });
  const none = () => {
    throw new Error("must not read checks");
  };

  it("reports a bump branch without any pull request, which no run proposes again", () => {
    const open = pr(9, "bump/hello/2222222", "open", "2026-10-06T11:00:00Z");
    const closed = pr(8, "bump/hello/3333333", "closed", "2026-09-01T00:00:00Z");
    expect(
      outstandingBumps(
        {
          branches: ["bump/hello/1111111", "bump/hello/2222222", "bump/hello/3333333"],
          prs: [open, closed],
        },
        none,
        now,
      ),
    ).toEqual([
      "bump/hello/1111111 has no pull request, so no bump run proposes its target again; " +
        "open the pull request by hand, or delete the branch",
    ]);
  });

  it("reports an open pull request whose head lacks a required check after the grace period", () => {
    const asked: string[] = [];
    const stuck = pr(7, "bump/hello/89abcde", "open", "2026-10-06T05:59:00Z", NEW);
    const lines = outstandingBumps(
      { branches: [stuck.head], prs: [stuck] },
      (sha) => {
        asked.push(sha);
        return ["CodeRabbit", "commit messages"];
      },
      now,
    );
    expect(asked).toEqual([NEW]);
    expect(lines).toEqual([
      '#7 (bump/hello/89abcde) has no "verify passed" on 89abcde after 6 hours, so it cannot ' +
        "merge; start gh workflow run verify.yml --ref bump/hello/89abcde",
    ]);
    expect(outstandingBumps({ branches: [], prs: [stuck] }, () => [], now)[0]).toContain(
      'no "verify passed" or "commit messages"',
    );
  });

  it("leaves alone pull requests that reported, are young, closed, or superseded", () => {
    const reported = pr(1, "bump/hello/1111111", "open", "2026-10-01T00:00:00Z");
    const young = pr(2, "bump/hello/2222222", "open", "2026-10-06T06:01:00Z");
    const closed = pr(3, "bump/hello/3333333", "closed", "2026-09-01T00:00:00Z");
    const superseded = pr(4, "bump/hello/4444444", "open", "2026-09-01T00:00:00Z");
    expect(
      outstandingBumps(
        { branches: [], prs: [reported] },
        () => ["verify passed", "commit messages"],
        now,
      ),
    ).toEqual([]);
    expect(
      outstandingBumps({ branches: [], prs: [young, closed, superseded] }, none, now, new Set([4])),
    ).toEqual([]);
  });
});

describe("renderBumpBody", () => {
  const bump = bumped(decideBump(tagPin, tag("v1.3.0"), never));

  it("links the compare view and lists commits as inert code spans", () => {
    const body = renderBumpBody(tagPin, bump, {
      total: 2,
      subjects: ["fix: thanks @someone for `x`", "feat: closes #12"],
    });
    expect(body).toContain(`https://github.com/example/hello/compare/${PIN}...${NEW}`);
    expect(body).toContain("- `fix: thanks @someone for 'x'`");
    expect(body).toContain("- `feat: closes #12`");
    expect(body).toContain("2 commits:");
  });

  it("says so when the commits cannot be compared", () => {
    expect(renderBumpBody(tagPin, bump, null)).toContain("could not be compared");
  });

  it("asks to update source.version only for entries that set it", () => {
    expect(renderBumpBody(tagPin, bump, null)).not.toContain("source.version");
    const versioned: AppPin = {
      ...tagPin,
      source: { ...tagPin.source, version: "1.1.10" },
    };
    const body = renderBumpBody(versioned, bump, null);
    expect(body).toContain(
      "- [ ] Set `source.version` in `apps/hello/appflare.jsonc` to Hello's version at the " +
        "new commit (it is `1.1.10` now).",
    );
  });
});

describe("auto-merge", () => {
  const optOutApp = findApp(
    path.join(import.meta.dirname, "..", "fixtures", "auto-merge-apps"),
    "hello-opt-out",
  );
  const optOutPin = readPin(optOutApp);
  const plan1 = (app: AppEntry): Bump => {
    const plan = planBumps([app], {
      tags: () => [{ name: "v1.3.0", sha: NEW }],
      branch: () => {
        throw new Error("must not read a branch");
      },
      defaultBranch: noBranch,
      compare: () => ({ total: 0, subjects: [] }),
      relation: never,
      changedFiles: never,
    });
    expect(plan.failed).toEqual([]);
    expect(plan.bumps).toHaveLength(1);
    return plan.bumps[0] as Bump;
  };

  it("reads bump.autoMerge and the tier from the raw JSONC, comments included", () => {
    expect(tagPin).toMatchObject({ tier: "artifact", autoMerge: "on" });
    expect(optOutPin).toMatchObject({ tier: "artifact", autoMerge: "off" });
  });

  it("reads an absent setting or true as on, and false as off", () => {
    for (const manifest of [{}, { bump: {} }, { bump: { autoMerge: true } }]) {
      expect(readAutoMerge(manifest)).toBe("on");
    }
    expect(readAutoMerge({ bump: { autoMerge: false } })).toBe("off");
  });

  it("reads anything else as malformed, which never merges or stops the bot", () => {
    for (const manifest of [
      null,
      "bump",
      { bump: null },
      { bump: true },
      { bump: [true] },
      { bump: { autoMerge: "false" } },
      { bump: { autoMerge: 0 } },
      { bump: { automerge: false } },
      { bump: { autoMerge: true, extra: 1 } },
    ]) {
      expect(readAutoMerge(manifest)).toBe("malformed");
    }
    const malformed: AppPin = { ...tagPin, autoMerge: "malformed" };
    const bump = bumped(decideBump(malformed, tag("v1.3.0"), never));
    expect(bump.autoMerge).toBe(false);
    expect(renderBumpBody(malformed, bump, null)).toContain(
      "**A maintainer merges this pull request.** The bump bot cannot read the `bump` " +
        "setting in `apps/hello/appflare.jsonc`",
    );
  });

  it("merges the bump of an entry without a bump setting, and says how to stop it", () => {
    const bump = plan1(hello);
    expect(bump.autoMerge).toBe(true);
    const body = renderBumpBody(tagPin, bump, null);
    expect(body).toContain("**This pull request merges itself.**");
    expect(body).toContain("the next nightly bump run publishes the new version");
    expect(body).toContain("it does not review upstream's code");
    expect(body).toContain("disable auto-merge here or close the pull request");
    expect(body).toContain('set `"bump": { "autoMerge": false }` in `apps/hello/appflare.jsonc`');
    expect(body).toContain("installs it into the CI account");
    expect(body).not.toContain("A maintainer merges");
    expect(body).not.toContain("Merging publishes");
  });

  it("merges a branch-tracked entry's bump too", () => {
    const bump = bumped(decideBump(branchPin, head(), () => ({ ahead: 1, behind: 0 })));
    expect(bump.autoMerge).toBe(true);
  });

  it("leaves an entry that sets bump.autoMerge to false to a maintainer", () => {
    const bump = plan1(optOutApp);
    expect(bump.autoMerge).toBe(false);
    const body = renderBumpBody(optOutPin, bump, null);
    expect(body).toContain(
      "**A maintainer merges this pull request.** `apps/hello-opt-out/appflare.jsonc` sets " +
        "`bump.autoMerge` to `false`",
    );
    expect(body).toContain("Merging publishes the new version.");
    expect(body).not.toContain("merges itself.**");
  });

  it("never auto-merges an entry that sets source.version", () => {
    const versioned: AppPin = { ...tagPin, source: { ...tagPin.source, version: "1.1.10" } };
    const bump = bumped(decideBump(versioned, tag("v1.3.0"), never));
    expect(bump.autoMerge).toBe(false);
    const body = renderBumpBody(versioned, bump, null);
    expect(body).toContain("sets `source.version`, which has to be updated by hand first");
    expect(body).toContain("- [ ] Set `source.version`");
    expect(body).not.toContain("merges itself.**");
  });

  it("never auto-merges a sandbox or self-deploying entry, which CI does not install", () => {
    const root = mkdtempSync(path.join(tmpdir(), "appflare-bump-tier-"));
    try {
      for (const tier of ["sandbox", "self-deploying"]) {
        const dir = path.join(root, tier);
        mkdirSync(dir);
        const text = readFileSync(hello.manifestPath, "utf8")
          .replace('"slug": "hello"', `"slug": "${tier}"`)
          .replace('"install": {', `"install": {\n    "tier": "${tier}",`);
        writeFileSync(path.join(dir, "appflare.jsonc"), text);
        const app = findApp(root, tier);
        const pin = readPin(app);
        expect(pin).toMatchObject({ tier, autoMerge: "on" });
        const bump = plan1(app);
        expect(bump.autoMerge).toBe(false);
        const body = renderBumpBody(pin, bump, null);
        expect(body).toContain(
          `**A maintainer merges this pull request.** \`apps/${tier}/appflare.jsonc\` is a ` +
            `\`${tier}\` tier entry, which CI does not install`,
        );
        expect(body).not.toContain("installs it into the CI account");
        expect(body).not.toContain("merges itself.**");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("applyBump", () => {
  it("edits the fixture manifest's source and keeps its leading comment", () => {
    const text = readFileSync(hello.manifestPath, "utf8");
    const out = applyBump(text, { ref: "v1.3.0", sha: NEW });
    expect(out.split("\n")[0]).toBe(text.split("\n")[0]);
    expect((parseJsonc(out) as { source: unknown }).source).toEqual({ ref: "v1.3.0", sha: NEW });
    expect(out.replace("v1.3.0", "v1.2.3").replace(NEW, PIN)).toBe(text);
  });
});
