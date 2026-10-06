import path from "node:path";
import { z } from "zod";
import type { AppEntry } from "./apps.ts";
import { readManifestFile } from "./apps.ts";
import { declaredTier } from "./changed-apps.ts";
import { setJsoncStrings } from "./jsonc-edit.ts";
import {
  type ChangedFiles,
  type CommitRelation,
  compareSemver,
  isPrereleaseTag,
  newestInSeries,
  newestStableTag,
  parseSeriesTag,
  parseStableTag,
  type UpstreamBranch,
  type UpstreamSource,
  type UpstreamTag,
  type UpstreamTarget,
} from "./upstream.ts";

/** The part of a catalog manifest the bump workflow reads. */
const pinSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  source: z.object({
    ref: z.string().min(1),
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    version: z.string().min(1).optional(),
  }),
  install: z.object({
    wranglerConfig: z.string().min(1),
    /** Every Worker of a multi-Worker entry; the primary is `install.wranglerConfig`'s too. */
    workers: z.array(z.object({ wranglerConfig: z.string().min(1) })).optional(),
    /** The directories the packer installs dependencies in; the root when absent. */
    installDirs: z.array(z.object({ path: z.string().min(1) })).optional(),
  }),
});
export type AppPin = z.infer<typeof pinSchema> & {
  /** `install.tier` as CI reads it, `artifact` when absent; see `declaredTier`. */
  tier: string;
  /** `bump.autoMerge` in the manifest; see `readAutoMerge`. */
  autoMerge: AutoMergeSetting;
};

export function readPin(app: AppEntry): AppPin {
  const manifest = readManifestFile(app.manifestPath);
  const result = pinSchema.safeParse(manifest);
  if (!result.success) {
    throw new Error(`${app.manifestPath}: ${z.prettifyError(result.error)}`);
  }
  return { ...result.data, tier: declaredTier(manifest), autoMerge: readAutoMerge(manifest) };
}

/**
 * What an entry's `bump` setting asks of the bot: `on` when `bump` or
 * `bump.autoMerge` is absent or `bump.autoMerge` is `true`, `off` for
 * `bump.autoMerge: false`, and `malformed` for anything else.
 */
export type AutoMergeSetting = "on" | "off" | "malformed";

/**
 * Reads `bump.autoMerge` from the parsed JSONC rather than the synced schema,
 * whose default for it may still be `false`. A malformed `bump` never stops
 * the bot: it reads as `malformed`, which leaves the merge to a maintainer,
 * since it may be a misspelt opt-out (`{ "automerge": false }`). The validate
 * step reports it.
 */
export function readAutoMerge(manifest: unknown): AutoMergeSetting {
  if (!isRecord(manifest)) {
    return "malformed";
  }
  if (manifest.bump === undefined) {
    return "on";
  }
  if (!isRecord(manifest.bump)) {
    return "malformed";
  }
  const { autoMerge, ...rest } = manifest.bump;
  if (Object.keys(rest).length > 0) {
    return "malformed";
  }
  if (autoMerge === undefined || autoMerge === true) {
    return "on";
  }
  return autoMerge === false ? "off" : "malformed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether the bump pull request for `pin` merges itself: only for an
 * `artifact` tier entry, the one tier the install check covers, whose `bump`
 * setting does not opt out and which does not state `source.version` (a
 * person has to set the new version first, or publish refuses the moved pin).
 */
export function autoMerges(pin: AppPin): boolean {
  return pin.tier === "artifact" && pin.autoMerge === "on" && pin.source.version === undefined;
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
  /**
   * Why `source.ref` moves to another branch. Set only then; such a bump
   * never merges itself, since a person has to confirm the line to follow.
   */
  refChange?: string;
  /**
   * The workflow enables GitHub auto-merge (squash, with `title` as the
   * subject) on the pull request, so it merges once the required checks pass.
   * False leaves the merge to a maintainer.
   */
  autoMerge: boolean;
}

/** Longest commit header the repository's commitlint accepts. */
export const MAX_HEADER = 72;

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function bumpFor(pin: AppPin, target: UpstreamTarget, refChange?: string): Bump {
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
    ...(refChange ? { refChange } : {}),
    autoMerge: autoMerges(pin) && !refChange,
  };
}

