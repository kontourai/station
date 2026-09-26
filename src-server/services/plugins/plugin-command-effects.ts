import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  OPERATIONAL_EVENT_SCHEMA_VERSION,
  type OperationalEventEnvelope,
  type OperationalEventJson,
} from '@kontourai/station-contracts/operational-event';
import {
  PLUGIN_COMMAND_EFFECT_EVENT_SCHEMA,
  PLUGIN_COMMAND_EFFECT_MAX_SETTLEMENT_ITEMS,
  PLUGIN_COMMAND_EFFECT_OUTCOMES,
  PLUGIN_COMMAND_EFFECT_REQUEST_WINDOW_MS,
  PLUGIN_COMMAND_WITHDRAWAL_MAX_LISTED_EFFECTS,
  type PluginCommandEffectContent,
  type PluginCommandEffectEventData,
  type PluginCommandEffectOutcome,
  type PluginCommandEffectReceipt,
  type PluginCommandEffectRefusalReason,
  type PluginCommandEffectSettledBy,
  type PluginCommandEffectSettlementResult,
  type PluginCommandEffectState,
  type PluginCommandEffectsWithdrawalSummary,
  type PluginCommandEffectTarget,
  type PluginCommandUncapturedEffect,
  type PluginCommandWithdrawalCause,
  type PluginCommandWithdrawalProjection,
  type PluginCommandWithdrawalStatus,
} from '@kontourai/station-contracts/plugin-command-effect';
import { serializeJsonDocument } from '@kontourai/station-shared/durable-json-file';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import {
  publishJsonFileWithOwnedLock,
  readJsonFile,
} from '../../domain/file-storage-helpers.js';

/**
 * The durable plugin command effect ledger (kontourai/station#1418, #1419).
 *
 * Linearization points owned here:
 * - LP-A: {@link PluginCommandEffectService.recordAdmission}'s atomic append.
 *   Callers reach it only after their authority checks, inside the same
 *   serialization a withdrawal of that authority uses.
 * - LP-W: {@link PluginCommandEffectService.beginWithdrawal}'s capture of the
 *   plugin's outstanding effects, called after the authority change commits.
 *   A plugin has at most one open withdrawal; a later change joins it.
 * - LP-K: {@link PluginCommandEffectService.settle}'s atomic settlement write.
 * - LP-C: a ledger read finding a withdrawal with nothing outstanding.
 *
 * The ledger lock is always the LAST lock taken and is never held across any
 * wait other than this file's own write.
 *
 * Audit is written after the ledger commits. A crash between the two leaves a
 * committed admission or settlement with no operational event; the ledger is
 * the record, the event stream is an observation of it and can miss one.
 */

export const PLUGIN_COMMAND_EFFECT_BOUNDS = Object.freeze({
  outstandingPerPrincipal: 16,
  outstandingPerPlugin: 8,
  outstandingTotal: 64,
  retainedTerminalEffects: 64,
  retainedResolvedWithdrawals: 64,
  tombstonesPerDocument: 16,
  tombstonesPerPrincipal: 64,
  tombstonesTotal: 256,
  /**
   * The file cap. A ledger at every bound with every field at its maximum
   * length fits well under it (asserted by test), so writes that do not grow
   * the ledger always fit.
   */
  storeBytes: 1024 * 1024,
  /** Growth (admissions, cancels) is refused past this. */
  growthBytes: 896 * 1024,
});

/** A cancel can only still match an admission issued within the window. */
const TOMBSTONE_LIFETIME_MS = 2 * PLUGIN_COMMAND_EFFECT_REQUEST_WINDOW_MS;
const STORE_VERSION = 1 as const;
const STORE_FILE = 'plugin-command-effects.json';
const JSON_INDENT = 2;
const CAUSES: readonly PluginCommandWithdrawalCause[] = [
  'removal',
  'update',
  'grant-withdrawal',
];
/** Client-chosen ids: opaque, bounded, and safe in logs and event payloads. */
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const DOCUMENT_KEY = /^[A-Za-z0-9_-]{32,256}$/;
const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_PRINCIPAL_ID = 256;
const MAX_GENERATION = 256;
const MAX_COMMAND_ID = 127;
const MAX_PLUGIN_ID = 64;
const MAX_RECORD_ID = 64;

interface EffectRecord {
  effectId: string;
  sequence: number;
  documentId: string;
  documentKeyDigest: string;
  requestId: string;
  principalId: string;
  pluginId: string;
  installationGeneration: string;
  requiresPluginServer: boolean;
  commandId: string;
  target: PluginCommandEffectTarget;
  effectDigest: string;
  state: PluginCommandEffectState;
  settledBy?: PluginCommandEffectSettledBy;
  admittedAt: string;
  settledAt?: string;
  conflicts: number;
  lateOutcome?: PluginCommandEffectOutcome;
}

interface WithdrawalRecord {
  withdrawalId: string;
  sequence: number;
  pluginId: string;
  causes: PluginCommandWithdrawalCause[];
  createdAt: string;
  /** Captured effects still admitted. Settled ones leave and are counted. */
  outstanding: Array<{ effectId: string; capturedAt: string }>;
  /** Captured effects settled with document or station proof. */
  settled: number;
  resolution?: {
    disposition: 'accept-indeterminate';
    resolvedAt: string;
    abandoned: number;
  };
}

interface TombstoneRecord {
  sequence: number;
  documentId: string;
  documentKeyDigest: string;
  requestId: string;
  principalId: string;
  createdAt: string;
}

export interface PluginCommandEffectLedger {
  version: typeof STORE_VERSION;
  sequence: number;
  effects: EffectRecord[];
  withdrawals: WithdrawalRecord[];
  tombstones: TombstoneRecord[];
}

const emptyLedger = (): PluginCommandEffectLedger => ({
  version: STORE_VERSION,
  sequence: 0,
  effects: [],
  withdrawals: [],
  tombstones: [],
});

/** The ledger cannot be read, validated or written. Nothing was recorded. */
export class PluginCommandEffectsUnavailableError extends Error {
  constructor(message = 'Plugin command effects are unavailable') {
    super(message);
    this.name = 'PluginCommandEffectsUnavailableError';
  }
}

export interface PluginCommandEffectTransaction<T> {
  readonly result: T;
  /** Omit for a read-only transaction. */
  readonly next?: PluginCommandEffectLedger;
}

export interface PluginCommandEffectStore {
  /** Services on the same ledger share settlement wake-ups through this. */
  readonly ledgerIdentity: string;
  read(): Promise<PluginCommandEffectLedger>;
  transact<T>(
    update: (
      current: PluginCommandEffectLedger,
    ) => PluginCommandEffectTransaction<T>,
  ): Promise<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  return (
    required.every((field) => Object.hasOwn(value, field)) &&
    Object.keys(value).every(
      (key) => required.includes(key) || optional.includes(key),
    )
  );
}

const isNonNegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const isTimestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 32 &&
  !Number.isNaN(Date.parse(value));

const isBoundedString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

const OUTCOMES = new Set<string>(PLUGIN_COMMAND_EFFECT_OUTCOMES);
const SETTLED_BY = new Set<string>(['document', 'operator', 'station']);

/** Canonical byte measure: exactly the document the store writes. */
function ledgerBytes(ledger: PluginCommandEffectLedger): number {
  return Buffer.byteLength(serializeJsonDocument(ledger, JSON_INDENT, false));
}

export function parsePluginCommandEffectTarget(
  value: unknown,
): PluginCommandEffectTarget | null {
  if (!isRecord(value)) return null;
  if (
    value.kind === 'destination' &&
    hasExactFields(value, ['kind', 'destinationId']) &&
    typeof value.destinationId === 'string' &&
    HOST_ID.test(value.destinationId)
  )
    return { kind: 'destination', destinationId: value.destinationId };
  if (
    value.kind === 'composer' &&
    hasExactFields(value, ['kind', 'sessionId']) &&
    typeof value.sessionId === 'string' &&
    HOST_ID.test(value.sessionId)
  )
    return { kind: 'composer', sessionId: value.sessionId };
  return null;
}

function parseEffect(value: unknown): EffectRecord | null {
  if (
    !isRecord(value) ||
    !hasExactFields(
      value,
      [
        'effectId',
        'sequence',
        'documentId',
        'documentKeyDigest',
        'requestId',
        'principalId',
        'pluginId',
        'installationGeneration',
        'requiresPluginServer',
        'commandId',
        'target',
        'effectDigest',
        'state',
        'admittedAt',
        'conflicts',
      ],
      ['settledBy', 'settledAt', 'lateOutcome'],
    ) ||
    !isBoundedString(value.effectId, MAX_RECORD_ID) ||
    !isNonNegativeInteger(value.sequence) ||
    typeof value.documentId !== 'string' ||
    !CLIENT_ID.test(value.documentId) ||
    typeof value.documentKeyDigest !== 'string' ||
    !SHA256.test(value.documentKeyDigest) ||
    typeof value.requestId !== 'string' ||
    !CLIENT_ID.test(value.requestId) ||
    !isBoundedString(value.principalId, MAX_PRINCIPAL_ID) ||
    !isBoundedString(value.pluginId, MAX_PLUGIN_ID) ||
    !isBoundedString(value.installationGeneration, MAX_GENERATION) ||
    typeof value.requiresPluginServer !== 'boolean' ||
    !isBoundedString(value.commandId, MAX_COMMAND_ID) ||
    !parsePluginCommandEffectTarget(value.target) ||
    typeof value.effectDigest !== 'string' ||
    !SHA256.test(value.effectDigest) ||
    (value.state !== 'admitted' && !OUTCOMES.has(value.state as string)) ||
    !isTimestamp(value.admittedAt) ||
    !isNonNegativeInteger(value.conflicts)
  )
    return null;
  const terminal = value.state !== 'admitted';
  if (
    terminal !==
      (value.settledBy !== undefined && value.settledAt !== undefined) ||
    (value.settledBy !== undefined &&
      !SETTLED_BY.has(value.settledBy as string)) ||
    (value.settledAt !== undefined && !isTimestamp(value.settledAt)) ||
    (value.lateOutcome !== undefined &&
      (!OUTCOMES.has(value.lateOutcome as string) ||
        value.settledBy !== 'operator'))
  )
    return null;
  return structuredClone(value) as unknown as EffectRecord;
}

function parseWithdrawal(value: unknown): WithdrawalRecord | null {
  if (
    !isRecord(value) ||
    !hasExactFields(
      value,
      [
        'withdrawalId',
        'sequence',
        'pluginId',
        'causes',
        'createdAt',
        'outstanding',
        'settled',
      ],
      ['resolution'],
    ) ||
    !isBoundedString(value.withdrawalId, MAX_RECORD_ID) ||
    !isNonNegativeInteger(value.sequence) ||
    !isBoundedString(value.pluginId, MAX_PLUGIN_ID) ||
    !Array.isArray(value.causes) ||
    value.causes.length === 0 ||
    new Set(value.causes).size !== value.causes.length ||
    !value.causes.every((cause) =>
      CAUSES.includes(cause as PluginCommandWithdrawalCause),
    ) ||
    !isTimestamp(value.createdAt) ||
    !Array.isArray(value.outstanding) ||
    value.outstanding.length >
      PLUGIN_COMMAND_EFFECT_BOUNDS.outstandingPerPlugin ||
    !isNonNegativeInteger(value.settled)
  )
    return null;
  for (const capture of value.outstanding) {
    if (
      !isRecord(capture) ||
      !hasExactFields(capture, ['effectId', 'capturedAt']) ||
      !isBoundedString(capture.effectId, MAX_RECORD_ID) ||
      !isTimestamp(capture.capturedAt)
    )
      return null;
  }
  if (value.resolution !== undefined) {
    const resolution = value.resolution;
    if (
      !isRecord(resolution) ||
      !hasExactFields(resolution, ['disposition', 'resolvedAt', 'abandoned']) ||
      resolution.disposition !== 'accept-indeterminate' ||
      !isTimestamp(resolution.resolvedAt) ||
      !isNonNegativeInteger(resolution.abandoned)
    )
      return null;
  }
  return structuredClone(value) as unknown as WithdrawalRecord;
}

function parseTombstone(value: unknown): TombstoneRecord | null {
  if (
    !isRecord(value) ||
    !hasExactFields(value, [
      'sequence',
      'documentId',
      'documentKeyDigest',
      'requestId',
      'principalId',
      'createdAt',
    ]) ||
    !isNonNegativeInteger(value.sequence) ||
    typeof value.documentId !== 'string' ||
    !CLIENT_ID.test(value.documentId) ||
    typeof value.documentKeyDigest !== 'string' ||
    !SHA256.test(value.documentKeyDigest) ||
    typeof value.requestId !== 'string' ||
    !CLIENT_ID.test(value.requestId) ||
    !isBoundedString(value.principalId, MAX_PRINCIPAL_ID) ||
    !isTimestamp(value.createdAt)
  )
    return null;
  return structuredClone(value) as unknown as TombstoneRecord;
}

const isOpenWithdrawal = (withdrawal: WithdrawalRecord) =>
  withdrawal.resolution === undefined && withdrawal.outstanding.length > 0;

