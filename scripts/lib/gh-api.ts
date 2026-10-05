import { spawnSync } from "node:child_process";

/**
 * GitHub REST calls through the GitHub CLI, which keeps authentication (the
 * token never passes through this process). Every call runs `gh api --include`,
 * so the HTTP status and headers are known even when gh fails to read the body:
 * gh answers an error response whose JSON body is empty or cut short with
 * nothing but "unexpected end of JSON input". Transient failures are retried
 * with exponential backoff, rate limits wait as GitHub asks, and a final
 * failure names the method, endpoint, status, attempts and body.
 */

export type HttpMethod = "GET" | "HEAD" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface GhRequest {
  /** Path under the REST root (`repos/o/r/releases`), with any query string. */
  path: string;
  /** Default GET. */
  method?: HttpMethod;
  /** Accept header, for example `application/octet-stream` for a release asset. */
  accept?: string;
  /** jq filter gh applies to each response body; the result is what is returned. */
  jq?: string;
  /**
   * GET every page (`per_page=100` unless the path sets it), following each
   * response's `Link: rel="next"`, and return the pages' outputs one after
   * another. Needs `jq` (so each page yields lines, not a JSON array).
   */
  paginate?: boolean;
}

/**
 * Runs one GitHub API request and returns the body of its 2xx response (jq's
 * output when `jq` is set). Throws {@link GhNotFoundError} for HTTP 404 and
 * {@link GhApiError} for any other failure.
 */
export type GhRunner = (request: GhRequest) => Buffer;

/** HTTP 404. Never retried: callers decide whether it means "absent". */
export class GhNotFoundError extends Error {}

/** A request that failed for good, after `attempts` tries. */
export class GhApiError extends Error {
  /** Last HTTP status, or null when no response arrived. */
  readonly status: number | null;
  readonly attempts: number;
  constructor(message: string, status: number | null, attempts: number) {
    super(message);
    this.status = status;
    this.attempts = attempts;
  }
}

/** What one `gh` process produced. */
export interface GhProcessResult {
  stdout: Buffer;
  /** gh's stderr, which never holds the token. */
  stderr: string;
  /** Exit code, or null when gh did not exit on its own. */
  exitCode: number | null;
  /** Set when gh could not be started or was stopped (ENOENT, ETIMEDOUT). */
  errorCode?: string;
}

/** Starts `gh` with these arguments and waits for it. */
export type GhProcess = (args: string[]) => GhProcessResult;

/** One HTTP response as `gh api --include` printed it. */
export interface GhResponse {
  status: number;
  /** Header names lower-cased; repeated headers joined with ", " (as gh prints them). */
  headers: Map<string, string>;
  /** What gh printed after the headers: the body, or jq's output of it. */
  body: Buffer;
}

