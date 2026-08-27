/**
 * Error contract for `KnowledgeStoreAdapter` implementations (store-contract.md §8.1).
 * Every mutation method MUST throw one of these (never a plain `Error`) so callers can
 * distinguish enforcement failures (`.code`) from unexpected bugs.
 */
import type { KnowledgeStoreErrorCode } from '@kontourai/station-contracts/knowledge-store';

export class MissingEvidenceError extends Error {
  readonly code: KnowledgeStoreErrorCode = 'MISSING_EVIDENCE';

  constructor(message: string) {
    super(message);
    this.name = 'MissingEvidenceError';
  }
}

export class KnowledgeRecordNotFoundError extends Error {
  readonly code: KnowledgeStoreErrorCode = 'NOT_FOUND';

  constructor(id: string) {
    super(`Record not found: ${id}`);
    this.name = 'KnowledgeRecordNotFoundError';
  }
}

export class AmbiguousIdError extends Error {
  readonly code: KnowledgeStoreErrorCode = 'AMBIGUOUS_ID';
  readonly matches: string[];

  constructor(input: string, matches: string[]) {
    const shown = matches.slice(0, 5).join(', ');
    super(
      `Ambiguous id prefix "${input}" matches ${matches.length} records: ${shown}${
        matches.length > 5 ? ', …' : ''
      }`,
    );
    this.name = 'AmbiguousIdError';
    this.matches = matches.slice();
  }
}

export class SlugConflictError extends Error {
  readonly code: KnowledgeStoreErrorCode = 'SLUG_CONFLICT';

  constructor(slug: string, owner: string) {
    super(`Slug alias "${slug}" already assigned to record ${owner}`);
    this.name = 'SlugConflictError';
  }
}

/**
 * Thrown by every mutation verb on a read-only projection adapter (station#1879,
 * e.g. the conversation-history root) — a Station extension beyond
 * store-contract.md §8.1 (see `KnowledgeStoreErrorCode`'s `READ_ONLY` doc comment).
 * `op` is the verb the caller attempted (`create`, `update`, `link`, `propose`,
 * `apply`, `reject`, `supersede`, `retire`), so the message and any caller
 * (`knowledge-record-routes.ts`'s 405 mapping) always name what was rejected.
 */
export class ReadOnlyStoreError extends Error {
  readonly code: KnowledgeStoreErrorCode = 'READ_ONLY';

  constructor(op: string) {
    super(`${op} rejected: this store is a read-only projection.`);
    this.name = 'ReadOnlyStoreError';
  }
}

/** Station-local file authority changed outside the serialized mutation. */
export class KnowledgeStoreConflictError extends Error {
  constructor(path: string) {
    super(`Knowledge store changed concurrently: ${path}`);
    this.name = 'KnowledgeStoreConflictError';
  }
}

/** Authoritative bytes or the retained transaction journal cannot be trusted. */
export class KnowledgeStoreCorruptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'KnowledgeStoreCorruptionError';
  }
}

/** The file authority could not be read, locked, published, or recovered. */
export class KnowledgeStoreUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super('Knowledge store storage is unavailable', options);
    this.name = 'KnowledgeStoreUnavailableError';
  }
}

/** Distinguishes intentional store-contract outcomes from ambient I/O codes. */
export function isKnowledgeStoreError(error: unknown): error is Error {
  return (
    error instanceof MissingEvidenceError ||
    error instanceof KnowledgeRecordNotFoundError ||
    error instanceof AmbiguousIdError ||
    error instanceof SlugConflictError ||
    error instanceof ReadOnlyStoreError ||
    error instanceof KnowledgeStoreConflictError ||
    error instanceof KnowledgeStoreCorruptionError ||
    error instanceof KnowledgeStoreUnavailableError
  );
}