/** One request identity per principal and document key (never across them). */
const requestScope = (entry: {
  principalId: string;
  documentKeyDigest: string;
  documentId: string;
  requestId: string;
}) =>
  `${entry.principalId}/${entry.documentKeyDigest}/${entry.documentId}/${entry.requestId}`;

const documentScope = (entry: {
  principalId: string;
  documentKeyDigest: string;
}) => `${entry.principalId}/${entry.documentKeyDigest}`;

/**
 * Strict parse plus the cross-record invariants the protocol depends on. A
 * ledger that violates one is refused whole rather than partially trusted.
 */
function validatePluginCommandEffectLedger(
  value: unknown,
): PluginCommandEffectLedger {
  const unavailable = () =>
    new PluginCommandEffectsUnavailableError(
      'Plugin command effect ledger is invalid',
    );
  if (
    !isRecord(value) ||
    !hasExactFields(value, [
      'version',
      'sequence',
      'effects',
      'withdrawals',
      'tombstones',
    ]) ||
    value.version !== STORE_VERSION ||
    !isNonNegativeInteger(value.sequence) ||
    !Array.isArray(value.effects) ||
    !Array.isArray(value.withdrawals) ||
    !Array.isArray(value.tombstones)
  )
    throw unavailable();
  const effects = value.effects.map(parseEffect);
  const withdrawals = value.withdrawals.map(parseWithdrawal);
  const tombstones = value.tombstones.map(parseTombstone);
  if (
    effects.some((effect) => !effect) ||
    withdrawals.some((withdrawal) => !withdrawal) ||
    tombstones.some((tombstone) => !tombstone)
  )
    throw unavailable();
  const ledger: PluginCommandEffectLedger = {
    version: STORE_VERSION,
    sequence: value.sequence,
    effects: effects as EffectRecord[],
    withdrawals: withdrawals as WithdrawalRecord[],
    tombstones: tombstones as TombstoneRecord[],
  };
  const bounds = PLUGIN_COMMAND_EFFECT_BOUNDS;
  const byId = new Map<string, EffectRecord>();
  const requests = new Set<string>();
  for (const effect of ledger.effects) {
    if (byId.has(effect.effectId) || requests.has(requestScope(effect)))
      throw unavailable();
    byId.set(effect.effectId, effect);
    requests.add(requestScope(effect));
  }
  const outstanding = ledger.effects.filter(
    (effect) => effect.state === 'admitted',
  );
  const count = (key: (effect: EffectRecord) => string) => {
    const counts = new Map<string, number>();
    for (const effect of outstanding)
      counts.set(key(effect), (counts.get(key(effect)) ?? 0) + 1);
    return Math.max(0, ...counts.values());
  };
  const captured = new Set<string>();
  const withdrawalIds = new Set<string>();
  const openPlugins = new Set<string>();
  for (const withdrawal of ledger.withdrawals) {
    if (withdrawalIds.has(withdrawal.withdrawalId)) throw unavailable();
    withdrawalIds.add(withdrawal.withdrawalId);
    if (withdrawal.resolution !== undefined && withdrawal.outstanding.length)
      throw unavailable();
    if (isOpenWithdrawal(withdrawal)) {
      // At most one open withdrawal per plugin: later changes join it.
      if (openPlugins.has(withdrawal.pluginId)) throw unavailable();
      openPlugins.add(withdrawal.pluginId);
    }
    for (const capture of withdrawal.outstanding) {
      const effect = byId.get(capture.effectId);
      if (
        captured.has(capture.effectId) ||
        effect?.state !== 'admitted' ||
        effect.pluginId !== withdrawal.pluginId
      )
        throw unavailable();
      captured.add(capture.effectId);
    }
  }
  const tombstoneCounts = new Map<string, number>();
  const principalTombstones = new Map<string, number>();
  for (const tombstone of ledger.tombstones) {
    const scope = documentScope(tombstone);
    tombstoneCounts.set(scope, (tombstoneCounts.get(scope) ?? 0) + 1);
    principalTombstones.set(
      tombstone.principalId,
      (principalTombstones.get(tombstone.principalId) ?? 0) + 1,
    );
  }
  const sequences = [
    ...ledger.effects,
    ...ledger.withdrawals,
    ...ledger.tombstones,
  ].map((entry) => entry.sequence);
  if (
    outstanding.length > bounds.outstandingTotal ||
    count((effect) => effect.pluginId) > bounds.outstandingPerPlugin ||
    count((effect) => effect.principalId) > bounds.outstandingPerPrincipal ||
    ledger.effects.length - outstanding.length >
      bounds.retainedTerminalEffects ||
    ledger.withdrawals.filter((withdrawal) => !isOpenWithdrawal(withdrawal))
      .length > bounds.retainedResolvedWithdrawals ||
    ledger.tombstones.length > bounds.tombstonesTotal ||
    Math.max(0, ...tombstoneCounts.values()) > bounds.tombstonesPerDocument ||
    Math.max(0, ...principalTombstones.values()) >
      bounds.tombstonesPerPrincipal ||
    new Set(sequences).size !== sequences.length ||
    Math.max(0, ...sequences) > ledger.sequence ||
    ledgerBytes(ledger) > bounds.storeBytes
  )
    throw unavailable();
  return ledger;
}

interface FilePluginCommandEffectStoreOptions {
  readonly acquireLock?: typeof acquireFileMutationLockAsync;
  /** Fault seam immediately before the atomic rename commit. */
  readonly beforeCommit?: () => void | Promise<void>;
}

/** Station home file store; the rename is the commit point. */
export class FilePluginCommandEffectStore implements PluginCommandEffectStore {
  readonly ledgerIdentity: string;
  readonly #file: string;
  readonly #acquireLock: typeof acquireFileMutationLockAsync;
  readonly #beforeCommit?: () => void | Promise<void>;

  constructor(
    projectHomeDir: string,
    options: FilePluginCommandEffectStoreOptions = {},
  ) {
    this.#file = join(projectHomeDir, STORE_FILE);
    this.ledgerIdentity = this.#file;
    this.#acquireLock = options.acquireLock ?? acquireFileMutationLockAsync;
    this.#beforeCommit = options.beforeCommit;
  }

  async read(): Promise<PluginCommandEffectLedger> {
    return this.#readLedger();
  }