export interface GhApiOptions {
  exec?: GhProcess;
  /** Blocks for `ms` milliseconds. */
  sleep?: (ms: number) => void;
  /** Current time in epoch milliseconds (for `x-ratelimit-reset`). */
  now?: () => number;
  /** Receives one line per retry. */
  log?: (message: string) => void;
  /** Tries per request, including the first. Default 5. */
  maxAttempts?: number;
  /** First backoff; doubles on each retry. Default 1 s. */
  baseDelayMs?: number;
  /** Longest single wait. A rate limit that asks for more fails at once. Default 2 min. */
  maxDelayMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 120_000;
/** GitHub's guidance for a rate limit that names no reset time: wait at least a minute. */
const RATE_LIMIT_FLOOR_MS = 60_000;
/** Longest one gh process may run before it counts as a network failure. */
const GH_TIMEOUT_MS = 120_000;
const BODY_SNIPPET_CHARS = 200;
const MAX_PAGES = 1000;

const execGh: GhProcess = (args) => {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  // Forced colour or TTY output would put escape codes into the headers parsed below.
  delete env.CLICOLOR_FORCE;
  delete env.GH_FORCE_TTY;
  const res = spawnSync("gh", args, {
    env,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GH_TIMEOUT_MS,
  });
  const errorCode = (res.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    stdout: res.stdout ?? Buffer.alloc(0),
    stderr: res.stderr?.toString("utf8") ?? "",
    exitCode: res.status,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
};

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Splits `gh api --include` output into status, headers and body. gh writes the
 * status line, then `Name: value\r\n` per header, then an empty `\r\n` line,
 * then the body. Null when the output does not start with a status line (no
 * response arrived).
 */
export function parseIncluded(stdout: Buffer): GhResponse | null {
  const lineEnd = stdout.indexOf("\n");
  if (lineEnd < 0) {
    return null;
  }
  const match = /^HTTP\/[\d.]+ (\d{3})/.exec(stdout.subarray(0, lineEnd).toString("latin1"));
  if (!match) {
    return null;
  }
  const headers = new Map<string, string>();
  let pos = lineEnd + 1;
  for (;;) {
    const end = stdout.indexOf("\r\n", pos);
    if (end < 0) {
      // Headers cut short: no body followed.
      return { status: Number(match[1]), headers, body: Buffer.alloc(0) };
    }
    const line = stdout.subarray(pos, end).toString("latin1");
    pos = end + 2;
    if (line === "") {
      break;
    }
    const colon = line.indexOf(":");
    if (colon > 0) {
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
  }
  return { status: Number(match[1]), headers, body: stdout.subarray(pos) };
}

/** Whether repeating the request cannot apply it twice (RFC 9110 idempotent methods). */
function idempotent(method: HttpMethod): boolean {
  return method !== "POST" && method !== "PATCH";
}

/**
 * gh failed before any request byte reached GitHub: name resolution, the TCP
 * connect, or the TLS handshake. Only these are safe to repeat for a
 * non-idempotent request; a reset or timeout after connecting may follow a
 * request GitHub already applied.
 */
const BEFORE_REQUEST = /no such host|dial tcp|connection refused|TLS handshake|x509:/i;
const RATE_LIMITED = /rate limit/i;

type Verdict =
  | { kind: "ok"; response: GhResponse }
  | { kind: "not-found"; response: GhResponse }
  | { kind: "retry"; reason: string; response: GhResponse | null; rateLimited: boolean }
  | { kind: "fail"; reason: string; response: GhResponse | null };

/** Decides what one gh process's result means for a request with this method. */
export function classify(method: HttpMethod, result: GhProcessResult): Verdict {
  if (result.errorCode === "ENOENT") {
    throw new Error("the GitHub CLI (gh) is not installed");
  }
  const stderr = oneLine(result.stderr);
  const response = parseIncluded(result.stdout);
  if (response === null) {
    const reason =
      result.errorCode === "ETIMEDOUT"
        ? `no response within ${GH_TIMEOUT_MS / 1000}s`
        : `no HTTP response${stderr ? ` (${stderr})` : ""}`;
    if (result.exitCode === 0 && result.errorCode === undefined) {
      return { kind: "fail", reason: "gh printed no HTTP status line", response };
    }
    if (idempotent(method) || BEFORE_REQUEST.test(result.stderr)) {
      return { kind: "retry", reason, response, rateLimited: false };
    }
    return { kind: "fail", reason, response };
  }
  const { status } = response;
  // gh's own "gh: HTTP 502" adds nothing to the status already named.
  const detail = stderr && stderr !== `gh: HTTP ${status}` ? ` (${stderr})` : "";
  if (status >= 200 && status < 300) {
    if (result.exitCode === 0) {
      return { kind: "ok", response };
    }
    // gh got a success status but could not read or filter the body: an empty
    // or truncated body, or a connection reset while reading it.
    const reason = `HTTP ${status}, but gh could not read the body${detail}`;
    return idempotent(method)
      ? { kind: "retry", reason, response, rateLimited: false }
      : { kind: "fail", reason, response };
  }
  if (status === 404) {
    return { kind: "not-found", response };
  }
  const reason = `HTTP ${status}${detail}`;
  const limited =
    status === 429 ||
    (status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        response.headers.has("retry-after") ||
        RATE_LIMITED.test(result.stderr) ||
        RATE_LIMITED.test(response.body.toString("utf8"))));
  if (limited) {
    // GitHub refuses a rate-limited request without applying it, so any method may repeat.
    return { kind: "retry", reason, response, rateLimited: true };
  }
  if (status >= 500 && idempotent(method)) {
    return { kind: "retry", reason, response, rateLimited: false };
  }
  return { kind: "fail", reason, response };
}

/**
 * How long to wait before attempt `attempt + 1`: `retry-after` when present,
 * else `x-ratelimit-reset` when the rate limit is spent, else a minute for any
 * other rate limit, else exponential backoff from `baseMs`.
 */
export function retryDelayMs(
  response: GhResponse | null,
  rateLimited: boolean,
  attempt: number,
  baseMs: number,
  nowMs: number,
): number {
  const backoff = baseMs * 2 ** (attempt - 1);
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) {
      return Math.max(0, date - nowMs);
    }
  }
  const reset = Number(response?.headers.get("x-ratelimit-reset"));
  if (response?.headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset)) {
    return Math.max(0, reset * 1000 - nowMs) + 1000;
  }
  return rateLimited ? Math.max(RATE_LIMIT_FLOOR_MS, backoff) : backoff;
}

