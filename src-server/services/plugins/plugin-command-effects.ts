import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  OPERATIONAL_EVENT_SCHEMA_VERSION,
  type OperationalEventEnvelope,
} from '@kontourai/station-contracts/operational-event';
import {
  PLUGIN_COMMAND_EFFECT_EVENT_SCHEMA,
  PLUGIN_COMMAND_EFFECT_MAX_SETTLEMENT_ITEMS,
  PLUGIN_COMMAND_EFFECT_OUTCOMES,
  PLUGIN_COMMAND_WITHDRAWAL_MAX_LISTED_EFFECTS,
  type PluginCommandEffectContent,
  type PluginCommandEffectOutcome,
  type PluginCommandEffectReceipt,
  type PluginCommandEffectRefusalReason,
  type PluginCommandEffectSettledBy,
  type PluginCommandEffectSettlementResult,
  type PluginCommandEffectState,
  type PluginCommandEffectsWithdrawalSummary,
  type PluginCommandEffectTarget,
  type PluginCommandWithdrawalCause,
  type PluginCommandWithdrawalProjection,
  type PluginCommandWithdrawalStatus,
} from '@kontourai/station-contracts/plugin-command-effect';
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
 * - LP-K: {@link PluginCommandEffectService.settle}'s atomic settlement write.
 * - LP-C: a ledger read finding every captured effect settled with proof.
 *
 * The ledger lock is always the LAST lock taken and is never held across any
 * wait other than this file's own write.
 */

export const PLUGIN_COMMAND_EFFECT_BOUNDS = Object.freeze({
  outstandingPerPlugin: 8,
  outstandingTotal: 64,
  openWithdrawals: 64,
  retainedTerminalEffects: 64,
  retainedResolvedWithdrawals: 64,
  tombstonesPerDocument: 16,
  tombstonesTotal: 256,
  storeBytes: 512 * 1024,
});

const STORE_VERSION = 1 as const;
const STORE_FILE = 'plugin-command-effects.json';
/** Client-chosen ids: opaque, bounded, and safe in logs and event payloads. */
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const DOCUMENT_KEY = /^[A-Za-z0-9_-]{32,256}$/;
const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

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

interface CaptureRecord {
  effectId: string;
  settled?: {
    outcome: PluginCommandEffectOutcome;
    settledBy: PluginCommandEffectSettledBy;
  };
}

interface WithdrawalRecord {
  withdrawalId: string;
  sequence: number;
  pluginId: string;
  cause: PluginCommandWithdrawalCause;
  createdAt: string;
  captured: CaptureRecord[];
  resolution?: { disposition: 'accept-indeterminate'; resolvedAt: string };
}

interface TombstoneRecord {
  sequence: number;
  documentId: string;
  documentKeyDigest: string;
  requestId: string;
  principalId: string;
}

export interface PluginCommandEffectLedger {
  version: typeof STORE_VERSION;
  sequence: number;
  effects: EffectRecord[];
  withdrawals: WithdrawalRecord[];
  tombstones: TombstoneRecord[];
}

const EMPTY_LEDGER: PluginCommandEffectLedger = Object.freeze({
  version: STORE_VERSION,
  sequence: 0,
  effects: [],
  withdrawals: [],
  tombstones: [],
}) as PluginCommandEffectLedger;

/** The ledger cannot be read, validated or written. Nothing was recorded. */
export class PluginCommandEffectsUnavailableError extends Error {
  constructor(message = 'Plugin command effects are unavailable') {
    super(message);
    this.name = 'PluginCommandEffectsUnavailableError';
  }
}

/** A withdrawal could not be recorded because open withdrawals are at capacity. */
export class PluginCommandWithdrawalCapacityError extends PluginCommandEffectsUnavailableError {
  constructor() {
    super(
      'Too many plugin command withdrawals are unresolved; resolve an indeterminate withdrawal first',
    );
    this.name = 'PluginCommandWithdrawalCapacityError';
  }
}

export interface PluginCommandEffectTransaction<T> {
  readonly result: T;
  /** Omit for a read-only transaction. */
  readonly next?: PluginCommandEffectLedger;
}

