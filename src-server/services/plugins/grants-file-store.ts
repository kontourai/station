/**
 * Fail-closed grants storage shared by the plugin permission grants store
 * (`plugin-grants.json`) and the MCP-UI render grants store
 * (`mcp-ui-render-grants.json`) — archive#1835.
 *
 * Policy (mirrors `services/projects/project-binding-store.ts`, whose docblock
 * carries the full rationale): **the read validates and refuses; it never
 * coerces and never drops a row.** A corrupt consent store that silently reads
 * as `{}` is a security defect in both directions — plugin grants vanish (and
 * the next read-modify-write persists the wipe), and an explicitly revoked
 * MCP-UI server silently reads as allowed again.
 *
 * Load-bearing decisions:
 *
 * 1. **A MISSING file is not a corrupt file.** Genuine absence — no directory
 *    entry for the primary AND none for `.previous` — is the ordinary
 *    pre-first-grant state and reads as the empty default. Everything else
 *    throws the store's typed unavailable error: unreadable content (`EACCES`
 *    on the file or its parent directory), unparseable JSON, ill-shaped
 *    values, a dangling symlink where the primary should be, and a missing
 *    primary beside a surviving `.previous` (a torn replace). `existsSync` is
 *    NOT the absence check: it answers `false` for an `EACCES` parent and for
 *    a dangling symlink, both of which would silently turn "cannot read the
 *    consent store" into "no consents exist" — exactly the fail-open this
 *    store exists to close. Absence is classified by errnos from real
 *    `readFileSync`/`lstatSync` calls.
 * 2. **`.previous` is NEVER auto-consumed.** These files record consent, and
 *    `.previous` is by definition one write out of date — after
 *    `revokeAllGrants` (or an MCP-UI revoke) it holds the version in which
 *    the revoked consent was still granted, so any automatic fallback to it
 *    resurrects revoked authority. It is retained by the durable write purely
 *    as forensic material for EXPLICIT operator recovery: a human inspects
 *    `<store>.previous`, confirms it reflects intended consent, moves the
 *    corrupt primary aside by hand, and copies `.previous` into place. Until
 *    then, every read and every mutation fails closed with the typed error —
 *    nothing is quarantined, promoted, or rewritten automatically; the
 *    corrupt bytes stay exactly where they are for that inspection.
 * 3. **Every read-modify-write runs inside a cross-process file mutation
 *    lock** (`acquireFileMutationLockAsync` on `<store>.mutation`, the
 *    `lockedReadModifyWrite` pattern from `packages/shared/src/instance-registry.ts`),
 *    with the read INSIDE the lock. The lock acquisition is awaited (archive#2646)
 *    so a contended cross-process wait yields the event loop instead of
 *    freezing the server. A read failure propagates out before any write
 *    happens, and infrastructure failures (directory creation, lock
 *    acquisition, the write itself) surface as the same typed unavailable
 *    error so call sites keep their one-catch contract.
 * 4. **A write must be a superset-by-key of what was read, minus at most the
 *    single key the mutation is about** — checked with `Object.hasOwn`, so a
 *    row named after an `Object.prototype` member (`toString`, …) cannot
 *    vanish undetected behind an inherited property. Belt-and-braces: even if
 *    a future refactor breaks decision 1 or 3, a raced or corrupted read can
 *    not be amplified into a multi-entry consent wipe.
 * 5. **Grant objects are null-prototype and reserved keys are rejected.**
 *    Store keys are external identifiers (plugin names, MCP server ids); on a
 *    plain object, `grants['__proto__'] = …` hits the prototype setter and
 *    silently persists nothing while the caller is told the revocation
 *    succeeded, and `grants['constructor']` answers
 *    `Object.prototype.constructor` instead of `undefined`. Reads hand out
 *    null-prototype objects, mutations run on null-prototype copies, and
 *    `__proto__`/`constructor`/`prototype` are refused both as stored content
 *    (typed unavailable) and as mutation targets
 *    ({@link GrantsStoreReservedKeyError}). The key set and the null-prototype
 *    helper live in `utils/reserved-object-keys.ts` so the plugin-overrides
 *    store derives the same policy from the same place (archive#4307).
 * 6. **Client-visible error messages carry no filesystem paths.** The store
 *    path names the operator's home layout; it is available on the error as
 *    {@link GrantsStoreUnavailableError.storePath} and in server-side log
 *    fields, but the `message` that routes serialize to remote callers stays
 *    generic.
 */

