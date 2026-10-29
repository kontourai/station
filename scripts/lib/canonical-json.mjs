/**
 * Key-sorted JSON for digests and byte comparisons. Digests recorded by
 * callers (SBOMs, verification request keys, workflow policy hashes) depend
 * on these exact bytes, so a change here changes every recorded digest.
 *
 * documentation-freshness.mjs keeps its own variant because it drops
 * `undefined` members, which these do not, and release-cohort.mjs keeps one
 * that refuses non-JSON values. dependency-lifecycle-policy.mjs keeps an
 * identical inline copy because the container's dependencies stage copies
 * that module's imports file by file.
 */

/** Serializes `value` with object keys sorted at every depth. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Returns a copy of `value` whose object keys are sorted at every depth. */
export function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  return value;
}