export type BumpDecision = { action: "bump"; bump: Bump } | { action: "skip"; reason: string };

/** Why a branch pin moves to a tag on the same or a later commit. */
export const TAG_PIN_NOTE = "a tag pin gives the app a semver version instead of a date-based one";

/**
 * What `decideBump` reads: upstream's tags and branches, and the app's last
 * bump in the catalog. Each function is called only when the decision needs it.
 */
export interface UpstreamState {
  tags: readonly UpstreamTag[];
  /** The branch of this name, null when upstream has none; see `UpstreamSource.branch`. */
  branch: (name: string) => UpstreamBranch | null;
  defaultBranch: () => UpstreamBranch;
  /**
   * The tag the app's last bump moved it to; null when that bump moved it to a
   * branch head, or the app has no bump. Absent reads as null.
   */
  lastBumpTag?: () => string | null;
}

/**
 * Whether a ref reads as a release tag rather than a branch: it holds a
 * version number after its start or a separator (`app-v0.42.1`,
 * `deepcrawl@0.5.5`, `1.2`).
 */
export function looksLikeTag(ref: string): boolean {
  return /(?:^|[^0-9A-Za-z])v?\d+\.\d+/.test(ref);
}

/**
 * Where the pin moves, if anywhere; a bump never goes backwards:
 *
 * - a stable tag pin moves only to the newest stable tag, when its version is
 *   greater, never to a branch head;
 * - a pin on a tag with a prefix (`app-v0.42.1`) moves to the newest stable
 *   tag of the same prefix, when it is newer and contains the pinned commit
 *   (see `decideSeriesBump`);
 * - a prerelease tag pin, or a pin on a tag that is not a semver release, is
 *   left alone (someone chose it on purpose). A ref that is a branch upstream
 *   is a branch, even when a tag shares its name;
 * - a pin on a ref upstream has neither as a branch nor as a tag is left alone
 *   when the ref looks like a tag ({@link looksLikeTag}) or the app's last bump
 *   moved it to that tag: upstream deleted the tag, and a branch head is no
 *   substitute for a release;
 * - a branch pin moves to the newest stable tag when its commit is the pinned
 *   commit or contains it (`behind_by === 0` in the compare API); a tag on an
 *   older or unrelated commit is not a target (`relation` is null for commits
 *   that share no history);
 * - otherwise a branch pin follows its branch, or, when upstream has no branch
 *   of that name now (it was renamed or deleted), the default branch under its
 *   current name, when the head is ahead of the pinned commit (`ahead_by > 0`;
 *   this also covers histories that diverged). A head that shares no history
 *   with the pin throws: upstream rewrote its history, and someone has to
 *   choose the new pin.
 *
 * A bump that changes `source.ref` other than to a tag never merges itself.
 */
