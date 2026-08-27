/**
 * PrincipalStore — durable first-seen record of every principal this
 * Station has resolved (station#4075 stage 1; docs/design/principals.md).
 *
 * Follows `ProjectBindingsStore`'s idioms
 * (`services/projects/project-binding-store.ts`), the closest existing
 * settings-domain store: a schema-versioned JSON file under `<home>/config/`,
 * `durableAtomicWrite` + `onCorruption: 'throw'` (a corrupt store must never
 * silently read back empty — losing a principal's first-seen record is a
 * provenance loss, not a clean "nothing recorded yet"), a read that
 * validates and refuses rather than coercing or dropping a row, and a fresh
 * read/validate/write transaction inside a cross-process mutation lock so
 * concurrent upserts of distinct principals cannot clobber one another.
 *
 * This store is descriptive only. `firstSeenAt`/`display` are NEVER
 * authorization inputs — the same cosmetic-display warning
 * `docs/design/principals.md` §1 makes about the `os.userInfo()` alias
 * applies here. It exists so an audit/UI surface can answer "who has this
 * Station ever seen act" without re-deriving it from scattered event
 * history.
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  isPrincipalRef,
  type PrincipalKind,
  type PrincipalRef,
} from '@kontourai/station-contracts/principal';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { JsonFileStore } from '../infra/json-store.js';

export const PRINCIPAL_STORE_SCHEMA_VERSION = 1 as const;

/** A retained first-seen record for one principal. */
export interface PrincipalRecord {
  id: string;
  kind: PrincipalKind;
  display: string;
  /** When this principal was FIRST resolved by this Station. Never rewritten. */
  firstSeenAt: string;
}

interface PrincipalStoreFile {
  schemaVersion: typeof PRINCIPAL_STORE_SCHEMA_VERSION;
  principals: PrincipalRecord[];
}

export class PrincipalStoreShapeError extends Error {
  constructor(filePath: string, problems: string[]) {
    super(
      `Principal store is not readable as schema v${PRINCIPAL_STORE_SCHEMA_VERSION}: ${filePath}\n- ${problems.join('\n- ')}`,
    );
    this.name = 'PrincipalStoreShapeError';
  }
}

/**
 * An `upsert`-shaped write tried to reclassify an already-recorded
 * principal's `kind` (station#4075 stage 1 review, FINDING 3a). A colliding
 * observation is a conflict to surface, never a silent reclassification —
 * display-only refreshes stay allowed.
 */
export class PrincipalConflictError extends Error {
  constructor(
    id: string,
    existingKind: PrincipalKind,
    incomingKind: PrincipalKind,
  ) {
    super(
      `Principal ${id} is already recorded as kind '${existingKind}'; refusing to reclassify it to '${incomingKind}'`,
    );
    this.name = 'PrincipalConflictError';
  }
}

export function principalStorePath(homeDir: string): string {
  return join(homeDir, 'config', 'principals.json');
}

export function emptyPrincipalStore(): PrincipalStoreFile {
  return { schemaVersion: PRINCIPAL_STORE_SCHEMA_VERSION, principals: [] };
}

const PRINCIPAL_KINDS = new Set<PrincipalKind>(['human', 'agent', 'service']);

// Strict ISO-8601 UTC instant, matching `Date#toISOString()`'s own output —
// the only shape this store ever writes (station#4075 stage 1 review,
// FINDING 3c: a bare "non-empty string" previously accepted any nonblank
// value in `firstSeenAt`).
const ISO_8601_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * The regex above matches an impossible calendar date such as
 * `'2026-02-31T00:00:00.000Z'` — `Date.parse` silently ROLLS that over to
 * March 3rd rather than rejecting it, so a regex-only check let it through
 * (station#4075 stage 1 review round 2, N3). The round-trip below is the
 * actual validity check: this store only ever WRITES a value via
 * `Date#toISOString()`, which always emits this exact canonical form, so a
 * value is genuinely valid here if and only if re-parsing and
 * re-serializing it reproduces the identical string. An impossible date
 * fails because the round-trip lands on a DIFFERENT (rolled-over) instant;
 * a merely-differently-formatted valid instant (e.g. no milliseconds) fails
 * because this store never wrote that shape. The regex stays as a cheap
 * first gate so we never construct a `Date` from garbage input.
 */
function isValidIso8601Instant(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_8601_INSTANT_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(
  value: unknown,
  field: string,
  problems: string[],
): void {
  if (typeof value !== 'string' || value.length === 0) {
    problems.push(`${field}: must be a non-empty string`);
  }
}

/**
 * Matches `isPrincipalRef`'s `display` rule EXACTLY
 * (`@kontourai/station-contracts/principal`) — station#4075 stage 1 review
 * round 2, N2: a `''` (or whitespace-only) display previously passed the
 * looser `requireNonEmptyString` used here while `isPrincipalRef` (the
 * entry gate `recordSeen` validates against) already independently rejects
 * it, so a value could differ between the two checks. Aligning both to the
 * SAME non-blank rule closes that gap in both directions.
 */
function requireNonBlankString(
  value: unknown,
  field: string,
  problems: string[],
): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    problems.push(`${field}: must be a non-empty, non-whitespace-only string`);
  }
}

