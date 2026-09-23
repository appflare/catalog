import { z } from "zod";
import type { AppEntry } from "./apps.ts";
import { readManifestFile } from "./apps.ts";
import { setJsoncStrings } from "./jsonc-edit.ts";
import {
  type CommitRelation,
  compareSemver,
  isPrereleaseTag,
  parseStableTag,
  type UpstreamSource,
  type UpstreamTarget,
} from "./upstream.ts";

/** The part of a catalog manifest the bump workflow reads. */
const pinSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  source: z.object({ ref: z.string().min(1), sha: z.string().regex(/^[0-9a-f]{40}$/) }),
});
export type AppPin = z.infer<typeof pinSchema>;

export function readPin(app: AppEntry): AppPin {
  const result = pinSchema.safeParse(readManifestFile(app.manifestPath));
  if (!result.success) {
    throw new Error(`${app.manifestPath}: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** A pin that moved upstream. */
export interface Bump {
  slug: string;
  repo: string;
  from: { ref: string; sha: string };
  to: UpstreamTarget;
  /** `bump/<slug>/<short sha>`: one branch per target, so a rerun finds it. */
  branch: string;
  /** Conventional commit subject and PR title. */
  title: string;
  /** Why this bump, when it is not simply a newer commit. */
  note?: string;
}

/** Longest commit header the repository's commitlint accepts. */
export const MAX_HEADER = 72;

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function bumpFor(pin: AppPin, target: UpstreamTarget): Bump {
  // A branch name alone does not say where the pin moved; add the commit.
  const label = target.kind === "tag" ? target.ref : `${target.ref}@${shortSha(target.sha)}`;
  // Commit headers are at most 72 characters; fall back to the short SHA.
  const full = `chore(${pin.slug}): bump to ${label}`;
  const title =
    full.length <= MAX_HEADER ? full : `chore(${pin.slug}): bump to ${shortSha(target.sha)}`;
  return {
    slug: pin.slug,
    repo: pin.repo,
    from: { ...pin.source },
    to: target,
    branch: `bump/${pin.slug}/${shortSha(target.sha)}`,
    title,
  };
}

export type BumpDecision = { action: "bump"; bump: Bump } | { action: "skip"; reason: string };

/** Why a branch pin moves to a tag on the same or a later commit. */
export const TAG_PIN_NOTE = "a tag pin gives the app a semver version instead of a date-based one";

/**
 * Whether `target` is newer than the pin, so a bump never goes backwards:
 *
 * - a stable tag pin moves only to a tag with a greater version, never to a
 *   branch head;
 * - a prerelease tag pin is left alone (someone chose it on purpose);
 * - a branch pin moves to a stable tag whose commit is the pinned commit or
 *   contains it (`behind_by === 0` in the compare API); a tag on an older or
 *   unrelated commit is refused;
 * - a branch pin moves to a newer branch head when the head is ahead of the
 *   pinned commit (`ahead_by > 0`; this also covers histories that diverged).
 */
export function decideBump(
  pin: AppPin,
  target: UpstreamTarget,
  relation: (base: string, head: string) => CommitRelation,
): BumpDecision {
  const { ref, sha } = pin.source;
  if (target.sha === sha && target.ref === ref) {
    return { action: "skip", reason: "up to date" };
  }
  if (isPrereleaseTag(ref)) {
    return { action: "skip", reason: `pinned to prerelease ${ref}; left alone` };
  }
  const pinned = parseStableTag(ref);
  if (pinned) {
    const next = target.kind === "tag" ? parseStableTag(target.ref) : null;
    if (!next) {
      return {
        action: "skip",
        reason: `pinned to tag ${ref}, but upstream has no stable tag now; not moving to a branch`,
      };
    }
    if (compareSemver(next, pinned) <= 0) {
      return { action: "skip", reason: `newest tag ${target.ref} is not newer than ${ref}` };
    }
    return { action: "bump", bump: bumpFor(pin, target) };
  }
  if (target.kind === "tag") {
    if (target.sha !== sha && relation(sha, target.sha).behind > 0) {
      return {
        action: "skip",
        reason: `tag ${target.ref}@${shortSha(target.sha)} does not contain the pinned ${shortSha(sha)}`,
      };
    }
    return { action: "bump", bump: { ...bumpFor(pin, target), note: TAG_PIN_NOTE } };
  }
  if (target.sha === sha) {
    return { action: "skip", reason: "upstream still points at the pinned commit" };
  }
  if (relation(sha, target.sha).ahead <= 0) {
    return {
      action: "skip",
      reason: `${target.ref}@${shortSha(target.sha)} is not ahead of the pinned ${shortSha(sha)}`,
    };
  }
  return { action: "bump", bump: bumpFor(pin, target) };
}

export interface BumpPlan {
  bumps: Bump[];
  skipped: { slug: string; reason: string }[];
  /** Apps whose upstream could not be read; the others still proceed. */
  failed: { slug: string; error: string }[];
}

/** Decides every app, isolating failures so one broken upstream does not stop the rest. */
export function planBumps(apps: readonly AppEntry[], upstream: UpstreamSource): BumpPlan {
  const plan: BumpPlan = { bumps: [], skipped: [], failed: [] };
  for (const app of apps) {
    try {
      const pin = readPin(app);
      const decision = decideBump(pin, upstream.resolve(pin.repo), (base, head) =>
        upstream.relation(pin.repo, base, head),
      );
      if (decision.action === "bump") {
        plan.bumps.push(decision.bump);
      } else {
        plan.skipped.push({ slug: pin.slug, reason: decision.reason });
      }
    } catch (err) {
      plan.failed.push({ slug: app.slug, error: err instanceof Error ? err.message : String(err) });
    }
  }
  plan.bumps.sort((a, b) => a.slug.localeCompare(b.slug));
  return plan;
}

/** An existing bump branch's pull request. */
export interface BumpPr {
  number: number;
  head: string;
  state: "open" | "closed";
  createdAt: string;
}

/** Branch-tracked apps get at most one new bump pull request a week. */
export const BRANCH_BUMP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export type BumpGate =
  | { action: "open"; supersedes: number[] }
  | { action: "skip"; reason: string };

/**
 * Whether to open the pull request for `bump`, given the app's existing bump
 * branches and pull requests. Skips a target that was already proposed (its
 * branch or any pull request for it exists, so a closed bump stays closed),
 * and, for branch-tracked apps, while a bump opened in the last week is still
 * open. Otherwise the new pull request supersedes the app's open ones.
 */
export function gateBump(
  bump: Bump,
  existing: { branches: readonly string[]; prs: readonly BumpPr[] },
  now: Date,
): BumpGate {
  if (existing.branches.includes(bump.branch) || existing.prs.some((p) => p.head === bump.branch)) {
    return { action: "skip", reason: `${bump.branch} was already proposed` };
  }
  const open = existing.prs.filter(
    (p) => p.state === "open" && p.head.startsWith(`bump/${bump.slug}/`),
  );
  const recent = open.find(
    (p) => now.getTime() - Date.parse(p.createdAt) < BRANCH_BUMP_INTERVAL_MS,
  );
  if (bump.to.kind === "branch" && recent) {
    return {
      action: "skip",
      reason: `#${recent.number} (opened ${recent.createdAt}) is still open; branch-tracked apps bump at most weekly`,
    };
  }
  return { action: "open", supersedes: open.map((p) => p.number).sort((a, b) => a - b) };
}