export function decideBump(
  pin: AppPin,
  upstream: UpstreamState,
  relation: (base: string, head: string) => CommitRelation | null,
): BumpDecision {
  const { ref, sha } = pin.source;
  const newest = newestStableTag(upstream.tags);
  if (isPrereleaseTag(ref)) {
    return { action: "skip", reason: `pinned to prerelease ${ref}; left alone` };
  }
  const pinned = parseStableTag(ref);
  if (pinned) {
    if (!newest) {
      return {
        action: "skip",
        reason: `pinned to tag ${ref}, but upstream has no stable tag now; not moving to a branch`,
      };
    }
    if (newest.name === ref && newest.sha === sha) {
      return { action: "skip", reason: "up to date" };
    }
    const next = parseStableTag(newest.name);
    if (!next || compareSemver(next, pinned) <= 0) {
      return { action: "skip", reason: `newest tag ${newest.name} is not newer than ${ref}` };
    }
    return { action: "bump", bump: bumpFor(pin, tagTarget(newest)) };
  }
  const pinnedBranch = upstream.branch(ref);
  if (!pinnedBranch) {
    if (upstream.tags.some((t) => t.name === ref)) {
      return decideSeriesBump(pin, upstream.tags, relation);
    }
    const why = looksLikeTag(ref)
      ? "it looks like a tag"
      : upstream.lastBumpTag?.() === ref
        ? "the last bump moved the app to that tag"
        : null;
    if (why) {
      return {
        action: "skip",
        reason:
          `pinned to ${ref}, which upstream has neither as a branch nor as a tag now, and ` +
          `${why}; not moving to a branch, choose the new pin by hand`,
      };
    }
  }
  let refused: string | undefined;
  if (newest) {
    const tag = `tag ${newest.name}@${shortSha(newest.sha)}`;
    const related = newest.sha === sha ? { ahead: 0, behind: 0 } : relation(sha, newest.sha);
    if (related !== null && related.behind === 0) {
      return { action: "bump", bump: { ...bumpFor(pin, tagTarget(newest)), note: TAG_PIN_NOTE } };
    }
    refused =
      related === null
        ? `${tag} shares no history with the pinned ${shortSha(sha)}`
        : `${tag} does not contain the pinned ${shortSha(sha)}`;
  }
  const branch = pinnedBranch ?? upstream.defaultBranch();
  const target: UpstreamTarget = { ref: branch.name, sha: branch.sha, kind: "branch" };
  const refChange =
    branch.name === ref
      ? undefined
      : `upstream has no branch ${ref} now (it was renamed or deleted), so the pin ` +
        `follows ${branch.name}, the default branch`;
  const skip = (reason: string): BumpDecision => ({
    action: "skip",
    reason: [reason, refused].filter(Boolean).join("; "),
  });
  if (branch.sha === sha) {
    return skip(refChange ? `${refChange}, which still points at the pinned commit` : "up to date");
  }
  const related = relation(sha, branch.sha);
  if (related === null) {
    throw new Error(
      `${branch.name}@${shortSha(branch.sha)} shares no history with the pinned ` +
        `${shortSha(sha)} (upstream rewrote its history); choose the new pin by hand`,
    );
  }
  if (related.ahead <= 0) {
    return skip(
      `${branch.name}@${shortSha(branch.sha)} is not ahead of the pinned ${shortSha(sha)}`,
    );
  }
  return { action: "bump", bump: bumpFor(pin, target, refChange) };
}

/**
 * For a pin on a tag with a prefix before its version (`app-v0.42.1`,
 * `deepcrawl@0.5.5`, as monorepos tag each of their apps): the newest stable
 * tag with the same prefix, when its version is greater and its commit is the
 * pinned commit or contains it, the check a branch pin's move to a tag makes.
 * A tag of another series (`web-v1.0.0`) is never a target, and neither is a
 * prerelease. The move keeps `source.ref` on a tag, so it merges itself under
 * the same rules as any tag bump.
 */
function decideSeriesBump(
  pin: AppPin,
  tags: readonly UpstreamTag[],
  relation: (base: string, head: string) => CommitRelation | null,
): BumpDecision {
  const { ref, sha } = pin.source;
  const series = parseSeriesTag(ref);
  if (!series) {
    return {
      action: "skip",
      reason: `pinned to tag ${ref}, which is not a semver release; left alone`,
    };
  }
  if (!series.stable) {
    return { action: "skip", reason: `pinned to prerelease ${ref}; left alone` };
  }
  const next = newestInSeries(tags, series.prefix, series.stable);
  if (!next) {
    return {
      action: "skip",
      reason: `pinned to tag ${ref}; upstream has no stable ${series.prefix}<version> tag newer than it; left alone`,
    };
  }
  const related = next.sha === sha ? { ahead: 0, behind: 0 } : relation(sha, next.sha);
  if (related !== null && related.behind === 0) {
    return { action: "bump", bump: bumpFor(pin, tagTarget(next)) };
  }
  const tag = `tag ${next.name}@${shortSha(next.sha)}`;
  return {
    action: "skip",
    reason:
      related === null
        ? `${tag} shares no history with the pinned ${shortSha(sha)}; left alone`
        : `${tag} does not contain the pinned ${shortSha(sha)}; left alone`,
  };
}

