/**
 * Path-segment validation (SEC-1, `s201-knowledge-retrieval` remediation pass).
 *
 * `migrate-pre-index-knowledge.ts` joins a caller-supplied `projectSlug` (and pre-index
 * directory names it discovers via `readdirSync`) directly into filesystem paths on
 * BOTH the read side (`discoverPreIndexNamespaces`/`defaultKnowledgeStorageDir`'s
 * `join(dataDir, 'projects', projectSlug, ...)`) and the write side
 * (`knowledgeStoreRootPathForNamespace` -> `kit-default-store`'s `mkdirSync`/
 * `writeFileSync`). An unvalidated slug containing `..` or a path separator can
 * therefore both read and write outside `dataDir` entirely. This module is the
 * single place that decides whether a string is safe to use as ONE path segment
 * before it ever reaches `node:path`'s `join()`.
 *
 * No existing helper in this repo covers this: `knowledge-store/adapters/shared/
 * identity.ts`'s `validateSlug`/`SLUG_PATTERN` validates Kit record *alias* slugs
 * (a different concept — lowercase-only, and explicitly permits `/` as a category
 * separator, which would make it unsafe to reuse here for a filesystem path
 * segment). This helper is deliberately stricter and allows uppercase (matching
 * real-world project slugs already observed in this repo, e.g. `acme`/`Acme`).
 */

/** A single safe path segment: starts with an alphanumeric, followed by any run of
 * alphanumerics/dot/underscore/hyphen. No `/`, no `\`, no `..` anywhere in the value. */
export const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafePathSegment(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.includes('..')) return false;
  if (value.includes('/') || value.includes('\\')) return false;
  return PATH_SEGMENT_PATTERN.test(value);
}

export class InvalidPathSegmentError extends Error {
  constructor(
    public readonly kind: string,
    public readonly value: unknown,
  ) {
    super(
      `Invalid ${kind}: ${JSON.stringify(value)} — must be a single path segment matching ${PATH_SEGMENT_PATTERN} with no '..' and no path separators`,
    );
    this.name = 'InvalidPathSegmentError';
  }
}

/** Throws `InvalidPathSegmentError` for a caller-supplied value that isn't a safe
 * path segment. Used at trust boundaries (route bodies, exported function options)
 * where an invalid value must fail loudly rather than be silently skipped. */
export function assertSafePathSegment(
  kind: string,
  value: unknown,
): asserts value is string {
  if (!isSafePathSegment(value)) {
    throw new InvalidPathSegmentError(kind, value);
  }
}
