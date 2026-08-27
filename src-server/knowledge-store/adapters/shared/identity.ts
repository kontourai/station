/**
 * Record identity resolution — short-id prefix + slug aliases (store-contract.md Addendum H).
 *
 * On-disk identity is unchanged: records remain keyed by their full `id` (§9). These
 * helpers add a *resolution layer* over that identity so a query token passed to
 * `get`/`getLinks` may be the full id, a category-scoped human-readable slug alias, or
 * an unambiguous id prefix. Shared by both Station-owned Kit-format adapters so both
 * resolve identically.
 */
import {
  AmbiguousIdError,
  KnowledgeStoreCorruptionError,
  MissingEvidenceError,
  SlugConflictError,
} from '../../errors.js';

/** Minimum length of an id prefix eligible for prefix resolution (Addendum H.7). */
export const MIN_ID_PREFIX = 8;

/** Valid slug alias shape (Addendum H.4/H.7): lowercase, dot/slash/hyphen/underscore, <=200 chars. */
export const SLUG_PATTERN = '^[a-z0-9]([a-z0-9._/-]*[a-z0-9])?$';
const SLUG_RE = new RegExp(SLUG_PATTERN);

export function validateSlug(slug: unknown): slug is string {
  return (
    typeof slug === 'string' &&
    slug.length > 0 &&
    slug.length <= 200 &&
    SLUG_RE.test(slug)
  );
}

/**
 * Validate + de-duplicate a caller-supplied `aliases` array. Throws MISSING_EVIDENCE
 * on a non-array or a malformed slug, so bad aliases are rejected at the mutation
 * boundary rather than reaching disk.
 */
export function normalizeAliases(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new MissingEvidenceError('aliases must be an array of slug strings');
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (!validateSlug(raw)) {
      throw new MissingEvidenceError(
        `invalid slug alias: ${JSON.stringify(raw)} (must match ${SLUG_PATTERN})`,
      );
    }
    if (!seen.has(raw)) {
      seen.add(raw);
      out.push(raw);
    }
  }
  return out;
}

export interface ResolveContext {
  idExists: (id: string) => boolean;
  listIds: () => Iterable<string>;
  bySlug?: Record<string, string>;
}

/**
 * Resolve a query token to a single record id, in precedence order: (1) exact full id,
 * (2) slug alias whose target still exists, (3) unambiguous id prefix (>= MIN_ID_PREFIX
 * chars). Returns `null` when the token resolves to nothing. Throws `AmbiguousIdError`
 * when a prefix matches more than one record.
 */
export function resolveRecordId(
  input: string,
  ctx: ResolveContext,
): string | null {
  if (typeof input !== 'string' || input.length === 0) return null;

  // 1. Exact full-id match.
  if (ctx.idExists(input)) return input;

  // 2. Slug alias.
  const bySlug = ctx.bySlug ?? {};
  if (Object.hasOwn(bySlug, input)) {
    const target = bySlug[input];
    if (target && ctx.idExists(target)) return target;
  }

  // 3. Unambiguous id prefix.
  if (input.length >= MIN_ID_PREFIX) {
    const matches: string[] = [];
    for (const id of ctx.listIds()) {
      if (typeof id === 'string' && id.startsWith(input)) matches.push(id);
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new AmbiguousIdError(input, matches);
  }

  return null;
}

export interface AliasIndex {
  schema_version: string;
  by_slug: Record<string, string>;
}

export const ALIAS_INDEX_SCHEMA_VERSION = '1.0';

export function emptyAliasIndex(): AliasIndex {
  return { schema_version: ALIAS_INDEX_SCHEMA_VERSION, by_slug: {} };
}

export function assertAliasIndex(value: unknown, source: string): AliasIndex {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new KnowledgeStoreCorruptionError(
      `${source}: alias index must be an object`,
    );
  }
  const index = value as Partial<AliasIndex>;
  if (
    index.schema_version !== ALIAS_INDEX_SCHEMA_VERSION ||
    !index.by_slug ||
    typeof index.by_slug !== 'object' ||
    Array.isArray(index.by_slug) ||
    Object.entries(index.by_slug).some(
      ([slug, id]) => !validateSlug(slug) || typeof id !== 'string' || !id,
    )
  ) {
    throw new KnowledgeStoreCorruptionError(
      `${source}: alias index has an unsupported shape`,
    );
  }
  return index as AliasIndex;
}

/**
 * Point each slug at `id` in the alias map. A slug already owned by a different
 * record throws `SlugConflictError`. Re-registering a slug already owned by `id` is
 * an idempotent no-op.
 */
export function registerAliases(
  index: AliasIndex,
  id: string,
  slugs: string[],
): void {
  for (const slug of slugs) {
    const owner = index.by_slug[slug];
    if (owner && owner !== id) {
      throw new SlugConflictError(slug, owner);
    }
    index.by_slug[slug] = id;
  }
}
