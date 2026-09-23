import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findApp } from "./apps.ts";
import {
  type AppPin,
  applyBump,
  type Bump,
  decideBump,
  gateBump,
  planBumps,
  readPin,
  renderBumpBody,
} from "./bump.ts";
import { parseJsonc } from "./jsonc.ts";
import type { UpstreamSource, UpstreamTarget } from "./upstream.ts";

const fixtureApps = path.join(import.meta.dirname, "..", "fixtures", "apps");
const hello = findApp(fixtureApps, "hello");
const PIN = "0123456789abcdef0123456789abcdef01234567";
const NEW = "89abcdef0123456789abcdef0123456789abcdef";

const tagPin = readPin(hello); // source.ref v1.2.3
const branchPin: AppPin = { ...tagPin, source: { ref: "main", sha: PIN } };
const rcPin: AppPin = { ...tagPin, source: { ref: "v2.0.0-rc.1", sha: PIN } };
const tag = (ref: string, sha = NEW): UpstreamTarget => ({ ref, sha, kind: "tag" });
const head = (sha = NEW): UpstreamTarget => ({ ref: "main", sha, kind: "branch" });
const never = () => {
  throw new Error("must not compare");
};

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

  it("moves a branch pin only when the new head is ahead of it", () => {
    const asked: string[] = [];
    const ahead = (n: number) => (base: string, h: string) => {
      asked.push(`${base}...${h}`);
      return n;
    };
    expect(bumped(decideBump(branchPin, head(), ahead(3))).title).toBe(
      "chore(hello): bump to main@89abcde",
    );
    expect(asked).toEqual([`${PIN}...${NEW}`]);
    expect(decideBump(branchPin, head(), ahead(0)).action).toBe("skip");
    expect(decideBump(branchPin, head(PIN), never).action).toBe("skip");
  });

  it("moves a branch pin to a first stable tag that is ahead of it", () => {
    expect(bumped(decideBump(branchPin, tag("v1.0.0"), () => 5)).to.kind).toBe("tag");
    expect(decideBump(branchPin, tag("v1.0.0"), () => 0).action).toBe("skip");
  });

  it("keeps the title within the commit header limit", () => {
    const long = tag(`v1.3.0+${"x".repeat(80)}`);
    expect(bumped(decideBump(tagPin, long, never)).title).toBe("chore(hello): bump to 89abcde");
  });
});

describe("planBumps", () => {
  const upstream = (resolve: UpstreamSource["resolve"]): UpstreamSource => ({
    resolve,
    compare: () => ({ total: 0, subjects: [] }),
    aheadBy: () => 1,
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
});

describe("gateBump", () => {
  const now = new Date("2026-09-24T00:00:00Z");
  const tagBump = bumped(decideBump(tagPin, tag("v1.3.0"), never));
  const branchBump = bumped(decideBump(branchPin, head(), () => 1));
  const pr = (number: number, head: string, state: "open" | "closed", createdAt: string) => ({
    number,
    head,
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