  #readLedger(): PluginCommandEffectLedger {
    let value: unknown;
    try {
      value = readJsonFile(this.#file, emptyLedger(), {
        maxBytes: PLUGIN_COMMAND_EFFECT_BOUNDS.storeBytes,
        label: 'Plugin command effect ledger',
      });
    } catch {
      throw new PluginCommandEffectsUnavailableError();
    }
    return validatePluginCommandEffectLedger(value);
  }

  async transact<T>(
    update: (
      current: PluginCommandEffectLedger,
    ) => PluginCommandEffectTransaction<T>,
  ): Promise<T> {
    let release: () => void | Promise<void>;
    try {
      release = await this.#acquireLock(`${this.#file}.mutation`);
    } catch {
      throw new PluginCommandEffectsUnavailableError();
    }
    let committed = false;
    let result: T | undefined;
    let operationError: unknown;
    try {
      const outcome = update(structuredClone(this.#readLedger()));
      result = outcome.result;
      if (outcome.next) {
        // Validation includes the byte cap, measured on the exact document
        // the publish below writes (same serializer, same indentation).
        const next = validatePluginCommandEffectLedger(
          structuredClone(outcome.next),
        );
        try {
          await publishJsonFileWithOwnedLock(this.#file, next, {
            maxBytes: PLUGIN_COMMAND_EFFECT_BOUNDS.storeBytes,
            label: 'Plugin command effect ledger',
            indent: JSON_INDENT,
            beforeCommit: this.#beforeCommit,
          });
        } catch {
          throw new PluginCommandEffectsUnavailableError();
        }
      }
      committed = true;
    } catch (error) {
      operationError = error;
    }
    try {
      await release();
    } catch (error) {
      // Publication is the commit point; lock cleanup cannot un-commit it.
      if (!committed && operationError === undefined) operationError = error;
    }
    if (operationError !== undefined) throw operationError;
    return result as T;
  }
}

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

function effectContentDigest(content: PluginCommandEffectContent): string {
  return sha256(
    JSON.stringify(
      content.kind === 'navigate'
        ? ['navigate', content.destinationId]
        : ['seed-composer', content.sessionId, content.text],
    ),
  );
}

function sameTarget(
  left: PluginCommandEffectTarget,
  right: PluginCommandEffectTarget,
): boolean {
  return left.kind === 'destination'
    ? right.kind === 'destination' && left.destinationId === right.destinationId
    : right.kind === 'composer' && left.sessionId === right.sessionId;
}

export function isPluginCommandClientId(value: unknown): value is string {
  return typeof value === 'string' && CLIENT_ID.test(value);
}

export function isPluginCommandDocumentKey(value: unknown): value is string {
  return typeof value === 'string' && DOCUMENT_KEY.test(value);
}

export interface PluginCommandEffectAdmissionRecord {
  principalId: string;
  pluginId: string;
  installationGeneration: string;
  requiresPluginServer: boolean;
  commandId: string;
  target: PluginCommandEffectTarget;
  /** Server-read effect content; the receipt carries exactly this. */
  content: PluginCommandEffectContent;
  documentId: string;
  documentKey: string;
  requestId: string;
  issuedAt: number;
}

export type PluginCommandEffectAdmissionOutcome =
  | { kind: 'admitted'; receipt: PluginCommandEffectReceipt }
  | { kind: 'refused'; reason: PluginCommandEffectRefusalReason };

export interface PluginCommandEffectServiceOptions {
  store: PluginCommandEffectStore;
  now?: () => Date;
  /** Age after which an outstanding effect or withdrawal counts as stuck. */
  indeterminateAfterMs?: number;
  /** Durable audit. Returning false means the event was not persisted. */
  publishAudit?(event: OperationalEventEnvelope): boolean;
  producerVersion?: string;
  onSettlementConflict?(): void;
}

export type PluginCommandWithdrawalResolveOutcome =
  | { kind: 'resolved'; withdrawal: PluginCommandWithdrawalProjection }
  | { kind: 'not-found' }
  | {
      kind: 'not-indeterminate';
      withdrawal: PluginCommandWithdrawalProjection;
    };

export type PluginCommandEffectAbandonOutcome =
  | { kind: 'abandoned' }
  | { kind: 'not-found' }
  | { kind: 'captured'; withdrawalId: string }
  | { kind: 'too-recent' };

/**
 * A lifecycle route's wait and the settlement route may hold different service
 * instances over one ledger; a settlement must still wake the wait.
 */
const ledgerWaiters = new Map<string, Set<() => void>>();