/** The endpoint as it may appear in logs: the path only, no host and no query string. */
export function endpointLabel(path: string): string {
  const noQuery = path.split("?")[0] ?? path;
  return noQuery.replace(/^https?:\/\/[^/]+\//, "");
}

function oneLine(text: string): string {
  const line = text.trim().replace(/\s+/g, " ");
  return line.length > 300 ? `${line.slice(0, 300)}...` : line;
}

/** The body for an error message: nothing when it is JSON (gh's stderr quotes its message). */
function bodyNote(response: GhResponse | null): string {
  if (response === null) {
    return "";
  }
  const text = response.body.toString("utf8");
  if (text.trim() === "") {
    return "; empty body";
  }
  try {
    JSON.parse(text);
    return "";
  } catch {
    return `; body: ${JSON.stringify(text.slice(0, BODY_SNIPPET_CHARS))}`;
  }
}

function args(request: GhRequest, path: string, method: HttpMethod): string[] {
  return [
    "api",
    "--include",
    "--method",
    method,
    ...(request.accept === undefined ? [] : ["-H", `Accept: ${request.accept}`]),
    path,
    ...(request.jq === undefined ? [] : ["--jq", request.jq]),
  ];
}

function withPerPage(path: string): string {
  const query = path.split("?")[1];
  if (query !== undefined && new URLSearchParams(query).has("per_page")) {
    return path;
  }
  return `${path}${query === undefined ? "?" : "&"}per_page=100`;
}

/** The `rel="next"` URL of a Link header, if any. */
export function nextLink(link: string | undefined): string | null {
  for (const part of (link ?? "").split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m?.[1]) {
      return m[1];
    }
  }
  return null;
}

/** A {@link GhRunner} with the retry policy described at the top of this module. */
export function createGhRunner(options: GhApiOptions = {}): GhRunner {
  const exec = options.exec ?? execGh;
  const sleep = options.sleep ?? sleepSync;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((m: string) => process.stderr.write(`warning: ${m}\n`));
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  const once = (request: GhRequest, path: string): GhResponse => {
    const method = request.method ?? "GET";
    const label = `gh api ${method} ${endpointLabel(path)}`;
    for (let attempt = 1; ; attempt++) {
      const verdict = classify(method, exec(args(request, path, method)));
      if (verdict.kind === "ok") {
        return verdict.response;
      }
      if (verdict.kind === "not-found") {
        throw new GhNotFoundError(`${label}: HTTP 404`);
      }
      const tries = `${attempt} attempt${attempt === 1 ? "" : "s"}`;
      const failure = `${verdict.reason}${bodyNote(verdict.response)}`;
      const status = verdict.response?.status ?? null;
      if (verdict.kind === "fail" || attempt >= maxAttempts) {
        throw new GhApiError(`${label} failed after ${tries}: ${failure}`, status, attempt);
      }
      const delay = retryDelayMs(verdict.response, verdict.rateLimited, attempt, baseMs, now());
      if (delay > maxDelayMs) {
        throw new GhApiError(
          `${label} failed after ${tries}: ${failure}; GitHub asks to wait ` +
            `${Math.ceil(delay / 1000)}s, longer than the ${maxDelayMs / 1000}s this run waits`,
          status,
          attempt,
        );
      }
      log(
        `${label}: ${failure} (attempt ${attempt} of ${maxAttempts}); ` +
          `retrying in ${Math.ceil(delay / 1000)}s`,
      );
      sleep(delay);
    }
  };

  return (request) => {
    if (!request.paginate) {
      return once(request, request.path).body;
    }
    if ((request.method ?? "GET") !== "GET" || request.jq === undefined) {
      throw new Error(`paginating ${endpointLabel(request.path)} needs a GET with a jq filter`);
    }
    const pages: Buffer[] = [];
    let path: string | null = withPerPage(request.path);
    while (path !== null) {
      if (pages.length >= MAX_PAGES) {
        throw new Error(`${endpointLabel(request.path)}: more than ${MAX_PAGES} pages`);
      }
      const response = once(request, path);
      pages.push(response.body);
      // An absolute URL on the API host, used verbatim as gh --paginate does.
      path = nextLink(response.headers.get("link"));
    }
    return Buffer.concat(pages);
  };
}

/** The default runner: real `gh`, real waits, retries logged to stderr. */
export const runGh: GhRunner = createGhRunner();
