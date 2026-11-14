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
  CliSessionGroupEventPage,
  CliSessionGroupPresetIdentity,
  CliSessionGroupView,
} from '@kontourai/station-contracts/delegation-group';
import {
  publishJsonFileWithOwnedLock,
  readJsonFile,
} from '@kontourai/station-shared/json-file-storage';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { z } from 'zod/v3';
import { buildSyntheticTrustBundle } from '../evidence/trust-bundle.js';
import { awaitWithAbort, pageByBytes } from './delegation-group-transport.js';

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
const attentionSchema = z
  .object({
    kind: z.enum(['needs-input', 'review-pending', 'blocked']),
    observedAt: z.string().datetime(),
    request: z
      .object({
        id: z.string().min(1).max(512),
        eventId: z.string().min(1).max(512).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const memberViewSchema = z.object({
  seatId: id,
  needs: z.array(id).max(32),
  state: z.enum(['pending', 'launch-intent', 'started', 'terminal']),
  claimId: z.string().max(512).optional(),
  reservedSessionId: z.string().max(512).optional(),
  initialClientTurnId: z.string().max(512).optional(),
  handle: handleSchema.optional(),
  outcome: z.enum(['completed', 'failed', 'canceled']).optional(),
  attention: attentionSchema.optional(),
  terminalEvent: terminalEventSchema.optional(),
  dispatchFailure: z
    .object({
      status: z.number().int().min(400).max(599),
      code: z.string().max(128),
    })
    .strict()
    .optional(),
});
const scheduleEventSchema = z
  .object({
    kind: z.string().max(32),
    stepId: id,
    claimId: z.string().max(512),
  })
  .strict();
const syncSchema = z
  .object({
    operationId: id,
    runId: id,
    contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    timestamp: z.string().datetime(),
    status: z.enum(['syncing', 'acknowledged', 'incomplete']),
    members: z
      .array(
        z
          .object({
            seatId: id,
            status: z.enum(['pending', 'acknowledged', 'failed', 'unknown']),
            attempts: z.number().int().min(0).max(2),
            timestamp: z.string().datetime().optional(),
            turnId: z.string().min(1).max(512).optional(),
            terminalEventId: z.string().min(1).max(512).optional(),
            toolCalls: z.number().int().min(0).max(1_000_000).optional(),
            nativeIdentityHash: z
              .string()
              .regex(/^sha256:[0-9a-f]{64}$/)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();
const groupEventSchema = z
  .object({
    revision: z.number().int().positive().safe(),
    members: z.array(memberViewSchema).max(32),
    cancelled: z.boolean().optional(),
    admissionClosed: z.literal('dispatch-limit-exhausted').optional(),
    contextSync: syncSchema.optional(),
    schedule: z.array(scheduleEventSchema).max(32),
  })
  .strict();
const recordSchema = z
  .object({
    version: z.literal(1),
    groupId: id,
    ownerKey: z.string().length(64),
    intentDigest: z.string().length(64),
    revision: z.number().int().nonnegative(),
    eventHistoryStart: z.number().int().positive().safe().optional(),
    events: z.array(groupEventSchema).max(4096).optional(),
    maxConcurrent: z.number().int().min(1).max(32),
    maxDispatches: z.number().int().min(0).max(32).optional(),
    deadlineAt: z.number().int().positive(),
    cancelled: z.boolean(),
    flowReady: z.boolean(),
    dispatchCount: z.number().int().min(0).max(32),
    admissionClosed: z.literal('dispatch-limit-exhausted').optional(),
    preset: z
      .object({
        presetId: z.string().min(1).max(64),
        name: z.string().min(1).max(128),
        sha256: z
          .string()
          .max(71)
          .regex(/^sha256:[0-9a-f]{64}$/),
        stationmaster: id,
        members: z
          .array(
            z
              .object({
                seatId: id,
                codename: z
                  .string()
                  .min(1)
                  .max(64)
                  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
                color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
                role: z
                  .string()
                  .min(1)
                  .max(512)
                  .refine((value) => value.trim().length > 0),
              })
              .strict(),
          )
          .min(1)
          .max(16)
          .optional(),
      })
      .strict()
      .optional(),
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
            outcome: z.enum(['completed', 'failed', 'canceled']).optional(),
            attention: attentionSchema.optional(),
            terminalObservedAt: z.string().datetime().optional(),
            notDispatched: z.literal(true).optional(),
            terminalEvent: terminalEventSchema.optional(),
            dispatchFailure: z
              .object({
                status: z.number().int().min(400).max(599),
                code: z.string().max(128),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    syncs: z.array(syncSchema).max(8).optional(),
    scheduleEvents: z.array(scheduleEventSchema).max(4096),
  })
  .strict();
type GroupRecord = z.infer<typeof recordSchema>;
type MemberHandle = z.infer<typeof handleSchema>;
function presetRosterMatchesSeats(
  record: Pick<GroupRecord, 'preset' | 'seats'>,
): boolean {
  const members = record.preset?.members;
  return (
    members === undefined ||
    (members.length === record.seats.length &&
      new Set(members.map((member) => member.seatId)).size === members.length &&
      new Set(members.map((member) => member.codename.toLowerCase())).size ===
        members.length &&
      record.seats.every((seat) =>
        members.some((member) => member.seatId === seat.seatId),
      ))
  );
}
const digest = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const MAX_BYTES = 1024 * 1024;

export class CliSessionGroupUnavailable extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CliSessionGroupUnavailable';
  }
}

export class CliSessionGroupDispatchRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly admission: 'unknown' | 'not-dispatched' = 'unknown',
  ) {
    super('The delegated session did not return an accepted handle.');
    this.name = 'CliSessionGroupDispatchRefusal';
  }
}

export interface CliSessionGroupRunAdmission {
  prepareDispatch(seatId: string): Promise<() => void>;
  invokeDispatch?<R>(seatId: string, sessionId: string, work: () => R): R;
}

export interface CliSessionGroupHost<T> {
  prepareRun?(input: {
    groupId: string;
    intentDigest: string;
    members: Array<{ seatId: string; input: T }>;
    signal: AbortSignal;
  }): Promise<CliSessionGroupRunAdmission>;
  assertCurrent(): void;
  dispatch(
    input: T,
    admission: {
      assertCurrent(): void;
      signal: AbortSignal;
      sessionId: string;
      initialClientTurnId: string;
    },
  ): Promise<unknown>;
  observe(handle: MemberHandle): Promise<{
    status: string;
    sessionId: string;
    completedEvent?: { eventId: string; turnId: string };
    terminalEvent?: { eventId: string; turnId: string };
    pendingRequest?: { id: string; eventId?: string };
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
  ): Promise<{
    sessionId: string;
    turnId: string;
    terminalEventId: string;
    nativeIdentityHash: string;
    output: string;
    toolCalls: number;
  }>;
}

/** Station owns session authority; Flow owns readiness, claims and gate evaluation. */
export class CliSessionGroups<T> {
  private readonly root: string;
  private readonly active = new Map<string, AbortController>();
  private readonly listeners = new Map<string, Set<() => void>>();

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

  private read(
    groupId: string,
    owner: string,
    authorizeInspection?: () => void,
  ): GroupRecord {
    const value = readJsonFile(this.path(groupId), null, {
      maxBytes: MAX_BYTES,
      label: 'CLI session group',
    });
    if (value === null) throw new CliSessionGroupUnavailable('group_not_found');
    const record = recordSchema.parse(value);
    if (record.groupId !== groupId)
      throw new CliSessionGroupUnavailable('group_not_found');
    if (record.ownerKey !== digest(owner)) {
      if (!authorizeInspection)
        throw new CliSessionGroupUnavailable('group_not_found');
      authorizeInspection();
    }
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
          (s.state === 'started' || s.state === 'terminal') &&
          !s.handle &&
          !(
            s.state === 'terminal' &&
            s.outcome === 'failed' &&
            s.notDispatched &&
            s.dispatchFailure
          ),
      ) ||
      !presetRosterMatchesSeats(record) ||
      (record.preset !== undefined &&
        !record.seats.some(
          (seat) => seat.seatId === record.preset?.stationmaster,
        ))
    )
      throw new CliSessionGroupUnavailable('group_storage_unavailable');
    if (
      (record.events === undefined) !==
        (record.eventHistoryStart === undefined) ||
      (record.events !== undefined &&
        (record.events.some(
          (event, index) =>
            event.revision !== (record.eventHistoryStart ?? 1) + index,
        ) ||
          (record.events.at(-1)?.revision ??
            (record.eventHistoryStart ?? 1) - 1) !== record.revision))
    )
      throw new CliSessionGroupUnavailable('group_storage_unavailable');
    if (
      new Set(record.syncs?.map((sync) => sync.operationId)).size !==
        (record.syncs?.length ?? 0) ||
      record.syncs?.some(
        (sync) =>
          sync.members.length !== record.seats.length ||
          new Set(sync.members.map((member) => member.seatId)).size !==
            sync.members.length ||
          sync.members.some(
            (member) =>
              !record.seats.some((seat) => seat.seatId === member.seatId) ||
              (member.status === 'acknowledged' &&
                (!member.attempts ||
                  !member.turnId ||
                  !member.terminalEventId ||
                  !member.nativeIdentityHash ||
                  member.toolCalls !== 0)),
          ) ||
          (sync.status === 'acknowledged' &&
            sync.members.some((member) => member.status !== 'acknowledged')),
      )
    )
      throw new CliSessionGroupUnavailable('group_storage_unavailable');
    return record;
  }

  private async mutate<R>(
    groupId: string,
    owner: string,
    work: (record: GroupRecord) => R,
  ): Promise<R> {
    const path = this.path(groupId);
    const release = await acquireFileMutationLockAsync(`${path}.mutation`);
    try {
      const record = this.read(groupId, owner);
      const before = new Map(
        record.seats.map((seat) => [
          seat.seatId,
          canonicalJson(memberViewSchema.parse(seat)),
        ]),
      );
      const cancelled = record.cancelled;
      const admissionClosed = record.admissionClosed;
      const scheduleCount = record.scheduleEvents.length;
      const syncBefore = canonicalJson(record.syncs?.at(-1) ?? null);
      record.eventHistoryStart ??= record.revision + 1;
      record.events ??= [];
      const result = work(record);
      record.revision += 1;
      record.events.push(
        groupEventSchema.parse({
          revision: record.revision,
          members: record.seats
            .map((seat) => memberViewSchema.parse(seat))
            .filter((seat) => canonicalJson(seat) !== before.get(seat.seatId)),
          ...(cancelled !== record.cancelled
            ? { cancelled: record.cancelled }
            : {}),
          ...(admissionClosed !== record.admissionClosed
            ? { admissionClosed: record.admissionClosed }
            : {}),
          ...(syncBefore !== canonicalJson(record.syncs?.at(-1) ?? null)
            ? { contextSync: record.syncs?.at(-1) }
            : {}),
          schedule: record.scheduleEvents.slice(scheduleCount),
        }),
      );
      let bytes = Buffer.byteLength(JSON.stringify(record)) + 32;
      let dropped = 0;
      while (
        dropped < record.events.length &&
        (record.events.length - dropped > 4096 || bytes > MAX_BYTES)
      ) {
        bytes -= Buffer.byteLength(JSON.stringify(record.events[dropped])) + 1;
        dropped++;
      }
      if (dropped) {
        record.events = record.events.slice(dropped);
        record.eventHistoryStart =
          record.events[0]?.revision ?? record.revision + 1;
      }
      recordSchema.parse(record);
      await publishJsonFileWithOwnedLock(path, record, {
        maxBytes: MAX_BYTES,
        indent: null,
      });
      for (const listener of this.listeners.get(groupId) ?? []) {
        try {
          listener();
        } catch {
          this.logger.warn?.('CLI session group observer failed', { groupId });
        }
      }
      return result;
    } finally {
      await release();
    }
  }

  async create(
    owner: string,
    operationId: string,
    input: {
      seats: { seatId: string; input: T; needs: string[] }[];
      maxConcurrent: number;
      maxDispatches?: number;
      deadlineAt: number;
      preset?: CliSessionGroupPresetIdentity;
    },
    assertCurrent: () => void,
  ): Promise<CliSessionGroupView> {
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
        let sameIntent = record.intentDigest === intentDigest;
        // Before retained rosters, preset identity had these four fields only.
        if (
          !sameIntent &&
          record.preset &&
          record.preset.members === undefined &&
          input.preset?.members !== undefined
        ) {
          const legacyPreset = {
            presetId: input.preset.presetId,
            name: input.preset.name,
            sha256: input.preset.sha256,
            stationmaster: input.preset.stationmaster,
          };
          sameIntent =
            record.intentDigest === digest({ ...input, preset: legacyPreset });
        }
        if (!sameIntent) throw new CliSessionGroupUnavailable('group_conflict');
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
        eventHistoryStart: 1,
        events: [],
        maxConcurrent: input.maxConcurrent,
        ...(input.maxDispatches === undefined
          ? {}
          : { maxDispatches: input.maxDispatches }),
        deadlineAt: input.deadlineAt,
        cancelled: false,
        flowReady: false,
        dispatchCount: 0,
        ...(input.preset ? { preset: input.preset } : {}),
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
      if (
        !presetRosterMatchesSeats(record) ||
        (record.preset &&
          !record.seats.some(
            (seat) => seat.seatId === record.preset?.stationmaster,
          ))
      )
        throw new CliSessionGroupUnavailable('group_invalid');
      for (const seat of record.seats) this.parseInput(seat.input);
      const cwd = join(this.root, groupId);
      mkdirSync(cwd, { mode: 0o700 });
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
        finalizeCommit: () => {
          assertCurrent();
        },
      });
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

  subscribe(groupId: string, listener: () => void): () => void {
    const listeners = this.listeners.get(groupId) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(groupId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size && this.listeners.get(groupId) === listeners)
        this.listeners.delete(groupId);
    };
  }

  async events(
    groupId: string,
    owner: string,
    afterRevision: number,
    authorizeInspection?: () => void,
  ): Promise<CliSessionGroupEventPage> {
    const record = this.read(groupId, owner, authorizeInspection);
    if (
      !Number.isSafeInteger(afterRevision) ||
      afterRevision < 0 ||
      afterRevision > record.revision
    )
      throw new CliSessionGroupUnavailable('group_stream_cursor_invalid');
    const availableFromRevision =
      record.eventHistoryStart ?? record.revision + 1;
    const after = Math.max(afterRevision, availableFromRevision - 1);
    const rows = (record.events ?? [])
      .filter((event) => event.revision > after)
      .map((value) => ({ cursor: value.revision, value }));
    const gap =
      afterRevision < availableFromRevision - 1
        ? { availableFromRevision }
        : undefined;
    const page = pageByBytes({
      rows,
      after,
      hasMore: false,
      maxItems: 64,
      maxBytes: 262_144,
      format: (
        events,
        unavailable,
        cursor,
        hasMore,
      ): CliSessionGroupEventPage => ({
        groupId,
        afterRevision,
        nextRevision: cursor,
        events,
        hasMore,
        ...(gap ? { gap } : {}),
        unavailable,
      }),
    });
    authorizeInspection?.();
    return page;
  }

  async list(
    owner: string,
    afterGroupId?: string,
    authorizeInspection?: () => void,
  ): Promise<{
    groups: CliSessionGroupView[];
    nextGroupId: string | null;
    hasMore: boolean;
  }> {
    if (afterGroupId !== undefined) id.parse(afterGroupId);
    const names = readdirSync(this.root)
      .filter((name) => name.endsWith('.json'))
      .sort();
    if (names.length > 128)
      throw new CliSessionGroupUnavailable('group_storage_unavailable');
    const groups: CliSessionGroupView[] = [];
    let hasMore = false;
    for (const name of names) {
      const groupId = id.parse(name.slice(0, -5));
      if (afterGroupId !== undefined && groupId <= afterGroupId) continue;
      const record = recordSchema.parse(
        readJsonFile(this.path(groupId), null, {
          maxBytes: MAX_BYTES,
          label: 'CLI session group',
        }),
      );
      if (record.groupId !== groupId)
        throw new CliSessionGroupUnavailable('group_storage_unavailable');
      if (record.ownerKey !== digest(owner)) {
        if (!authorizeInspection) continue;
        authorizeInspection();
      }
      if (groups.length === 16) {
        hasMore = true;
        break;
      }
      const group = await this.view(groupId, owner, authorizeInspection);
      if (
        Buffer.byteLength(
          JSON.stringify({
            success: true,
            data: {
              groups: [...groups, group],
              nextGroupId: groupId,
              hasMore: true,
            },
          }),
        ) > 262_144
      ) {
        if (!groups.length)
          throw new CliSessionGroupUnavailable('group_response_too_large');
        hasMore = true;
        break;
      }
      groups.push(group);
    }
    return {
      groups,
      nextGroupId: hasMore ? (groups.at(-1)?.groupId ?? null) : null,
      hasMore,
    };
  }

  async view(
    groupId: string,
    owner: string,
    authorizeInspection?: () => void,
    options?: { requireCurrent: boolean },
  ): Promise<CliSessionGroupView> {
    return this.#view(
      groupId,
      owner,
      authorizeInspection,
      undefined,
      options?.requireCurrent,
    );
  }

  async #view(
    groupId: string,
    owner: string,
    authorizeInspection?: () => void,
    syncSelection?: { operationId: string; replayed: boolean },
    requireCurrent = false,
  ): Promise<CliSessionGroupView> {
    const record = this.read(groupId, owner, authorizeInspection);
    const contextSync =
      syncSelection === undefined
        ? record.syncs?.at(-1)
        : record.syncs?.find(
            (sync) => sync.operationId === syncSelection.operationId,
          );
    if (syncSelection !== undefined && !contextSync)
      throw new CliSessionGroupUnavailable('group_sync_unavailable');
    const flow = record.flowReady
      ? await loadRun(groupId, join(this.root, groupId))
      : null;
    authorizeInspection?.();
    if (
      requireCurrent &&
      canonicalJson(this.read(groupId, owner, authorizeInspection)) !==
        canonicalJson(record)
    )
      throw new CliSessionGroupUnavailable('group_snapshot_changed');
    const supervising = this.active.has(groupId) && !syncSelection?.replayed;
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
              ...(!supervising && contextSync.status === 'syncing'
                ? { status: 'incomplete' as const }
                : {}),
            },
          }
        : {}),
      ...(record.preset ? { preset: record.preset } : {}),
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
          attention,
          terminalEvent,
          dispatchFailure,
        }) => ({
          seatId,
          needs,
          state,
          claimId,
          reservedSessionId,
          initialClientTurnId,
          handle,
          outcome,
          attention,
          terminalEvent,
          dispatchFailure,
        }),
      ),
    };
  }

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
    id.parse(input.operationId);
    id.parse(input.runId);
    if (
      !input.content.trim() ||
      Buffer.byteLength(input.content) > 128 * 1024 ||
      !Number.isSafeInteger(input.deadlineAt) ||
      input.deadlineAt <= Date.now() ||
      input.deadlineAt > Date.now() + 30 * 60_000
    )
      throw new CliSessionGroupUnavailable('group_invalid');
    host.assertCurrent();
    if (!host.sync || !host.prepareSync || this.active.has(groupId))
      throw new CliSessionGroupUnavailable('group_busy');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(abort, input.deadlineAt - Date.now());
    this.active.set(groupId, controller);
    const hash = `sha256:${createHash('sha256').update(input.content).digest('hex')}`;
    const assertCurrent = () => {
      host.assertCurrent();
      if (controller.signal.aborted || Date.now() >= input.deadlineAt)
        throw new CliSessionGroupUnavailable('group_sync_interrupted');
    };
    let created = false;
    const finalize = () =>
      this.mutate(groupId, owner, (record) => {
        const sync = record.syncs?.find(
          (sync) => sync.operationId === input.operationId,
        );
        if (sync?.status === 'syncing')
          sync.status = sync.members.every(
            (member) => member.status === 'acknowledged',
          )
            ? 'acknowledged'
            : 'incomplete';
      });
    try {
      await this.mutate(groupId, owner, (record) => {
        assertCurrent();
        const existing = record.syncs?.find(
          (sync) => sync.operationId === input.operationId,
        );
        if (existing) {
          if (existing.contentHash !== hash || existing.runId !== input.runId)
            throw new CliSessionGroupUnavailable('group_conflict');
          return;
        }
        if (
          record.cancelled ||
          record.syncs?.some(
            (sync) =>
              sync.status === 'syncing' ||
              sync.members.some((member) => member.status === 'unknown'),
          ) ||
          record.seats.some(
            (seat) =>
              seat.state !== 'terminal' ||
              seat.outcome !== 'completed' ||
              !seat.handle,
          ) ||
          (record.syncs?.length ?? 0) >= 8
        )
          throw new CliSessionGroupUnavailable('group_sync_unavailable');
        record.syncs ??= [];
        record.syncs.push({
          operationId: input.operationId,
          runId: input.runId,
          contentHash: hash,
          timestamp: new Date().toISOString(),
          status: 'syncing',
          members: record.seats.map((seat) => ({
            seatId: seat.seatId,
            status: 'pending',
            attempts: 0,
          })),
        });
        created = true;
      });
      if (!created)
        return await this.#view(groupId, owner, undefined, {
          operationId: input.operationId,
          replayed: true,
        });
      const seats = this.read(groupId, owner).seats;
      for (const seat of seats) {
        assertCurrent();
        if (!seat.handle)
          throw new CliSessionGroupUnavailable('group_sync_unavailable');
        await host.prepareSync(seat.handle);
        assertCurrent();
      }
      for (const seat of seats) {
        if (!seat.handle)
          throw new CliSessionGroupUnavailable('group_sync_unavailable');
        for (let attempt = 1; attempt <= 2; attempt++) {
          const clientTurnId = `sync-${digest([groupId, input.operationId, seat.seatId, attempt])}`;
          await this.mutate(groupId, owner, (record) => {
            assertCurrent();
            if (record.cancelled)
              throw new CliSessionGroupUnavailable('group_sync_interrupted');
            const member = record
              .syncs!.at(-1)!
              .members.find((member) => member.seatId === seat.seatId)!;
            if (
              member.attempts !== attempt - 1 ||
              (attempt === 2 && member.status !== 'failed')
            )
              throw new CliSessionGroupUnavailable('group_conflict');
            member.attempts = attempt;
            member.status = 'unknown';
            member.timestamp = new Date().toISOString();
          });
          try {
            assertCurrent();
            const result = await host.sync(seat.handle, {
              clientTurnId,
              signal: controller.signal,
              assertCurrent: () => {
                assertCurrent();
                const record = this.read(groupId, owner);
                const sync = record.syncs?.at(-1);
                const member = sync?.members.find(
                  (member) => member.seatId === seat.seatId,
                );
                if (
                  record.cancelled ||
                  sync?.operationId !== input.operationId ||
                  member?.attempts !== attempt ||
                  member.status !== 'unknown'
                )
                  throw new CliSessionGroupUnavailable(
                    'group_sync_interrupted',
                  );
              },
              prompt: `Retain the complete folded result below as context for this conversation. Use no tools. Reply with exactly ACK SYNC ${input.runId} and nothing else.\n\n${input.content}`,
            });
            assertCurrent();
            if (result.sessionId !== seat.handle.sessionId)
              throw new CliSessionGroupUnavailable(
                'group_sync_identity_changed',
              );
            const acknowledged =
              result.toolCalls === 0 &&
              result.output === `ACK SYNC ${input.runId}`;
            await this.mutate(groupId, owner, (record) => {
              assertCurrent();
              const member = record
                .syncs!.at(-1)!
                .members.find((member) => member.seatId === seat.seatId)!;
              member.status = acknowledged ? 'acknowledged' : 'failed';
              member.turnId = result.turnId;
              member.terminalEventId = result.terminalEventId;
              member.nativeIdentityHash = result.nativeIdentityHash;
              member.toolCalls = result.toolCalls;
              member.timestamp = new Date().toISOString();
            });
            if (acknowledged || result.toolCalls !== 0) break;
          } catch {
            // Reserved attempts are never resent after an uncertain result.
            break;
          }
        }
      }
      await finalize();
      return await this.#view(groupId, owner, undefined, {
        operationId: input.operationId,
        replayed: false,
      });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      try {
        if (created) await finalize();
      } finally {
        this.active.delete(groupId);
      }
    }
  }

  async cancel(
    groupId: string,
    owner: string,
    host: CliSessionGroupHost<T>,
  ): Promise<CliSessionGroupView> {
    await this.mutate(groupId, owner, (record) => {
      host.assertCurrent();
      record.cancelled = true;
    });
    this.active.get(groupId)?.abort();
    for (const seat of this.read(groupId, owner).seats) {
      if (seat.state === 'started' || seat.state === 'launch-intent') {
        host.assertCurrent();
        const reserved = seat.reservedSessionId!;
        await this.requestInterrupt(
          host,
          seat.handle ?? {
            taskId: reserved,
            conversationId: reserved,
            sessionId: reserved,
          },
        );
      }
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
    const controller = new AbortController();
    this.active.set(groupId, controller);
    const deadline = AbortSignal.timeout(
      Math.max(0, Math.min(2_147_483_647, record.deadlineAt - Date.now())),
    );
    const lifetime = AbortSignal.any([signal, controller.signal, deadline]);
    let admission: CliSessionGroupRunAdmission | undefined;
    let scheduling = false;
    try {
      if (
        record.preset &&
        !record.cancelled &&
        !record.admissionClosed &&
        record.dispatchCount < (record.maxDispatches ?? record.seats.length) &&
        record.seats.some((seat) => seat.state === 'pending')
      ) {
        lifetime.throwIfAborted();
        if (!host.prepareRun)
          throw new CliSessionGroupUnavailable('ensemble_auth_unsupported');
        admission = await host.prepareRun({
          groupId,
          intentDigest: record.intentDigest,
          members: record.seats.map((seat) => ({
            seatId: seat.seatId,
            input: this.parseInput(seat.input),
          })),
          signal: lifetime,
        });
        host.assertCurrent();
        lifetime.throwIfAborted();
      }
      scheduling = true;
      await orchestrateFlowMultiCursor({
        runId: groupId,
        cwd: join(this.root, groupId),
        actor: { key: record.ownerKey, kind: 'station-session-group' },
        maxConcurrent: record.maxConcurrent,
        maxRounds: record.seats.length,
        signal: lifetime,
        onEvent: (event) => this.recordEvent(groupId, owner, event),
        execute: (execution) =>
          this.execute(groupId, owner, host, execution, admission),
      });
    } catch (error) {
      if (!scheduling) throw error;
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
    host: CliSessionGroupHost<T>,
    handle: MemberHandle,
  ): Promise<void> {
    try {
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
    runAdmission?: CliSessionGroupRunAdmission,
  ): Promise<void> {
    const seatId = execution.claim.step_id;
    const pending =
      this.read(groupId, owner).seats.find((seat) => seat.seatId === seatId)
        ?.state === 'pending';
    let assertPrepared: (() => void) | undefined;
    try {
      assertPrepared = pending
        ? await runAdmission?.prepareDispatch(seatId)
        : undefined;
      assertPrepared?.();
    } catch (error) {
      if (
        error instanceof CliSessionGroupUnavailable &&
        /^ensemble_[a-z_]{1,110}$/.test(error.code)
      ) {
        await this.mutate(groupId, owner, (record) => {
          host.assertCurrent();
          execution.signal.throwIfAborted();
          const seat = record.seats.find((member) => member.seatId === seatId);
          if (seat?.state === 'pending')
            seat.dispatchFailure = { status: 409, code: error.code };
        });
      }
      throw error;
    }
    const launch = await this.mutate(groupId, owner, (record) => {
      host.assertCurrent();
      assertPrepared?.();
      execution.signal.throwIfAborted();
      if (record.cancelled || Date.now() >= record.deadlineAt)
        throw new CliSessionGroupUnavailable('group_closed');
      const seat = record.seats.find((s) => s.seatId === seatId);
      if (!seat) throw new CliSessionGroupUnavailable('group_invalid');
      if (seat.state !== 'pending')
        return {
          seat: structuredClone(seat),
          dispatch: false,
          exhausted: false,
        };
      if (
        record.admissionClosed ||
        record.dispatchCount >= (record.maxDispatches ?? record.seats.length)
      ) {
        record.admissionClosed = 'dispatch-limit-exhausted';
        return {
          seat: structuredClone(seat),
          dispatch: false,
          exhausted: true,
        };
      }
      const occupied = record.seats.filter(
        (s) => s.state === 'launch-intent' || s.state === 'started',
      ).length;
      if (occupied >= record.maxConcurrent)
        throw new CliSessionGroupUnavailable('group_capacity');
      seat.reservedSessionId = `task:${randomUUID()}`;
      seat.initialClientTurnId = randomUUID();
      seat.state = 'launch-intent';
      delete seat.dispatchFailure;
      seat.claimId = execution.claim.claim_id;
      record.dispatchCount += 1;
      if (
        record.dispatchCount >= (record.maxDispatches ?? record.seats.length) &&
        record.seats.some((member) => member.state === 'pending')
      )
        record.admissionClosed = 'dispatch-limit-exhausted';
      return { seat: structuredClone(seat), dispatch: true, exhausted: false };
    });
    if (launch.exhausted)
      throw new CliSessionGroupUnavailable('group_dispatch_limit');
    let handle = launch.seat.handle;
    if (launch.dispatch) {
      host.assertCurrent();
      execution.signal.throwIfAborted();
      const dispatch = () =>
        host.dispatch(this.parseInput(launch.seat.input), {
          signal: execution.signal,
          sessionId: z.string().min(1).parse(launch.seat.reservedSessionId),
          initialClientTurnId: z
            .string()
            .min(1)
            .parse(launch.seat.initialClientTurnId),
          assertCurrent: () => {
            host.assertCurrent();
            assertPrepared?.();
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
        });
      const dispatched = (
        runAdmission?.invokeDispatch
          ? runAdmission.invokeDispatch(
              seatId,
              z.string().min(1).parse(launch.seat.reservedSessionId),
              dispatch,
            )
          : dispatch()
      ).then(async (result) => {
        const accepted = handleSchema.parse(result);
        if (accepted.sessionId !== launch.seat.reservedSessionId)
          throw new CliSessionGroupUnavailable('group_session_changed');
        await this.mutate(groupId, owner, (record) => {
          const seat = record.seats.find((s) => s.seatId === seatId)!;
          seat.handle = accepted;
          seat.state = 'started';
        });
        return accepted;
      });
      // Losing work can still return its actual identity; retain it without authorizing a resend.
      void dispatched.catch(() => {});
      try {
        handle = await awaitWithAbort(dispatched, execution.signal);
      } catch (error) {
        if (error instanceof CliSessionGroupDispatchRefusal) {
          await this.mutate(groupId, owner, (record) => {
            const seat = record.seats.find((s) => s.seatId === seatId)!;
            seat.dispatchFailure = { status: error.status, code: error.code };
            if (error.admission === 'not-dispatched') {
              seat.state = 'terminal';
              seat.outcome = 'failed';
              seat.notDispatched = true;
              delete seat.attention;
            }
          });
          if (error.admission === 'not-dispatched') throw error;
        }
        const reserved = launch.seat.reservedSessionId!;
        await this.requestInterrupt(host, {
          taskId: reserved,
          conversationId: reserved,
          sessionId: reserved,
        });
        throw error;
      }
    }
    if (!handle) throw new CliSessionGroupUnavailable('group_start_unknown');
    if (launch.seat.state === 'terminal') {
      if (launch.seat.outcome !== 'completed')
        throw new CliSessionGroupUnavailable('group_member_failed');
      await this.recordCompletion(groupId, owner, seatId);
      return;
    }
    let lastAttention = launch.seat.attention;
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
            delete seat.attention;
            seat.outcome = outcome;
            seat.terminalObservedAt = new Date().toISOString();
            if (snapshot.completedEvent || snapshot.terminalEvent)
              seat.terminalEvent = terminalEventSchema.parse(
                snapshot.completedEvent ?? snapshot.terminalEvent,
              );
          });
          if (outcome !== 'completed')
            throw new CliSessionGroupUnavailable('group_member_failed');
          await this.recordCompletion(groupId, owner, seatId);
          return;
        }
        const kind =
          snapshot.status === 'needs_input'
            ? 'needs-input'
            : snapshot.status === 'review_pending'
              ? 'review-pending'
              : snapshot.status === 'blocked'
                ? 'blocked'
                : undefined;
        const nextAttention = kind
          ? {
              kind,
              ...(snapshot.pendingRequest
                ? { request: snapshot.pendingRequest }
                : {}),
            }
          : undefined;
        const previous = lastAttention
          ? {
              kind: lastAttention.kind,
              ...(lastAttention.request
                ? { request: lastAttention.request }
                : {}),
            }
          : undefined;
        if (
          canonicalJson(nextAttention ?? null) !==
          canonicalJson(previous ?? null)
        ) {
          const attention = nextAttention
            ? attentionSchema.parse({
                ...nextAttention,
                observedAt: new Date().toISOString(),
              })
            : undefined;
          await this.mutate(groupId, owner, (record) => {
            const seat = record.seats.find((entry) => entry.seatId === seatId)!;
            if (
              seat.state !== 'started' ||
              seat.handle?.initialTurnId !== handle?.initialTurnId
            )
              throw new CliSessionGroupUnavailable('group_session_changed');
            if (attention) seat.attention = attention;
            else delete seat.attention;
          });
          lastAttention = attention;
        }
        await delay(250, undefined, { signal: execution.signal });
      }
    } catch (error) {
      await this.requestInterrupt(host, handle);
      throw error;
    }
  }
}
