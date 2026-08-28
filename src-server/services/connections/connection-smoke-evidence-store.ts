import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CLEAN_ID_PATTERN } from '@kontourai/station-contracts/agent-identity';
import type {
  ConnectionSmokeFailureReason,
  ConnectionSmokeStatus,
} from '@kontourai/station-contracts/tool';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { JsonFileStore } from '../infra/json-store.js';

const SMOKE_FAILURE_REASONS = new Set<ConnectionSmokeFailureReason>([
  'disabled',
  'missing-prerequisites',
  'unsupported-runtime',
  'start-failed',
  'turn-failed',
  'timeout',
  'cleanup-failed',
  'empty-response',
  'unexpected-response',
  'cancelled',
  'unknown',
]);
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** One bounded smoke receipt is fresh for exactly one day from its observation. */
export const CONNECTION_SMOKE_FRESH_MS = 24 * 60 * 60 * 1000;
const CONNECTION_SMOKE_STORE_VERSION = 3;

type ConnectionSmokeDocument = {
  evidenceVersion: typeof CONNECTION_SMOKE_STORE_VERSION;
  results: StoredConnectionSmokeResult[];
};
// Async-compatible seam (archive#2646): the default is the ASYNC cross-process lock
// so a contended acquisition yields the event loop; sync test fakes remain
// assignable (awaiting a non-promise is a no-op).
type ConnectionSmokeMutationLock = (
  lockPath: string,
) => (() => void | Promise<void>) | Promise<() => void | Promise<void>>;
type ConnectionSmokeStore = Pick<
  JsonFileStore<ConnectionSmokeDocument>,
  'read' | 'write'
>;
type ConnectionSmokeStoreFactory = (filePath: string) => ConnectionSmokeStore;

export interface FileConnectionSmokeEvidenceStoreOptions {
  /** Injectable only for deterministic cross-process mutation tests. */
  acquireMutationLock?: ConnectionSmokeMutationLock;
  /** Injectable only for durable-write fault-injection tests. */
  storeFactory?: ConnectionSmokeStoreFactory;
}

/** A persisted receipt is unusable until it matches the exact v3 store schema. */
export class ConnectionSmokeEvidenceStoreValidationError extends Error {
  constructor() {
    super('Connection smoke evidence is invalid');
    this.name = 'ConnectionSmokeEvidenceStoreValidationError';
  }
}

export interface StoredConnectionSmokeResult {
  evidenceVersion: 2;
  connectionId: string;
  configurationFingerprint: string;
  status: Exclude<ConnectionSmokeStatus, 'not-tested'>;
  testedAt: string;
  freshUntil: string;
  provider: string;
  model?: string;
  durationMs: number;
  reasonCode?: ConnectionSmokeFailureReason;
  reason?: string;
  action?: string;
  turnLimit: 1;
}

export interface ConnectionSmokeEvidenceStore {
  get(connectionId: string): StoredConnectionSmokeResult | null;
  record(result: StoredConnectionSmokeResult): Promise<void>;
}

export class MemoryConnectionSmokeEvidenceStore
  implements ConnectionSmokeEvidenceStore
{
  private readonly results = new Map<string, StoredConnectionSmokeResult>();

  get(connectionId: string): StoredConnectionSmokeResult | null {
    return this.results.get(connectionId) ?? null;
  }

  // Async-compatible seam (archive#2646): the in-memory twin has nothing to await,
  // but every ConnectionSmokeEvidenceStore implementation returns
  // Promise<void> so callers can await uniformly regardless of which one is
  // wired in.
  record(result: StoredConnectionSmokeResult): Promise<void> {
    this.results.set(result.connectionId, result);
    return Promise.resolve();
  }
}

export class FileConnectionSmokeEvidenceStore
  implements ConnectionSmokeEvidenceStore
{
  private readonly store: ConnectionSmokeStore;
  private readonly filePath: string;
  private readonly acquireMutationLock: ConnectionSmokeMutationLock;

  constructor(
    dataDir: string,
    options: FileConnectionSmokeEvidenceStoreOptions = {},
  ) {
    this.filePath = join(dataDir, 'connection-smoke.json');
    this.acquireMutationLock =
      options.acquireMutationLock ?? acquireFileMutationLockAsync;
    this.store =
      options.storeFactory?.(this.filePath) ??
      new JsonFileStore<ConnectionSmokeDocument>(
        this.filePath,
        { evidenceVersion: CONNECTION_SMOKE_STORE_VERSION, results: [] },
        {
          // A smoke receipt is the evidence that elevates a connection from
          // discovered/catalog-ready to smoke-passed. Treating damaged bytes
          // as an honest empty receipt would silently erase that evidence on
          // the next smoke completion.
          onCorruption: 'throw',
          durableAtomicWrite: true,
        },
      );
  }

  get(connectionId: string): StoredConnectionSmokeResult | null {
    const data = this.read();
    return (
      data.results.find((result) => result.connectionId === connectionId) ??
      null
    );
  }

  async record(result: StoredConnectionSmokeResult): Promise<void> {
    validateResult(result.connectionId, result);
    const persistedResult = jsonClone(result);
    validateResult(result.connectionId, persistedResult);
    mkdirSync(dirname(this.filePath), { recursive: true });
    const release = await this.acquireMutationLock(`${this.filePath}.mutation`);
    try {
      // The read belongs inside the lock. Reading it before acquisition makes
      // two Station processes each publish an otherwise-valid document that
      // loses the other's distinct connection receipt.
      const current = this.read();
      const next: ConnectionSmokeDocument = {
        evidenceVersion: CONNECTION_SMOKE_STORE_VERSION,
        results: [
          ...current.results.filter(
            (candidate) =>
              candidate.connectionId !== persistedResult.connectionId,
          ),
          persistedResult,
        ],
      };
      validateDocument(next);
      this.store.write(next);
    } finally {
      await release();
    }
  }

  private read(): ConnectionSmokeDocument {
    return validateDocument(this.store.read());
  }
}