export function createPluginCommandEffectService(
  options: PluginCommandEffectServiceOptions,
) {
  const { store } = options;
  const now = options.now ?? (() => new Date());
  const indeterminateAfterMs = options.indeterminateAfterMs ?? 60_000;
  const bounds = PLUGIN_COMMAND_EFFECT_BOUNDS;
  let waiters = ledgerWaiters.get(store.ledgerIdentity);
  if (!waiters) {
    waiters = new Set();
    ledgerWaiters.set(store.ledgerIdentity, waiters);
  }
  const notify = () => {
    for (const waiter of [...waiters]) waiter();
  };
  const commit = async <T>(
    update: (
      ledger: PluginCommandEffectLedger,
    ) => PluginCommandEffectTransaction<T>,
  ): Promise<T> => {
    const result = await store.transact(update);
    notify();
    return result;
  };

  const audit = (
    effect: EffectRecord,
    outcome: PluginCommandEffectState,
    extra: {
      settledBy?: PluginCommandEffectSettledBy;
      disposition?: 'conflict' | 'late';
      sequence?: number;
    } = {},
  ): boolean => {
    if (!options.publishAudit) return true;
    const data: PluginCommandEffectEventData = {
      effectId: effect.effectId,
      principalId: effect.principalId,
      pluginId: effect.pluginId,
      installationGeneration: effect.installationGeneration,
      commandId: effect.commandId,
      target: structuredClone(effect.target),
      outcome,
      ...(extra.settledBy ? { settledBy: extra.settledBy } : {}),
      ...(extra.disposition ? { disposition: extra.disposition } : {}),
    };
    try {
      return options.publishAudit({
        schemaVersion: OPERATIONAL_EVENT_SCHEMA_VERSION,
        id: [
          'plugin-command',
          effect.effectId,
          outcome,
          ...(extra.disposition ? [extra.disposition] : []),
          ...(extra.sequence !== undefined ? [String(extra.sequence)] : []),
        ].join('-'),
        type: PLUGIN_COMMAND_EFFECT_EVENT_SCHEMA,
        producer: {
          id: 'station-server',
          version: options.producerVersion ?? '1.0',
        },
        occurredAt: now().toISOString(),
        correlationId: effect.requestId,
        scopes: [{ kind: 'plugin', pluginId: effect.pluginId }],
        payload: {
          schema: PLUGIN_COMMAND_EFFECT_EVENT_SCHEMA,
          // The contract type names the one-way payload shape; JSON-safe by construction.
          data: data as unknown as OperationalEventJson,
        },
        privacy: 'private',
        delivery: 'durable',
      });
    } catch {
      return false;
    }
  };

  const nextSequence = (ledger: PluginCommandEffectLedger) => {
    ledger.sequence += 1;
    return ledger.sequence;
  };

  /**
   * Evict only terminal effects, closed or completed withdrawals and expired
   * cancels, oldest first. Outstanding effects and open withdrawals stay.
   */
  const trim = (ledger: PluginCommandEffectLedger) => {
    const terminal = ledger.effects
      .filter((effect) => effect.state !== 'admitted')
      .sort((left, right) => left.sequence - right.sequence);
    const evictEffects = new Set(
      terminal
        .slice(0, Math.max(0, terminal.length - bounds.retainedTerminalEffects))
        .map((effect) => effect.effectId),
    );
    ledger.effects = ledger.effects.filter(
      (effect) => !evictEffects.has(effect.effectId),
    );
    const closed = ledger.withdrawals
      .filter((withdrawal) => !isOpenWithdrawal(withdrawal))
      .sort((left, right) => left.sequence - right.sequence);
    const evictWithdrawals = new Set(
      closed
        .slice(
          0,
          Math.max(0, closed.length - bounds.retainedResolvedWithdrawals),
        )
        .map((withdrawal) => withdrawal.withdrawalId),
    );
    ledger.withdrawals = ledger.withdrawals.filter(
      (withdrawal) => !evictWithdrawals.has(withdrawal.withdrawalId),
    );
    const expiry = now().getTime() - TOMBSTONE_LIFETIME_MS;
    ledger.tombstones = ledger.tombstones.filter(
      (tombstone) => Date.parse(tombstone.createdAt) > expiry,
    );
  };

  const openWithdrawalFor = (
    ledger: PluginCommandEffectLedger,
    pluginId: string,
  ) =>
    ledger.withdrawals.find(
      (withdrawal) =>
        withdrawal.pluginId === pluginId && isOpenWithdrawal(withdrawal),
    );

  /** Settle one outstanding effect; its capture leaves the open withdrawal. */
  const settleInLedger = (
    ledger: PluginCommandEffectLedger,
    effect: EffectRecord,
    outcome: PluginCommandEffectOutcome,
    settledBy: PluginCommandEffectSettledBy,
  ) => {
    effect.state = outcome;
    effect.settledBy = settledBy;
    effect.settledAt = now().toISOString();
    for (const withdrawal of ledger.withdrawals) {
      const index = withdrawal.outstanding.findIndex(
        (capture) => capture.effectId === effect.effectId,
      );
      if (index < 0) continue;
      withdrawal.outstanding.splice(index, 1);
      // Operator settlement only happens through `resolveWithdrawal`, which
      // records its own count; every other settlement is proof.
      if (settledBy !== 'operator') withdrawal.settled += 1;
    }
  };

  const project = (
    withdrawal: WithdrawalRecord,
  ): PluginCommandWithdrawalProjection => {
    const outstanding = withdrawal.outstanding.map(
      (capture) => capture.effectId,
    );
    const newestCapture = Math.max(
      0,
      ...withdrawal.outstanding.map((capture) =>
        Date.parse(capture.capturedAt),
      ),
    );
    const status: PluginCommandWithdrawalStatus =
      withdrawal.resolution !== undefined
        ? 'closed-indeterminate'
        : outstanding.length === 0
          ? 'completed'
          : now().getTime() - newestCapture < indeterminateAfterMs
            ? 'winding-down'
            : 'indeterminate';
    return {
      withdrawalId: withdrawal.withdrawalId,
      pluginId: withdrawal.pluginId,
      causes: [...withdrawal.causes],
      createdAt: withdrawal.createdAt,
      status,
      outstanding: outstanding.length,
      outstandingEffectIds: outstanding.slice(
        0,
        PLUGIN_COMMAND_WITHDRAWAL_MAX_LISTED_EFFECTS,
      ),
    };
  };

  const summary = (
    projection: PluginCommandWithdrawalProjection,
  ): PluginCommandEffectsWithdrawalSummary => ({
    withdrawalId: projection.withdrawalId,
    status: projection.status,
    outstanding: projection.outstanding,
  });

  const service = {
    /**
     * LP-A. Idempotent on (documentId, requestId) within the principal and
     * document key. A cancel recorded before this commit makes it refuse;
     * capacity refuses and never evicts an outstanding effect.
     */
    async recordAdmission(
      input: PluginCommandEffectAdmissionRecord,
    ): Promise<PluginCommandEffectAdmissionOutcome> {
      const clock = now().getTime();
      if (
        !Number.isSafeInteger(input.issuedAt) ||
        Math.abs(clock - input.issuedAt) >
          PLUGIN_COMMAND_EFFECT_REQUEST_WINDOW_MS
      )
        return { kind: 'refused', reason: 'request-expired' };
      if (
        !isBoundedString(input.principalId, MAX_PRINCIPAL_ID) ||
        !isBoundedString(input.installationGeneration, MAX_GENERATION) ||
        !isBoundedString(input.pluginId, MAX_PLUGIN_ID) ||
        !isBoundedString(input.commandId, MAX_COMMAND_ID)
      )
        return { kind: 'refused', reason: 'invalid-request' };
      const scope = {
        principalId: input.principalId,
        documentKeyDigest: sha256(input.documentKey),
        documentId: input.documentId,
        requestId: input.requestId,
      };
      const effectDigest = effectContentDigest(input.content);
      const receiptFor = (
        effect: EffectRecord,
      ): PluginCommandEffectReceipt => ({
        effectId: effect.effectId,
        requestId: effect.requestId,
        pluginId: effect.pluginId,
        commandId: effect.commandId,
        installationGeneration: effect.installationGeneration,
        effect: structuredClone(input.content),
      });
      type AdmissionStep =
        | { kind: 'created'; effect: EffectRecord }
        | { kind: 'existing'; effect: EffectRecord }
        | { kind: 'refused'; reason: PluginCommandEffectRefusalReason };
      let outcome: AdmissionStep;
      try {
        outcome = await commit(
          (ledger): PluginCommandEffectTransaction<AdmissionStep> => {
            trim(ledger);
            if (
              ledger.tombstones.some(
                (tombstone) => requestScope(tombstone) === requestScope(scope),
              )
            )
              return { result: { kind: 'refused', reason: 'cancelled' } };
            const existing = ledger.effects.find(
              (effect) => requestScope(effect) === requestScope(scope),
            );
            if (existing) {
              if (
                existing.pluginId !== input.pluginId ||
                existing.commandId !== input.commandId ||
                existing.installationGeneration !==
                  input.installationGeneration ||
                !sameTarget(existing.target, input.target) ||
                existing.effectDigest !== effectDigest
              )
                return {
                  result: { kind: 'refused', reason: 'request-conflict' },
                };
              if (existing.state === 'admitted')
                return { result: { kind: 'existing', effect: existing } };
              return {
                result: {
                  kind: 'refused',
                  reason:
                    existing.state === 'cancelled' ||
                    existing.state === 'abandoned'
                      ? 'cancelled'
                      : 'request-conflict',
                },
              };
            }
            const outstanding = ledger.effects.filter(
              (effect) => effect.state === 'admitted',
            );
            if (
              outstanding.filter(
                (effect) => effect.principalId === input.principalId,
              ).length >= bounds.outstandingPerPrincipal ||
              outstanding.filter((effect) => effect.pluginId === input.pluginId)
                .length >= bounds.outstandingPerPlugin ||
              outstanding.length >= bounds.outstandingTotal
            )
              return { result: { kind: 'refused', reason: 'capacity' } };
            const effect: EffectRecord = {
              effectId: `pce-${randomUUID()}`,
              sequence: nextSequence(ledger),
              ...scope,
              pluginId: input.pluginId,
              installationGeneration: input.installationGeneration,
              requiresPluginServer: input.requiresPluginServer,
              commandId: input.commandId,
              target: structuredClone(input.target),
              effectDigest,
              state: 'admitted',
              admittedAt: now().toISOString(),
              conflicts: 0,
            };
            ledger.effects.push(effect);
            if (ledgerBytes(ledger) > bounds.growthBytes)
              return { result: { kind: 'refused', reason: 'capacity' } };
            return { result: { kind: 'created', effect }, next: ledger };
          },
        );
      } catch (error) {
        if (error instanceof PluginCommandEffectsUnavailableError)
          return { kind: 'refused', reason: 'unavailable' };
        throw error;
      }
      if (outcome.kind === 'refused') return outcome;
      if (outcome.kind === 'existing')
        return { kind: 'admitted', receipt: receiptFor(outcome.effect) };
      if (audit(outcome.effect, 'admitted')) {
        return { kind: 'admitted', receipt: receiptFor(outcome.effect) };
      }
      // The receipt was never released. Record that proof before refusing;
      // if even that write fails the effect stays outstanding, which a
      // withdrawal reports honestly rather than as completed.
      const effectId = outcome.effect.effectId;
      try {
        await commit((ledger) => {
          const effect = ledger.effects.find(
            (candidate) => candidate.effectId === effectId,
          );
          if (effect?.state !== 'admitted') return { result: undefined };
          settleInLedger(ledger, effect, 'cancelled', 'station');
          trim(ledger);
          return { result: undefined, next: ledger };
        });
      } catch {
        // Reported by the outstanding effect itself.
      }
      return { kind: 'refused', reason: 'unavailable' };
    },

    /** LP-K. First terminal wins; the same outcome is idempotent. */
    async settle(input: {
      principalId: string;
      documentId: string;
      documentKey: string;
      items: ReadonlyArray<{
        requestId: string;
        effectId?: string;
        outcome: PluginCommandEffectOutcome;
      }>;
    }): Promise<PluginCommandEffectSettlementResult[]> {
      if (input.items.length > PLUGIN_COMMAND_EFFECT_MAX_SETTLEMENT_ITEMS)
        throw new RangeError('Too many settlement items');
      const documentKeyDigest = sha256(input.documentKey);
      const events: Array<{
        effect: EffectRecord;
        outcome: PluginCommandEffectOutcome;
        disposition?: 'conflict' | 'late';
        sequence?: number;
      }> = [];
      let conflicts = 0;
      const results = await commit((ledger) => {
        trim(ledger);
        let changed = false;
        const results = input.items.map(
          (item): PluginCommandEffectSettlementResult => {
            const scope = {
              principalId: input.principalId,
              documentKeyDigest,
              documentId: input.documentId,
              requestId: item.requestId,
            };
            const effect = ledger.effects.find(
              (candidate) => requestScope(candidate) === requestScope(scope),
            );
            if (
              effect &&
              item.effectId !== undefined &&
              item.effectId !== effect.effectId
            )
              return { requestId: item.requestId, status: 'not-found' };
            if (!effect) {
              if (item.outcome !== 'cancelled' || item.effectId !== undefined)
                return { requestId: item.requestId, status: 'not-found' };
              if (
                ledger.tombstones.some(
                  (tombstone) =>
                    requestScope(tombstone) === requestScope(scope),
                )
              )
                return { requestId: item.requestId, status: 'cancel-recorded' };
              // Never evict an unexpired cancel: another request of this
              // document may still depend on it. Refuse the new one instead.
              if (
                ledger.tombstones.filter(
                  (tombstone) =>
                    documentScope(tombstone) === documentScope(scope),
                ).length >= bounds.tombstonesPerDocument ||
                ledger.tombstones.filter(
                  (tombstone) => tombstone.principalId === input.principalId,
                ).length >= bounds.tombstonesPerPrincipal ||
                ledger.tombstones.length >= bounds.tombstonesTotal
              )
                return { requestId: item.requestId, status: 'cancel-refused' };
              const tombstone: TombstoneRecord = {
                sequence: nextSequence(ledger),
                ...scope,
                createdAt: now().toISOString(),
              };
              ledger.tombstones.push(tombstone);
              if (ledgerBytes(ledger) > bounds.growthBytes) {
                ledger.tombstones.pop();
                return { requestId: item.requestId, status: 'cancel-refused' };
              }
              changed = true;
              return { requestId: item.requestId, status: 'cancel-recorded' };
            }
            if (effect.state === 'admitted') {
              settleInLedger(ledger, effect, item.outcome, 'document');
              events.push({
                effect: structuredClone(effect),
                outcome: item.outcome,
              });
              changed = true;
              return { requestId: item.requestId, status: 'settled' };
            }
            if (effect.settledBy === 'operator') {
              if (effect.lateOutcome === undefined) {
                effect.lateOutcome = item.outcome;
                events.push({
                  effect: structuredClone(effect),
                  outcome: item.outcome,
                  disposition: 'late',
                });
                changed = true;
              }
              return { requestId: item.requestId, status: 'recorded-late' };
            }
            if (effect.state === item.outcome)
              return { requestId: item.requestId, status: 'already-settled' };
            effect.conflicts += 1;
            conflicts += 1;
            events.push({
              effect: structuredClone(effect),
              outcome: item.outcome,
              disposition: 'conflict',
              sequence: effect.conflicts,
            });
            changed = true;
            return { requestId: item.requestId, status: 'conflict' };
          },
        );
        if (!changed) return { result: results };
        // Settling makes effects terminal; retention applies after, not before.
        trim(ledger);
        return { result: results, next: ledger };
      });
      for (const event of events)
        audit(event.effect, event.outcome, {
          settledBy: event.disposition ? undefined : 'document',
          disposition: event.disposition,
          sequence: event.sequence,
        });
      for (let index = 0; index < conflicts; index += 1)
        options.onSettlementConflict?.();
      return results;
    },

    /**
     * LP-W. Captures the plugin's outstanding effects the change withdrew.
     * Call only after the authority change is durable, under the
     * serialization admission of that authority uses. When the plugin
     * already has an open withdrawal, this change joins it: its newly
     * captured effects and its cause are merged and the same withdrawal is
     * answered. A completed or closed withdrawal is never reopened.
     * `null` means nothing this change withdrew is outstanding.
     */
    async beginWithdrawal(input: {
      pluginId: string;
      cause: PluginCommandWithdrawalCause;
      captures(effect: {
        installationGeneration: string;
        requiresPluginServer: boolean;
      }): boolean;
    }): Promise<PluginCommandEffectsWithdrawalSummary | null> {
      const matches = (ledger: PluginCommandEffectLedger) =>
        ledger.effects.filter(
          (effect) =>
            effect.pluginId === input.pluginId &&
            effect.state === 'admitted' &&
            input.captures({
              installationGeneration: effect.installationGeneration,
              requiresPluginServer: effect.requiresPluginServer,
            }),
        );
      // Lock-free fast path. Callers are after the authority change and every
      // admission of that authority committed before it, so an empty read
      // cannot miss a capturable effect. Nothing captured, nothing recorded.
      if (matches(await store.read()).length === 0) return null;
      const withdrawal = await commit(
        (ledger): PluginCommandEffectTransaction<WithdrawalRecord | null> => {
          const matched = matches(ledger);
          if (matched.length === 0) return { result: null };
          const capturedAt = now().toISOString();
          const open = openWithdrawalFor(ledger, input.pluginId);
          if (open) {
            // An open withdrawal already holds every outstanding captured
            // effect of this plugin, so an effect is never in two.
            for (const effect of matched) {
              if (
                !open.outstanding.some(
                  (capture) => capture.effectId === effect.effectId,
                )
              )
                open.outstanding.push({
                  effectId: effect.effectId,
                  capturedAt,
                });
            }
            if (!open.causes.includes(input.cause))
              open.causes.push(input.cause);
            trim(ledger);
            return { result: structuredClone(open), next: ledger };
          }
          const record: WithdrawalRecord = {
            withdrawalId: `pcw-${randomUUID()}`,
            sequence: nextSequence(ledger),
            pluginId: input.pluginId,
            causes: [input.cause],
            createdAt: capturedAt,
            outstanding: matched.map((effect) => ({
              effectId: effect.effectId,
              capturedAt,
            })),
            settled: 0,
          };
          ledger.withdrawals.push(record);
          trim(ledger);
          return { result: structuredClone(record), next: ledger };
        },
      );
      return withdrawal ? summary(project(withdrawal)) : null;
    },

    async withdrawal(
      withdrawalId: string,
    ): Promise<PluginCommandWithdrawalProjection | null> {
      const ledger = await store.read();
      const record = ledger.withdrawals.find(
        (candidate) => candidate.withdrawalId === withdrawalId,
      );
      return record ? project(record) : null;
    },

    /** Operator view: every open withdrawal, then the most recent closed ones. */
    async listWithdrawals(): Promise<PluginCommandWithdrawalProjection[]> {
      const ledger = await store.read();
      const bySequence = (left: WithdrawalRecord, right: WithdrawalRecord) =>
        right.sequence - left.sequence;
      return [
        ...ledger.withdrawals.filter(isOpenWithdrawal).sort(bySequence),
        ...ledger.withdrawals
          .filter((withdrawal) => !isOpenWithdrawal(withdrawal))
          .sort(bySequence)
          .slice(0, PLUGIN_COMMAND_WITHDRAWAL_MAX_LISTED_EFFECTS),
      ].map(project);
    },

    /** Operator view: outstanding effects no open withdrawal captured. */
    async listUncapturedEffects(): Promise<PluginCommandUncapturedEffect[]> {
      const ledger = await store.read();
      const captured = new Set(
        ledger.withdrawals.flatMap((withdrawal) =>
          withdrawal.outstanding.map((capture) => capture.effectId),
        ),
      );
      return ledger.effects
        .filter(
          (effect) =>
            effect.state === 'admitted' && !captured.has(effect.effectId),
        )
        .sort((left, right) => left.sequence - right.sequence)
        .map((effect) => ({
          effectId: effect.effectId,
          pluginId: effect.pluginId,
          principalId: effect.principalId,
          commandId: effect.commandId,
          admittedAt: effect.admittedAt,
          abandonable:
            now().getTime() - Date.parse(effect.admittedAt) >=
            indeterminateAfterMs,
        }));
    },

    /**
     * LP-C, bounded. Callers must hold no lock: this waits for settlements.
     * Returns the status observed when nothing is outstanding or the wait ended.
     */
    async awaitWithdrawal(
      withdrawalId: string,
      waitMs: number,
    ): Promise<PluginCommandEffectsWithdrawalSummary | null> {
      const deadline = Date.now() + waitMs;
      for (;;) {
        let wake!: () => void;
        const woken = new Promise<void>((resolve) => {
          wake = resolve;
        });
        waiters.add(wake);
        try {
          const current = await service.withdrawal(withdrawalId);
          const remaining = deadline - Date.now();
          if (
            !current ||
            current.status === 'completed' ||
            current.status === 'closed-indeterminate' ||
            remaining <= 0
          )
            return current ? summary(current) : null;
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            woken,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, remaining);
            }),
          ]);
          clearTimeout(timer);
        } finally {
          waiters.delete(wake);
        }
      }
    },

    /** Operator only: accept an indeterminate withdrawal's unknown outcome. */
    async resolveWithdrawal(
      withdrawalId: string,
    ): Promise<PluginCommandWithdrawalResolveOutcome> {
      const abandoned: EffectRecord[] = [];
      const outcome = await commit(
        (
          ledger,
        ): PluginCommandEffectTransaction<PluginCommandWithdrawalResolveOutcome> => {
          const record = ledger.withdrawals.find(
            (candidate) => candidate.withdrawalId === withdrawalId,
          );
          if (!record) return { result: { kind: 'not-found' } };
          const current = project(record);
          if (current.status !== 'indeterminate')
            return {
              result: { kind: 'not-indeterminate', withdrawal: current },
            };
          let count = 0;
          for (const capture of [...record.outstanding]) {
            const effect = ledger.effects.find(
              (candidate) => candidate.effectId === capture.effectId,
            );
            if (effect?.state === 'admitted') {
              settleInLedger(ledger, effect, 'abandoned', 'operator');
              abandoned.push(structuredClone(effect));
              count += 1;
            }
          }
          record.outstanding = [];
          record.resolution = {
            disposition: 'accept-indeterminate',
            resolvedAt: now().toISOString(),
            abandoned: count,
          };
          trim(ledger);
          return {
            result: { kind: 'resolved', withdrawal: project(record) },
            next: ledger,
          };
        },
      );
      for (const effect of abandoned)
        audit(effect, 'abandoned', { settledBy: 'operator' });
      return outcome;
    },

    /**
     * Operator only: abandon one outstanding effect no withdrawal captured,
     * once it is older than the withdrawal wait.
     */
    async abandonEffect(
      effectId: string,
    ): Promise<PluginCommandEffectAbandonOutcome> {
      let abandoned: EffectRecord | undefined;
      const outcome = await commit(
        (
          ledger,
        ): PluginCommandEffectTransaction<PluginCommandEffectAbandonOutcome> => {
          const effect = ledger.effects.find(
            (candidate) => candidate.effectId === effectId,
          );
          if (effect?.state !== 'admitted')
            return { result: { kind: 'not-found' } };
          const holder = ledger.withdrawals.find((withdrawal) =>
            withdrawal.outstanding.some(
              (capture) => capture.effectId === effectId,
            ),
          );
          if (holder)
            return {
              result: { kind: 'captured', withdrawalId: holder.withdrawalId },
            };
          if (
            now().getTime() - Date.parse(effect.admittedAt) <
            indeterminateAfterMs
          )
            return { result: { kind: 'too-recent' } };
          settleInLedger(ledger, effect, 'abandoned', 'operator');
          abandoned = structuredClone(effect);
          trim(ledger);
          return { result: { kind: 'abandoned' }, next: ledger };
        },
      );
      if (abandoned) audit(abandoned, 'abandoned', { settledBy: 'operator' });
      return outcome;
    },
  };
  return Object.freeze(service);
}