import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { pluginGrantsStoreCorruption } from '../../telemetry/metrics.js';
import { createLogger } from '../../utils/logger.js';
import {
  isReservedObjectKey,
  nullPrototypeCopy,
} from '../../utils/reserved-object-keys.js';
import { JsonFileStore } from '../infra/json-store.js';

const logger = createLogger({ name: 'grants-file-store' });

/**
 * Base error for "the grants store cannot be read or written". Consumers that
 * need to distinguish the stores catch the per-store subclass
 * (`PluginGrantsUnavailableError`, `McpUiRenderGrantsUnavailableError`).
 * The message is deliberately path-free (decision 6).
 */
export class GrantsStoreUnavailableError extends Error {
  readonly storePath: string;

  constructor(
    storePath: string,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(`Permission grants store is unavailable (${detail})`, options);
    this.name = 'GrantsStoreUnavailableError';
    this.storePath = storePath;
  }
}

/** A mutation targeted a reserved object key; nothing was written. */
export class GrantsStoreReservedKeyError extends Error {
  constructor(key: string) {
    super(`'${key}' is a reserved key and cannot name a grants store entry`);
    this.name = 'GrantsStoreReservedKeyError';
  }
}

export interface GrantsFileStoreOptions<T extends Record<string, unknown>> {
  filePath: string;
  /** Metrics attribute + log context value naming the store file. */
  storeLabel: string;
  /** Returns shape problems for a parsed value; empty array = valid. */
  shapeProblems: (value: unknown) => string[];
  /** Wraps a corruption into the store's typed unavailable error. */
  makeUnavailableError: (
    storePath: string,
    detail: string,
    cause: unknown,
  ) => GrantsStoreUnavailableError;
  emptyValue: T;
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when the directory has ANY entry at `path` — including a dangling
 * symlink, which `existsSync` reports as absent. Non-ENOENT `lstat` failures
 * count as "an entry may exist" so the caller fails closed.
 */
function directoryEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

export class GrantsFileStore<T extends Record<string, unknown>> {
  private readonly writer: JsonFileStore<T>;

  constructor(private readonly options: GrantsFileStoreOptions<T>) {
    // JsonFileStore is used for WRITES only (same-directory temp file, atomic
    // rename, retained `.previous`, byte-compatible format). Reads are owned
    // by this class because the stored value is consent: JsonFileStore's
    // missing-primary recovery auto-consumes `.previous`, which for these
    // stores would resurrect revoked authority (decision 2).
    this.writer = new JsonFileStore<T>(options.filePath, options.emptyValue, {
      onCorruption: 'throw',
      durableAtomicWrite: true,
    });
  }

  get filePath(): string {
    return this.options.filePath;
  }

  /**
   * Validated read. Genuine absence (no primary entry AND no `.previous`
   * entry) reads as the empty default; everything else throws the store's
   * typed unavailable error (decisions 1, 2, 5).
   */
  read(): T {
    const primary = this.options.filePath;
    let raw: string;
    try {
      raw = readFileSync(primary, 'utf-8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw this.reportCorruption(
          `unreadable (${code ?? 'unknown errno'})`,
          error,
        );
      }
      if (directoryEntryExists(primary)) {
        // An entry exists but cannot be opened as a file: dangling symlink
        // or an unstatable path. Not absence — fail closed.
        throw this.reportCorruption(
          'primary exists but is not a readable file (dangling symlink?)',
          error,
        );
      }
      if (directoryEntryExists(`${primary}.previous`)) {
        // A completed write always leaves a primary; primary-gone with
        // `.previous` surviving is a torn replace. `.previous` is NOT
        // auto-consumed (decision 2) — recovery is an explicit operator step.
        throw this.reportCorruption(
          'primary is missing while .previous exists (torn state; recover manually)',
          error,
        );
      }
      return nullPrototypeCopy(structuredClone(this.options.emptyValue));
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw this.reportCorruption('corrupt JSON', error);
    }
    if (isPlainObject(value)) {
      const reserved = Object.keys(value).filter((key) =>
        isReservedObjectKey(key),
      );
      if (reserved.length > 0) {
        throw this.reportCorruption(
          `reserved keys in stored content: ${reserved.join(', ')}`,
          undefined,
        );
      }
    }
    const problems = this.options.shapeProblems(value);
    if (problems.length > 0) {
      throw this.reportCorruption(
        `ill-shaped content: ${problems.join('; ')}`,
        undefined,
      );
    }
    return nullPrototypeCopy(value as T);
  }