function tagTarget(tag: UpstreamTag): UpstreamTarget {
  return { ref: tag.name, sha: tag.sha, kind: "tag" };
}

/** A repository directory as written in a manifest, normalized; null for the root. */
function repoDirectory(dir: string): string | null {
  const normalized = path.posix.normalize(dir.replaceAll("\\", "/")).replace(/^\/+|\/+$/g, "");
  return normalized === "." || normalized === "" ? null : normalized;
}

/**
 * The repository directory an app lives in, from its `install.wranglerConfig`
 * (`r2-explorer-template/wrangler.json` gives `r2-explorer-template`); null when
 * the config is at the repository root.
 */
export function appDirectory(wranglerConfig: string): string | null {
  return repoDirectory(path.posix.dirname(wranglerConfig.replaceAll("\\", "/")));
}

/**
 * The repository directories whose changes can change an app's build: the
 * directory of `install.wranglerConfig` and of each
 * `install.workers[].wranglerConfig`, and each directory `install.installDirs`
 * declares. Sorted, without duplicates or directories inside another listed
 * one; null when any of them is the repository root, since every upstream
 * change may then touch the app. The default install at the root, when
 * `installDirs` is absent, does not count: the root lockfile changes with every
 * dependency bump and says little about one app.
 */
export function appDirectories(pin: AppPin): string[] | null {
  const candidates = [
    appDirectory(pin.install.wranglerConfig),
    ...(pin.install.workers ?? []).map((w) => appDirectory(w.wranglerConfig)),
    ...(pin.install.installDirs ?? []).map((d) => repoDirectory(d.path)),
  ];
  const dirs = new Set<string>();
  for (const dir of candidates) {
    if (dir === null) {
      return null;
    }
    dirs.add(dir);
  }
  const sorted = [...dirs].sort();
  return sorted.filter((dir) => !sorted.some((other) => dir.startsWith(`${other}/`)));
}

/**
 * Keeps a bump for an app in subdirectories of its repository (a monorepo of
 * many apps, or of one app's several Workers) only when the upstream changes
 * touch one of its {@link appDirectories}, since a new repository tag says
 * nothing about this app otherwise. A file list GitHub may have cut short
 * cannot prove the directories are untouched, so the bump stays.
 */
export function gateOnAppDirectories(
  pin: AppPin,
  bump: Bump,
  changedFiles: (base: string, head: string) => ChangedFiles,
): BumpDecision {
  const dirs = appDirectories(pin);
  if (dirs === null) {
    return { action: "bump", bump };
  }
  const changed = changedFiles(bump.from.sha, bump.to.sha);
  const prefixes = dirs.map((dir) => `${dir}/`);
  if (!changed.complete || changed.paths.some((p) => prefixes.some((pre) => p.startsWith(pre)))) {
    return { action: "bump", bump };
  }
  return {
    action: "skip",
    reason:
      `${bump.to.ref}@${shortSha(bump.to.sha)} changes nothing under ${prefixes.join(" or ")} ` +
      `since ${bump.from.ref}@${shortSha(bump.from.sha)}; not bumping`,
  };
}

export interface BumpPlan {
  bumps: Bump[];
  skipped: { slug: string; reason: string }[];
  /** Apps whose upstream could not be read; the others still proceed. */
  failed: { slug: string; error: string }[];
}

/**
 * Decides every app, isolating failures so one broken upstream does not stop
 * the rest. `lastBumpTag` reads the tag each app's last bump moved it to (see
 * `UpstreamState.lastBumpTag`).
 */