export interface PluginCommandEffectStore {
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
  const keys = Object.keys(value);
  return (
    required.every((field) => Object.hasOwn(value, field)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    !Number.isNaN(Date.parse(value))
  );
}

const OUTCOMES = new Set<string>(PLUGIN_COMMAND_EFFECT_OUTCOMES);
const SETTLED_BY = new Set<string>(['document', 'operator', 'station']);

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
    typeof value.effectId !== 'string' ||
    !isNonNegativeInteger(value.sequence) ||
    typeof value.documentId !== 'string' ||
    !CLIENT_ID.test(value.documentId) ||
    typeof value.documentKeyDigest !== 'string' ||
    !SHA256.test(value.documentKeyDigest) ||
    typeof value.requestId !== 'string' ||
    !CLIENT_ID.test(value.requestId) ||
    typeof value.principalId !== 'string' ||
    typeof value.pluginId !== 'string' ||
    typeof value.installationGeneration !== 'string' ||
    typeof value.requiresPluginServer !== 'boolean' ||
    typeof value.commandId !== 'string' ||
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
        'cause',
        'createdAt',
        'captured',
      ],
      ['resolution'],
    ) ||
    typeof value.withdrawalId !== 'string' ||
    !isNonNegativeInteger(value.sequence) ||
    typeof value.pluginId !== 'string' ||
    !['removal', 'update', 'grant-withdrawal'].includes(
      value.cause as string,
    ) ||
    !isTimestamp(value.createdAt) ||
    !Array.isArray(value.captured) ||
    value.captured.length > PLUGIN_COMMAND_EFFECT_BOUNDS.outstandingPerPlugin
  )
    return null;
  for (const capture of value.captured) {
    if (
      !isRecord(capture) ||
      !hasExactFields(capture, ['effectId'], ['settled']) ||
      typeof capture.effectId !== 'string'
    )
      return null;
    if (capture.settled !== undefined) {
      const settled = capture.settled;
      if (
        !isRecord(settled) ||
        !hasExactFields(settled, ['outcome', 'settledBy']) ||
        !OUTCOMES.has(settled.outcome as string) ||
        !SETTLED_BY.has(settled.settledBy as string)
      )
        return null;
    }
  }
  if (value.resolution !== undefined) {
    const resolution = value.resolution;
    if (
      !isRecord(resolution) ||
      !hasExactFields(resolution, ['disposition', 'resolvedAt']) ||
      resolution.disposition !== 'accept-indeterminate' ||
      !isTimestamp(resolution.resolvedAt)
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
    ]) ||
    !isNonNegativeInteger(value.sequence) ||
    typeof value.documentId !== 'string' ||
    !CLIENT_ID.test(value.documentId) ||
    typeof value.documentKeyDigest !== 'string' ||
    !SHA256.test(value.documentKeyDigest) ||
    typeof value.requestId !== 'string' ||
    !CLIENT_ID.test(value.requestId) ||
    typeof value.principalId !== 'string'
  )
    return null;
  return structuredClone(value) as unknown as TombstoneRecord;
}

const isOpenWithdrawal = (withdrawal: WithdrawalRecord) =>
  withdrawal.resolution === undefined &&
  withdrawal.captured.some((capture) => capture.settled === undefined);

/**
 * Strict parse plus the cross-record invariants the protocol depends on. A
 * ledger that violates one is refused whole rather than partially trusted.
 */
