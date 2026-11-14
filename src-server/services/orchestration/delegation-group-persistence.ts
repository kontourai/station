import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { delegationIdV2 } from '@kontourai/flow-agents/delegation-authority-contract';
import {
  type DelegationAuthorityLedger,
  type DelegationAuthorityStore,
  validateDelegationAuthorityLedger,
} from '@kontourai/flow-agents/delegation-authority-service';
import {
  AUTHORITY_V3_MAX_BYTES,
  authorityCapacityV3,
  type DelegationAuthorityLedgerV3,
  type DelegationAuthorityStoreV3,
  validateDelegationAuthorityLedgerV3,
} from '@kontourai/flow-agents/delegation-authority-service-v3';
import {
  type DelegationRoundsJournal,
  type DelegationRoundsStore,
  delegationRoundsCapacity,
  projectDelegationRounds,
  ROUNDS_MAX_BYTES,
  ROUNDS_MAX_EVENTS,
} from '@kontourai/flow-agents/delegation-group-rounds';
import {
  type DelegationGroupJournalV2,
  type DelegationGroupStoreV2,
  delegationGroupCapacityV2,
  GROUP_V2_MAX_BYTES,
  GROUP_V2_MAX_EVENTS,
  projectDelegationGroupV2,
} from '@kontourai/flow-agents/delegation-group-v2';
import { canonicalJson } from '@kontourai/relay';
import type {
  ReportGroupInput,
  ReportGroupReference,
} from '@kontourai/station-contracts/report-group';
import { readInputRequestResponse } from '@kontourai/station-shared/input-request';
import { publishJsonFileWithOwnedLock } from '@kontourai/station-shared/json-file-storage';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { z } from 'zod/v3';
import { priceBoundedApiHistoricalRawUsage } from '../../runtime/conversation/bounded-api-provider-contract.js';
import type { ReservedProviderEvidence } from '../../runtime/conversation/reserved-provider-fetch.js';
import {
  type HomeWriterLease,
  HomeWriterOwner,
} from '../ssh/home-writer-owner.js';
import {
  assertReportInputTransition,
  type ReportInputStore,
  reportInputDigest,
  reportInputKey,
  reportInputRecordSchema,
} from './report-input-ledger.js';
import {
  type ReportAccountingRecoveryIntent,
  reportAccountingRecoveryIntentSchema,
} from './station-report-accounting-recovery.js';
import {
  type StationReportAdmission,
  validateStationReportAdmission,
} from './station-report-group-admission.js';
import {
  type ReportContinuationTurn,
  type ReportInterruptRecord,
  reportContinuationTurnLedgerSchema,
  reportContinuationTurnSchema,
  reportInterruptLedgerSchema,
  reportInterruptRecordSchema,
} from './station-report-group-cancellation.js';
import {
  encodeReportIntent,
  parseStationReportGroupInput,
  REPORT_INTENT_DOMAIN,
} from './station-report-group-input.js';
import { reportTerminalWitnessSchema } from './station-report-terminal-witness.js';

