import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  attachEvidence,
  definitionIdentity,
  loadRun,
  startRun,
  validateDefinition,
} from '@kontourai/flow';
import {
  type FlowMultiCursorExecution,
  type FlowScheduleEvent,
  orchestrateFlowMultiCursor,
} from '@kontourai/flow-agents';
import { canonicalJson } from '@kontourai/relay';
import type {
  CliSessionGroupListPage,
  CliSessionGroupSync,
  CliSessionGroupView,
} from '@kontourai/station-contracts/delegation-group';
import {
  publishJsonFileWithOwnedLock,
  readJsonFile,
} from '@kontourai/station-shared/json-file-storage';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { z } from 'zod/v3';
import { buildSyntheticTrustBundle } from '../evidence/trust-bundle.js';

async function awaitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const handleSchema = z.object({
  taskId: z.string().min(1).max(512),
  conversationId: z.string().min(1).max(512),
  sessionId: z.string().min(1).max(512),
  initialTurnId: z.string().min(1).max(512).optional(),
});
const terminalEventSchema = z
  .object({
    eventId: z.string().min(1).max(512),
    turnId: z.string().min(1).max(512),
  })
  .strict();
const MAX_SYNC_OPERATIONS = 8;
const MAX_SYNC_CONTENT_BYTES = 128 * 1024;
const MAX_SYNC_DURATION_MS = 30 * 60_000;
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const syncReceiptSchema = z.object({
  turnId: terminalEventSchema.shape.turnId,
  terminalEventId: terminalEventSchema.shape.eventId,
  nativeIdentityHash: sha256,
  toolCalls: z.number().int().min(0).max(1_000_000),
});
const syncResultSchema = syncReceiptSchema.extend({
  sessionId: handleSchema.shape.sessionId,
  output: z.string(),
});
const syncSchema: z.ZodType<CliSessionGroupSync> = z
  .object({
    operationId: id,
    runId: id,
    contentHash: sha256,
    timestamp: z.string().datetime(),
    status: z.enum(['syncing', 'acknowledged', 'incomplete']),
    members: z
      .array(
        syncReceiptSchema
          .partial()
          .extend({
            seatId: id,
            status: z.enum(['pending', 'acknowledged', 'failed', 'unknown']),
            attempts: z.number().int().min(0).max(2),
            timestamp: z.string().datetime().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();
const recordSchema = z
  .object({
    version: z.literal(1),
    groupId: id,
    ownerKey: z.string().length(64),
    intentDigest: z.string().length(64),
    revision: z.number().int().nonnegative(),
    maxConcurrent: z.number().int().min(1).max(32),
    maxDispatches: z.number().int().min(0).max(32).optional(),
    deadlineAt: z.number().int().positive(),
    cancelled: z.boolean(),
    flowReady: z.boolean(),
    dispatchCount: z.number().int().min(0).max(32),
    admissionClosed: z.literal('dispatch-limit-exhausted').optional(),
    seats: z
      .array(
        z
          .object({
            seatId: id,
            input: z.unknown(),
            needs: z.array(id).max(32),
            state: z.enum(['pending', 'launch-intent', 'started', 'terminal']),
            claimId: z.string().max(512).optional(),
            reservedSessionId: z.string().max(512).optional(),
            initialClientTurnId: z.string().max(512).optional(),
            handle: handleSchema.optional(),
            stopReserved: z.literal(true).optional(),
            outcome: z.enum(['completed', 'failed', 'canceled']).optional(),
            terminalObservedAt: z.string().datetime().optional(),
            terminalEvent: terminalEventSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    syncs: z.array(syncSchema).max(MAX_SYNC_OPERATIONS).optional(),
    scheduleEvents: z
      .array(
        z
          .object({
            kind: z.string().max(32),
            stepId: id,
            claimId: z.string().max(512),
          })
          .strict(),
      )
      .max(4096),
  })
  .strict();
type GroupRecord = z.infer<typeof recordSchema>;
type MemberHandle = z.infer<typeof handleSchema>;
const digest = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const MAX_BYTES = 1024 * 1024;

export class CliSessionGroupUnavailable extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CliSessionGroupUnavailable';
  }
}

export interface CliSessionGroupDispatchAdmission {
  readonly sessionId: string;
  readonly initialClientTurnId: string;
  readonly signal: AbortSignal;
  assertCurrent(): void;
}

export interface CliSessionGroupHost<T> {
  assertCurrent(): void;
  assertStopCurrent(): void;
  dispatch(
    input: T,
    admission: CliSessionGroupDispatchAdmission,
  ): Promise<unknown>;
  observe(handle: MemberHandle): Promise<{
    status: string;
    sessionId: string;
    completedEvent?: { eventId: string; turnId: string };
  }>;
  interrupt(handle: MemberHandle): Promise<void>;
  prepareSync?(handle: MemberHandle): Promise<void>;
  sync?(
    handle: MemberHandle,
    input: {
      prompt: string;
      clientTurnId: string;
      signal: AbortSignal;
      assertCurrent(): void;
    },
  ): Promise<z.infer<typeof syncResultSchema>>;
}

/** Station owns session authority; Flow owns readiness, claims and gate evaluation. */
export class CliSessionGroups<T> {
  private readonly root: string;
  private readonly active = new Map<string, AbortController>();

  constructor(
    home: string,
    private readonly parseInput: (input: unknown) => T,
    private readonly logger: {
      warn?(message: string, meta?: Record<string, unknown>): void;
    },
  ) {
    this.root = join(realpathSync(home), 'runtime', 'cli-session-groups');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.root);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync(this.root) !== this.root ||
      (stat.mode & 0o077) !== 0
    )
      throw new CliSessionGroupUnavailable('group_storage_unavailable');
  }

  private path(groupId: string): string {
    return join(this.root, `${id.parse(groupId)}.json`);
  }

  private readStored(groupId: string): GroupRecord {
    const value = readJsonFile(this.path(groupId), null, {
      maxBytes: MAX_BYTES,
      label: 'CLI session group',
    });
    if (value === null) throw new CliSessionGroupUnavailable('group_not_found');
    return recordSchema.parse(value);
  }

  private read(groupId: string, owner: string): GroupRecord {
    const record = this.readStored(groupId);
    if (record.groupId !== groupId || record.ownerKey !== digest(owner))
      throw new CliSessionGroupUnavailable('group_not_found');
    this.validateRecord(record);
    return record;
  }

  private validateRecord(record: GroupRecord): void {
    for (const seat of record.seats) this.parseInput(seat.input);
    if (
      new Set(record.seats.map((s) => s.seatId)).size !== record.seats.length ||
      record.dispatchCount !==
        record.seats.filter((s) => s.state !== 'pending').length ||
      (record.maxDispatches !== undefined &&
        (record.maxDispatches > record.seats.length ||
          record.dispatchCount > record.maxDispatches)) ||
      record.seats.some(
        (s) =>
          ((s.state === 'started' || s.state === 'terminal') && !s.handle) ||
          (s.stopReserved &&
            (!s.handle?.initialTurnId ||
              s.handle.sessionId !== s.reservedSessionId)),
      )
    )
      throw new CliSessionGroupUnavailable('group_storage_unavailable');
    const syncs = record.syncs ?? [];
    if (
      new Set(syncs.map((sync) => sync.operationId)).size !== syncs.length ||
      syncs.some(
        (sync) =>
          sync.members.length !== record.seats.length ||
          new Set(sync.members.map((member) => member.seatId)).size !==
            sync.members.length ||
          sync.members.some(
            (member) =>
              !record.seats.some((seat) => seat.seatId === member.seatId) ||
              (member.status === 'pending'
                ? member.attempts !== 0
                : member.attempts === 0) ||
              (member.status === 'acknowledged' && member.toolCalls !== 0) ||
              ((member.status === 'acknowledged' ||
                member.status === 'failed') &&
                !syncReceiptSchema.safeParse(member).success),
          ) ||
          (sync.status === 'acknowledged' &&
            sync.members.some((member) => member.status !== 'acknowledged')),
      )
    )
      throw new CliSessionGroupUnavailable('group_storage_unavailable');
  }

  private async withGroupMutation<R>(
    groupId: string,
    owner: string,
    work: (record: GroupRecord, path: string) => Promise<R>,
  ): Promise<R> {
    const path = this.path(groupId);
    const release = await acquireFileMutationLockAsync(`${path}.mutation`);
    try {
      return await work(this.read(groupId, owner), path);
    } finally {
      await release();
    }
  }

  private async publishRecord(
    path: string,
    record: GroupRecord,
    assertCurrent?: (record: GroupRecord) => void,
  ): Promise<void> {
    record.revision += 1;
    recordSchema.parse(record);
    await publishJsonFileWithOwnedLock(path, record, {
      maxBytes: MAX_BYTES,
      assertCurrent: assertCurrent ? () => assertCurrent(record) : undefined,
    });
  }

  private async mutate<R>(
    groupId: string,
    owner: string,
    work: (record: GroupRecord) => R,
    assertCurrent?: (record: GroupRecord) => void,
  ): Promise<R> {
    return this.withGroupMutation(groupId, owner, async (record, path) => {
      assertCurrent?.(record);
      const result = work(record);
      await this.publishRecord(path, record, assertCurrent);
      return result;
    });
  }

  async create(
    owner: string,
    operationId: string,
    input: {
      seats: { seatId: string; input: T; needs: string[] }[];
      maxConcurrent: number;
      maxDispatches?: number;
      deadlineAt: number;
    },
    assertCurrent: () => void,
  ): Promise<CliSessionGroupView> {
    input = structuredClone(input);
    id.parse(operationId);
    const groupId = `cli-${digest([owner, operationId])}`;
    const path = this.path(groupId);
    const release = await acquireFileMutationLockAsync(
      join(this.root, 'create.mutation'),
    );
    try {
      assertCurrent();
      const intentDigest = digest(input);
      const existing = readJsonFile(path, null, {
        maxBytes: MAX_BYTES,
        label: 'CLI session group',
      });
      if (existing !== null) {
        const record = this.read(groupId, owner);
        if (record.intentDigest !== intentDigest)
          throw new CliSessionGroupUnavailable('group_conflict');
        return await this.view(groupId, owner);
      }
      if (
        readdirSync(this.root).filter((name) => name.endsWith('.json'))
          .length >= 128
      )
        throw new CliSessionGroupUnavailable('group_capacity');
      if (
        input.deadlineAt <= Date.now() ||
        input.deadlineAt > Date.now() + 30 * 60_000
      )
        throw new CliSessionGroupUnavailable('group_invalid');
      const record = recordSchema.parse({
        version: 1,
        groupId,
        ownerKey: digest(owner),
        intentDigest,
        revision: 0,
        maxConcurrent: input.maxConcurrent,
        maxDispatches: input.maxDispatches,
        admissionClosed:
          input.maxDispatches === 0 ? 'dispatch-limit-exhausted' : undefined,
        deadlineAt: input.deadlineAt,
        cancelled: false,
        flowReady: false,
        dispatchCount: 0,
        seats: input.seats.map((s) => ({ ...s, state: 'pending' })),
        scheduleEvents: [],
      });
      if (
        new Set(record.seats.map((s) => s.seatId)).size !==
          record.seats.length ||
        (record.maxDispatches !== undefined &&
          record.maxDispatches > record.seats.length)
      )
        throw new CliSessionGroupUnavailable('group_invalid');
      for (const seat of record.seats) this.parseInput(seat.input);
      const cwd = join(this.root, groupId);
      const definition = validateDefinition({
        id: groupId,
        version: '1',
        execution: { mode: 'multi-cursor', claim_contract_version: '1' },
        steps: record.seats.map((s) => ({
          id: s.seatId,
          next: null,
          needs: s.needs,
          mutable_resources: [],
        })),
        gates: Object.fromEntries(
          record.seats.map((s) => [
            `${s.seatId}-returned`,
            {
              step: s.seatId,
              expects: [
                {
                  id: 'member-completed',
                  kind: 'trust.bundle',
                  required: true,
                  description: 'Station observed this member session complete.',
                  bundle_claim: {
                    claimType: 'station.session-group.member-completed',
                    subjectType: 'station-session-group-seat',
                    subjectId: `${groupId}:${s.seatId}`,
                    accepted_statuses: ['assumed'],
                  },
                },
              ],
            },
          ]),
        ),
      });
      // Publish the operation before creating Flow artifacts. A partial creation is never retried as a launch.
      await publishJsonFileWithOwnedLock(path, record, {
        maxBytes: MAX_BYTES,
        assertCurrent,
      });
      mkdirSync(cwd, { mode: 0o700 });
      const definitionPath = join(cwd, 'definition.json');
      await publishJsonFileWithOwnedLock(definitionPath, definition);
      await startRun(definitionPath, { cwd, runId: groupId });
      record.flowReady = true;
      await publishJsonFileWithOwnedLock(path, record, { maxBytes: MAX_BYTES });
      assertCurrent();
    } finally {
      await release();
    }
    return this.view(groupId, owner);
  }

  async list(
    owner: string,
    afterGroupId: string | undefined,
    assertCurrent: () => void,
  ): Promise<CliSessionGroupListPage> {
    if (afterGroupId !== undefined) id.parse(afterGroupId);
    const names = readdirSync(this.root)
      .filter((name) => name.endsWith('.json'))
      .sort();
    if (names.length > 128)
      throw new CliSessionGroupUnavailable('group_storage_unavailable');

    const ownerKey = digest(owner);
    const groups: CliSessionGroupView[] = [];
    for (const name of names) {
      const groupId = id.parse(name.slice(0, -5));
      if (afterGroupId !== undefined && groupId <= afterGroupId) continue;
      assertCurrent();
      const record = this.readStored(groupId);
      if (record.ownerKey !== ownerKey) continue;
      if (record.groupId !== groupId)
        throw new CliSessionGroupUnavailable('group_storage_unavailable');
      const last = groups.at(-1);
      if (groups.length === 16 && last)
        return { groups, nextGroupId: last.groupId, hasMore: true };
      this.validateRecord(record);
      const view = await this.project(record);
      assertCurrent();
      const page = {
        groups: [...groups, view],
        nextGroupId: groupId,
        hasMore: true,
      };
      if (
        Buffer.byteLength(JSON.stringify({ success: true, data: page })) >
        262_144
      ) {
        if (!last)
          throw new CliSessionGroupUnavailable('group_response_too_large');
        return { groups, nextGroupId: last.groupId, hasMore: true };
      }
      groups.push(view);
    }
    return { groups, nextGroupId: null, hasMore: false };
  }

  async view(groupId: string, owner: string): Promise<CliSessionGroupView> {
    return this.project(this.read(groupId, owner));
  }

  private async project(
    record: GroupRecord,
    replayOperationId?: string,
  ): Promise<CliSessionGroupView> {
    const { groupId } = record;
    const contextSync =
      replayOperationId === undefined
        ? record.syncs?.at(-1)
        : record.syncs?.find(
            (entry) => entry.operationId === replayOperationId,
          );
    if (replayOperationId !== undefined && !contextSync)
      throw new CliSessionGroupUnavailable('group_sync_unavailable');
    const flow = record.flowReady
      ? await loadRun(groupId, join(this.root, groupId))
      : null;
    const supervising =
      replayOperationId === undefined && this.active.has(groupId);
    return {
      version: 'station.cli-session-group/v1',
      groupId,
      revision: record.revision,
      supervision: supervising ? 'active' : 'not-running',
      cancelled: record.cancelled,
      deadlineAt: record.deadlineAt,
      maxConcurrent: record.maxConcurrent,
      maxDispatches: record.maxDispatches ?? record.seats.length,
      admissionClosed: record.admissionClosed,
      dispatchCount: record.dispatchCount,
      ...(contextSync
        ? {
            contextSync: {
              ...contextSync,
              status:
                !supervising && contextSync.status === 'syncing'
                  ? 'incomplete'
                  : contextSync.status,
            },
          }
        : {}),
      guarantees: {
        authority: 'station-session',
        portableFlowLineage: 'unbound',
        dollarCap: 'unavailable',
        tokenCap: 'unavailable',
        physicalAttemptCap: 'unavailable',
        deadline: 'stop-admission-and-request-interruption',
      },
      flow: flow
        ? {
            runId: groupId,
            definition: definitionIdentity(flow.definition),
            status: flow.state.status,
          }
        : null,
      acceptance: 'unassessed',
      members: record.seats.map(
        ({
          seatId,
          needs,
          state,
          claimId,
          reservedSessionId,
          initialClientTurnId,
          handle,
          outcome,
          terminalEvent,
        }) => ({
          seatId,
          needs,
          state,
          claimId,
          reservedSessionId,
          initialClientTurnId,
          handle,
          outcome,
          terminalEvent,
        }),
      ),
    };
  }

  private membersForNewSync(record: GroupRecord) {
    if (
      !record.flowReady ||
      record.cancelled ||
      (record.syncs?.length ?? 0) >= MAX_SYNC_OPERATIONS ||
      record.syncs?.some(
        (entry) =>
          entry.status === 'syncing' ||
          entry.members.some((member) => member.status === 'unknown'),
      )
    )
      throw new CliSessionGroupUnavailable('group_sync_unavailable');
    return record.seats.map((seat) => {
      const handle = seat.handle;
      if (
        seat.state !== 'terminal' ||
        seat.outcome !== 'completed' ||
        !handle?.initialTurnId ||
        handle.sessionId !== seat.reservedSessionId ||
        seat.terminalEvent?.turnId !== handle.initialTurnId
      )
        throw new CliSessionGroupUnavailable('group_sync_unavailable');
      return {
        seatId: seat.seatId,
        handle: Object.freeze({ ...handle }),
        initialTerminalEventId: seat.terminalEvent.eventId,
      };
    });
  }

  // The retained Session adapter and credential-bound route own delivery.
  async sync(
    groupId: string,
    owner: string,
    input: {
      operationId: string;
      runId: string;
      content: string;
      deadlineAt: number;
    },
    host: CliSessionGroupHost<T>,
    signal: AbortSignal,
  ): Promise<CliSessionGroupView> {
    const { operationId, runId, content, deadlineAt } = input;
    id.parse(operationId);
    id.parse(runId);
    if (
      typeof content !== 'string' ||
      !content.trim() ||
      Buffer.byteLength(content) > MAX_SYNC_CONTENT_BYTES ||
      !Number.isSafeInteger(deadlineAt) ||
      deadlineAt <= 0
    )
      throw new CliSessionGroupUnavailable('group_invalid');
    const contentHash = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    const assertCallerCurrent = host.assertCurrent.bind(host);
    const assertInspectionCurrent = () => {
      assertCallerCurrent();
      signal.throwIfAborted();
    };
    const existingOperation = (record: GroupRecord) => {
      const existing = record.syncs?.find(
        (entry) => entry.operationId === operationId,
      );
      if (
        existing &&
        (existing.contentHash !== contentHash || existing.runId !== runId)
      )
        throw new CliSessionGroupUnavailable('group_conflict');
      return existing;
    };
    const observeOperation = async (record: GroupRecord) => {
      assertInspectionCurrent();
      const projection = await this.project(record, operationId);
      assertInspectionCurrent();
      return projection;
    };
    assertInspectionCurrent();
    const initial = this.read(groupId, owner);
    if (existingOperation(initial)) return observeOperation(initial);

    const duration = deadlineAt - Date.now();
    if (duration <= 0 || duration > MAX_SYNC_DURATION_MS)
      throw new CliSessionGroupUnavailable('group_invalid');
    const prepareSync = host.prepareSync?.bind(host);
    const sync = host.sync?.bind(host);
    if (!prepareSync || !sync || this.active.has(groupId))
      throw new CliSessionGroupUnavailable('group_busy');
    const participants = this.membersForNewSync(initial);
    const memberBinding = canonicalJson(participants);
    const controller = new AbortController();
    const lifetime = AbortSignal.any([
      signal,
      controller.signal,
      AbortSignal.timeout(duration),
    ]);
    this.active.set(groupId, controller);
    const assertAdmission = (record?: GroupRecord) => {
      assertCallerCurrent();
      if (lifetime.aborted || Date.now() >= deadlineAt || record?.cancelled)
        throw new CliSessionGroupUnavailable('group_sync_interrupted');
    };
    const findMember = (record: GroupRecord, seatId: string) => {
      const operation = record.syncs?.find(
        (entry) => entry.operationId === operationId,
      );
      const member = operation?.members.find(
        (value) => value.seatId === seatId,
      );
      if (operation?.status !== 'syncing' || !member)
        throw new CliSessionGroupUnavailable('group_sync_unavailable');
      return member;
    };
    const ack = `ACK SYNC ${runId}`;
    const prompt = `Retain the complete folded result below as context for this conversation. Use no tools. Reply with exactly ${ack} and nothing else.

${content}`;
    // The owned operation keeps its reservation until its effect settles.
    const settlement = (async () => {
      let reserved = false;
      try {
        for (const { handle } of participants) {
          assertAdmission();
          const preparation = prepareSync(handle);
          void preparation.catch(() => {});
          await awaitWithAbort(preparation, lifetime);
          assertAdmission();
        }

        const replay = await this.withGroupMutation(
          groupId,
          owner,
          async (record, path) => {
            assertInspectionCurrent();
            if (existingOperation(record)) return record;
            assertAdmission(record);
            if (canonicalJson(this.membersForNewSync(record)) !== memberBinding)
              throw new CliSessionGroupUnavailable(
                'group_sync_identity_changed',
              );
            record.syncs ??= [];
            record.syncs.push({
              operationId,
              runId,
              contentHash,
              timestamp: new Date().toISOString(),
              status: 'syncing',
              members: participants.map(({ seatId }) => ({
                seatId,
                status: 'pending',
                attempts: 0,
              })),
            });
            await this.publishRecord(path, record, assertAdmission);
            return undefined;
          },
        );
        if (replay) return replay;
        reserved = true;

        for (const { seatId, handle, initialTerminalEventId } of participants) {
          for (let attempt = 1; attempt <= 2; attempt++) {
            const clientTurnId = `sync-${digest([groupId, operationId, seatId, attempt])}`;
            await this.mutate(
              groupId,
              owner,
              (record) => {
                const member = findMember(record, seatId);
                if (
                  member.attempts !== attempt - 1 ||
                  (attempt === 2 &&
                    (member.status !== 'failed' || member.toolCalls !== 0))
                )
                  throw new CliSessionGroupUnavailable('group_conflict');
                member.attempts = attempt;
                member.status = 'unknown';
                member.timestamp = new Date().toISOString();
              },
              assertAdmission,
            );

            const reservedMember = (record: GroupRecord) => {
              const member = findMember(record, seatId);
              const seat = record.seats.find(
                (value) => value.seatId === seatId,
              );
              if (
                member.attempts !== attempt ||
                member.status !== 'unknown' ||
                seat?.handle?.sessionId !== handle.sessionId ||
                seat.handle.initialTurnId !== handle.initialTurnId ||
                seat.terminalEvent?.eventId !== initialTerminalEventId
              )
                throw new CliSessionGroupUnavailable(
                  'group_sync_identity_changed',
                );
              return member;
            };
            const assertAttempt = () => {
              const record = this.read(groupId, owner);
              assertAdmission(record);
              reservedMember(record);
            };
            try {
              assertAttempt();
              const result = syncResultSchema.parse(
                await sync(handle, {
                  prompt,
                  clientTurnId,
                  signal: lifetime,
                  assertCurrent: assertAttempt,
                }),
              );
              if (
                result.sessionId !== handle.sessionId ||
                result.turnId === handle.initialTurnId ||
                result.terminalEventId === initialTerminalEventId
              )
                throw new CliSessionGroupUnavailable(
                  'group_sync_identity_changed',
                );
              const acknowledged =
                result.toolCalls === 0 && result.output === ack;
              await this.mutate(groupId, owner, (record) => {
                const member = reservedMember(record);
                if (
                  (member.nativeIdentityHash &&
                    member.nativeIdentityHash !== result.nativeIdentityHash) ||
                  record.syncs?.some((entry) =>
                    entry.members.some(
                      (previous) =>
                        (previous.seatId === seatId &&
                          previous.turnId === result.turnId) ||
                        previous.terminalEventId === result.terminalEventId,
                    ),
                  )
                )
                  throw new CliSessionGroupUnavailable(
                    'group_sync_identity_changed',
                  );
                member.status = acknowledged ? 'acknowledged' : 'failed';
                member.turnId = result.turnId;
                member.terminalEventId = result.terminalEventId;
                member.nativeIdentityHash = result.nativeIdentityHash;
                member.toolCalls = result.toolCalls;
                member.timestamp = new Date().toISOString();
              });
              if (lifetime.aborted || acknowledged || result.toolCalls !== 0)
                break;
            } catch {
              // An attempted effect with no exact receipt stays unknown.
              break;
            }
          }
        }
      } finally {
        try {
          if (reserved)
            await this.mutate(groupId, owner, (record) => {
              const entry = record.syncs?.find(
                (value) => value.operationId === operationId,
              );
              if (entry?.status === 'syncing')
                entry.status = entry.members.every(
                  (member) => member.status === 'acknowledged',
                )
                  ? 'acknowledged'
                  : 'incomplete';
            });
        } finally {
          this.active.delete(groupId);
        }
      }
      return this.read(groupId, owner);
    })();
    const response = settlement.then(async (record) => {
      lifetime.throwIfAborted();
      const projection = await observeOperation(record);
      lifetime.throwIfAborted();
      return projection;
    });
    void response.catch(() => {});
    try {
      return await awaitWithAbort(response, lifetime);
    } catch (error) {
      if (!lifetime.aborted) throw error;
      assertCallerCurrent();
      throw new CliSessionGroupUnavailable('group_sync_interrupted');
    }
  }

  async cancel(
    groupId: string,
    owner: string,
    host: CliSessionGroupHost<T>,
  ): Promise<CliSessionGroupView> {
    await this.mutate(
      groupId,
      owner,
      (record) => {
        record.cancelled = true;
      },
      () => host.assertCurrent(),
    );
    this.active.get(groupId)?.abort();
    for (const seat of this.read(groupId, owner).seats) {
      if (seat.state === 'started')
        await this.requestInterrupt(groupId, owner, host, seat.seatId);
    }
    host.assertCurrent();
    return this.view(groupId, owner);
  }

  async run(
    groupId: string,
    owner: string,
    host: CliSessionGroupHost<T>,
    signal: AbortSignal,
  ): Promise<CliSessionGroupView> {
    host.assertCurrent();
    const record = this.read(groupId, owner);
    if (!record.flowReady || this.active.has(groupId))
      throw new CliSessionGroupUnavailable('group_unavailable');
    if (record.maxDispatches === 0) return this.view(groupId, owner);
    const controller = new AbortController();
    this.active.set(groupId, controller);
    const deadline = AbortSignal.timeout(
      Math.max(0, Math.min(2_147_483_647, record.deadlineAt - Date.now())),
    );
    const lifetime = AbortSignal.any([signal, controller.signal, deadline]);
    try {
      await orchestrateFlowMultiCursor({
        runId: groupId,
        cwd: join(this.root, groupId),
        actor: { key: record.ownerKey, kind: 'station-session-group' },
        maxConcurrent: record.maxConcurrent,
        maxRounds: record.seats.length,
        signal: lifetime,
        onEvent: (event) => this.recordEvent(groupId, owner, event),
        execute: (execution) => this.execute(groupId, owner, host, execution),
      });
    } catch (error) {
      this.logger.warn?.('CLI session group scheduling stopped', {
        groupId,
        error,
      });
      // Durable seat intents survive scheduler failure, disconnect and process restart.
    } finally {
      this.active.delete(groupId);
    }
    host.assertCurrent();
    return this.view(groupId, owner);
  }

  private async requestInterrupt(
    groupId: string,
    owner: string,
    host: CliSessionGroupHost<T>,
    seatId: string,
  ): Promise<void> {
    try {
      const handle = await this.mutate(
        groupId,
        owner,
        (record) => {
          const seat = record.seats.find((member) => member.seatId === seatId);
          if (
            seat?.state !== 'started' ||
            !seat.handle?.initialTurnId ||
            seat.stopReserved
          )
            return undefined;
          seat.stopReserved = true;
          return structuredClone(seat.handle);
        },
        () => host.assertStopCurrent(),
      );
      if (!handle) return;
      host.assertStopCurrent();
      const interruption = host.interrupt(handle);
      void interruption.catch(() => {});
      await awaitWithAbort(interruption, AbortSignal.timeout(5_000));
    } catch {
      /* A request without stop evidence leaves the seat occupied. */
    }
  }

  private async recordEvent(
    groupId: string,
    owner: string,
    event: FlowScheduleEvent,
  ): Promise<void> {
    if (event.kind === 'renewed') return;
    await this.mutate(groupId, owner, (record) => {
      if (record.scheduleEvents.length >= 4096)
        throw new CliSessionGroupUnavailable('group_capacity');
      record.scheduleEvents.push({
        kind: event.kind,
        stepId: event.stepId,
        claimId: 'claimId' in event ? event.claimId : '',
      });
    });
  }

  private async recordCompletion(
    groupId: string,
    owner: string,
    seatId: string,
  ): Promise<void> {
    const seat = this.read(groupId, owner).seats.find(
      (s) => s.seatId === seatId,
    );
    if (
      seat?.state !== 'terminal' ||
      seat.outcome !== 'completed' ||
      !seat.handle ||
      !seat.terminalObservedAt ||
      !seat.terminalEvent ||
      seat.terminalEvent.turnId !== seat.handle.initialTurnId
    )
      throw new CliSessionGroupUnavailable('group_completion_unavailable');
    const cwd = join(this.root, groupId);
    const gate = `${seatId}-returned`;
    const producer = `station-session-group:${seatId}`;
    const run = await loadRun(groupId, cwd);
    if (
      run.manifest.evidence.some(
        (entry: { gate_id?: string; producer?: string }) =>
          entry.gate_id === gate && entry.producer === producer,
      )
    )
      return;
    const file = join(cwd, `${digest(seatId)}-completed.json`);
    await publishJsonFileWithOwnedLock(
      file,
      buildSyntheticTrustBundle({
        claimType: 'station.session-group.member-completed',
        subjectType: 'station-session-group-seat',
        subjectId: `${groupId}:${seatId}`,
        fieldOrBehavior: 'Station member-session observation',
        value: canonicalJson({
          handle: seat.handle,
          terminalEvent: seat.terminalEvent,
        }),
        now: seat.terminalObservedAt,
      }),
    );
    await attachEvidence(groupId, {
      cwd,
      gate,
      file,
      kind: 'trust.bundle',
      producer,
      expectation_ids: ['member-completed'],
    });
  }

  private async execute(
    groupId: string,
    owner: string,
    host: CliSessionGroupHost<T>,
    execution: FlowMultiCursorExecution,
  ): Promise<void> {
    const seatId = execution.claim.step_id;
    const assertLaunchCurrent = (record: GroupRecord) => {
      host.assertCurrent();
      execution.signal.throwIfAborted();
      if (record.cancelled || Date.now() >= record.deadlineAt)
        throw new CliSessionGroupUnavailable('group_closed');
    };
    const launch = await this.mutate(
      groupId,
      owner,
      (record) => {
        const seat = record.seats.find((s) => s.seatId === seatId);
        if (!seat) throw new CliSessionGroupUnavailable('group_invalid');
        if (seat.state !== 'pending')
          return { seat: structuredClone(seat), dispatch: false };
        if (
          record.dispatchCount >= (record.maxDispatches ?? record.seats.length)
        )
          throw new CliSessionGroupUnavailable('group_dispatch_limit');
        const occupied = record.seats.filter(
          (s) => s.state === 'launch-intent' || s.state === 'started',
        ).length;
        if (occupied >= record.maxConcurrent)
          throw new CliSessionGroupUnavailable('group_capacity');
        seat.reservedSessionId = `task:${randomUUID()}`;
        seat.initialClientTurnId = randomUUID();
        seat.state = 'launch-intent';
        seat.claimId = execution.claim.claim_id;
        record.dispatchCount += 1;
        if (
          record.dispatchCount >=
            (record.maxDispatches ?? record.seats.length) &&
          record.seats.some((member) => member.state === 'pending')
        )
          record.admissionClosed = 'dispatch-limit-exhausted';
        return { seat: structuredClone(seat), dispatch: true };
      },
      assertLaunchCurrent,
    );
    let handle = launch.seat.handle;
    if (launch.dispatch) {
      host.assertCurrent();
      execution.signal.throwIfAborted();
      const dispatched = host
        .dispatch(this.parseInput(launch.seat.input), {
          signal: execution.signal,
          sessionId: z.string().min(1).parse(launch.seat.reservedSessionId),
          initialClientTurnId: z
            .string()
            .min(1)
            .parse(launch.seat.initialClientTurnId),
          assertCurrent: () => {
            host.assertCurrent();
            execution.signal.throwIfAborted();
            const current = this.read(groupId, owner);
            const seat = current.seats.find((s) => s.seatId === seatId);
            if (
              current.cancelled ||
              Date.now() >= current.deadlineAt ||
              seat?.state !== 'launch-intent' ||
              seat.claimId !== execution.claim.claim_id
            )
              throw new CliSessionGroupUnavailable('group_closed');
          },
        })
        .then(async (result) => {
          const accepted = handleSchema.parse(result);
          if (accepted.sessionId !== launch.seat.reservedSessionId)
            throw new CliSessionGroupUnavailable('group_session_changed');
          const cancelled = await this.mutate(groupId, owner, (record) => {
            const seat = record.seats.find((s) => s.seatId === seatId)!;
            seat.handle = accepted;
            seat.state = 'started';
            return record.cancelled;
          });
          if (cancelled || execution.signal.aborted)
            await this.requestInterrupt(groupId, owner, host, seatId);
          return accepted;
        });
      // Losing work can still return its actual identity; retain it without authorizing a resend.
      void dispatched.catch(() => {});
      handle = await awaitWithAbort(dispatched, execution.signal);
    }
    if (!handle) throw new CliSessionGroupUnavailable('group_start_unknown');
    if (launch.seat.state === 'terminal') {
      if (launch.seat.outcome !== 'completed')
        throw new CliSessionGroupUnavailable('group_member_failed');
      await this.recordCompletion(groupId, owner, seatId);
      return;
    }
    try {
      while (true) {
        host.assertCurrent();
        execution.signal.throwIfAborted();
        const observation = host.observe(handle);
        void observation.catch(() => {});
        const snapshot = await awaitWithAbort(observation, execution.signal);
        if (snapshot.sessionId !== handle.sessionId)
          throw new CliSessionGroupUnavailable('group_session_changed');
        if (
          snapshot.status === 'completed' ||
          snapshot.status === 'failed' ||
          snapshot.status === 'canceled'
        ) {
          if (
            snapshot.status === 'completed' &&
            (!snapshot.completedEvent ||
              snapshot.completedEvent.turnId !== handle.initialTurnId)
          )
            throw new CliSessionGroupUnavailable(
              'group_completion_unavailable',
            );
          const outcome = snapshot.status;
          await this.mutate(groupId, owner, (record) => {
            const seat = record.seats.find((s) => s.seatId === seatId)!;
            seat.state = 'terminal';
            seat.outcome = outcome;
            seat.terminalObservedAt = new Date().toISOString();
            if (snapshot.completedEvent)
              seat.terminalEvent = terminalEventSchema.parse(
                snapshot.completedEvent,
              );
          });
          if (outcome !== 'completed')
            throw new CliSessionGroupUnavailable('group_member_failed');
          await this.recordCompletion(groupId, owner, seatId);
          return;
        }
        await delay(250, undefined, { signal: execution.signal });
      }
    } catch (error) {
      await this.requestInterrupt(groupId, owner, host, seatId);
      throw error;
    }
  }
}
