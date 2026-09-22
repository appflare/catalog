/** Canonical JSON for structural comparison of manifests. Dependency-free. */

/** JSON with object keys sorted at every level and `undefined` members dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** `value` round-tripped through {@link canonicalJson}. */
export function canonicalize<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/** Top-level fields whose values differ between two objects, sorted. */
export function changedFields(a: unknown, b: unknown): string[] {
  const x = (a ?? {}) as Record<string, unknown>;
  const y = (b ?? {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(x), ...Object.keys(y)])]
    .filter((k) => canonicalJson(x[k]) !== canonicalJson(y[k]))
    .sort();
}