export type PluginCommandEffectService = ReturnType<
  typeof createPluginCommandEffectService
>;

/** How long a lifecycle response waits, after releasing its locks, for settlements. */
const PLUGIN_COMMAND_WITHDRAWAL_RESPONSE_WAIT_MS = 2_000;

/**
 * What a lifecycle change reports about the command effects it withdrew.
 * `unavailable` means the change committed but its withdrawal could not be
 * recorded (the ledger could not be read or written); it is never completion.
 */
export type PluginCommandWithdrawalCapture =
  | { kind: 'none' }
  | { kind: 'captured'; summary: PluginCommandEffectsWithdrawalSummary }
  | { kind: 'unavailable' };

/**
 * LP-W for a lifecycle path. Call inside the serialization admission of the
 * withdrawn authority uses, after that change is durable. It never throws for
 * ledger trouble: a lifecycle change is never vetoed by effect bookkeeping.
 */
export async function withdrawPluginCommandEffects(
  projectHomeDir: string,
  input: Parameters<PluginCommandEffectService['beginWithdrawal']>[0],
): Promise<PluginCommandWithdrawalCapture> {
  try {
    const summary = await createPluginCommandEffectService({
      store: new FilePluginCommandEffectStore(projectHomeDir),
    }).beginWithdrawal(input);
    return summary ? { kind: 'captured', summary } : { kind: 'none' };
  } catch (error) {
    if (error instanceof PluginCommandEffectsUnavailableError)
      return { kind: 'unavailable' };
    throw error;
  }
}