function validateDocument(value: unknown): ConnectionSmokeDocument {
  if (!isRecord(value) || !hasExactKeys(value, ['evidenceVersion', 'results']))
    throw new ConnectionSmokeEvidenceStoreValidationError();
  if (
    value.evidenceVersion !== CONNECTION_SMOKE_STORE_VERSION ||
    !Array.isArray(value.results)
  )
    throw new ConnectionSmokeEvidenceStoreValidationError();

  const connectionIds = new Set<string>();
  for (const result of value.results) {
    if (!isRecord(result) || typeof result.connectionId !== 'string')
      throw new ConnectionSmokeEvidenceStoreValidationError();
    if (connectionIds.has(result.connectionId))
      throw new ConnectionSmokeEvidenceStoreValidationError();
    connectionIds.add(result.connectionId);
    validateResult(result.connectionId, result);
  }
  return value as ConnectionSmokeDocument;
}

function validateResult(key: string, value: unknown): void {
  if (!isCanonicalConnectionId(key) || !isRecord(value))
    throw new ConnectionSmokeEvidenceStoreValidationError();
  const status = value.status;
  const commonKeys = [
    'evidenceVersion',
    'connectionId',
    'configurationFingerprint',
    'status',
    'testedAt',
    'freshUntil',
    'provider',
    'durationMs',
    'turnLimit',
  ];
  const optionalModel = Object.hasOwn(value, 'model');
  const failure = status === 'failed';
  const allowedKeys = [
    ...commonKeys,
    ...(optionalModel ? ['model'] : []),
    ...(failure ? ['reasonCode', 'reason', 'action'] : []),
  ];
  if (!hasExactKeys(value, allowedKeys))
    throw new ConnectionSmokeEvidenceStoreValidationError();
  if (
    value.evidenceVersion !== 2 ||
    value.connectionId !== key ||
    typeof value.configurationFingerprint !== 'string' ||
    !SHA256_HEX.test(value.configurationFingerprint) ||
    (status !== 'passed' && status !== 'failed') ||
    !isCanonicalTimestamp(value.testedAt) ||
    !isCanonicalTimestamp(value.freshUntil) ||
    value.freshUntil !== deriveConnectionSmokeFreshUntil(value.testedAt) ||
    !isCanonicalText(value.provider) ||
    (optionalModel && !isCanonicalText(value.model)) ||
    typeof value.durationMs !== 'number' ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0 ||
    value.turnLimit !== 1
  ) {
    throw new ConnectionSmokeEvidenceStoreValidationError();
  }
  if (
    failure &&
    (!SMOKE_FAILURE_REASONS.has(
      value.reasonCode as ConnectionSmokeFailureReason,
    ) ||
      !isCanonicalText(value.reason) ||
      !isCanonicalText(value.action))
  ) {
    throw new ConnectionSmokeEvidenceStoreValidationError();
  }
}

/** Derives the only valid expiry for a canonical smoke observation timestamp. */
export function deriveConnectionSmokeFreshUntil(testedAt: string): string {
  if (!isCanonicalTimestamp(testedAt))
    throw new ConnectionSmokeEvidenceStoreValidationError();
  const freshAt = Date.parse(testedAt) + CONNECTION_SMOKE_FRESH_MS;
  if (!Number.isFinite(freshAt))
    throw new ConnectionSmokeEvidenceStoreValidationError();
  try {
    return new Date(freshAt).toISOString();
  } catch {
    throw new ConnectionSmokeEvidenceStoreValidationError();
  }
}

function jsonClone(
  value: StoredConnectionSmokeResult,
): StoredConnectionSmokeResult {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined)
      throw new ConnectionSmokeEvidenceStoreValidationError();
    return JSON.parse(serialized) as StoredConnectionSmokeResult;
  } catch (error) {
    if (error instanceof ConnectionSmokeEvidenceStoreValidationError)
      throw error;
    throw new ConnectionSmokeEvidenceStoreValidationError();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isCanonicalConnectionId(value: unknown): value is string {
  return typeof value === 'string' && CLEAN_ID_PATTERN.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function isCanonicalText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}