const reportObservationId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const reportEvidenceReference = z
  .object({
    id: reportObservationId,
    domain: z.literal('station.provider-evidence'),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();
const reportObservationSchema = z
  .object({
    groupId: reportObservationId,
    seatId: reportObservationId,
    invocationId: reportObservationId,
    observation: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('result'),
          evidence: reportEvidenceReference,
          inputReceipt: z
            .object({
              id: reportObservationId,
              domain: z.literal('station.report-input.v1'),
              digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
            })
            .strict()
            .optional(),
          text: z.string().max(1024 * 1024),
          modelId: z.string().min(1).max(512),
          inputTokens: z.number().int().nonnegative().safe(),
          outputTokens: z.number().int().nonnegative().safe(),
          costMicros: z.number().int().nonnegative().safe(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('failure'),
          code: z.literal('report_attempt_unavailable'),
        })
        .strict(),
      z
        .object({
          kind: z.literal('terminal'),
          evidence: reportEvidenceReference,
          taskId: reportObservationId,
          sessionId: reportObservationId,
          turnId: reportObservationId,
          eventId: reportObservationId,
          witness: reportTerminalWitnessSchema.optional(),
          recipient: z
            .object({
              id: reportObservationId,
              domain: z.literal('station.report-flow-observation.v1'),
              digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((record, context) => {
    const observation = record.observation;
    if (observation.kind !== 'terminal' || !observation.witness) return;
    const witness = observation.witness.data;
    if (
      witness.groupId !== record.groupId ||
      witness.seatId !== record.seatId ||
      witness.invocationId !== record.invocationId ||
      canonicalJson(witness.evidence) !== canonicalJson(observation.evidence) ||
      witness.terminal.conversationId !== observation.taskId ||
      witness.terminal.sessionId !== observation.sessionId ||
      witness.terminal.turnId !== observation.turnId ||
      witness.terminal.terminalEventId !== observation.eventId
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Report terminal witness identity mismatch',
      });
  });
export type StationReportObservation = z.infer<typeof reportObservationSchema>;
const reportObservationFile = (
  groupId: string,
  invocationId: string,
  kind: StationReportObservation['observation']['kind'],
) =>
  address(
    `observation:${createHash('sha256')
      .update(canonicalJson([groupId, invocationId, kind]))
      .digest('hex')}`,
  );
const reportRecoveryFile = (groupId: string, operationKey: string) =>
  `${createHash('sha256')
    .update(
      canonicalJson([
        'station.report-accounting-recovery.v1',
        groupId,
        operationKey,
      ]),
    )
    .digest('hex')}.json`;

export type DelegationPersistenceFinalizer = () => undefined;
const AUTHORITY_MAX_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 1024;
const MAX_USAGE_BYTES =
  Buffer.byteLength(
    canonicalJson({
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: Number.MAX_SAFE_INTEGER,
      costMicros: Number.MAX_SAFE_INTEGER,
    }),
  ) - Buffer.byteLength('null');

export class DelegationPersistenceError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function requirePersistence(
  condition: unknown,
  code: string,
): asserts condition {
  if (!condition) throw new DelegationPersistenceError(code);
}
function assertCurrent(finalizeCurrent: DelegationPersistenceFinalizer): void {
  const result: unknown = finalizeCurrent();
  if (result !== undefined) void Promise.resolve(result).catch(() => {});
  requirePersistence(
    result === undefined,
    'delegation_finalizer_must_be_synchronous',
  );
}
function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
function address(id: string): string {
  delegationIdV2(id);
  return `${createHash('sha256').update(id).digest('hex')}.json`;
}
function privateDirectory(path: string): void {
  const stat = lstatSync(path);
  requirePersistence(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid?.() &&
      (stat.mode & 0o7777) === 0o700,
    'delegation_private_directory_required',
  );
}
function syncDirectory(path: string): void {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Bounded fd read: a present corrupt/aliased record never becomes an absent ledger. */
function readBytes(
  path: string,
  limit: number,
  directoryFence: 'immediate' | 'domain-return' = 'immediate',
): string | null {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    requirePersistence(
      stat.isFile() &&
        stat.nlink === 1 &&
        stat.uid === process.getuid?.() &&
        (stat.mode & 0o7777) === 0o600 &&
        stat.size <= limit,
      'delegation_unsafe_record',
    );
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= limit) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      chunks.push(chunk.subarray(0, count));
      total += count;
    }
    requirePersistence(total <= limit, 'delegation_record_too_large');
    fsyncSync(fd);
    // Read-only snapshots retain their directory fence in PrivateDomain.locked.
    if (directoryFence === 'immediate') syncDirectory(dirname(path));
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } finally {
    closeSync(fd);
  }
}

class PrivateDomain {
  readonly root: string;
  readonly directory: string;
  readonly lock: string;
  constructor(root: string, name: string, lockName = name) {
    this.root = root;
    this.directory = join(root, name);
    this.lock = join(root, `${lockName}.mutation`);
  }
  check(): void {
    privateDirectory(this.root);
    privateDirectory(this.directory);
  }
  async locked<T>(
    finalizeCurrent: DelegationPersistenceFinalizer,
    body: () => Promise<T>,
  ): Promise<T> {
    assertCurrent(finalizeCurrent);
    privateDirectory(this.root);
    try {
      mkdirSync(this.directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    this.check();
    const release = await acquireFileMutationLockAsync(this.lock);
    let result: T;
    try {
      assertCurrent(finalizeCurrent);
      this.check();
      result = await body();
      this.check();
      syncDirectory(this.directory);
      syncDirectory(this.root);
      syncDirectory(dirname(this.root));
      assertCurrent(finalizeCurrent);
    } finally {
      await release();
    }
    // Replay/read results are disclosed only to the still-current actual request.
    assertCurrent(finalizeCurrent);
    return result;
  }
  filesIfPresent(): string[] {
    try {
      return this.files();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  files(): string[] {
    this.check();
    const files = readdirSync(this.directory)
      .filter((file) => /^[a-f0-9]{64}\.json$/.test(file))
      .sort();
    requirePersistence(files.length <= MAX_FILES, 'delegation_store_capacity');
    return files;
  }
  async publish(
    file: string,
    value: unknown,
    maxBytes: number,
    finalizeCurrent: DelegationPersistenceFinalizer,
    commitWithin?: (commit: () => void) => void,
  ): Promise<void> {
    this.check();
    assertCurrent(finalizeCurrent);
    await publishJsonFileWithOwnedLock(join(this.directory, file), value, {
      maxBytes,
      indent: null,
      trailingNewline: true,
      commitWithin,
      beforeCommit: () => {
        this.check();
        assertCurrent(finalizeCurrent);
      },
      finalizeCommit: () => {
        this.check();
        assertCurrent(finalizeCurrent);
        return undefined;
      },
    });
    this.check();
    assertCurrent(finalizeCurrent);
  }
}

/**
 * Host persistence only; Flow owns issuance, narrowing, budgets and group transitions.
 * One exclusive root per host. Never mix this domain with upstream local-store writers.
 * Report rounds use home -> group -> authority; authority callbacks must not re-enter group storage.
 */
export class StationDelegationPersistence {
  readonly #homeDir?: string;
  readonly #root: string;
  readonly #authorities: PrivateDomain;
  readonly #groups: PrivateDomain;
  readonly #providerEvidence: PrivateDomain;
  readonly #roundsAuthorities: PrivateDomain;
  readonly #rounds: PrivateDomain;
  readonly #reportAdmissions: PrivateDomain;
  readonly #reportIntents: PrivateDomain;
  readonly #reportInterrupts: PrivateDomain;
  readonly #reportContinuationTurns: PrivateDomain;
  readonly #reportObservations: PrivateDomain;
  readonly #reportRecoveries: PrivateDomain;
  readonly #flowObservations: PrivateDomain;
  readonly #reportInputs: PrivateDomain;
  constructor(privateRoot: string, options?: { homeDir: string }) {
    this.#homeDir = options?.homeDir;
    const requested = resolve(privateRoot);
    privateDirectory(requested);
    const root = join(realpathSync(dirname(requested)), basename(requested));
    this.#root = root;
    privateDirectory(root);
    if (this.#homeDir)
      requirePersistence(
        realpathSync(this.#homeDir) === dirname(root) &&
          basename(root) === 'report-groups',
        'delegation_home_custody_mismatch',
      );
    this.#authorities = new PrivateDomain(
      root,
      'station-delegation-authorities',
    );
    this.#groups = new PrivateDomain(root, 'station-delegation-groups');
    this.#roundsAuthorities = new PrivateDomain(
      root,
      'station-rounds-authorities-v3',
      'station-delegation-authorities',
    );
    this.#rounds = new PrivateDomain(
      root,
      'station-delegation-rounds',
      'station-delegation-groups',
    );
    this.#reportAdmissions = new PrivateDomain(
      root,
      'station-report-admissions-v1',
    );
    this.#reportIntents = new PrivateDomain(root, 'station-report-intents-v1');
    this.#reportContinuationTurns = new PrivateDomain(
      root,
      'station-report-continuation-turns-v1',
    );
    this.#reportInterrupts = new PrivateDomain(
      root,
      'station-report-interrupts-v1',
    );
    this.#reportObservations = new PrivateDomain(
      root,
      'station-report-observations-v1',
    );
    this.#reportRecoveries = new PrivateDomain(
      root,
      'station-report-accounting-recoveries-v1',
    );
    this.#flowObservations = new PrivateDomain(
      root,
      'station-report-flow-observations-v1',
    );
    this.#reportInputs = new PrivateDomain(root, 'station-report-input-v1');
    this.#providerEvidence = new PrivateDomain(
      root,
      'station-provider-evidence',
    );
  }

  async #roundsLifetime<T>(
    body: (commitWithin?: (commit: () => void) => void) => Promise<T>,
    existing?: { owner: HomeWriterOwner; lease: HomeWriterLease },
  ): Promise<T> {
    if (existing) {
      requirePersistence(
        existing.owner.homeDir === dirname(this.#root) &&
          basename(this.#root) === 'report-groups',
        'delegation_home_custody_mismatch',
      );
      existing.owner.runWithLease(existing.lease, () => undefined);
      return body((commit) =>
        existing.owner.runWithLease(existing.lease, commit),
      );
    }
    if (!this.#homeDir) return body();
    const owner = await HomeWriterOwner.forHome(this.#homeDir);
    return owner.runLifetime(() =>
      body((commit) => owner.runSynchronous(commit)),
    );
  }

  reportInputStore(current: DelegationPersistenceFinalizer): ReportInputStore {
    const domain = this.#reportInputs;
    const maxBytes = 64 * 1024;
    const read = (key: string) => {
      requirePersistence(
        /^[a-f0-9]{64}$/.test(key),
        'report_input_key_invalid',
      );
      const bytes = readBytes(join(domain.directory, `${key}.json`), maxBytes);
      if (bytes === null) return null;
      const record = reportInputRecordSchema.parse(JSON.parse(bytes));
      requirePersistence(
        reportInputKey(record.binding) === key,
        'report_input_key_mismatch',
      );
      return record;
    };
    return {
      transact: (key, update) =>
        domain.locked(current, async () => {
          const previous = read(key);
          const next = update(previous && structuredClone(previous));
          const record = reportInputRecordSchema.parse(next.record);
          requirePersistence(
            reportInputKey(record.binding) === key,
            'report_input_key_mismatch',
          );
          assertReportInputTransition(previous, record);
          if (!previous)
            requirePersistence(
              domain.files().length < MAX_FILES,
              'report_input_capacity',
            );
          await domain.publish(`${key}.json`, record, maxBytes, current);
          requirePersistence(
            same(read(key), record),
            'report_input_commit_unconfirmed',
          );
          return next.result;
        }),
    };
  }

  async readReportInputReceipt(
    reference: ReportGroupReference,
    scope: {
      groupId: string;
      invocationId: string;
      seatId: string;
      threadId: string;
      turnId?: string;
    },
    current: DelegationPersistenceFinalizer,
  ) {
    const ref = structuredClone(reference),
      expected = structuredClone(scope);
    const key = reportInputKey(expected);
    requirePersistence(
      ref.domain === 'station.report-input.v1' &&
        ref.id === key &&
        /^sha256:[a-f0-9]{64}$/.test(ref.digest),
      'report_input_reference_mismatch',
    );
    const domain = this.#reportInputs;
    return domain.locked(current, async () => {
      const bytes = readBytes(join(domain.directory, `${key}.json`), 64 * 1024);
      requirePersistence(bytes !== null, 'report_input_unavailable');
      const record = reportInputRecordSchema.parse(JSON.parse(bytes));
      requirePersistence(
        record.binding.groupId === expected.groupId &&
          record.binding.invocationId === expected.invocationId &&
          record.binding.seatId === expected.seatId &&
          record.binding.threadId === expected.threadId &&
          (expected.turnId === undefined ||
            record.binding.turnId === expected.turnId) &&
          reportInputDigest(record) === ref.digest,
        'report_input_reference_mismatch',
      );
      const response = readInputRequestResponse(record.result);
      requirePersistence(response, 'report_input_unavailable');
      return structuredClone({
        binding: record.binding,
        question: record.question,
        response,
      });
    });
  }

  async retainReportFlowObservation(
    groupId: string,
    kind:
      | 'schedule'
      | 'member'
      | 'evaluation'
      | 'recipient'
      | 'context'
      | 'continuation',
    value: unknown,
    finalizeCurrent: DelegationPersistenceFinalizer,
  ) {
    delegationIdV2(groupId);
    const record = { version: 1, groupId, kind, value: structuredClone(value) };
    const serialized = canonicalJson(record);
    const maxBytes = kind === 'context' ? 512 * 1024 : 128 * 1024;
    requirePersistence(
      Buffer.byteLength(serialized) <= maxBytes,
      'report_flow_observation_too_large',
    );
    const digest = createHash('sha256').update(serialized).digest('hex');
    const domain = this.#flowObservations;
    const file = `${digest}.json`;
    return domain.locked(finalizeCurrent, async () => {
      const bytes = readBytes(join(domain.directory, file), maxBytes);
      if (bytes !== null)
        requirePersistence(
          same(JSON.parse(bytes), record),
          'report_flow_observation_conflict',
        );
      else {
        requirePersistence(
          domain.files().length < MAX_FILES,
          'report_flow_observation_capacity',
        );
        await domain.publish(file, record, maxBytes, finalizeCurrent);
      }
      const confirmed = readBytes(join(domain.directory, file), maxBytes);
      requirePersistence(
        confirmed !== null && same(JSON.parse(confirmed), record),
        'report_flow_observation_unconfirmed',
      );
      return {
        id: digest,
        domain: 'station.report-flow-observation.v1' as const,
        digest: `sha256:${digest}`,
      };
    });
  }

  async readReportFlowObservation(
    groupId: string,
    reference: ReportGroupReference,
    finalizeCurrent: DelegationPersistenceFinalizer,
  ) {
    const expected = structuredClone(reference);
    requirePersistence(
      expected.domain === 'station.report-flow-observation.v1' &&
        /^[a-f0-9]{64}$/.test(expected.id) &&
        expected.digest === `sha256:${expected.id}`,
      'report_flow_observation_reference_invalid',
    );
    const domain = this.#flowObservations;
    return domain.locked(finalizeCurrent, async () => {
      const bytes = readBytes(
        join(domain.directory, `${expected.id}.json`),
        512 * 1024,
      );
      requirePersistence(bytes !== null, 'report_flow_observation_missing');
      const record = z
        .object({
          version: z.literal(1),
          groupId: reportObservationId,
          kind: z.enum([
            'schedule',
            'member',
            'evaluation',
            'recipient',
            'context',
            'continuation',
          ]),
          value: z.unknown(),
        })
        .strict()
        .parse(JSON.parse(bytes));
      requirePersistence(
        Buffer.byteLength(bytes) <=
          (record.kind === 'context' ? 512 * 1024 : 128 * 1024),
        'report_flow_observation_too_large',
      );
      requirePersistence(
        record.groupId === groupId &&
          createHash('sha256').update(canonicalJson(record)).digest('hex') ===
            expected.id,
        'report_flow_observation_reference_mismatch',
      );
      assertCurrent(finalizeCurrent);
      return record;
    });
  }

  /** Retain exact canonical continuation receipt bytes under group-bound custody. */
  async retainReportContinuation(
    groupId: string,
    value: unknown,
    current: DelegationPersistenceFinalizer,
  ) {
    delegationIdV2(groupId);
    const valueBytes = canonicalJson(value);
    requirePersistence(
      Buffer.byteLength(valueBytes) <= 128 * 1024,
      'report_flow_observation_too_large',
    );
    const record = {
      version: 1,
      groupId,
      kind: 'continuation-receipt',
      value: JSON.parse(valueBytes),
    };
    const recordBytes = canonicalJson(record);
    const id = createHash('sha256').update(recordBytes).digest('hex');
    const digest = createHash('sha256').update(valueBytes).digest('hex');
    const domain = this.#flowObservations;
    return domain.locked(current, async () => {
      const file = `${id}.json`;
      const existing = readBytes(join(domain.directory, file), 256 * 1024);
      if (existing === null) {
        requirePersistence(
          domain.files().length < MAX_FILES,
          'report_flow_observation_capacity',
        );
        await domain.publish(file, record, 256 * 1024, current);
      } else
        requirePersistence(
          canonicalJson(JSON.parse(existing)) === recordBytes,
          'report_flow_observation_conflict',
        );
      const confirmed = readBytes(join(domain.directory, file), 256 * 1024);
      requirePersistence(
        confirmed !== null &&
          canonicalJson(JSON.parse(confirmed)) === recordBytes,
        'report_flow_observation_unconfirmed',
      );
      assertCurrent(current);
      return {
        id,
        domain: 'station.report-continuation.v1' as const,
        digest: `sha256:${digest}`,
      };
    });
  }

  async loadReportContinuation(
    groupId: string,
    reference: ReportGroupReference,
    current: DelegationPersistenceFinalizer,
  ): Promise<string> {
    delegationIdV2(groupId);
    const expected = structuredClone(reference);
    requirePersistence(
      expected.domain === 'station.report-continuation.v1' &&
        /^[a-f0-9]{64}$/.test(expected.id) &&
        /^sha256:[a-f0-9]{64}$/.test(expected.digest),
      'report_flow_observation_reference_invalid',
    );
    const domain = this.#flowObservations;
    return domain.locked(current, async () => {
      const bytes = readBytes(
        join(domain.directory, `${expected.id}.json`),
        256 * 1024,
        'domain-return',
      );
      requirePersistence(bytes !== null, 'report_flow_observation_missing');
      const record = z
        .object({
          version: z.literal(1),
          groupId: reportObservationId,
          kind: z.literal('continuation-receipt'),
          value: z.unknown(),
        })
        .strict()
        .parse(JSON.parse(bytes));
      const recordBytes = canonicalJson(record);
      const valueBytes = canonicalJson(record.value);
      requirePersistence(
        record.groupId === groupId &&
          Buffer.byteLength(valueBytes) <= 128 * 1024 &&
          createHash('sha256').update(recordBytes).digest('hex') ===
            expected.id &&
          `sha256:${createHash('sha256').update(valueBytes).digest('hex')}` ===
            expected.digest,
        'report_flow_observation_reference_mismatch',
      );
      assertCurrent(current);
      return valueBytes;
    });
  }

  async retainReportContext(
    groupId: string,
    text: string,
    current: DelegationPersistenceFinalizer,
  ) {
    requirePersistence(
      typeof text === 'string' && Buffer.byteLength(text) <= 65_536,
      'report_context_too_large',
    );
    const retained = await this.retainReportFlowObservation(
      groupId,
      'context',
      text,
      current,
    );
    return {
      domain: 'station.report-context.v1',
      id: retained.id,
      digest: `sha256:${createHash('sha256').update(text).digest('hex')}`,
    };
  }

  async readReportContext(
    groupId: string,
    reference: ReportGroupReference,
    current: DelegationPersistenceFinalizer,
  ) {
    const expected = structuredClone(reference);
    requirePersistence(
      expected.domain === 'station.report-context.v1',
      'report_context_reference_invalid',
    );
    const record = await this.readReportFlowObservation(
      groupId,
      {
        ...expected,
        domain: 'station.report-flow-observation.v1',
        digest: `sha256:${expected.id}`,
      },
      current,
    );
    requirePersistence(
      record.kind === 'context' &&
        typeof record.value === 'string' &&
        Buffer.byteLength(record.value) <= 65_536 &&
        `sha256:${createHash('sha256').update(record.value).digest('hex')}` ===
          expected.digest,
      'report_context_reference_mismatch',
    );
    return record.value;
  }

  async retainReportObservation(
    value: StationReportObservation,
    finalizeCurrent: DelegationPersistenceFinalizer,
  ) {
    const record = reportObservationSchema.parse(value);
    const domain = this.#reportObservations;
    const file = reportObservationFile(
      record.groupId,
      record.invocationId,
      record.observation.kind,
    );
    return domain.locked(finalizeCurrent, async () => {
      const bytes = readBytes(join(domain.directory, file), 2 * 1024 * 1024);
      if (bytes !== null)
        requirePersistence(
          same(reportObservationSchema.parse(JSON.parse(bytes)), record),
          'report_observation_conflict',
        );
      else {
        requirePersistence(
          domain.files().length < MAX_FILES,
          'report_observation_capacity',
        );
        await domain.publish(file, record, 2 * 1024 * 1024, finalizeCurrent);
      }
      const confirmed = readBytes(
        join(domain.directory, file),
        2 * 1024 * 1024,
      );
      requirePersistence(
        confirmed !== null &&
          same(reportObservationSchema.parse(JSON.parse(confirmed)), record),
        'report_observation_unconfirmed',
      );
      return {
        domain: 'station.report-observation.v1',
        id: file.slice(0, -5),
        digest: `sha256:${createHash('sha256').update(canonicalJson(record)).digest('hex')}`,
      };
    });
  }

  async retainReportAccountingRecovery(
    value: ReportAccountingRecoveryIntent,
    current: DelegationPersistenceFinalizer,
  ) {
    const record = reportAccountingRecoveryIntentSchema.parse(value);
    const file = reportRecoveryFile(
      record.data.groupId,
      record.data.operationKey,
    );
    const domain = this.#reportRecoveries;
    return domain.locked(current, async () => {
      const previous = readBytes(join(domain.directory, file), 128 * 1024);
      if (previous !== null)
        requirePersistence(
          same(
            reportAccountingRecoveryIntentSchema.parse(JSON.parse(previous)),
            record,
          ),
          'report_recovery_intent_conflict',
        );
      else {
        requirePersistence(
          domain.files().length < MAX_FILES,
          'report_recovery_capacity',
        );
        await domain.publish(file, record, 128 * 1024, current);
      }
      const bytes = readBytes(join(domain.directory, file), 128 * 1024);
      requirePersistence(
        bytes !== null &&
          same(
            reportAccountingRecoveryIntentSchema.parse(JSON.parse(bytes)),
            record,
          ),
        'report_recovery_intent_unconfirmed',
      );
      return {
        id: file.slice(0, -5),
        domain: 'station.report-accounting-recovery.v1',
        digest: `sha256:${createHash('sha256').update(canonicalJson(record)).digest('hex')}`,
      };
    });
  }

  async readReportAccountingRecovery(
    groupId: string,
    operationKey: string,
    current: DelegationPersistenceFinalizer,
  ): Promise<ReportAccountingRecoveryIntent | null> {
    reportObservationId.parse(groupId);
    reportObservationId.parse(operationKey);
    return this.#reportRecoveries.locked(current, async () => {
      const bytes = readBytes(
        join(
          this.#reportRecoveries.directory,
          reportRecoveryFile(groupId, operationKey),
        ),
        128 * 1024,
      );
      if (bytes === null) return null;
      const record = reportAccountingRecoveryIntentSchema.parse(
        JSON.parse(bytes),
      );
      requirePersistence(
        record.data.groupId === groupId &&
          record.data.operationKey === operationKey,
        'report_recovery_intent_mismatch',
      );
      return record;
    });
  }

  async readReportResultByInvocation(
    groupId: string,
    invocationId: string,
    current: DelegationPersistenceFinalizer,
  ) {
    const record = await this.findReportObservationByInvocation(
      groupId,
      invocationId,
      'result',
      current,
    );
    requirePersistence(record !== null, 'report_observation_missing');
    return record;
  }

  async findReportObservationByInvocation(
    groupId: string,
    invocationId: string,
    kind: StationReportObservation['observation']['kind'],
    current: DelegationPersistenceFinalizer,
  ): Promise<StationReportObservation | null> {
    reportObservationId.parse(groupId);
    reportObservationId.parse(invocationId);
    return this.#reportObservations.locked(current, async () => {
      const bytes = readBytes(
        join(
          this.#reportObservations.directory,
          reportObservationFile(groupId, invocationId, kind),
        ),
        2 * 1024 * 1024,
      );
      if (bytes === null) return null;
      const record = reportObservationSchema.parse(JSON.parse(bytes));
      requirePersistence(
        record.groupId === groupId &&
          record.invocationId === invocationId &&
          record.observation.kind === kind,
        'report_observation_reference_mismatch',
      );
      assertCurrent(current);
      return record;
    });
  }

  async readReportObservation(
    groupId: string,
    invocationId: string,
    reference: { id: string; domain: string; digest: string },
    finalizeCurrent: DelegationPersistenceFinalizer,
  ) {
    requirePersistence(
      reference.domain === 'station.report-observation.v1' &&
        /^[a-f0-9]{64}$/.test(reference.id),
      'report_observation_reference_invalid',
    );
    const domain = this.#reportObservations;
    return domain.locked(finalizeCurrent, async () => {
      const bytes = readBytes(
        join(domain.directory, `${reference.id}.json`),
        2 * 1024 * 1024,
      );
      requirePersistence(bytes !== null, 'report_observation_missing');
      const record = reportObservationSchema.parse(JSON.parse(bytes));
      requirePersistence(
        record.groupId === groupId &&
          record.invocationId === invocationId &&
          reference.digest ===
            `sha256:${createHash('sha256').update(canonicalJson(record)).digest('hex')}`,
        'report_observation_reference_mismatch',
      );
      assertCurrent(finalizeCurrent);
      return record;
    });
  }

  async retainReportContinuationTurn(
    value: ReportContinuationTurn,
    current: DelegationPersistenceFinalizer,
  ) {
    const record = reportContinuationTurnSchema.parse(value);
    const domain = this.#reportContinuationTurns;
    return domain.locked(current, async () => {
      const file = address(record.intent.groupId);
      const bytes = readBytes(join(domain.directory, file), 256 * 1024);
      const ledger =
        bytes === null
          ? {
              version: 1 as const,
              groupId: record.intent.groupId,
              entries: [] as ReportContinuationTurn[],
            }
          : reportContinuationTurnLedgerSchema.parse(JSON.parse(bytes));
      requirePersistence(
        ledger.groupId === record.intent.groupId,
        'report_continuation_group_conflict',
      );
      const prior = ledger.entries.find(
        (e) => e.intent.invocationId === record.intent.invocationId,
      );
      if (prior) {
        requirePersistence(
          same(prior, record),
          'report_continuation_turn_conflict',
        );
        return prior;
      }
      requirePersistence(
        ledger.entries.length < 128 &&
          (bytes !== null || domain.files().length < 128),
        'report_continuation_turn_capacity',
      );
      ledger.entries.push(record);
      await domain.publish(
        file,
        reportContinuationTurnLedgerSchema.parse(ledger),
        256 * 1024,
        current,
      );
      const confirmed = readBytes(join(domain.directory, file), 256 * 1024);
      requirePersistence(
        confirmed !== null &&
          same(
            reportContinuationTurnLedgerSchema.parse(JSON.parse(confirmed)),
            ledger,
          ),
        'report_continuation_turn_unconfirmed',
      );
      return record;
    });
  }

  async readReportContinuationTurn(
    groupId: string,
    invocationId: string,
    current: DelegationPersistenceFinalizer,
  ) {
    delegationIdV2(groupId);
    delegationIdV2(invocationId);
    const domain = this.#reportContinuationTurns;
    return domain.locked(current, async () => {
      const bytes = readBytes(
        join(domain.directory, address(groupId)),
        256 * 1024,
      );
      if (bytes === null) return null;
      const ledger = reportContinuationTurnLedgerSchema.parse(
        JSON.parse(bytes),
      );
      requirePersistence(
        ledger.groupId === groupId,
        'report_continuation_group_conflict',
      );
      return (
        ledger.entries.find((e) => e.intent.invocationId === invocationId) ??
        null
      );
    });
  }

  async recordReportInterrupt(
    value: ReportInterruptRecord,
    finalizeCurrent: DelegationPersistenceFinalizer,
    issue: () => Promise<ReportInterruptRecord>,
    publication?: <Value>(
      body: (current: DelegationPersistenceFinalizer) => Promise<Value>,
    ) => Promise<Value>,
  ) {
    const intent = reportInterruptRecordSchema.parse(value);
    requirePersistence(
      intent.acknowledgement === null,
      'report_interrupt_intent_required',
    );
    const domain = this.#reportInterrupts,
      file = address(intent.intent.groupId);
    const publish = <Value>(
      body: (current: DelegationPersistenceFinalizer) => Promise<Value>,
    ) => (publication ? publication(body) : body(finalizeCurrent));
    const claimed = await publish((current) =>
      domain.locked(current, async () => {
        const bytes = readBytes(join(domain.directory, file), 128 * 1024);
        const ledger =
          bytes === null
            ? {
                version: 1 as const,
                groupId: intent.intent.groupId,
                entries: [] as ReportInterruptRecord[],
              }
            : reportInterruptLedgerSchema.parse(JSON.parse(bytes));
        requirePersistence(
          ledger.groupId === intent.intent.groupId,
          'report_interrupt_group_conflict',
        );
        const prior = ledger.entries.find(
          (entry) =>
            entry.intent.seatId === intent.intent.seatId &&
            entry.intent.clientTurnId === intent.intent.clientTurnId,
        );
        if (prior) {
          requirePersistence(
            same(prior.intent, intent.intent),
            'report_interrupt_identity_conflict',
          );
          return { record: prior, replayed: true };
        }
        requirePersistence(
          ledger.entries.length < 128 &&
            (bytes !== null || domain.files().length < 128),
          'report_interrupt_capacity',
        );
        ledger.entries.push(intent);
        await domain.publish(
          file,
          reportInterruptLedgerSchema.parse(ledger),
          128 * 1024,
          current,
        );
        const retained = readBytes(join(domain.directory, file), 128 * 1024);
        requirePersistence(
          retained !== null &&
            same(
              reportInterruptLedgerSchema.parse(JSON.parse(retained)),
              ledger,
            ),
          'report_interrupt_intent_unconfirmed',
        );
        return { record: intent, replayed: false };
      }),
    );
    if (claimed.replayed) return claimed;
    if (!publication) assertCurrent(finalizeCurrent);
    const acknowledged = reportInterruptRecordSchema.parse(await issue());
    requirePersistence(
      same(acknowledged.intent, intent.intent) &&
        acknowledged.acknowledgement !== null,
      'report_interrupt_ack_invalid',
    );
    return publish((current) =>
      domain.locked(current, async () => {
        const bytes = readBytes(join(domain.directory, file), 128 * 1024);
        requirePersistence(
          bytes !== null,
          'report_interrupt_intent_unconfirmed',
        );
        const ledger = reportInterruptLedgerSchema.parse(JSON.parse(bytes));
        requirePersistence(
          ledger.groupId === intent.intent.groupId,
          'report_interrupt_group_conflict',
        );
        const index = ledger.entries.findIndex(
          (entry) =>
            entry.intent.seatId === intent.intent.seatId &&
            entry.intent.clientTurnId === intent.intent.clientTurnId,
        );
        requirePersistence(
          index >= 0 && same(ledger.entries[index], intent),
          'report_interrupt_intent_changed',
        );
        ledger.entries[index] = acknowledged;
        await domain.publish(file, ledger, 128 * 1024, current);
        const confirmed = readBytes(join(domain.directory, file), 128 * 1024);
        requirePersistence(
          confirmed !== null &&
            same(
              reportInterruptLedgerSchema.parse(JSON.parse(confirmed)),
              ledger,
            ),
          'report_interrupt_ack_unconfirmed',
        );
        return { record: acknowledged, replayed: false };
      }),
    );
  }

  async readReportInterrupt(
    groupId: string,
    seatId: string,
    finalizeCurrent: DelegationPersistenceFinalizer,
    clientTurnId?: string,
  ) {
    const domain = this.#reportInterrupts,
      file = address(groupId);
    return domain.locked(finalizeCurrent, async () => {
      const bytes = readBytes(join(domain.directory, file), 128 * 1024);
      if (bytes === null) return null;
      const ledger = reportInterruptLedgerSchema.parse(JSON.parse(bytes));
      requirePersistence(
        ledger.groupId === groupId,
        'report_interrupt_group_conflict',
      );
      return (
        ledger.entries.find(
          (entry) =>
            entry.intent.seatId === seatId &&
            (clientTurnId === undefined ||
              entry.intent.clientTurnId === clientTurnId),
        ) ?? null
      );
    });
  }

  async retainReportIntent(
    groupId: string,
    input: ReportGroupInput,
    finalizeCurrent: DelegationPersistenceFinalizer,
  ) {
    const encoded = encodeReportIntent(groupId, input);
    requirePersistence(
      Buffer.byteLength(encoded.serialized) <= 512 * 1024,
      'report_intent_too_large',
    );
    const domain = this.#reportIntents;
    return domain.locked(finalizeCurrent, async () => {
      const file = `${encoded.reference.id}.json`;
      const before = readBytes(join(domain.directory, file), 512 * 1024);
      if (before !== null)
        requirePersistence(
          same(JSON.parse(before), encoded.record),
          'report_intent_conflict',
        );
      else {
        requirePersistence(
          domain.files().length < 128,
          'report_intent_capacity',
        );
        await domain.publish(file, encoded.record, 512 * 1024, finalizeCurrent);
      }
      const confirmed = readBytes(join(domain.directory, file), 512 * 1024);
      requirePersistence(
        confirmed !== null && same(JSON.parse(confirmed), encoded.record),
        'report_intent_unconfirmed',
      );
      return encoded.reference;
    });
  }

  async readReportIntent(
    groupId: string,
    reference: ReportGroupReference,
    finalizeCurrent: DelegationPersistenceFinalizer,
  ): Promise<ReportGroupInput> {
    delegationIdV2(groupId);
    const expected = structuredClone(reference);
    requirePersistence(
      expected.domain === REPORT_INTENT_DOMAIN &&
        /^[0-9a-f]{64}$/.test(expected.id) &&
        expected.digest === `sha256:${expected.id}`,
      'report_intent_reference_invalid',
    );
    const domain = this.#reportIntents;
    return domain.locked(finalizeCurrent, async () => {
      const serialized = readBytes(
        join(domain.directory, `${expected.id}.json`),
        512 * 1024,
      );
      requirePersistence(serialized !== null, 'report_intent_missing');
      const stored: { version: number; groupId: string; intent: unknown } =
        JSON.parse(serialized);
      requirePersistence(
        stored.version === 1 && stored.groupId === groupId,
        'report_intent_identity_invalid',
      );
      const input = parseStationReportGroupInput(stored.intent);
      const encoded = encodeReportIntent(groupId, input);
      requirePersistence(
        same(stored, encoded.record) && same(encoded.reference, expected),
        'report_intent_digest_invalid',
      );
      return input;
    });
  }

  async retainReportAdmission(
    value: StationReportAdmission,
    finalizeCurrent: DelegationPersistenceFinalizer,
  ): Promise<void> {
    const record = validateStationReportAdmission(value);
    const domain = this.#reportAdmissions;
    const file = address(record.data.spec.groupId);
    await domain.locked(finalizeCurrent, async () => {
      const execution = await this.readReportExecution(
        record.data.spec.groupId,
        record.data.root.authority_id,
        finalizeCurrent,
      );
      requirePersistence(
        (!execution.group || same(execution.group.spec, record.data.spec)) &&
          (!execution.authority ||
            (same(execution.authority.epochs[0].root, record.data.root) &&
              execution.authority.importedFromV2 === null)),
        'report_admission_execution_conflict',
      );
      const previous = readBytes(join(domain.directory, file), 1024 * 1024);
      if (previous !== null) {
        requirePersistence(
          same(validateStationReportAdmission(JSON.parse(previous)), record),
          'report_admission_conflict',
        );
      } else {
        const files = domain.files();
        requirePersistence(files.length < 128, 'report_admission_capacity');
        for (const otherFile of files) {
          const bytes = readBytes(
            join(domain.directory, otherFile),
            1024 * 1024,
          );
          requirePersistence(bytes !== null, 'report_admission_disappeared');
          const other = validateStationReportAdmission(JSON.parse(bytes));
          requirePersistence(
            other.data.root.issuer_host_id !==
              record.data.root.issuer_host_id ||
              other.data.root.authenticated_principal_ref.id !==
                record.data.root.authenticated_principal_ref.id ||
              other.data.root.revisions.policy.id !==
                record.data.root.revisions.policy.id,
            'report_operation_already_admitted',
          );
        }
        await domain.publish(file, record, 1024 * 1024, finalizeCurrent);
      }
      const persisted = readBytes(join(domain.directory, file), 1024 * 1024);
      requirePersistence(
        persisted !== null &&
          same(validateStationReportAdmission(JSON.parse(persisted)), record),
        'report_admission_commit_unconfirmed',
      );
    });
  }

  async readReportAdmission(
    groupId: string,
    finalizeCurrent: DelegationPersistenceFinalizer,
  ): Promise<StationReportAdmission | null> {
    const domain = this.#reportAdmissions;
    const file = address(groupId);
    return domain.locked(finalizeCurrent, async () => {
      const bytes = readBytes(
        join(domain.directory, file),
        1024 * 1024,
        'domain-return',
      );
      if (bytes === null) return null;
      const record = validateStationReportAdmission(JSON.parse(bytes));
      requirePersistence(
        record.data.spec.groupId === groupId,
        'report_admission_identity_mismatch',
      );
      return record;
    });
  }

  async listReportAdmissions(
    finalizeCurrent: DelegationPersistenceFinalizer,
  ): Promise<StationReportAdmission[]> {
    const domain = this.#reportAdmissions;
    return domain.locked(finalizeCurrent, async () => {
      const files = domain.files();
      requirePersistence(files.length <= 128, 'report_admission_capacity');
      return files.map((file) => {
        const bytes = readBytes(join(domain.directory, file), 1024 * 1024);
        requirePersistence(bytes !== null, 'report_admission_disappeared');
        return validateStationReportAdmission(JSON.parse(bytes));
      });
    });
  }

  /** Exact locked snapshots only; missing execution remains missing. */
  async readReportExecution(
    groupId: string,
    authorityId: string,
    finalizeCurrent: DelegationPersistenceFinalizer,
  ) {
    const groupFile = address(groupId),
      authorityFile = address(authorityId);
    return this.#rounds.locked(finalizeCurrent, () =>
      this.#roundsAuthorities.locked(finalizeCurrent, async () => {
        requirePersistence(
          readBytes(
            join(this.#groups.directory, groupFile),
            GROUP_V2_MAX_BYTES,
          ) === null &&
            readBytes(
              join(this.#authorities.directory, authorityFile),
              AUTHORITY_MAX_BYTES,
            ) === null,
          'report_execution_protocol_conflict',
        );
        const groupBytes = readBytes(
          join(this.#rounds.directory, groupFile),
          ROUNDS_MAX_BYTES,
          'domain-return',
        );
        const authorityBytes = readBytes(
          join(this.#roundsAuthorities.directory, authorityFile),
          AUTHORITY_V3_MAX_BYTES,
          'domain-return',
        );
        const journal: DelegationRoundsJournal | null =
          groupBytes === null ? null : JSON.parse(groupBytes);
        const group = journal ? projectDelegationRounds(journal) : null;
        const authority =
          authorityBytes === null
            ? null
            : validateDelegationAuthorityLedgerV3(JSON.parse(authorityBytes));
        requirePersistence(
          (!group || group.spec.groupId === groupId) &&
            (!authority ||
              authority.epochs[0].root.authority_id === authorityId),
          'report_execution_identity_mismatch',
        );
        return { group, authority, events: journal?.events ?? [] };
      }),
    );
  }

  /** Private raw evidence remains bound to the consumed physical invocation. */
  async retainProviderEvidence(
    evidence: ReservedProviderEvidence,
    finalizeCurrent: DelegationPersistenceFinalizer,
    commitWithin?: (commit: () => void) => void,
  ) {
    const record = structuredClone({ version: 1, evidence });
    const domain = this.#providerEvidence;
    const file = `${createHash('sha256')
      .update(
        canonicalJson([
          record.evidence.intent.root.id,
          record.evidence.intent.invocationId,
        ]),
      )
      .digest('hex')}.json`;
    const maxBytes = 20 * 1024 * 1024;
    return domain.locked(finalizeCurrent, async () => {
      const path = join(domain.directory, file);
      const previous = readBytes(path, maxBytes);
      if (previous !== null) {
        requirePersistence(
          same(JSON.parse(previous), record),
          'delegation_provider_evidence_conflict',
        );
      } else {
        requirePersistence(
          domain.files().length < MAX_FILES,
          'delegation_store_capacity',
        );
        await domain.publish(
          file,
          record,
          maxBytes,
          finalizeCurrent,
          commitWithin,
        );
      }
      const committed = readBytes(path, maxBytes);
      requirePersistence(
        committed !== null && same(JSON.parse(committed), record),
        'delegation_commit_unconfirmed',
      );
      return Object.freeze({
        id: file.slice(0, -5),
        domain: 'station.provider-evidence',
        digest: `sha256:${createHash('sha256').update(canonicalJson(record)).digest('hex')}`,
      });
    });
  }

  async assertProviderEvidenceRetained(
    evidence: ReservedProviderEvidence,
    reference: { id: string; domain: string; digest: string },
    finalizeCurrent: DelegationPersistenceFinalizer,
  ): Promise<void> {
    const record = structuredClone({ version: 1, evidence });
    const id = createHash('sha256')
      .update(
        canonicalJson([evidence.intent.root.id, evidence.intent.invocationId]),
      )
      .digest('hex');
    const digest = `sha256:${createHash('sha256')
      .update(canonicalJson(record))
      .digest('hex')}`;
    requirePersistence(
      reference.id === id &&
        reference.domain === 'station.provider-evidence' &&
        reference.digest === digest,
      'delegation_provider_evidence_mismatch',
    );
    await this.#providerEvidence.locked(finalizeCurrent, async () => {
      const bytes = readBytes(
        join(this.#providerEvidence.directory, `${id}.json`),
        20 * 1024 * 1024,
      );
      requirePersistence(
        bytes !== null && same(JSON.parse(bytes), record),
        'delegation_provider_evidence_unavailable',
      );
    });
  }

  async assertProviderEvidenceReference(
    reference: ReportGroupReference,
    expected: {
      groupId: string;
      rootId: string;
      invocationId: string;
      executionId: string;
      usage?: { inputTokens: number; outputTokens: number; costMicros: number };
      executionIntent?: {
        binding: Pick<
          ReservedProviderEvidence['intent'],
          | 'controller'
          | 'seatId'
          | 'root'
          | 'envelope'
          | 'effect'
          | 'allocation'
          | 'executionBindingDigest'
          | 'principalDigest'
          | 'subjectDigest'
          | 'finalWireDigest'
        >;
        modelReceipt: { id: string; domain: string; digest: string };
      };
      inputIntent?: {
        seatId: string;
        root: { id: string; authority_epoch: number; digest: string };
        envelope: { id: string; generation: number; digest: string };
      };
    },
    finalizeCurrent: DelegationPersistenceFinalizer,
  ) {
    const ref = structuredClone(reference);
    const scope = structuredClone(expected);
    const expectedId = createHash('sha256')
      .update(canonicalJson([scope.rootId, scope.invocationId]))
      .digest('hex');
    requirePersistence(
      ref.domain === 'station.provider-evidence' &&
        ref.id === expectedId &&
        /^sha256:[a-f0-9]{64}$/.test(ref.digest),
      'delegation_provider_evidence_mismatch',
    );
    return this.#providerEvidence.locked(finalizeCurrent, async () => {
      const bytes = readBytes(
        join(this.#providerEvidence.directory, `${expectedId}.json`),
        20 * 1024 * 1024,
      );
      requirePersistence(
        bytes !== null,
        'delegation_provider_evidence_unavailable',
      );
      const value: unknown = JSON.parse(bytes);
      const record = z
        .object({
          version: z.literal(1),
          evidence: z
            .object({
              intent: z
                .object({
                  groupId: reportObservationId,
                  invocationId: reportObservationId,
                  executionId: reportObservationId,
                  root: z.object({ id: reportObservationId }).passthrough(),
                })
                .passthrough(),
              historicalPricingJson: z
                .string()
                .max(128 * 1024)
                .optional(),
              rawResponseJson: z
                .string()
                .max(8 * 1024 * 1024)
                .optional(),
              quote: z
                .object({
                  contractId: z.string(),
                  contractRevision: z.string(),
                  contractSha256: z.string(),
                  evidenceDigest: z.string(),
                  wireSha256: z.string(),
                  currency: z.literal('USD'),
                  inputUpperBoundTokens: z.number().int().nonnegative().safe(),
                  outputUpperBoundTokens: z.number().int().nonnegative().safe(),
                  costMicros: z.number().int().nonnegative().safe(),
                })
                .passthrough()
                .optional(),
              usage: z
                .object({
                  inputTokens: z.number().int().nonnegative().safe(),
                  outputTokens: z.number().int().nonnegative().safe(),
                  costMicros: z.number().int().nonnegative().safe(),
                })
                .passthrough(),
            })
            .passthrough(),
        })
        .strict()
        .parse(value);
      requirePersistence(
        ref.digest ===
          `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}` &&
          record.evidence.intent.groupId === scope.groupId &&
          record.evidence.intent.root.id === scope.rootId &&
          record.evidence.intent.invocationId === scope.invocationId &&
          record.evidence.intent.executionId === scope.executionId &&
          (scope.usage === undefined ||
            (record.evidence.usage.inputTokens === scope.usage.inputTokens &&
              record.evidence.usage.outputTokens === scope.usage.outputTokens &&
              record.evidence.usage.costMicros === scope.usage.costMicros)) &&
          (!scope.inputIntent ||
            (record.evidence.intent.seatId === scope.inputIntent.seatId &&
              same(record.evidence.intent.root, scope.inputIntent.root) &&
              same(
                record.evidence.intent.envelope,
                scope.inputIntent.envelope,
              ))),
        'delegation_provider_evidence_mismatch',
      );
      let accounting:
        | ReturnType<typeof priceBoundedApiHistoricalRawUsage>
        | undefined;
      if (scope.executionIntent) {
        const { binding, modelReceipt } = scope.executionIntent;
        const quote = record.evidence.quote;
        const { historicalPricingJson, rawResponseJson } = record.evidence;
        requirePersistence(
          quote !== undefined &&
            historicalPricingJson !== undefined &&
            rawResponseJson !== undefined,
          'delegation_provider_evidence_pricing_unavailable',
        );
        accounting = priceBoundedApiHistoricalRawUsage(
          historicalPricingJson,
          quote,
          rawResponseJson,
        );
        requirePersistence(
          same(accounting, record.evidence.usage),
          'delegation_provider_evidence_pricing_mismatch',
        );
        requirePersistence(
          quote !== undefined &&
            same(
              Object.fromEntries(
                Object.keys(binding).map((key) => [
                  key,
                  record.evidence.intent[key],
                ]),
              ),
              binding,
            ) &&
            quote.inputUpperBoundTokens === binding.allocation.inputTokens &&
            quote.outputUpperBoundTokens === binding.allocation.outputTokens &&
            quote.costMicros === binding.allocation.costMicros &&
            modelReceipt.domain === 'station.provider-public-contract.v1' &&
            modelReceipt.id === quote.contractId &&
            modelReceipt.digest ===
              `sha256:${createHash('sha256')
                .update(
                  canonicalJson({
                    id: quote.contractId,
                    revision: quote.contractRevision,
                    contractSha256: quote.contractSha256,
                    evidenceDigest: quote.evidenceDigest,
                  }),
                )
                .digest('hex')}`,
          'delegation_provider_evidence_epoch_mismatch',
        );
      }
      assertCurrent(finalizeCurrent);
      return accounting;
    });
  }

  authorityStore(
    finalizeCurrent: DelegationPersistenceFinalizer,
  ): DelegationAuthorityStore {
    const domain = this.#authorities;
    const read = (file: string): DelegationAuthorityLedger | null => {
      const bytes = readBytes(
        join(domain.directory, file),
        AUTHORITY_MAX_BYTES,
      );
      if (bytes === null) return null;
      const ledger = validateDelegationAuthorityLedger(JSON.parse(bytes));
      requirePersistence(
        address(ledger.root.authority_id) === file,
        'delegation_authority_identity_mismatch',
      );
      return ledger;
    };
    return {
      transact: (authorityId, body) =>
        domain.locked(finalizeCurrent, async () => {
          const file = address(authorityId);
          requirePersistence(
            readBytes(
              join(this.#roundsAuthorities.directory, file),
              AUTHORITY_V3_MAX_BYTES,
            ) === null,
            'delegation_authority_custody_conflict',
          );
          const previous = read(file);
          const next = await body(previous && structuredClone(previous));
          assertCurrent(finalizeCurrent);
          const ledger = validateDelegationAuthorityLedger(next.ledger);
          requirePersistence(
            ledger.root.authority_id === authorityId,
            'delegation_authority_identity_mismatch',
          );
          if (previous) {
            requirePersistence(
              same(previous.root, ledger.root) &&
                (!previous.cancelled || ledger.cancelled),
              'delegation_authority_history_changed',
            );
            requirePersistence(
              ledger.envelopes.length >= previous.envelopes.length &&
                same(
                  ledger.envelopes.slice(0, previous.envelopes.length),
                  previous.envelopes,
                ),
              'delegation_envelope_history_changed',
            );
            for (const before of previous.invocations) {
              const after = ledger.invocations.find(
                (invocation) => invocation.invocationId === before.invocationId,
              );
              requirePersistence(
                after &&
                  after.envelopeId === before.envelopeId &&
                  same(after.allocation, before.allocation) &&
                  (!before.terminal || after.terminal) &&
                  (before.usage === null || same(before.usage, after.usage)),
                'delegation_invocation_history_changed',
              );
            }
          }
          const files = domain.files();
          requirePersistence(
            previous || files.length < MAX_FILES,
            'delegation_store_capacity',
          );
          const identities = new Set(
            ledger.envelopes.map((envelope) => envelope.execution_id),
          );
          for (const otherFile of this.#roundsAuthorities.filesIfPresent()) {
            const bytes = readBytes(
              join(this.#roundsAuthorities.directory, otherFile),
              AUTHORITY_V3_MAX_BYTES,
            );
            requirePersistence(bytes !== null, 'delegation_record_disappeared');
            const other = validateDelegationAuthorityLedgerV3(
              JSON.parse(bytes),
            );
            requirePersistence(
              !other.epochs
                .at(-1)!
                .envelopes.some((e) => identities.has(e.execution_id)),
              'delegation_execution_custody_conflict',
            );
          }
          for (const otherFile of files) {
            if (otherFile === file) continue;
            const other = read(otherFile);
            requirePersistence(
              other &&
                !other.envelopes.some((envelope) =>
                  identities.has(envelope.execution_id),
                ),
              'delegation_execution_custody_conflict',
            );
          }
          // Serialization headroom only; no token/cost arithmetic is implemented here.
          const headroom =
            ledger.invocations.filter((invocation) => invocation.usage === null)
              .length * MAX_USAGE_BYTES;
          requirePersistence(
            Buffer.byteLength(`${canonicalJson(ledger)}\n`) + headroom <=
              AUTHORITY_MAX_BYTES,
            'delegation_settlement_capacity',
          );
          if (!previous || !same(previous, ledger))
            await domain.publish(
              file,
              ledger,
              AUTHORITY_MAX_BYTES,
              finalizeCurrent,
            );
          const committed = read(file);
          requirePersistence(
            committed && same(committed, ledger),
            'delegation_commit_unconfirmed',
          );
          return next.result;
        }),
    };
  }

  /** New rounds only: no v2 import or writer transfer is provided by this store. */
  roundsAuthorityStore(
    finalizeCurrent: DelegationPersistenceFinalizer,
    preparationCurrent: DelegationPersistenceFinalizer = finalizeCurrent,
    existing?: { owner: HomeWriterOwner; lease: HomeWriterLease },
  ): DelegationAuthorityStoreV3 {
    const domain = this.#roundsAuthorities;
    const publicationCurrent = (): undefined => {
      assertCurrent(finalizeCurrent);
      if (preparationCurrent !== finalizeCurrent) {
        assertCurrent(preparationCurrent);
        assertCurrent(finalizeCurrent);
      }
      return undefined;
    };
    const read = (
      file: string,
      bytes = readBytes(join(domain.directory, file), AUTHORITY_V3_MAX_BYTES),
    ): DelegationAuthorityLedgerV3 | null => {
      if (bytes === null) return null;
      const ledger = validateDelegationAuthorityLedgerV3(JSON.parse(bytes));
      requirePersistence(
        ledger.importedFromV2 === null &&
          address(ledger.epochs[0].root.authority_id) === file,
        'delegation_rounds_authority_identity_mismatch',
      );
      return ledger;
    };
    return {
      transact: (authorityId, body) =>
        this.#roundsLifetime(
          (commitWithin) =>
            domain.locked(finalizeCurrent, async () => {
              if (preparationCurrent !== finalizeCurrent)
                assertCurrent(preparationCurrent);
              const file = address(authorityId);
              requirePersistence(
                readBytes(
                  join(this.#authorities.directory, file),
                  AUTHORITY_MAX_BYTES,
                ) === null,
                'delegation_authority_custody_conflict',
              );
              const previousBytes = readBytes(
                join(domain.directory, file),
                AUTHORITY_V3_MAX_BYTES,
              );
              const previous = read(file, previousBytes);
              const next = await body(previous && structuredClone(previous));
              if (preparationCurrent !== finalizeCurrent)
                assertCurrent(preparationCurrent);
              assertCurrent(finalizeCurrent);
              const ledger = validateDelegationAuthorityLedgerV3(next.ledger);
              requirePersistence(
                ledger.importedFromV2 === null &&
                  ledger.epochs[0].root.authority_id === authorityId,
                'delegation_rounds_authority_identity_mismatch',
              );
              if (previous) {
                requirePersistence(
                  ledger.revision ===
                    previous.revision + (same(previous, ledger) ? 0 : 1) &&
                    ledger.maxRenewals === previous.maxRenewals &&
                    (!previous.cancelled || ledger.cancelled) &&
                    ledger.epochs.length >= previous.epochs.length &&
                    ledger.epochs.length <= previous.epochs.length + 1 &&
                    same(
                      ledger.origins.slice(0, previous.origins.length),
                      previous.origins,
                    ),
                  'delegation_rounds_authority_history_changed',
                );
                if (ledger.epochs.length > previous.epochs.length)
                  requirePersistence(
                    ledger.epochs.at(-1)?.renewal?.command.expectedRevision ===
                      previous.revision,
                    'delegation_rounds_authority_history_changed',
                  );
                for (let i = 0; i < previous.epochs.length; i++) {
                  const before = previous.epochs[i],
                    after = ledger.epochs[i];
                  requirePersistence(
                    same(before.root, after.root) &&
                      same(before.renewal, after.renewal) &&
                      (i < previous.epochs.length - 1 ||
                      ledger.epochs.length > previous.epochs.length
                        ? same(before.envelopes, after.envelopes)
                        : after.envelopes.length >= before.envelopes.length &&
                          same(
                            after.envelopes.slice(0, before.envelopes.length),
                            before.envelopes,
                          )),
                    'delegation_rounds_epoch_history_changed',
                  );
                }
                for (const before of previous.invocations) {
                  const after = ledger.invocations.find(
                    (i) => i.invocationId === before.invocationId,
                  );
                  requirePersistence(
                    after &&
                      after.envelopeId === before.envelopeId &&
                      same(after.allocation, before.allocation) &&
                      (!before.terminal || after.terminal) &&
                      (before.usage === null ||
                        same(before.usage, after.usage)),
                    'delegation_invocation_history_changed',
                  );
                }
              }
              const files = domain.files();
              requirePersistence(
                previous || files.length < MAX_FILES,
                'delegation_store_capacity',
              );
              const identities = new Set(
                ledger.epochs.at(-1)!.envelopes.map((e) => e.execution_id),
              );
              for (const otherFile of this.#authorities.filesIfPresent()) {
                const bytes = readBytes(
                  join(this.#authorities.directory, otherFile),
                  AUTHORITY_MAX_BYTES,
                );
                requirePersistence(
                  bytes !== null,
                  'delegation_record_disappeared',
                );
                const other = validateDelegationAuthorityLedger(
                  JSON.parse(bytes),
                );
                requirePersistence(
                  !other.envelopes.some((e) => identities.has(e.execution_id)),
                  'delegation_execution_custody_conflict',
                );
              }
              for (const otherFile of files) {
                if (otherFile === file) continue;
                const other = read(otherFile);
                requirePersistence(
                  other &&
                    !other.epochs
                      .at(-1)!
                      .envelopes.some((e) => identities.has(e.execution_id)),
                  'delegation_execution_custody_conflict',
                );
              }
              requirePersistence(
                Buffer.byteLength(`${canonicalJson(ledger)}\n`) +
                  authorityCapacityV3(ledger) <=
                  AUTHORITY_V3_MAX_BYTES,
                'delegation_settlement_capacity',
              );
              const changed = !previous || !same(previous, ledger);
              if (changed)
                await domain.publish(
                  file,
                  ledger,
                  AUTHORITY_V3_MAX_BYTES,
                  publicationCurrent,
                  commitWithin,
                );
              requirePersistence(
                changed
                  ? same(read(file), ledger)
                  : readBytes(
                      join(domain.directory, file),
                      AUTHORITY_V3_MAX_BYTES,
                    ) === previousBytes,
                'delegation_commit_unconfirmed',
              );
              return next.result;
            }),
          existing,
        ),
    };
  }

  roundsStore(
    finalizeCurrent: DelegationPersistenceFinalizer,
    preparationCurrent: DelegationPersistenceFinalizer = finalizeCurrent,
    existing?: { owner: HomeWriterOwner; lease: HomeWriterLease },
  ): DelegationRoundsStore {
    const domain = this.#rounds;
    const publicationCurrent = (): undefined => {
      assertCurrent(finalizeCurrent);
      if (preparationCurrent !== finalizeCurrent) {
        assertCurrent(preparationCurrent);
        assertCurrent(finalizeCurrent);
      }
      return undefined;
    };
    const read = (
      file: string,
      bytes = readBytes(join(domain.directory, file), ROUNDS_MAX_BYTES),
    ): DelegationRoundsJournal | null => {
      if (bytes === null) return null;
      const journal: DelegationRoundsJournal = JSON.parse(bytes);
      projectDelegationRounds(journal);
      requirePersistence(
        address(journal.groupId) === file,
        'delegation_group_identity_mismatch',
      );
      return journal;
    };
    return {
      transact: (groupId, body) =>
        this.#roundsLifetime(
          (commitWithin) =>
            domain.locked(finalizeCurrent, async () => {
              if (preparationCurrent !== finalizeCurrent)
                assertCurrent(preparationCurrent);
              const file = address(groupId);
              const previousBytes = readBytes(
                join(domain.directory, file),
                ROUNDS_MAX_BYTES,
              );
              const previous = read(file, previousBytes);
              requirePersistence(
                readBytes(
                  join(this.#groups.directory, file),
                  GROUP_V2_MAX_BYTES,
                ) === null,
                'delegation_group_protocol_conflict',
              );
              const next = await body(previous && structuredClone(previous));
              if (preparationCurrent !== finalizeCurrent)
                assertCurrent(preparationCurrent);
              assertCurrent(finalizeCurrent);
              const projection = projectDelegationRounds(next.journal);
              requirePersistence(
                next.journal.groupId === groupId,
                'delegation_group_identity_mismatch',
              );
              if (previous)
                requirePersistence(
                  next.journal.events.length >= previous.events.length &&
                    same(
                      next.journal.events.slice(0, previous.events.length),
                      previous.events,
                    ),
                  'delegation_journal_history_changed',
                );
              else {
                for (const otherFile of this.#groups.filesIfPresent()) {
                  const bytes = readBytes(
                    join(this.#groups.directory, otherFile),
                    GROUP_V2_MAX_BYTES,
                  );
                  requirePersistence(
                    bytes !== null,
                    'delegation_record_disappeared',
                  );
                  const other = projectDelegationGroupV2(JSON.parse(bytes));
                  requirePersistence(
                    other.spec.rootAuthorityRef.id !==
                      projection.spec.rootAuthorityRef.id,
                    'delegation_group_authority_custody_conflict',
                  );
                }
                const files = domain.files();
                requirePersistence(
                  files.length < MAX_FILES,
                  'delegation_store_capacity',
                );
                for (const otherFile of files) {
                  const other = read(otherFile);
                  requirePersistence(
                    other &&
                      projectDelegationRounds(other).spec.rootAuthorityRef
                        .id !== projection.spec.rootAuthorityRef.id,
                    'delegation_group_authority_custody_conflict',
                  );
                }
              }
              const capacity = delegationRoundsCapacity(next.journal);
              requirePersistence(
                next.journal.events.length + capacity.events <=
                  ROUNDS_MAX_EVENTS &&
                  Buffer.byteLength(`${canonicalJson(next.journal)}\n`) +
                    capacity.bytes <=
                    ROUNDS_MAX_BYTES,
                'delegation_group_capacity',
              );
              const changed = !previous || !same(previous, next.journal);
              if (changed)
                await domain.publish(
                  file,
                  next.journal,
                  ROUNDS_MAX_BYTES,
                  publicationCurrent,
                  commitWithin,
                );
              requirePersistence(
                changed
                  ? same(read(file), next.journal)
                  : readBytes(
                      join(domain.directory, file),
                      ROUNDS_MAX_BYTES,
                    ) === previousBytes,
                'delegation_commit_unconfirmed',
              );
              return next.result;
            }),
          existing,
        ),
    };
  }

  groupStore(
    finalizeCurrent: DelegationPersistenceFinalizer,
  ): DelegationGroupStoreV2 {
    const domain = this.#groups;
    const read = (file: string): DelegationGroupJournalV2 | null => {
      const bytes = readBytes(join(domain.directory, file), GROUP_V2_MAX_BYTES);
      if (bytes === null) return null;
      const journal: DelegationGroupJournalV2 = JSON.parse(bytes);
      projectDelegationGroupV2(journal);
      requirePersistence(
        address(journal.groupId) === file,
        'delegation_group_identity_mismatch',
      );
      return journal;
    };
    const all = (): DelegationGroupJournalV2[] =>
      domain.files().map((file) => {
        const journal = read(file);
        requirePersistence(journal, 'delegation_record_disappeared');
        return journal;
      });
    return {
      transact: (groupId, body) =>
        domain.locked(finalizeCurrent, async () => {
          const file = address(groupId);
          const previous = read(file);
          requirePersistence(
            readBytes(join(this.#rounds.directory, file), ROUNDS_MAX_BYTES) ===
              null,
            'delegation_group_protocol_conflict',
          );
          const next = await body(previous && structuredClone(previous));
          assertCurrent(finalizeCurrent);
          const projection = projectDelegationGroupV2(next.journal);
          requirePersistence(
            next.journal.groupId === groupId,
            'delegation_group_identity_mismatch',
          );
          if (previous)
            requirePersistence(
              next.journal.events.length >= previous.events.length &&
                same(
                  next.journal.events.slice(0, previous.events.length),
                  previous.events,
                ),
              'delegation_journal_history_changed',
            );
          else {
            for (const otherFile of this.#rounds.filesIfPresent()) {
              const bytes = readBytes(
                join(this.#rounds.directory, otherFile),
                ROUNDS_MAX_BYTES,
              );
              requirePersistence(
                bytes !== null,
                'delegation_record_disappeared',
              );
              const other = projectDelegationRounds(JSON.parse(bytes));
              requirePersistence(
                other.spec.rootAuthorityRef.id !==
                  projection.spec.rootAuthorityRef.id,
                'delegation_group_authority_custody_conflict',
              );
            }
            const journals = all();
            requirePersistence(
              journals.length < MAX_FILES,
              'delegation_store_capacity',
            );
            requirePersistence(
              !journals.some(
                (journal) =>
                  projectDelegationGroupV2(journal).spec.rootAuthorityRef.id ===
                  projection.spec.rootAuthorityRef.id,
              ),
              'delegation_group_authority_custody_conflict',
            );
          }
          const capacity = delegationGroupCapacityV2(next.journal);
          requirePersistence(
            next.journal.events.length + capacity.events <=
              GROUP_V2_MAX_EVENTS &&
              Buffer.byteLength(`${canonicalJson(next.journal)}\n`) +
                capacity.bytes <=
                GROUP_V2_MAX_BYTES,
            'delegation_group_capacity',
          );
          if (!previous || !same(previous, next.journal))
            await domain.publish(
              file,
              next.journal,
              GROUP_V2_MAX_BYTES,
              finalizeCurrent,
            );
          const committed = read(file);
          requirePersistence(
            committed && same(committed, next.journal),
            'delegation_commit_unconfirmed',
          );
          return next.result;
        }),
      scan: (body) =>
        domain.locked(finalizeCurrent, async () => {
          const result = await body(all());
          assertCurrent(finalizeCurrent);
          return result;
        }),
    };
  }
}