/**
 * The command effect fields a lifecycle result and its HTTP response carry:
 * the changed plugin's own withdrawal, the withdrawals of dependencies the
 * same change removed, and whether any of them could not be recorded.
 */
export interface PluginCommandEffectResponseFields {
  commandEffects?: PluginCommandEffectsWithdrawalSummary;
  dependencyCommandEffects?: PluginCommandEffectsWithdrawalSummary[];
  commandEffectsUnavailable?: true;
}

export function pluginCommandEffectFields(
  own: PluginCommandWithdrawalCapture,
  dependencies: ReadonlyArray<
    PluginCommandEffectResponseFields | undefined
  > = [],
): PluginCommandEffectResponseFields {
  const dependencySummaries = dependencies.flatMap((fields) => [
    ...(fields?.commandEffects ? [fields.commandEffects] : []),
    ...(fields?.dependencyCommandEffects ?? []),
  ]);
  const unavailable =
    own.kind === 'unavailable' ||
    dependencies.some((fields) => fields?.commandEffectsUnavailable);
  return {
    ...(own.kind === 'captured' ? { commandEffects: own.summary } : {}),
    ...(dependencySummaries.length > 0
      ? { dependencyCommandEffects: dependencySummaries }
      : {}),
    ...(unavailable ? { commandEffectsUnavailable: true as const } : {}),
  };
}