function requireIso8601Instant(
  value: unknown,
  field: string,
  problems: string[],
): void {
  if (!isValidIso8601Instant(value)) {
    problems.push(`${field}: must be an ISO-8601 UTC instant`);
  }
}

function validatePrincipalStore(
  value: unknown,
  filePath: string,
): PrincipalStoreFile {
  if (!isPlainObject(value)) {
    throw new PrincipalStoreShapeError(filePath, ['must be an object']);
  }
  // schemaVersion gates everything else and is never cast.
  if (value.schemaVersion !== PRINCIPAL_STORE_SCHEMA_VERSION) {
    throw new PrincipalStoreShapeError(filePath, [
      `schemaVersion: unknown or absent (expected ${PRINCIPAL_STORE_SCHEMA_VERSION}, got ${JSON.stringify(value.schemaVersion)})`,
    ]);
  }

  const problems: string[] = [];
  if (!Array.isArray(value.principals)) {
    problems.push('principals: must be an array');
  } else {
    const seenIds = new Set<string>();
    value.principals.forEach((entry, index) => {
      const at = `principals[${index}]`;
      if (!isPlainObject(entry)) {
        problems.push(`${at}: must be an object`);
        return;
      }
      const allowed = new Set(['id', 'kind', 'display', 'firstSeenAt']);
      for (const field of Object.keys(entry)) {
        if (!allowed.has(field)) problems.push(`${at}.${field}: unknown field`);
      }
      requireNonEmptyString(entry.id, `${at}.id`, problems);
      requireNonBlankString(entry.display, `${at}.display`, problems);
      requireIso8601Instant(entry.firstSeenAt, `${at}.firstSeenAt`, problems);
      const displayIsNonBlank =
        typeof entry.display === 'string' && entry.display.trim().length > 0;
      if (
        typeof entry.kind !== 'string' ||
        !PRINCIPAL_KINDS.has(entry.kind as PrincipalKind)
      ) {
        problems.push(
          `${at}.kind: must be one of ${[...PRINCIPAL_KINDS].join(', ')}`,
        );
      } else if (
        typeof entry.id === 'string' &&
        displayIsNonBlank &&
        !isPrincipalRef({
          id: entry.id,
          kind: entry.kind,
          display: entry.display,
        })
      ) {
        // station#4075 stage 1 review FINDING 1: a well-typed but
        // grammar-invalid id (e.g. wrong prefix for its declared kind) must
        // fail the read, not be accepted as a bare non-empty string.
        problems.push(
          `${at}.id: does not match the '${entry.kind}' id grammar (see principal.ts)`,
        );
      }
      if (typeof entry.id === 'string') {
        if (seenIds.has(entry.id)) {
          problems.push(`${at}.id: duplicate principal id`);
        }
        seenIds.add(entry.id);
      }
    });
  }

  if (problems.length > 0) {
    throw new PrincipalStoreShapeError(filePath, problems);
  }
  return value as unknown as PrincipalStoreFile;
}

// Async-compatible seam (mirrors ProjectBindingsStore): the default is the
// ASYNC cross-process lock so a contended acquisition yields the event loop;
// sync test fakes remain assignable (awaiting a non-promise is a no-op).
type PrincipalStoreMutationLock = (
  lockPath: string,
) => (() => void | Promise<void>) | Promise<() => void | Promise<void>>;

export interface PrincipalStoreOptions {
  /** Injectable only for deterministic store concurrency tests. */
  acquireMutationLock?: PrincipalStoreMutationLock;
  /** Injectable clock for deterministic `firstSeenAt` tests. */
  now?: () => Date;
}

export class PrincipalStore {
  private readonly filePath: string;
  private readonly store: JsonFileStore<PrincipalStoreFile>;
  private readonly acquireMutationLock: PrincipalStoreMutationLock;
  private readonly now: () => Date;