export function validatePluginCommandEffectLedger(
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
  const sequences = [
    ...ledger.effects,
    ...ledger.withdrawals,
    ...ledger.tombstones,
  ].map((entry) => entry.sequence);
  for (const effect of ledger.effects) {
    const request = `${effect.documentId} ${effect.requestId}`;
    if (byId.has(effect.effectId) || requests.has(request)) throw unavailable();
    byId.set(effect.effectId, effect);
    requests.add(request);
  }
  const outstanding = ledger.effects.filter(
    (effect) => effect.state === 'admitted',
  );
  const perPlugin = new Map<string, number>();
  for (const effect of outstanding)
    perPlugin.set(effect.pluginId, (perPlugin.get(effect.pluginId) ?? 0) + 1);
  const open = ledger.withdrawals.filter(isOpenWithdrawal);
  const withdrawalIds = new Set<string>();
  for (const withdrawal of ledger.withdrawals) {
    if (withdrawalIds.has(withdrawal.withdrawalId)) throw unavailable();
    withdrawalIds.add(withdrawal.withdrawalId);
    for (const capture of withdrawal.captured) {
      // An unsettled capture must still name an outstanding effect of this
      // plugin: only terminal effects are ever evicted, and a settlement
      // writes its proof into every open capture in the same transaction.
      if (capture.settled === undefined) {
        const effect = byId.get(capture.effectId);
        if (
          withdrawal.resolution !== undefined ||
          effect?.state !== 'admitted' ||
          effect.pluginId !== withdrawal.pluginId
        )
          throw unavailable();
      }
    }
  }
  if (
    outstanding.length > bounds.outstandingTotal ||
    [...perPlugin.values()].some(
      (count) => count > bounds.outstandingPerPlugin,
    ) ||
    ledger.effects.length - outstanding.length >
      bounds.retainedTerminalEffects ||
    open.length > bounds.openWithdrawals ||
    ledger.withdrawals.length - open.length >
      bounds.retainedResolvedWithdrawals ||
    ledger.tombstones.length > bounds.tombstonesTotal ||
    new Set(sequences).size !== sequences.length ||
    Math.max(0, ...sequences) > ledger.sequence
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
  readonly #file: string;
  readonly #acquireLock: typeof acquireFileMutationLockAsync;
  readonly #beforeCommit?: () => void | Promise<void>;

  constructor(
    projectHomeDir: string,
    options: FilePluginCommandEffectStoreOptions = {},
  ) {
    this.#file = join(projectHomeDir, STORE_FILE);
    this.#acquireLock = options.acquireLock ?? acquireFileMutationLockAsync;
    this.#beforeCommit = options.beforeCommit;
  }

  async read(): Promise<PluginCommandEffectLedger> {
    return this.#readLedger();
  }

  #readLedger(): PluginCommandEffectLedger {
    let value: unknown;
    try {
      value = readJsonFile(this.#file, EMPTY_LEDGER, {
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
        const next = validatePluginCommandEffectLedger(
          structuredClone(outcome.next),
        );
        try {
          await publishJsonFileWithOwnedLock(this.#file, next, {
            maxBytes: PLUGIN_COMMAND_EFFECT_BOUNDS.storeBytes,
            label: 'Plugin command effect ledger',
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
}

export type PluginCommandEffectAdmissionOutcome =
  | { kind: 'admitted'; receipt: PluginCommandEffectReceipt }
  | { kind: 'refused'; reason: PluginCommandEffectRefusalReason };

export interface PluginCommandEffectServiceOptions {
  store: PluginCommandEffectStore;
  now?: () => Date;
  /** Age after which an outstanding withdrawal reads `indeterminate`. */
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

export function createPluginCommandEffectService(
  options: PluginCommandEffectServiceOptions,
) {
  const { store } = options;
  const now = options.now ?? (() => new Date());
  const indeterminateAfterMs = options.indeterminateAfterMs ?? 60_000;
  const bounds = PLUGIN_COMMAND_EFFECT_BOUNDS;
  const waiters = new Set<() => void>();
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
    effect: Pick<
      EffectRecord,
      | 'effectId'
      | 'pluginId'
      | 'installationGeneration'
      | 'commandId'
      | 'target'
      | 'requestId'
    >,
    outcome: PluginCommandEffectState,
    settledBy?: PluginCommandEffectSettledBy,
  ): boolean => {
    if (!options.publishAudit) return true;
    try {
      return options.publishAudit({
        schemaVersion: OPERATIONAL_EVENT_SCHEMA_VERSION,
        id: `plugin-command-${effect.effectId}-${outcome}`,
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
          data: {
            effectId: effect.effectId,
            pluginId: effect.pluginId,
            installationGeneration: effect.installationGeneration,
            commandId: effect.commandId,
            target: structuredClone(effect.target),
            outcome,
            ...(settledBy ? { settledBy } : {}),
          },
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

  /** Evict only terminal effects and resolved withdrawals, oldest first. */
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
    const resolved = ledger.withdrawals
      .filter((withdrawal) => !isOpenWithdrawal(withdrawal))
      .sort((left, right) => left.sequence - right.sequence);
    const evictWithdrawals = new Set(
      resolved
        .slice(
          0,
          Math.max(0, resolved.length - bounds.retainedResolvedWithdrawals),
        )
        .map((withdrawal) => withdrawal.withdrawalId),
    );
    ledger.withdrawals = ledger.withdrawals.filter(
      (withdrawal) => !evictWithdrawals.has(withdrawal.withdrawalId),
    );
  };

  /** Settle one outstanding effect and write its proof into every open capture. */
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
      for (const capture of withdrawal.captured) {
        if (capture.effectId === effect.effectId && !capture.settled)
          capture.settled = { outcome, settledBy };
      }
    }
  };

  const project = (
    withdrawal: WithdrawalRecord,
  ): PluginCommandWithdrawalProjection => {
    const outstanding = withdrawal.captured
      .filter((capture) => capture.settled === undefined)
      .map((capture) => capture.effectId);
    const status: PluginCommandWithdrawalStatus =
      withdrawal.resolution !== undefined ||
      withdrawal.captured.some(
        (capture) => capture.settled?.settledBy === 'operator',
      )
        ? 'closed-indeterminate'
        : outstanding.length === 0
          ? 'completed'
          : now().getTime() - Date.parse(withdrawal.createdAt) <
              indeterminateAfterMs
            ? 'winding-down'
            : 'indeterminate';
    return {
      withdrawalId: withdrawal.withdrawalId,
      pluginId: withdrawal.pluginId,
      cause: withdrawal.cause,
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
     * LP-A. Idempotent on (documentId, requestId). A cancel recorded before
     * this commit makes it refuse; capacity refuses and never evicts an
     * outstanding effect.
     */
    async recordAdmission(
      input: PluginCommandEffectAdmissionRecord,
    ): Promise<PluginCommandEffectAdmissionOutcome> {
      const keyDigest = sha256(input.documentKey);
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
            const cancelled = ledger.tombstones.some(
              (tombstone) =>
                tombstone.documentId === input.documentId &&
                tombstone.requestId === input.requestId &&
                tombstone.documentKeyDigest === keyDigest &&
                tombstone.principalId === input.principalId,
            );
            if (cancelled)
              return { result: { kind: 'refused', reason: 'cancelled' } };
            const existing = ledger.effects.find(
              (effect) =>
                effect.documentId === input.documentId &&
                effect.requestId === input.requestId,
            );
            if (existing) {
              if (
                existing.documentKeyDigest !== keyDigest ||
                existing.principalId !== input.principalId ||
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
              outstanding.length >= bounds.outstandingTotal ||
              outstanding.filter((effect) => effect.pluginId === input.pluginId)
                .length >= bounds.outstandingPerPlugin
            )
              return { result: { kind: 'refused', reason: 'capacity' } };
            const effect: EffectRecord = {
              effectId: `pce-${randomUUID()}`,
              sequence: nextSequence(ledger),
              documentId: input.documentId,
              documentKeyDigest: keyDigest,
              requestId: input.requestId,
              principalId: input.principalId,
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
            trim(ledger);
            if (Buffer.byteLength(JSON.stringify(ledger)) > bounds.storeBytes)
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
      const keyDigest = sha256(input.documentKey);
      const transitioned: EffectRecord[] = [];
      let conflicts = 0;
      const results = await commit((ledger) => {
        let changed = false;
        const results = input.items.map(
          (item): PluginCommandEffectSettlementResult => {
            const effect = ledger.effects.find(
              (candidate) =>
                candidate.documentId === input.documentId &&
                candidate.requestId === item.requestId,
            );
            const owned =
              effect &&
              effect.documentKeyDigest === keyDigest &&
              effect.principalId === input.principalId &&
              (item.effectId === undefined ||
                item.effectId === effect.effectId);
            if (effect && !owned)
              return { requestId: item.requestId, status: 'not-found' };
            if (!effect) {
              if (item.outcome !== 'cancelled' || item.effectId !== undefined)
                return { requestId: item.requestId, status: 'not-found' };
              const exists = ledger.tombstones.some(
                (tombstone) =>
                  tombstone.documentId === input.documentId &&
                  tombstone.requestId === item.requestId &&
                  tombstone.documentKeyDigest === keyDigest &&
                  tombstone.principalId === input.principalId,
              );
              if (!exists) {
                ledger.tombstones.push({
                  sequence: nextSequence(ledger),
                  documentId: input.documentId,
                  documentKeyDigest: keyDigest,
                  requestId: item.requestId,
                  principalId: input.principalId,
                });
                const forDocument = ledger.tombstones.filter(
                  (tombstone) => tombstone.documentId === input.documentId,
                );
                const overDocument = new Set(
                  forDocument
                    .slice(
                      0,
                      Math.max(
                        0,
                        forDocument.length - bounds.tombstonesPerDocument,
                      ),
                    )
                    .map((tombstone) => tombstone.sequence),
                );
                ledger.tombstones = ledger.tombstones
                  .filter((tombstone) => !overDocument.has(tombstone.sequence))
                  .slice(-bounds.tombstonesTotal);
                changed = true;
              }
              return { requestId: item.requestId, status: 'cancel-recorded' };
            }
            if (effect.state === 'admitted') {
              settleInLedger(ledger, effect, item.outcome, 'document');
              transitioned.push(structuredClone(effect));
              changed = true;
              return { requestId: item.requestId, status: 'settled' };
            }
            if (effect.settledBy === 'operator') {
              if (effect.lateOutcome === undefined) {
                effect.lateOutcome = item.outcome;
                changed = true;
              }
              return { requestId: item.requestId, status: 'recorded-late' };
            }
            if (effect.state === item.outcome)
              return { requestId: item.requestId, status: 'already-settled' };
            effect.conflicts += 1;
            conflicts += 1;
            changed = true;
            return { requestId: item.requestId, status: 'conflict' };
          },
        );
        if (!changed) return { result: results };
        trim(ledger);
        return { result: results, next: ledger };
      });
      for (const effect of transitioned)
        audit(effect, effect.state, 'document');
      for (let index = 0; index < conflicts; index += 1)
        options.onSettlementConflict?.();
      return results;
    },

    /**
     * LP-W. Captures the plugin's outstanding effects the change withdrew.
     * Call only after the authority change is durable, under the
     * serialization admission of that authority uses.
     */
    async beginWithdrawal(input: {
      pluginId: string;
      cause: PluginCommandWithdrawalCause;
      captures(effect: {
        installationGeneration: string;
        requiresPluginServer: boolean;
      }): boolean;
    }): Promise<PluginCommandEffectsWithdrawalSummary> {
      const withdrawal = await commit((ledger) => {
        const captured = ledger.effects
          .filter(
            (effect) =>
              effect.pluginId === input.pluginId &&
              effect.state === 'admitted' &&
              input.captures({
                installationGeneration: effect.installationGeneration,
                requiresPluginServer: effect.requiresPluginServer,
              }),
          )
          .map((effect) => ({ effectId: effect.effectId }));
        if (
          captured.length > 0 &&
          ledger.withdrawals.filter(isOpenWithdrawal).length >=
            bounds.openWithdrawals
        )
          throw new PluginCommandWithdrawalCapacityError();
        const record: WithdrawalRecord = {
          withdrawalId: `pcw-${randomUUID()}`,
          sequence: nextSequence(ledger),
          pluginId: input.pluginId,
          cause: input.cause,
          createdAt: now().toISOString(),
          captured,
        };
        ledger.withdrawals.push(record);
        trim(ledger);
        return { result: structuredClone(record), next: ledger };
      });
      return summary(project(withdrawal));
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

    /**
     * LP-C, bounded. Callers must hold no lock: this waits for settlements.
     * Returns the status observed when every capture settled or the wait ended.
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
          for (const capture of record.captured) {
            if (capture.settled) continue;
            const effect = ledger.effects.find(
              (candidate) => candidate.effectId === capture.effectId,
            );
            if (effect?.state === 'admitted') {
              settleInLedger(ledger, effect, 'abandoned', 'operator');
              abandoned.push(structuredClone(effect));
            }
          }
          record.resolution = {
            disposition: 'accept-indeterminate',
            resolvedAt: now().toISOString(),
          };
          trim(ledger);
          return {
            result: { kind: 'resolved', withdrawal: project(record) },
            next: ledger,
          };
        },
      );
      for (const effect of abandoned) audit(effect, 'abandoned', 'operator');
      return outcome;
    },
  };
  return Object.freeze(service);
}

export type PluginCommandEffectService = ReturnType<
  typeof createPluginCommandEffectService
>;
