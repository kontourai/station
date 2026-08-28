import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export type SelfUpdateRestartStatus = 'pending' | 'verified' | 'failed';
export type SelfUpdateRestartFailureCode =
  | 'health-unreachable'
  | 'identity-mismatch'
  | 'watchdog-crashed';

interface SelfUpdateRestartRecordBase {
  instanceId: string;
  hash: string;
  pid: number;
  port: number;
  startedAt: string;
}

export type SelfUpdateRestartRecord =
  | (SelfUpdateRestartRecordBase & {
      status: 'pending';
      resolvedAt?: never;
      detail?: never;
    })
  | (SelfUpdateRestartRecordBase & {
      status: 'verified';
      resolvedAt: string;
      detail?: never;
    })
  | (SelfUpdateRestartRecordBase & {
      status: 'failed';
      resolvedAt: string;
      failureCode: SelfUpdateRestartFailureCode;
    });

/**
 * `committed` becomes true exactly when the rename succeeds. A directory
 * fsync failure after that point is a durability warning, not permission to
 * tell a caller the record was absent and overwrite the published verdict.
 */
export type RestartStateWriteResult =
  | { committed: true; durability: 'confirmed' }
  | { committed: true; durability: 'uncertain'; warning: string };

export type RestartDiagnosticLogger = Partial<
  Pick<Console, 'info' | 'warn' | 'error'>
>;

/**
 * Restart-state publication is already committed when these diagnostics run.
 * A broken log sink must never alter the restart outcome or trigger another
 * write. Callers pass only fixed text and non-sensitive correlation facts.
 */
export function emitRestartDiagnostic(
  logger: RestartDiagnosticLogger | undefined,
  level: 'info' | 'warn' | 'error',
  message: string,
  context?: Record<string, unknown>,
): void {
  try {
    logger?.[level]?.call(logger, message, context);
  } catch {
    // Diagnostics are strictly best-effort after a restart-state transition.
  }
}

/** File operations are injectable only to exercise publication faults. */
export interface RestartStateFileOperations {
  closeSync: typeof closeSync;
  fsyncSync: typeof fsyncSync;
  mkdirSync: typeof mkdirSync;
  openSync: typeof openSync;
  renameSync: typeof renameSync;
  rmSync: typeof rmSync;
  writeFileSync: typeof writeFileSync;
  temporaryPath: (path: string) => string;
  platform: NodeJS.Platform;
}

const defaultFileOperations: RestartStateFileOperations = {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
  temporaryPath: (path) => `${path}.${process.pid}.${randomUUID()}.tmp`,
  platform: process.platform,
};

const baseFields = ['hash', 'instanceId', 'pid', 'port', 'startedAt', 'status'];
const terminalFields = [...baseFields, 'resolvedAt'];
const failedFields = [...terminalFields, 'failureCode'];
const SHA_PREFIX = /^[a-f0-9]{7}$/;

function hasExactFields(
  record: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  const keys = Object.keys(record).sort();
  const expected = [...fields].sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

function isCanonicalText(value: unknown, maxLength = 256): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
      );
    })
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (!isCanonicalText(value, 64)) return false;
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

function isValidRecordBase(record: Record<string, unknown>): boolean {
  const pid = record.pid;
  const port = record.port;
  return (
    isCanonicalText(record.instanceId, 128) &&
    typeof record.hash === 'string' &&
    SHA_PREFIX.test(record.hash) &&
    typeof pid === 'number' &&
    Number.isSafeInteger(pid) &&
    pid >= 0 &&
    typeof port === 'number' &&
    Number.isSafeInteger(port) &&
    port >= 1 &&
    port <= 65_535 &&
    isCanonicalTimestamp(record.startedAt)
  );
}

/**
 * Validates the exact current durable schema. Unknown or partial data is not
 * projected into a plausible restart result: callers must treat it as
 * unavailable and preserve the source bytes for diagnosis.
 */
function parseRestartRecord(value: unknown): SelfUpdateRestartRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (!isValidRecordBase(record)) return null;

  if (record.status === 'pending' && hasExactFields(record, baseFields)) {
    if (record.pid !== 0) return null;
    return record as unknown as SelfUpdateRestartRecord;
  }
  if (
    record.status === 'verified' &&
    hasExactFields(record, terminalFields) &&
    isCanonicalTimestamp(record.resolvedAt) &&
    Date.parse(record.resolvedAt) >=
      Date.parse(
        typeof record.startedAt === 'string' ? record.startedAt : '',
      ) &&
    typeof record.pid === 'number' &&
    Number.isSafeInteger(record.pid) &&
    record.pid > 0
  ) {
    return record as unknown as SelfUpdateRestartRecord;
  }
  if (
    record.status === 'failed' &&
    hasExactFields(record, failedFields) &&
    isCanonicalTimestamp(record.resolvedAt) &&
    Date.parse(record.resolvedAt) >=
      Date.parse(
        typeof record.startedAt === 'string' ? record.startedAt : '',
      ) &&
    (record.failureCode === 'health-unreachable' ||
      record.failureCode === 'identity-mismatch' ||
      record.failureCode === 'watchdog-crashed') &&
    typeof record.pid === 'number' &&
    Number.isSafeInteger(record.pid) &&
    record.pid > 0
  ) {
    return record as unknown as SelfUpdateRestartRecord;
  }
  return null;
}

