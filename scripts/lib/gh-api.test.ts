import { describe, expect, it } from "vitest";
import {
  createGhRunner,
  endpointLabel,
  GhApiError,
  GhNotFoundError,
  type GhProcessResult,
  nextLink,
  parseIncluded,
} from "./gh-api.ts";

/** What `gh api --include` prints for one response, and how gh exits. */
function http(
  status: number,
  body: string,
  options: { headers?: Record<string, string>; stderr?: string; exitCode?: number } = {},
): GhProcessResult {
  const headers = { "Content-Type": "application/json; charset=utf-8", ...options.headers };
  const head = Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  const ok = status >= 200 && status < 300;
  return {
    stdout: Buffer.from(`HTTP/2.0 ${status} Status\n${head}\r\n${body}`),
    stderr: options.stderr ?? (ok ? "" : `gh: HTTP ${status}\n`),
    exitCode: options.exitCode ?? (ok ? 0 : 1),
  };
}

/** gh exits before any response arrived. */
const noResponse = (stderr: string): GhProcessResult => ({
  stdout: Buffer.alloc(0),
  stderr,
  exitCode: 1,
});

/** A runner over scripted gh results, recording each call's arguments and every wait. */
function scripted(results: GhProcessResult[], now = 0) {
  const calls: string[][] = [];
  const waits: number[] = [];
  const logs: string[] = [];
  const run = createGhRunner({
    exec: (args) => {
      calls.push(args);
      const next = results.shift();
      if (next === undefined) {
        throw new Error(`unexpected gh call ${args.join(" ")}`);
      }
      return next;
    },
    sleep: (ms) => waits.push(ms),
    now: () => now,
    log: (m) => logs.push(m),
  });
  return { run, calls, waits, logs };
}

const ASSET = "repos/appflare/catalog/releases/assets/7";

describe("parseIncluded", () => {
  it("splits the status line, headers and body", () => {
    const res = parseIncluded(
      http(200, '{"a":1}', { headers: { Link: '<x>; rel="next"' } }).stdout,
    );
    expect(res?.status).toBe(200);
    expect(res?.headers.get("link")).toBe('<x>; rel="next"');
    expect(res?.body.toString()).toBe('{"a":1}');
  });

  it("returns null when gh printed no status line", () => {
    expect(parseIncluded(Buffer.alloc(0))).toBe(null);
    expect(parseIncluded(Buffer.from("{}\n"))).toBe(null);
  });
});