export function planBumps(
  apps: readonly AppEntry[],
  upstream: UpstreamSource,
  lastBumpTag: (slug: string) => string | null = () => null,
): BumpPlan {
  const plan: BumpPlan = { bumps: [], skipped: [], failed: [] };
  for (const app of apps) {
    try {
      const pin = readPin(app);
      const state: UpstreamState = {
        tags: upstream.tags(pin.repo),
        branch: (name) => upstream.branch(pin.repo, name),
        defaultBranch: () => upstream.defaultBranch(pin.repo),
        lastBumpTag: () => lastBumpTag(pin.slug),
      };
      let decision = decideBump(pin, state, (base, head) =>
        upstream.relation(pin.repo, base, head),
      );
      if (decision.action === "bump") {
        decision = gateOnAppDirectories(pin, decision.bump, (base, head) =>
          upstream.changedFiles(pin.repo, base, head),
        );
      }
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
  /** The head commit. */
  headSha: string;
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

/**
 * The pull request body: where the pin moves, the compare link, the commits,
 * and, for an entry that states `source.version`, a reminder to update it.
 */
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
    ...(bump.refChange
      ? [
          `The ref changes from ${codeSpan(bump.from.ref)} to ${codeSpan(bump.to.ref)}: ` +
            `${bump.refChange}. A bump that changes \`source.ref\` to another branch never ` +
            "merges itself.",
          "",
        ]
      : []),
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
  if (pin.source.version !== undefined) {
    const manifest = `\`apps/${pin.slug}/appflare.jsonc\``;
    const now = `(it is ${codeSpan(pin.source.version)} now)`;
    const refused =
      "publish refuses a moved pin under a `source.version` that is already released.";
    const tagged = bump.to.kind === "tag" ? parseSeriesTag(bump.to.ref) : null;
    lines.push(
      "",
      "Before merging:",
      "",
      tagged && tagged.prefix !== "" && tagged.prefix !== "v"
        ? `- [ ] Set \`source.version\` in ${manifest} to ${codeSpan(tagged.version)}, the ` +
            `version in the new tag ${codeSpan(bump.to.ref)} ${now}. The packer reads a ` +
            "version only from a tag that is a bare version such as `v1.2.3`, and " +
            refused
        : `- [ ] Set \`source.version\` in ${manifest} to ${pin.name}'s version at the new ` +
            `commit ${now}. The repository's tag does not describe this app, so this pull ` +
            `request cannot tell the new version, and ${refused}`,
    );
  }
  lines.push("", checksText(pin.tier), "", mergePathText(pin, bump));
  return `${lines.join("\n")}\n`;
}

/** What the verify workflow checks for an entry of `tier`. */
function checksText(tier: string): string {
  if (tier === "sandbox") {
    return "The verify workflow packs this pin to show that it builds. CI does not install sandbox tier entries.";
  }
  if (tier === "self-deploying") {
    return "The verify workflow validates this entry. CI does not build or install self-deploying entries.";
  }
  return "The verify workflow packs this pin, checks the artifact's hashes, and installs it into the CI account.";
}

/**
 * The pull request body's closing paragraph: who merges it, why, and when it
 * publishes. The catalog checks that a release builds and installs; it does
 * not review upstream's code, so no case promises that review.
 */
function mergePathText(pin: AppPin, bump: Bump): string {
  const manifest = `\`apps/${pin.slug}/appflare.jsonc\``;
  if (bump.autoMerge) {
    return (
      "**This pull request merges itself.** It squash-merges once the required checks pass, " +
      "the install check included, and the next nightly bump run publishes the new version. " +
      "The catalog checks that the new release builds, matches its hashes and installs; it " +
      "does not review upstream's code, and each user decides whether to update. To stop " +
      "this bump, disable auto-merge here or close the pull request. To have a maintainer " +
      `merge every bump of this app, set \`"bump": { "autoMerge": false }\` in ${manifest}, ` +
      "for example in a commit on this pull request's branch."
    );
  }
  const head = "**A maintainer merges this pull request.**";
  const tail = "Merging publishes the new version.";
  if (pin.tier !== "artifact") {
    return (
      `${head} ${manifest} is a \`${pin.tier}\` tier entry, which CI does not install, so ` +
      `none of its bumps merges itself. ${tail}`
    );
  }
  if (pin.source.version !== undefined) {
    return (
      `${head} ${manifest} sets \`source.version\`, which has to be updated by hand first, ` +
      `so this pull request does not merge itself. ${tail}`
    );
  }
  if (pin.autoMerge === "off") {
    return (
      `${head} ${manifest} sets \`bump.autoMerge\` to \`false\`, so its bumps wait for a ` +
      `maintainer instead of merging themselves once the checks pass. ${tail}`
    );
  }
  if (bump.refChange) {
    return (
      `${head} It moves \`source.ref\` to another branch, so it does not merge itself: ` +
      `check that ${codeSpan(bump.to.ref)} is the line this app should follow. ${tail}`
    );
  }
  return (
    `${head} The bump bot cannot read the \`bump\` setting in ${manifest}, so it leaves ` +
    `the merge to a maintainer; \`pnpm validate\` says what is wrong. ${tail}`
  );
}

/** `appflare.jsonc` text with `source.ref`/`source.sha` replaced, comments kept. */
export function applyBump(text: string, to: { ref: string; sha: string }): string {
  return setJsoncStrings(text, [
    { path: ["source", "ref"], value: to.ref },
    { path: ["source", "sha"], value: to.sha },
  ]);
}

/**
 * The status checks main's ruleset requires, with the workflow that reports
 * each on a bump branch: the bump workflow starts both with workflow_dispatch,
 * and they set their result as a commit status of that name.
 */
export const REQUIRED_CHECKS = [
  { context: "verify passed", workflow: "verify.yml" },
  { context: "commit messages", workflow: "conventions.yml" },
] as const;

/**
 * How long an open bump pull request may go without a required check on its
 * head before it needs a person. Far longer than a verify run takes.
 */
export const CHECKS_GRACE_MS = 6 * 60 * 60 * 1000;

/**
 * What in an app's existing bumps needs a person, one line each. Both would
 * otherwise wait forever, with nothing in the run to say so:
 *
 * - a bump branch without any pull request (the bump workflow pushed it but
 *   could not open the pull request): `gateBump` counts the target as proposed,
 *   so no run proposes it again;
 * - an open bump pull request, opened at least {@link CHECKS_GRACE_MS} ago,
 *   whose head commit lacks a required check (its checks never started, or
 *   never reported): it cannot merge. `reported(sha)` names the checks the pull
 *   request sees on that commit.
 *
 * Pull requests in `skip` (this run supersedes them) are left out.
 */
export function outstandingBumps(
  existing: { branches: readonly string[]; prs: readonly BumpPr[] },
  reported: (sha: string) => readonly string[],
  now: Date,
  skip: ReadonlySet<number> = new Set(),
): string[] {
  const lines: string[] = [];
  for (const branch of existing.branches) {
    if (!existing.prs.some((p) => p.head === branch)) {
      lines.push(
        `${branch} has no pull request, so no bump run proposes its target again; ` +
          "open the pull request by hand, or delete the branch",
      );
    }
  }
  for (const pr of existing.prs) {
    if (
      pr.state !== "open" ||
      skip.has(pr.number) ||
      now.getTime() - Date.parse(pr.createdAt) < CHECKS_GRACE_MS
    ) {
      continue;
    }
    const seen = reported(pr.headSha);
    const missing = REQUIRED_CHECKS.filter((c) => !seen.includes(c.context));
    if (missing.length > 0) {
      const hours = CHECKS_GRACE_MS / 3_600_000;
      lines.push(
        `#${pr.number} (${pr.head}) has no ${missing.map((c) => `"${c.context}"`).join(" or ")} ` +
          `on ${shortSha(pr.headSha)} after ${hours} hours, so it cannot merge; start ` +
          missing.map((c) => `gh workflow run ${c.workflow} --ref ${pr.head}`).join(" and "),
      );
    }
  }
  return lines;
}