/**
 * LP-C for a lifecycle response. The caller must hold no lock. Returns the
 * response fields and status: a success whose withdrawal still has outstanding
 * effects, or whose withdrawal could not be recorded, is 202, never 200.
 */
export async function settlePluginCommandEffectsForResponse(
  projectHomeDir: string,
  capture: PluginCommandEffectResponseFields,
  status: number,
  waitMs = PLUGIN_COMMAND_WITHDRAWAL_RESPONSE_WAIT_MS,
): Promise<{ fields: PluginCommandEffectResponseFields; status: number }> {
  const summaries = [
    ...(capture.commandEffects ? [capture.commandEffects] : []),
    ...(capture.dependencyCommandEffects ?? []),
  ];
  if (summaries.length === 0 && !capture.commandEffectsUnavailable)
    return { fields: {}, status };
  const service = createPluginCommandEffectService({
    store: new FilePluginCommandEffectStore(projectHomeDir),
  });
  const deadline = Date.now() + waitMs;
  const latest = await Promise.all(
    summaries.map(async (summary) => {
      try {
        return (
          (await service.awaitWithdrawal(
            summary.withdrawalId,
            Math.max(0, deadline - Date.now()),
          )) ?? summary
        );
      } catch {
        // The capture already committed; an unreadable ledger now leaves the
        // captured summary, which is never `completed` unless it already was.
        return summary;
      }
    }),
  );
  const parent = capture.commandEffects ? latest[0] : undefined;
  const dependencies = capture.commandEffects ? latest.slice(1) : latest;
  const incomplete =
    capture.commandEffectsUnavailable === true ||
    latest.some((summary) => summary.status !== 'completed');
  return {
    fields: {
      ...(parent ? { commandEffects: parent } : {}),
      ...(dependencies.length > 0
        ? { dependencyCommandEffects: dependencies }
        : {}),
      ...(capture.commandEffectsUnavailable
        ? { commandEffectsUnavailable: true as const }
        : {}),
    },
    status: status === 200 && incomplete ? 202 : status,
  };
}