describe("createGhRunner retries", () => {
  it("retries an empty body gh could not parse, then succeeds", () => {
    const { run, calls, waits } = scripted([
      http(200, "", { stderr: "unexpected end of JSON input\n", exitCode: 1 }),
      http(200, "manifest"),
    ]);
    expect(run({ path: ASSET, accept: "application/octet-stream" }).toString()).toBe("manifest");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      "api",
      "--include",
      "--method",
      "GET",
      "-H",
      "Accept: application/octet-stream",
      ASSET,
    ]);
    expect(waits).toEqual([1000]);
  });

  it("retries an error status whose JSON body is empty (gh's bare 'unexpected end of JSON input')", () => {
    const { run, waits } = scripted([
      http(502, "", { stderr: "unexpected end of JSON input\n" }),
      http(200, "ok"),
    ]);
    expect(run({ path: ASSET }).toString()).toBe("ok");
    expect(waits).toEqual([1000]);
  });

  it("retries a 502, then succeeds", () => {
    const { run, calls } = scripted([
      http(502, "<html>Bad Gateway</html>", { headers: { "Content-Type": "text/html" } }),
      http(200, "ok"),
    ]);
    expect(run({ path: ASSET, jq: ".x" }).toString()).toBe("ok");
    expect(calls[1]).toEqual(["api", "--include", "--method", "GET", ASSET, "--jq", ".x"]);
  });

  it("retries a connection reset before any response", () => {
    const { run } = scripted([
      noResponse('Get "https://api.github.com/x": read tcp: read: connection reset by peer\n'),
      http(200, "ok"),
    ]);
    expect(run({ path: ASSET }).toString()).toBe("ok");
  });

  it("does not retry a 404", () => {
    const { run, calls } = scripted([
      http(404, '{"message":"Not Found"}', { stderr: "gh: Not Found (HTTP 404)\n" }),
    ]);
    expect(() => run({ path: ASSET })).toThrow(GhNotFoundError);
    expect(calls).toHaveLength(1);
  });

  it.each([400, 401, 403, 422])("does not retry HTTP %i", (status) => {
    const { run, calls } = scripted([
      http(status, '{"message":"no"}', { stderr: `gh: no (HTTP ${status})\n` }),
    ]);
    expect(() => run({ path: ASSET })).toThrow(`failed after 1 attempt: HTTP ${status}`);
    expect(calls).toHaveLength(1);
  });

  it("honours Retry-After on a 429", () => {
    const { run, waits } = scripted([
      http(429, '{"message":"slow down"}', { headers: { "Retry-After": "7" } }),
      http(200, "ok"),
    ]);
    expect(run({ path: ASSET }).toString()).toBe("ok");
    expect(waits).toEqual([7000]);
  });

  it("waits for x-ratelimit-reset on a spent rate limit, and a minute for a secondary one", () => {
    const { run, waits } = scripted(
      [
        http(403, '{"message":"API rate limit exceeded"}', {
          headers: { "X-Ratelimit-Remaining": "0", "X-Ratelimit-Reset": "1030" },
        }),
        http(403, '{"message":"You have exceeded a secondary rate limit."}', {
          stderr: "gh: You have exceeded a secondary rate limit. (HTTP 403)\n",
        }),
        http(200, "ok"),
      ],
      1_000_000,
    );
    expect(run({ path: ASSET }).toString()).toBe("ok");
    expect(waits).toEqual([31_000, 60_000]);
  });

  it("fails at once when a rate limit asks for a longer wait than the run allows", () => {
    const { run, calls } = scripted([http(429, "", { headers: { "Retry-After": "3600" } })]);
    expect(() => run({ path: ASSET })).toThrow(/asks to wait 3600s, longer than the 120s/);
    expect(calls).toHaveLength(1);
  });

  it("gives up after 5 attempts with the method, endpoint, status, attempts and body", () => {
    const failing = () =>
      http(502, "<html><body>Bad Gateway</body></html>", {
        headers: { "Content-Type": "text/html" },
        stderr: "gh: HTTP 502\n",
      });
    const { run, calls, waits, logs } = scripted([1, 2, 3, 4, 5].map(failing));
    let error: unknown;
    try {
      run({ path: `${ASSET}?page=2`, accept: "application/octet-stream" });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(GhApiError);
    expect((error as GhApiError).status).toBe(502);
    expect((error as GhApiError).attempts).toBe(5);
    expect((error as Error).message).toBe(
      `gh api GET ${ASSET} failed after 5 attempts: HTTP 502; ` +
        'body: "<html><body>Bad Gateway</body></html>"',
    );
    expect(calls).toHaveLength(5);
    expect(waits).toEqual([1000, 2000, 4000, 8000]);
    expect(logs[0]).toMatch(/\(attempt 1 of 5\); retrying in 1s$/);
  });

  it("cuts a long non-JSON body to 200 characters and says when it is empty", () => {
    const long = scripted([
      http(400, "x".repeat(500), { headers: { "Content-Type": "text/plain" } }),
    ]);
    expect(() => long.run({ path: ASSET })).toThrow(`body: "${"x".repeat(200)}"`);
    const empty = scripted([http(400, "")]);
    expect(() => empty.run({ path: ASSET })).toThrow(/HTTP 400; empty body$/);
  });

  it("does not repeat a POST that may have been applied, but does one that never left", () => {
    const applied = scripted([http(502, "")]);
    expect(() => applied.run({ path: "repos/o/r/releases", method: "POST" })).toThrow(
      /failed after 1 attempt: HTTP 502/,
    );
    const reset = scripted([noResponse("read: connection reset by peer")]);
    expect(() => reset.run({ path: "repos/o/r/releases", method: "POST" })).toThrow(
      /failed after 1 attempt: no HTTP response/,
    );
    const refused = scripted([
      noResponse(
        'Post "https://api.github.com/x": dial tcp 1.2.3.4:443: connect: connection refused',
      ),
      http(201, "{}"),
    ]);
    expect(refused.run({ path: "repos/o/r/releases", method: "POST" }).toString()).toBe("{}");
  });

  it("reports a missing gh without retrying", () => {
    const { run } = scripted([
      { stdout: Buffer.alloc(0), stderr: "", exitCode: null, errorCode: "ENOENT" },
    ]);
    expect(() => run({ path: ASSET })).toThrow(/gh\) is not installed/);
  });
});

describe("createGhRunner pagination", () => {
  it("follows Link rel=next, retrying a failed page on its own", () => {
    const next = "https://api.github.com/repositories/1/releases?per_page=100&page=2";
    const { run, calls } = scripted([
      http(200, "a\nb\n", { headers: { Link: `<${next}>; rel="next", <${next}>; rel="last"` } }),
      http(502, ""),
      http(200, "c\n"),
    ]);
    expect(run({ path: "repos/o/r/releases", paginate: true, jq: ".[]" }).toString()).toBe(
      "a\nb\nc\n",
    );
    expect(calls.map((c) => c[4])).toEqual(["repos/o/r/releases?per_page=100", next, next]);
  });

  it("keeps a per_page the path already sets", () => {
    const { run, calls } = scripted([http(200, "")]);
    run({ path: "repos/o/r/tags?per_page=50", paginate: true, jq: ".[]" });
    expect(calls[0]?.[4]).toBe("repos/o/r/tags?per_page=50");
  });
});

describe("helpers", () => {
  it("labels an endpoint without host or query", () => {
    expect(endpointLabel("https://api.github.com/repositories/1/releases?page=2")).toBe(
      "repositories/1/releases",
    );
    expect(endpointLabel("repos/o/r/pulls?state=all")).toBe("repos/o/r/pulls");
  });

  it("finds the next link", () => {
    expect(nextLink('<https://a/1>; rel="prev", <https://a/3>; rel="next"')).toBe("https://a/3");
    expect(nextLink('<https://a/1>; rel="last"')).toBe(null);
    expect(nextLink(undefined)).toBe(null);
  });
});