  /**
   * Serialized read-modify-write (decision 3). `mutatedKey` names the single
   * top-level entry this mutation may add, replace, or remove; the write is
   * refused if it would drop any OTHER entry that was present in the read
   * (decision 4). A read failure propagates out with no write, and every
   * infrastructure failure surfaces as the typed unavailable error.
   */
  async mutate(mutatedKey: string, update: (current: T) => T): Promise<T> {
    if (isReservedObjectKey(mutatedKey)) {
      throw new GrantsStoreReservedKeyError(mutatedKey);
    }
    let release: () => void | Promise<void>;
    try {
      mkdirSync(dirname(this.options.filePath), { recursive: true });
      release = await acquireFileMutationLockAsync(
        `${this.options.filePath}.mutation`,
      );
    } catch (error) {
      throw this.reportCorruption(
        `store infrastructure failure (${(error as NodeJS.ErrnoException).code ?? 'lock unavailable'})`,
        error,
      );
    }
    try {
      const current = this.read();
      // Defensive null-prototype copy: the updater must not be able to
      // diverge what the superset check saw from what gets written
      // (archive#1606 lesson), and key writes must not hit prototype setters
      // (decision 5).
      const next = update(nullPrototypeCopy(structuredClone(current)));
      const dropped = Object.keys(current).filter(
        (key) => key !== mutatedKey && !Object.hasOwn(next, key),
      );
      if (dropped.length > 0) {
        throw new Error(
          `Refusing to write the ${this.options.storeLabel} store: the write for '${mutatedKey}' would drop unrelated entries [${dropped.join(', ')}]`,
        );
      }
      try {
        this.writer.write(next);
      } catch (error) {
        throw this.reportCorruption(
          `write failed (${(error as NodeJS.ErrnoException).code ?? 'unknown errno'})`,
          error,
        );
      }
      return next;
    } finally {
      await release();
    }
  }

  /**
   * Holds the same cross-process authority as mutate through a publication
   * reader's effect. The callback must not recursively mutate this store.
   */
  async withReadLease<R>(effect: (current: T) => Promise<R>): Promise<R> {
    let release: () => void | Promise<void>;
    try {
      mkdirSync(dirname(this.options.filePath), { recursive: true });
      release = await acquireFileMutationLockAsync(
        `${this.options.filePath}.mutation`,
      );
    } catch (error) {
      throw this.reportCorruption(
        `store infrastructure failure (${(error as NodeJS.ErrnoException).code ?? 'lock unavailable'})`,
        error,
      );
    }
    try {
      return await effect(this.read());
    } finally {
      await release();
    }
  }

  private reportCorruption(
    detail: string,
    cause: unknown,
  ): GrantsStoreUnavailableError {
    pluginGrantsStoreCorruption.add(1, { store: this.options.storeLabel });
    logger.error(
      'Grants store is unavailable; failing closed (no grant or revocation is decided from it until recovered)',
      {
        path: this.options.filePath,
        store: this.options.storeLabel,
        detail,
        error: cause instanceof Error ? cause.message : cause,
      },
    );
    return this.options.makeUnavailableError(
      this.options.filePath,
      detail,
      cause,
    );
  }
}