export function restartStateFilePath(gitRoot: string): string {
  return join(gitRoot, '.station', 'self-update-restart.json');
}

/**
 * Atomically publishes a whole restart record. Readers observe either the
 * prior complete document or the new complete document, never a truncation
 * while the parent and detached watchdog exchange ownership.
 */
export function writeSelfUpdateRestartRecord(
  path: string,
  record: SelfUpdateRestartRecord,
  overrides: Partial<RestartStateFileOperations> = {},
): RestartStateWriteResult {
  if (!parseRestartRecord(record)) {
    throw new Error('Self-update restart record is invalid');
  }
  const operations = { ...defaultFileOperations, ...overrides };
  const parent = dirname(path);
  const temporary = operations.temporaryPath(path);
  let descriptor: number | undefined;
  let renamed = false;
  let primaryError: unknown;
  let cleanupError: unknown;

  operations.mkdirSync(parent, { recursive: true, mode: 0o700 });
  try {
    descriptor = operations.openSync(temporary, 'wx', 0o600);
    operations.writeFileSync(
      descriptor,
      `${JSON.stringify(record, null, 2)}\n`,
      'utf-8',
    );
    operations.fsyncSync(descriptor);
    operations.closeSync(descriptor);
    descriptor = undefined;
    operations.renameSync(temporary, path);
    renamed = true;

    // Windows does not support opening a directory descriptor for fsync. The
    // rename remains atomic there; POSIX also flushes the containing entry.
    if (operations.platform === 'win32') {
      return { committed: true, durability: 'confirmed' };
    }
    try {
      const parentDescriptor = operations.openSync(parent, 'r');
      try {
        operations.fsyncSync(parentDescriptor);
      } finally {
        operations.closeSync(parentDescriptor);
      }
    } catch {
      return {
        committed: true,
        durability: 'uncertain',
        warning:
          'Self-update restart state was committed but its parent directory could not be synchronized',
      };
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (descriptor !== undefined) {
      try {
        operations.closeSync(descriptor);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (!renamed) {
      try {
        operations.rmSync(temporary, { force: true });
      } catch (error) {
        cleanupError ??= error;
      }
    }
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
  return { committed: true, durability: 'confirmed' };
}

/**
 * Fail-closed reader: a missing or malformed record reads as `null` rather
 * than throwing or fabricating a status. Boot-time surfacing treats `null`
 * as "nothing to report" — never as a verified restart.
 */
export function readSelfUpdateRestartRecord(
  path: string,
): SelfUpdateRestartRecord | null {
  if (!existsSync(path)) return null;
  try {
    return parseRestartRecord(JSON.parse(readFileSync(path, 'utf-8')));
  } catch {
    return null;
  }
}

export type RestartBootFinding =
  | { kind: 'none' }
  | { kind: 'verified'; record: SelfUpdateRestartRecord }
  | { kind: 'in-flight'; record: SelfUpdateRestartRecord }
  | { kind: 'failed'; record: SelfUpdateRestartRecord }
  | { kind: 'stale-pending'; record: SelfUpdateRestartRecord; ageMs: number };

/**
 * How boot should react to whatever the last self-update cycle left behind.
 *
 * `staleAfterMs` mirrors the watchdog's own health-verification budget
 * (`SELF_UPDATE_WATCHDOG_DEADLINE_MS`, which shares the cold-start
 * MEASUREMENT behind `packages/cli/src/commands/lifecycle.ts`'s
 * `STARTUP_READINESS_TIMEOUT_MS` but, since archive#2646, not its budget — that one
 * is an extendable base, this one a hard ceiling; see the watchdog constant.
 * archive#1903): a `pending` record younger than that is an ordinary
 * in-flight restart — this boot is very likely the one the watchdog is
 * currently polling — and must not be reported as a problem. Older than
 * that, or `failed` outright, means a restart cycle never resolved and must
 * not stay silent (the defect this exists to close: the field used to be
 * written and never read at all).
 */
export function classifyRestartRecordAtBoot(
  record: SelfUpdateRestartRecord | null,
  nowMs: number,
  staleAfterMs = 90_000,
): RestartBootFinding {
  if (!record) return { kind: 'none' };
  if (record.status === 'failed') return { kind: 'failed', record };
  if (record.status === 'verified') return { kind: 'verified', record };
  const startedAtMs = Date.parse(record.startedAt);
  const ageMs = Number.isFinite(startedAtMs)
    ? nowMs - startedAtMs
    : Number.POSITIVE_INFINITY;
  if (ageMs > staleAfterMs) {
    return { kind: 'stale-pending', record, ageMs };
  }
  return { kind: 'in-flight', record };
}