/** Inline code that cannot break out of its backticks or mention anyone. */
function codeSpan(text: string): string {
  return `\`${text.replaceAll("`", "'").trim()}\``;
}

/** The pull request body: where the pin moves, the compare link, and the commits. */
export function renderBumpBody(
  pin: AppPin,
  bump: Bump,
  changes: { total: number; subjects: string[] } | null,
): string {
  const compareUrl = `https://github.com/${bump.repo}/compare/${bump.from.sha}...${bump.to.sha}`;
  const lines = [
    `Moves **${pin.name}** (\`${bump.repo}\`) to the upstream ${bump.to.kind === "tag" ? "release tag" : "branch head"}.`,
    "",
    "| | ref | commit |",
    "|---|---|---|",
    `| from | ${codeSpan(bump.from.ref)} | ${codeSpan(bump.from.sha)} |`,
    `| to | ${codeSpan(bump.to.ref)} | ${codeSpan(bump.to.sha)} |`,
    "",
    ...(bump.note ? [`Why: ${bump.note}.`, ""] : []),
    `Upstream changes: ${compareUrl}`,
    "",
  ];
  if (changes === null) {
    lines.push(
      "The two commits could not be compared (for example, upstream history was rewritten).",
    );
  } else if (changes.total === 0) {
    lines.push("No new commits: the target is the pinned commit.");
  } else {
    const shown = changes.subjects.slice(-50);
    lines.push(`${changes.total} commit${changes.total === 1 ? "" : "s"}:`, "");
    if (changes.total > shown.length) {
      lines.push(`- ... ${changes.total - shown.length} earlier commits, see the compare view`);
    }
    for (const subject of shown) {
      lines.push(`- ${codeSpan(subject)}`);
    }
  }
  lines.push(
    "",
    "The verify workflow packs this pin, checks the artifact's hashes, and installs it into " +
      "the CI account. Merging publishes the new version.",
  );
  return `${lines.join("\n")}\n`;
}

/** `appflare.jsonc` text with `source.ref`/`source.sha` replaced, comments kept. */
export function applyBump(text: string, to: { ref: string; sha: string }): string {
  return setJsoncStrings(text, [
    { path: ["source", "ref"], value: to.ref },
    { path: ["source", "sha"], value: to.sha },
  ]);
}