  constructor(homeDir: string, options: PrincipalStoreOptions = {}) {
    this.filePath = principalStorePath(homeDir);
    this.store = new JsonFileStore<PrincipalStoreFile>(
      this.filePath,
      emptyPrincipalStore(),
      { onCorruption: 'throw', durableAtomicWrite: true },
    );
    this.acquireMutationLock =
      options.acquireMutationLock ?? acquireFileMutationLockAsync;
    this.now = options.now ?? (() => new Date());
  }

  get path(): string {
    return this.filePath;
  }

  /** Validated read. Throws on corrupt or ill-shaped content; never coerces. */
  read(): PrincipalStoreFile {
    return validatePrincipalStore(this.store.read(), this.filePath);
  }

  find(id: string): PrincipalRecord | undefined {
    return this.read().principals.find((principal) => principal.id === id);
  }

  list(): PrincipalRecord[] {
    return this.read().principals.map((principal) => ({ ...principal }));
  }

  /**
   * Records a principal on first sight, or refreshes its `display` on a
   * later sighting. `firstSeenAt` is set exactly once and never rewritten —
   * it is a provenance fact, not a "last seen" cursor. `kind` NEVER changes
   * on an existing id: station#4075 stage 1 review FINDING 3a found that an
   * id collision between two different observations could silently
   * reclassify an already-recorded human as a service (or vice versa) — a
   * kind mismatch on an existing id is now a thrown
   * {@link PrincipalConflictError}, never a refresh.
   *
   * The fresh read is deliberately AFTER lock acquisition and INSIDE the
   * `try`: moving it above lock acquisition would let a concurrent writer's
   * commit be silently lost (last-writer data loss), mirroring
   * `ProjectBindingsStore.upsertProjectBinding`'s same contract.
   */
  async recordSeen(principal: PrincipalRef): Promise<PrincipalRecord> {
    // station#4075 stage 1 review FINDING 3b: validate the FULL candidate
    // principal up front (id grammar + kind + display, via the same
    // `isPrincipalRef` the reader uses) — not just a non-empty `id`. The
    // previous, narrower check let an otherwise-malformed principal reach
    // disk, where this store's own reader would then reject it on the next
    // read, bricking the whole store (`onCorruption`/shape errors throw).
    if (!isPrincipalRef(principal)) {
      throw new TypeError(
        'PrincipalStore.recordSeen requires a well-formed PrincipalRef (see principal.ts id grammar) — refusing to persist a record its own reader would then reject',
      );
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    const release = await this.acquireMutationLock(`${this.filePath}.mutation`);
    try {
      const current = this.read();
      const index = current.principals.findIndex(
        (existing) => existing.id === principal.id,
      );
      // Reachability note: given the entry-gate above (FINDING 3b) and this
      // store's own read-time grammar validation (FINDING 1,
      // `validatePrincipalStore`), a genuine cross-kind collision for the
      // same id is not reachable through this store's public API today —
      // an id's grammar ties it to exactly one kind, so two independently
      // grammar-valid principals sharing an id necessarily share a kind.
      // This check stays as defense in depth per the station#4075 stage 1
      // review ruling: it catches a stored row that reached disk before
      // this validation existed, was hand-edited, or would slip through a
      // future loosening of the grammar/validator — see
      // `__tests__/principal-store.test.ts`'s "defense in depth" test for
      // how it is exercised (a raw, unvalidated `read()` override).
      if (index !== -1 && current.principals[index]!.kind !== principal.kind) {
        throw new PrincipalConflictError(
          principal.id,
          current.principals[index]!.kind,
          principal.kind,
        );
      }
      const record: PrincipalRecord =
        index === -1
          ? {
              id: principal.id,
              kind: principal.kind,
              display: principal.display,
              firstSeenAt: this.now().toISOString(),
            }
          : {
              ...current.principals[index]!,
              display: principal.display,
            };
      // Defense in depth (FINDING 3b, continued): grammar collision-freedom
      // (FINDING 1) makes a cross-kind id collision impossible going
      // forward, but this guards against a corrupted store or a future
      // grammar change ever silently writing a row the reader would reject.
      if (
        !isPrincipalRef({
          id: record.id,
          kind: record.kind,
          display: record.display,
        }) ||
        !isValidIso8601Instant(record.firstSeenAt)
      ) {
        throw new PrincipalStoreShapeError(this.filePath, [
          `refusing to persist an invalid record for ${record.id}`,
        ]);
      }
      const principals =
        index === -1
          ? [...current.principals, record]
          : current.principals.map((existing, at) =>
              at === index ? record : existing,
            );
      this.store.write({ ...current, principals });
      return record;
    } finally {
      await release();
    }
  }
}
