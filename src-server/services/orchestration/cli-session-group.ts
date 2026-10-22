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
import type { CliSessionGroupView } from '@kontourai/station-contracts/delegation-group';
import {
  publishJsonFileWithOwnedLock,
  readJsonFile,
} from '@kontourai/station-shared/json-file-storage';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { z } from 'zod/v3';
import { buildSyntheticTrustBundle } from '../evidence/trust-bundle.js';
import { awaitWithAbort } from './delegation-group-transport.js';

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
const recordSchema = z
  .object({
    version: z.literal(1),
    groupId: id,
    ownerKey: z.string().length(64),
    intentDigest: z.string().length(64),
    revision: z.number().int().nonnegative(),
    maxConcurrent: z.number().int().min(1).max(32),
    deadlineAt: z.number().int().positive(),
    cancelled: z.boolean(),
    flowReady: z.boolean(),
    dispatchCount: z.number().int().min(0).max(32),
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
            terminalObservedAt: z.string().datetime().optional(),
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

export class CliSessionGroupDispatchRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super('The delegated session did not return an accepted handle.');
    this.name = 'CliSessionGroupDispatchRefusal';
  }
}

export interface CliSessionGroupHost<T> {
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
  }>;
  interrupt(handle: MemberHandle): Promise<void>;
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

  private read(groupId: string, owner: string): GroupRecord {
    const value = readJsonFile(this.path(groupId), null, {
      maxBytes: MAX_BYTES,
      label: 'CLI session group',
    });
    if (value === null) throw new CliSessionGroupUnavailable('group_not_found');
    const record = recordSchema.parse(value);
    if (record.groupId !== groupId || record.ownerKey !== digest(owner))
      throw new CliSessionGroupUnavailable('group_not_found');
    for (const seat of record.seats) this.parseInput(seat.input);
    if (
      new Set(record.seats.map((s) => s.seatId)).size !== record.seats.length ||
      record.dispatchCount !==
        record.seats.filter((s) => s.state !== 'pending').length ||
      record.seats.some(
        (s) => (s.state === 'started' || s.state === 'terminal') && !s.handle,
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
      const result = work(record);
      record.revision += 1;
      recordSchema.parse(record);
      await publishJsonFileWithOwnedLock(path, record, { maxBytes: MAX_BYTES });
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
      deadlineAt: number;
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
        deadlineAt: input.deadlineAt,
        cancelled: false,
        flowReady: false,
        dispatchCount: 0,
        seats: input.seats.map((s) => ({ ...s, state: 'pending' })),
        scheduleEvents: [],
      });
      if (
        new Set(record.seats.map((s) => s.seatId)).size !== record.seats.length
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

  async list(
    owner: string,
    afterGroupId?: string,
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
      if (record.ownerKey !== digest(owner)) continue;
      if (groups.length === 16) {
        hasMore = true;
        break;
      }
      const group = await this.view(groupId, owner);
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

  async view(groupId: string, owner: string): Promise<CliSessionGroupView> {
    const record = this.read(groupId, owner);
    const flow = record.flowReady
      ? await loadRun(groupId, join(this.root, groupId))
      : null;
    return {
      version: 'station.cli-session-group/v1',
      groupId,
      revision: record.revision,
      supervision: this.active.has(groupId) ? 'active' : 'not-running',
      cancelled: record.cancelled,
      deadlineAt: record.deadlineAt,
      maxConcurrent: record.maxConcurrent,
      dispatchCount: record.dispatchCount,
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
          terminalEvent,
          dispatchFailure,
        }),
      ),
    };
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
  ): Promise<void> {
    const seatId = execution.claim.step_id;
    const launch = await this.mutate(groupId, owner, (record) => {
      host.assertCurrent();
      execution.signal.throwIfAborted();
      if (record.cancelled || Date.now() >= record.deadlineAt)
        throw new CliSessionGroupUnavailable('group_closed');
      const seat = record.seats.find((s) => s.seatId === seatId);
      if (!seat) throw new CliSessionGroupUnavailable('group_invalid');
      if (seat.state !== 'pending')
        return { seat: structuredClone(seat), dispatch: false };
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
      return { seat: structuredClone(seat), dispatch: true };
    });
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
          });
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
      await this.requestInterrupt(host, handle);
      throw error;
    }
  }
}
