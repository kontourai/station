import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectTaskRoomAuthority } from '@kontourai/station-contracts/project-task-room';
import { PROJECT_TASK_ROOM_LIVE_HEARTBEAT_INTERVAL_MS } from '@kontourai/station-contracts/project-task-room-browser';
import type {
  TaskDispatchResult,
  TaskRecord,
} from '@kontourai/station-contracts/task-graph';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_LIVE_WORK_BOUNDS,
  type LiveWorkRecoveryState,
  LiveWorkSession,
} from '../../../domain/live-work-session.js';
import { SharedWorkingState } from '../../../domain/shared-working-state.js';
import { EventStore } from '../event-store.js';
import { projectTaskRoomDocumentId } from '../project-task-room-document-id.js';
import {
  canCollectLiveActivityRoom,
  LIVE_ACTIVITY_MAX_ROOM_SCAN,
  orderedLiveActivityEntries,
  type ProjectTaskRoomRequestAuthority,
  ProjectTaskRoomRuntime,
} from '../project-task-room-runtime.js';

const task = {
  id: 'task-1',
  projectId: 'project-1',
  title: 'Room task',
  description: '',
  priority: 'normal',
  status: 'ready',
  createdBy: 'operator',
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
} as const;

test('browser heartbeat cadence remains comfortably below live TTL', () => {
  expect(PROJECT_TASK_ROOM_LIVE_HEARTBEAT_INTERVAL_MS * 3).toBeLessThanOrEqual(
    DEFAULT_LIVE_WORK_BOUNDS.ttlMs,
  );
});

const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function hardExitRoomRuntime(
  path: string,
  phase: 'prepared' | 'post-commit' | 'mixed-prepared',
) {
  const eventStoreModule = new URL('../event-store.ts', import.meta.url).href;
  const runtimeModule = new URL(
    '../project-task-room-runtime.ts',
    import.meta.url,
  ).href;
  const source = `
    import { EventStore } from ${JSON.stringify(eventStoreModule)};
    import { ProjectTaskRoomRuntime } from ${JSON.stringify(runtimeModule)};
    const task={id:'task-1',projectId:'project-1',title:'Room task',description:'',priority:'normal',status:'ready',createdBy:'operator',createdAt:'2026-08-20T00:00:00.000Z',updatedAt:'2026-08-20T00:00:00.000Z'};
    const phase=process.argv[2];
    const store=new EventStore(process.argv[1]);
    const backing=store.createProjectTaskRoomWorkingState();
    const working={...backing,recovery:async(input)=>{
      const state=input?.value?.state;
      const result=await backing.recovery(input);
      if((phase==='prepared'||phase==='mixed-prepared')&&state?.pending?.some((item)=>item?.intent?.kind==='announce'&&!input?.value?.armedIntentIds?.includes(item?.intent?.intentId))&&(phase!=='mixed-prepared'||input?.value?.authorities?.some((item)=>item?.principal?.deviceId==='device-2'))) process.exit(88);
      if(phase==='post-commit'&&state?.terminal?.some((item)=>item?.intent?.kind==='announce'&&item?.result==='committed')) process.exit(86);
      return result;
    }};
    const runtime=new ProjectTaskRoomRuntime({
      taskGraph:{readTaskView:(id)=>id===task.id?task:null},
      projectForId:(id)=>id===task.projectId?{id,slug:'project'}:undefined,
      history:(authority)=>store.createProjectTaskRoomHistory({capabilities:authority.capabilities,agents:authority.agents}),
      working,
      requestAuthority:{resolve:async(request)=>{const deviceId=request.headers.get('x-room-device')??'device-1';return {kind:'granted',operatorId:'operator-1',deviceId,policyRevision:'pairing-v1'}}},
    });
    const first=new Request('http://station',{headers:{'x-room-device':'device-1'}});
    await runtime.discover({taskId:task.id,request:first});
    await runtime.live({taskId:task.id,request:first,command:'join'});
    await runtime.live({taskId:task.id,request:first,command:'announce'});
    if(phase==='mixed-prepared'){
      const second=new Request('http://station',{headers:{'x-room-device':'device-2'}});
      await runtime.live({taskId:task.id,request:second,command:'join'});
      await runtime.live({taskId:task.id,request:second,command:'announce'});
    }
    process.exit(87);
  `;
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', source, path, phase],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000 },
  );
}

function runtimeComposition(
  store: EventStore,
  options: {
    unavailableAfterCommitOnce?: boolean;
    taskRecord?: TaskRecord;
    requestAuthority?: ProjectTaskRoomRequestAuthority;
    maxRetainedOperations?: number;
    maxWorkingSnapshotBytes?: number;
    responseTimeoutMs?: number;
    readAgentLifecycle?: (input: { sessionId: string }) => Promise<
      | {
          provider: string;
          outcome?: 'completed' | 'failed' | 'cancelled';
        }
      | undefined
    >;
  } = {},
) {
  const taskRecord = options.taskRecord ?? task;
  let lifecycleAppendChecks = 0;
  const appendOutcomes: string[] = [];
  const runtime = new ProjectTaskRoomRuntime({
    taskGraph: {
      readTaskView: (id) => (id === taskRecord.id ? taskRecord : null),
    },
    projectForId: (id) =>
      id === task.projectId ? { id, slug: 'project' } : undefined,
    history: (authority) => {
      const history = store.createProjectTaskRoomHistory({
        capabilities: {
          resolve: async (input) => {
            if (input.required === 'lifecycle-append')
              lifecycleAppendChecks += 1;
            return authority.capabilities.resolve(input);
          },
        },
        agents: authority.agents,
        ...(options.unavailableAfterCommitOnce
          ? { unavailableAfterCommitOnce: true }
          : {}),
      });
      return {
        ...history,
        append: async (input: Parameters<typeof history.append>[0]) => {
          const outcome = await history.append(input);
          appendOutcomes.push(outcome.kind);
          return outcome;
        },
      };
    },
    working: store.createProjectTaskRoomWorkingState({
      ...(options.maxRetainedOperations
        ? { maxRetainedOperations: options.maxRetainedOperations }
        : {}),
      ...(options.maxWorkingSnapshotBytes
        ? { maxWorkingSnapshotBytes: options.maxWorkingSnapshotBytes }
        : {}),
      ...(options.responseTimeoutMs
        ? { responseTimeoutMs: options.responseTimeoutMs }
        : {}),
    }),
    requestAuthority: options.requestAuthority ?? {
      resolve: async () => ({
        kind: 'granted' as const,
        operatorId: 'operator-1',
        deviceId: 'device-1',
        policyRevision: 'pairing-v1',
      }),
    },
    ...(options.readAgentLifecycle
      ? { readAgentLifecycle: options.readAgentLifecycle }
      : {}),
  });
  return {
    runtime,
    lifecycleAppendChecks: () => lifecycleAppendChecks,
    appendOutcomes: () => appendOutcomes,
  };
}

function fixture(
  options: {
    hosted?: boolean;
    revoked?: boolean;
    receipt?: 'duplicate' | 'missing';
    agentLifecycle?: ConstructorParameters<
      typeof ProjectTaskRoomRuntime
    >[0]['working']['agentLifecycle'];
    revisionEvidence?: ConstructorParameters<
      typeof ProjectTaskRoomRuntime
    >[0]['revisionEvidence'];
    corruptRecovery?: boolean;
    revokeAfterRecoveryCheckpoint?: boolean;
    revokeOnRecoveryWrite?: number;
    revokeAfterWorkingRead?: boolean;
    recoveryValue?: unknown;
    readRecovery?: () => Promise<
      | { kind: 'available'; generation: string; value: unknown }
      | { kind: 'unavailable' }
    >;
    requestAuthority?: ProjectTaskRoomRequestAuthority;
  } = {},
) {
  const calls: unknown[] = [];
  const settled: unknown[] = [];
  const recoveryValues: unknown[] = [];
  let recoveryWrites = 0;
  let watches = 0;
  let unwatches = 0;
  let revoked = false;
  const room: ProjectTaskRoomAuthority = {
    open: async () => ({
      kind: 'opened',
      scope: {
        projectId: 'project-1',
        projectSlug: 'project',
        taskId: 'task-1',
      },
      channelId: 'channel-1',
      assurance: 'L0',
    }),
    read: async () => ({
      kind: 'available',
      records: [],
      hasMore: false,
      integrity: 'L0',
      checkpoint: {
        channelId: 'channel-1',
        epoch: 0,
        throughSeq: 0,
        checkpointDigest: 'a'.repeat(64),
        retainedAnchorSeq: 0,
        retainedAnchorDigest: 'b'.repeat(64),
      },
    }),
    append: async (input) => {
      calls.push(input);
      return {
        kind: 'committed',
        receipt: {
          schemaVersion: 'station.project-task-room-append-receipt/v1',
          proposalId: input.intent.proposalId,
          proposalDigest: 'a'.repeat(64),
          envelopeDigest: 'b'.repeat(64),
          coordinate: { channelId: 'channel-1', epoch: 0, seq: 1 },
          checkpoint: {
            channelId: 'channel-1',
            epoch: 0,
            throughSeq: 1,
            checkpointDigest: 'c'.repeat(64),
            retainedAnchorSeq: 0,
            retainedAnchorDigest: 'd'.repeat(64),
          },
          committedAt: '2026-08-20T00:00:00.000Z',
          assurance: 'L0',
        },
      };
    },
    close: async () => ({ kind: 'closed' }),
  };
  const runtime = new ProjectTaskRoomRuntime({
    taskGraph: { readTaskView: (id) => (id === task.id ? task : null) },
    projectForId: (id) =>
      id === task.projectId ? { id, slug: 'project' } : undefined,
    history: () => room,
    ...(options.revisionEvidence
      ? { revisionEvidence: options.revisionEvidence }
      : {}),
    working: {
      read: async () => {
        if (options.revokeAfterWorkingRead) revoked = true;
        return { kind: 'snapshot' as const, revision: 'empty', text: '' };
      },
      settle: async (input) => {
        settled.push(input);
        return {
          kind: 'committed',
          revision: 'next',
          text: 'next',
        };
      },
      receipt: async () =>
        options.receipt === 'duplicate'
          ? { kind: 'duplicate' as const, revision: 'persisted', text: 'hello' }
          : { kind: 'missing' as const },
      readRevisionPublication: async () => ({ kind: 'missing' as const }),
      markRevisionPublication: async () => 'unavailable' as const,
      removeRevisionPublication: async () => 'unavailable' as const,
      recovery: async (input) => {
        recoveryValues.push(input.value);
        recoveryWrites += 1;
        if (options.revokeAfterRecoveryCheckpoint && recoveryWrites >= 2)
          revoked = true;
        if (
          options.revokeOnRecoveryWrite !== undefined &&
          recoveryWrites >= options.revokeOnRecoveryWrite
        )
          revoked = true;
        return 'stored' as const;
      },
      readRecovery: async () =>
        options.readRecovery
          ? options.readRecovery()
          : options.recoveryValue
            ? {
                kind: 'available' as const,
                generation: 'old-generation',
                value: options.recoveryValue,
              }
            : options.corruptRecovery
              ? {
                  kind: 'available' as const,
                  generation: 'old-generation',
                  value: { malformed: true },
                }
              : { kind: 'unavailable' as const },
      privateSnapshot: async ({ scope }) =>
        new SharedWorkingState({ scope }).snapshot(),
      agentLifecycle: options.agentLifecycle ?? (async () => 'stored' as const),
      readAgentLifecycles: async () => [],
      removeAgentLifecycle: async () => 'removed' as const,
      watch: () => {
        watches += 1;
        return () => {
          unwatches += 1;
        };
      },
      close: async () => {},
    },
    hosted: () => options.hosted === true,
    requestAuthority: options.requestAuthority ?? {
      resolve: async () =>
        options.revoked || revoked
          ? { kind: 'revoked' as const }
          : {
              kind: 'granted' as const,
              operatorId: 'operator-1',
              deviceId: 'device-1',
              policyRevision: 'pairing-v1',
            },
    },
  });
  return {
    runtime,
    calls,
    settled,
    recoveryValues: () => recoveryValues,
    watches: () => watches,
    unwatches: () => unwatches,
  };
}

describe('ProjectTaskRoomRuntime', () => {
  test.each(['stored', 'unavailable'] as const)(
    'agent publication preparation requires the actual %s persistence result',
    async (outcome) => {
      const write = vi.fn(async () => outcome);
      const { runtime } = fixture({ agentLifecycle: write });
      const result: TaskDispatchResult = {
        task: { ...task, agentId: 'agent', sessionId: 'agent-session' },
        dispatch: {
          id: 'dispatch',
          taskId: task.id,
          sessionId: 'agent-session',
          provider: 'codex',
          outcome: 'started',
          createdAt: task.createdAt,
          sourceSurface: 'test',
        },
        session: {
          threadId: 'agent-session',
          provider: 'codex',
          status: 'ready',
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        },
        links: [],
      };
      try {
        if (outcome === 'stored')
          await expect(
            runtime.prepareAgentStarted(result),
          ).resolves.toBeUndefined();
        else
          await expect(runtime.prepareAgentStarted(result)).rejects.toThrow(
            'could not be stored',
          );
        expect(write).toHaveBeenCalledTimes(1);
        write.mockClear();
        const withoutAgent = {
          ...result,
          task: { ...task, sessionId: 'agent-session' },
        };
        await runtime.prepareAgentStarted(withoutAgent);
        await runtime.publishAgentStarted(withoutAgent);
        expect(write).not.toHaveBeenCalled();
      } finally {
        await runtime.close();
      }
    },
  );

  test.each([
    'committed',
    'duplicate',
    'throwing-observer',
    'revoked-subscriber',
  ] as const)(
    'gives %s document delivery an event-loop turn before synchronous evidence validation',
    async (mode) => {
      const order: string[] = [];
      let armed = false;
      let revoked = false;
      const { runtime } = fixture({
        ...(mode === 'duplicate' ? { receipt: 'duplicate' } : {}),
        requestAuthority: {
          resolve: async (request) => {
            const deviceId = request.headers.get('x-room-device') ?? 'writer';
            return revoked && deviceId === 'subscriber'
              ? { kind: 'revoked' }
              : {
                  kind: 'granted',
                  operatorId: 'operator-1',
                  deviceId,
                  policyRevision: 'pairing-v1',
                };
          },
        },
        revisionEvidence: {
          available: () => {
            if (armed) {
              order.push('evidence-validation');
              // Model the actual synchronous ledger restore, without making
              // elapsed time itself the assertion or weakening validation.
              const until = performance.now() + 30;
              while (performance.now() < until) {}
            }
            return false;
          },
          recordPublication: () => ({ kind: 'unavailable' }),
          links: { resolve: async () => ({ kind: 'unavailable' }) },
          close: () => {},
        },
      });
      const writer = new Request('http://station', {
        headers: { 'x-room-device': 'writer' },
      });
      const subscription = await runtime.subscribe({
        taskId: task.id,
        request: new Request('http://station', {
          headers: { 'x-room-device': 'subscriber' },
        }),
        emit: (event) => {
          if (!armed) return;
          const type = (event as { type?: unknown }).type;
          if (type !== 'document' && type !== 'terminal') return;
          order.push(String(type));
          setImmediate(() => order.push('delivery-turn'));
          if (mode === 'throwing-observer') throw new Error('observer failed');
        },
      });
      if (subscription.kind !== 'subscribed')
        throw new Error('expected subscription');
      subscription.activate();
      try {
        const plan =
          mode === 'duplicate'
            ? {
                kind: 'planned' as const,
                intentId: 'persisted-plan',
                digest: 'a'.repeat(64),
              }
            : await runtime.editPlan({
                taskId: task.id,
                request: writer,
                intentId: 'publication-priority',
                desiredText: 'next',
                selection: { anchor: 4, focus: 4 },
              });
        if (plan.kind !== 'planned') throw new Error('expected plan');
        armed = true;
        revoked = mode === 'revoked-subscriber';
        const result = await runtime.submitBatch({
          taskId: task.id,
          request: writer,
          intentId: plan.intentId,
          intentDigest: plan.digest,
        });
        expect(result.kind).toBe(
          mode === 'duplicate' ? 'duplicate' : 'committed',
        );
        expect(order).toEqual([
          mode === 'revoked-subscriber' ? 'terminal' : 'document',
          'delivery-turn',
          'evidence-validation',
        ]);
      } finally {
        subscription.unsubscribe();
        await runtime.close();
      }
    },
  );
  test('liveActivity: deterministically scans a bounded room prefix and caps authorized rooms', () => {
    const entries = Array.from(
      { length: LIVE_ACTIVITY_MAX_ROOM_SCAN + 12 },
      (_, index) => ({
        room: {
          scope: {
            projectId: 'project',
            taskId: `task-${String(LIVE_ACTIVITY_MAX_ROOM_SCAN + 11 - index).padStart(3, '0')}`,
            surfaceId: 'document',
          },
        },
      }),
    );
    const selected = orderedLiveActivityEntries(entries);
    expect(selected).toHaveLength(LIVE_ACTIVITY_MAX_ROOM_SCAN);
    expect(selected[0]?.room.scope.taskId).toBe('task-000');
    expect(selected.at(-1)?.room.scope.taskId).toBe('task-255');
    expect(canCollectLiveActivityRoom(63)).toBe(true);
    expect(canCollectLiveActivityRoom(64)).toBe(false);
  });
  test('liveActivity: projects only current published human and agent work without creating another room', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-live-activity-'));
    directories.push(directory);
    const store = new EventStore(join(directory, 'orchestration.sqlite'));
    const associatedTask: TaskRecord = {
      ...task,
      agentId: 'codex',
      sessionId: 'agent-session',
      dispatchedAt: task.createdAt,
    };
    const composed = runtimeComposition(store, { taskRecord: associatedTask });
    const request = new Request('http://station');
    await composed.runtime.discover({ taskId: task.id, request });
    await composed.runtime.live({ taskId: task.id, request, command: 'join' });
    await composed.runtime.live({
      taskId: task.id,
      request,
      command: 'announce',
    });
    await composed.runtime.publishAgentStarted({
      task: associatedTask,
      dispatch: {
        id: 'dispatch-live-activity',
        taskId: task.id,
        sessionId: 'agent-session',
        provider: 'codex',
        outcome: 'started',
        createdAt: task.createdAt,
        sourceSurface: 'task-dispatch',
      },
      session: {
        provider: 'codex',
        threadId: 'agent-session',
        status: 'running',
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      },
      links: [],
    } as any);
    const activity = await composed.runtime.liveActivity({ request });
    expect(activity).toMatchObject({ kind: 'available' });
    if (activity.kind !== 'available') throw new Error('expected activity');
    expect(activity.projection.participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: { kind: 'human', label: expect.any(String) },
        }),
        expect.objectContaining({
          actor: { kind: 'agent', label: 'codex' },
          work: expect.objectContaining({ sessionId: 'agent-session' }),
        }),
      ]),
    );
    await composed.runtime.close();
    store.close();
  });

  test('liveActivity: skips a private participant and removes departed work', async () => {
    let revoked = false;
    const { runtime } = fixture({
      requestAuthority: {
        resolve: async (request) => {
          const deviceId = request.headers.get('x-room-device') ?? 'private';
          return revoked
            ? { kind: 'revoked' as const }
            : {
                kind: 'granted' as const,
                operatorId: 'operator-1',
                deviceId,
                policyRevision: 'pairing-v1',
              };
        },
      },
    });
    const privateRequest = new Request('http://station', {
      headers: { 'x-room-device': 'private' },
    });
    const publishedRequest = new Request('http://station', {
      headers: { 'x-room-device': 'published' },
    });
    await runtime.live({
      taskId: task.id,
      request: privateRequest,
      command: 'join',
    });
    await runtime.live({
      taskId: task.id,
      request: publishedRequest,
      command: 'join',
    });
    await runtime.live({
      taskId: task.id,
      request: publishedRequest,
      command: 'announce',
    });
    await expect(
      runtime.liveActivity({ request: publishedRequest }),
    ).resolves.toMatchObject({
      kind: 'available',
      projection: { participants: [{ actor: { kind: 'human' } }] },
    });
    await runtime.live({
      taskId: task.id,
      request: publishedRequest,
      command: 'depart',
    });
    await expect(
      runtime.liveActivity({ request: publishedRequest }),
    ).resolves.toMatchObject({
      kind: 'available',
      projection: { participants: [] },
    });
    revoked = true;
    await expect(
      runtime.liveActivity({ request: privateRequest }),
    ).resolves.toMatchObject({
      kind: 'available',
      projection: { participants: [] },
    });
  });

  test('liveActivity: returns unavailable after close or in hosted mode', async () => {
    const hosted = fixture({ hosted: true }).runtime;
    await expect(
      hosted.liveActivity({ request: new Request('http://station') }),
    ).resolves.toEqual({ kind: 'unavailable' });
    const { runtime } = fixture();
    await runtime.close();
    await expect(
      runtime.liveActivity({ request: new Request('http://station') }),
    ).resolves.toEqual({ kind: 'unavailable' });
  });

  test('liveActivity: final authorization recheck withholds a mid-read revocation and persists nothing', async () => {
    let reading = false;
    let reads = 0;
    const fixtureValue = fixture({
      requestAuthority: {
        resolve: async () => {
          if (reading && ++reads >= 3) return { kind: 'revoked' as const };
          return {
            kind: 'granted' as const,
            operatorId: 'operator-1',
            deviceId: 'device-1',
            policyRevision: 'pairing-v1',
          };
        },
      },
    });
    const request = new Request('http://station');
    await fixtureValue.runtime.live({
      taskId: task.id,
      request,
      command: 'join',
    });
    await fixtureValue.runtime.live({
      taskId: task.id,
      request,
      command: 'announce',
    });
    const writesBefore = fixtureValue.recoveryValues().length;
    reading = true;
    await expect(
      fixtureValue.runtime.liveActivity({ request }),
    ).resolves.toMatchObject({
      kind: 'available',
      projection: { participants: [] },
    });
    expect(fixtureValue.recoveryValues()).toHaveLength(writesBefore);
  });

  test('liveActivity: projects watch state only for a currently visible target', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'station-live-activity-watch-'),
    );
    directories.push(directory);
    const store = new EventStore(join(directory, 'orchestration.sqlite'));
    const composed = runtimeComposition(store, {
      requestAuthority: {
        resolve: async (request) => {
          const deviceId = request.headers.get('x-room-device') ?? 'device-one';
          return {
            kind: 'granted' as const,
            operatorId: 'operator-1',
            deviceId,
            policyRevision: `credential:${deviceId}`,
          };
        },
      },
    });
    const first = new Request('http://station', {
      headers: { 'x-room-device': 'device-one' },
    });
    const second = new Request('http://station', {
      headers: { 'x-room-device': 'device-two' },
    });
    await composed.runtime.discover({ taskId: task.id, request: first });
    await composed.runtime.live({
      taskId: task.id,
      request: first,
      command: 'join',
    });
    await composed.runtime.live({
      taskId: task.id,
      request: first,
      command: 'announce',
    });
    await composed.runtime.live({
      taskId: task.id,
      request: second,
      command: 'join',
    });
    const secondAnnounced = await composed.runtime.live({
      taskId: task.id,
      request: second,
      command: 'announce',
    });
    if (
      secondAnnounced.kind !== 'available' ||
      secondAnnounced.snapshot.outcome !== 'available'
    )
      throw new Error('expected second live snapshot');
    const target = secondAnnounced.snapshot.snapshot.participants.find(
      (participant) =>
        participant.actor.actorId !== secondAnnounced.viewerActorId,
    );
    if (!target) throw new Error('expected visible target');
    await composed.runtime.live({
      taskId: task.id,
      request: second,
      command: 'watch',
      paneId: 'activity-test',
      targetActorId: target.actor.actorId,
    });
    const activity = await composed.runtime.liveActivity({ request: second });
    if (activity.kind !== 'available') throw new Error('expected activity');
    expect(
      activity.projection.participants.some(
        (participant) =>
          participant.watching?.state === 'watching' &&
          participant.watching.targetLabel === target.actor.label,
      ),
    ).toBe(true);
    await composed.runtime.live({
      taskId: task.id,
      request: first,
      command: 'depart',
    });
    const afterDeparture = await composed.runtime.liveActivity({
      request: second,
    });
    if (afterDeparture.kind !== 'available')
      throw new Error('expected activity after departure');
    expect(
      afterDeparture.projection.participants.some(
        (participant) => participant.watching !== undefined,
      ),
    ).toBe(false);
    await composed.runtime.close();
    store.close();
  });
  test('seeds exactly 10k canonical SQLite operations and distinguishes retained replay from fallback', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-room-perf-seed-'));
    directories.push(directory);
    const store = new EventStore(join(directory, 'orchestration.sqlite'));
    const { runtime } = runtimeComposition(store, {
      maxRetainedOperations: 10_000,
      maxWorkingSnapshotBytes: 16 * 1024 * 1024,
      responseTimeoutMs: 120_000,
    });
    const reader = store.createProjectTaskRoomWorkingState({
      maxRetainedOperations: 10_000,
      maxWorkingSnapshotBytes: 16 * 1024 * 1024,
      responseTimeoutMs: 120_000,
    });
    const scope = {
      projectId: task.projectId,
      taskId: task.id,
      documentId: projectTaskRoomDocumentId({
        projectId: task.projectId,
        taskId: task.id,
      }),
    };
    const seeded = await runtime.seedPerformanceOperations({
      taskId: task.id,
      count: 10_000,
    });
    expect(seeded).toMatchObject({
      kind: 'seeded',
      operationCount: 10_000,
      baseRevision: expect.stringMatching(/^swsr-v1:/),
      revision: expect.stringMatching(/^swsr-v1:/),
    });
    await expect(
      reader.read({ scope, after: seeded.baseRevision }),
    ).resolves.toMatchObject({
      kind: 'delta',
      revision: seeded.revision,
    });
    const beyond = await runtime.seedPerformanceOperations({
      taskId: task.id,
      count: 1,
    });
    expect(beyond.operationCount).toBe(1);
    await expect(
      reader.read({ scope, after: seeded.baseRevision }),
    ).resolves.toMatchObject({ kind: 'gap' });
    await reader.close();
    await runtime.close();
    store.close();
  }, 600_000);

  test('settles an associated agent edit with exact operation attribution and projects its live identity', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-room-agent-edit-'));
    directories.push(directory);
    const store = new EventStore(join(directory, 'orchestration.sqlite'));
    const associatedTask: TaskRecord = {
      ...task,
      agentId: 'agent-1',
      sessionId: 'session-1',
      createdBy: 'owner-1',
    };
    const backing = store.createProjectTaskRoomWorkingState();
    const operations: unknown[] = [];
    let settleAttempts = 0;
    const runtime = new ProjectTaskRoomRuntime({
      taskGraph: {
        readTaskView: (id) =>
          id === associatedTask.id ? associatedTask : null,
      },
      projectForId: (id) =>
        id === associatedTask.projectId ? { id, slug: 'project' } : undefined,
      history: (authority) =>
        store.createProjectTaskRoomHistory({
          capabilities: authority.capabilities,
          agents: authority.agents,
        }),
      working: {
        ...backing,
        settle: async (input) => {
          operations.push(...input.operations);
          settleAttempts += 1;
          if (settleAttempts === 1)
            return {
              kind: 'rejected' as const,
              reason: 'revision-publication-pending' as const,
            };
          return backing.settle(input);
        },
      },
      requestAuthority: {
        resolve: async () => ({
          kind: 'granted' as const,
          operatorId: 'owner-1',
          deviceId: 'device-1',
          policyRevision: 'pairing-v1',
        }),
      },
    });
    const request = new Request('http://station');
    await runtime.live({ taskId: task.id, request, command: 'join' });
    await runtime.publishAgentStarted({
      task: associatedTask,
      dispatch: {
        id: 'dispatch-1',
        taskId: task.id,
        sessionId: 'session-1',
        provider: 'task-dispatch',
        outcome: 'seeded',
        createdAt: task.createdAt,
        sourceSurface: 'e2e-task-room-control',
      },
      session: {
        provider: 'task-dispatch',
        threadId: 'session-1',
        status: 'running',
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      },
      links: [],
    });
    const edit = await runtime.publishAgentDocumentEdit({
      taskId: task.id,
      agentId: 'agent-1',
      sessionId: 'session-1',
      provider: 'task-dispatch',
      desiredText: 'Agent-authored text',
    });
    expect(edit).toMatchObject({
      kind: 'committed',
      text: 'Agent-authored text',
      sessionId: 'session-1',
      runId: 'orchestration:task-dispatch:session-1',
    });
    expect(settleAttempts).toBe(2);
    expect(operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: expect.objectContaining({
            kind: 'agent',
            displayLabel: 'agent-1',
          }),
          attribution: {
            projectId: 'project-1',
            taskId: 'task-1',
            agentSessionId: 'session-1',
            runId: 'orchestration:task-dispatch:session-1',
            correlationId: 'agent-edit:task-1:session-1',
          },
        }),
      ]),
    );
    const live = await runtime.live({
      taskId: task.id,
      request,
      command: 'heartbeat',
    });
    expect(live).toMatchObject({
      kind: 'available',
      snapshot: {
        snapshot: {
          participants: expect.arrayContaining([
            {
              actor: expect.objectContaining({
                kind: 'agent',
                label: 'agent-1',
              }),
              work: expect.objectContaining({
                sessionId: 'session-1',
                runId: 'orchestration:task-dispatch:session-1',
              }),
              publication: 'published',
            },
          ]),
        },
      },
    });
    await expect(
      runtime.document({ taskId: task.id, request }),
    ).resolves.toMatchObject({ text: 'Agent-authored text' });
    await runtime.close();
    store.close();
  });

  test('rolls back an agent edit when its Task association changes at the worker fence', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-room-agent-fence-'));
    directories.push(directory);
    const store = new EventStore(join(directory, 'orchestration.sqlite'));
    const associatedTask: TaskRecord = {
      ...task,
      agentId: 'agent-1',
      sessionId: 'session-1',
      createdBy: 'owner-1',
    };
    const backing = store.createProjectTaskRoomWorkingState();
    const runtime = new ProjectTaskRoomRuntime({
      taskGraph: {
        readTaskView: (id) =>
          id === associatedTask.id ? associatedTask : null,
      },
      projectForId: (id) =>
        id === associatedTask.projectId ? { id, slug: 'project' } : undefined,
      history: (authority) =>
        store.createProjectTaskRoomHistory({
          capabilities: authority.capabilities,
          agents: authority.agents,
        }),
      working: {
        ...backing,
        settle: async (input) => {
          associatedTask.sessionId = 'revoked-session';
          return backing.settle(input);
        },
      },
      requestAuthority: {
        resolve: async () => ({
          kind: 'granted' as const,
          operatorId: 'owner-1',
          deviceId: 'device-1',
          policyRevision: 'pairing-v1',
        }),
      },
    });
    await expect(
      runtime.publishAgentDocumentEdit({
        taskId: task.id,
        agentId: 'agent-1',
        sessionId: 'session-1',
        provider: 'task-dispatch',
        desiredText: 'must not commit',
      }),
    ).resolves.toEqual({ kind: 'not-found' });
    const snapshot = await backing.privateSnapshot({
      scope: {
        projectId: task.projectId,
        taskId: task.id,
        documentId: projectTaskRoomDocumentId({
          projectId: task.projectId,
          taskId: task.id,
        }),
      },
    });
    expect(
      new SharedWorkingState({
        scope: snapshot!.scope,
        snapshot: snapshot!,
      }).text(),
    ).toBe('');
    await runtime.close();
    store.close();
  });

  test('publishes the exact dispatch-associated agent as a server-only room author', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-room-runtime-'));
    directories.push(directory);
    const store = new EventStore(join(directory, 'orchestration.sqlite'));
    const associatedTask = {
      ...task,
      agentId: 'agent-1',
      sessionId: 'session-1',
      createdBy: 'owner-1',
    };
    const runtime = new ProjectTaskRoomRuntime({
      taskGraph: {
        readTaskView: (id) =>
          id === associatedTask.id ? associatedTask : null,
      },
      projectForId: (id) =>
        id === associatedTask.projectId ? { id, slug: 'project' } : undefined,
      history: (authority) =>
        store.createProjectTaskRoomHistory({
          capabilities: authority.capabilities,
          agents: authority.agents,
        }),
      working: store.createProjectTaskRoomWorkingState(),
      requestAuthority: {
        resolve: async () => ({
          kind: 'granted' as const,
          operatorId: 'owner-1',
          deviceId: 'device-1',
          policyRevision: 'pairing-v1',
        }),
      },
    });
    // Models a process that died after graph association but before it could
    // persist the room outbox record. Startup reconstructs this one idempotent
    // publication from the Task association; it never retries the provider.
    await runtime.reconcileAgentLifecycles([associatedTask.id]);
    await runtime.publishAgentStarted({
      task: associatedTask,
      dispatch: {
        id: 'dispatch-1',
        taskId: associatedTask.id,
        sessionId: 'session-1',
        provider: 'claude',
        outcome: 'started',
        createdAt: '2026-08-20T00:00:00.000Z',
        sourceSurface: 'task-dispatch',
      },
      session: {
        provider: 'claude',
        threadId: 'session-1',
        status: 'running',
        createdAt: '2026-08-20T00:00:00.000Z',
        updatedAt: '2026-08-20T00:00:00.000Z',
      },
      links: [],
    });
    await runtime.publishAgentFinished({
      taskId: associatedTask.id,
      sessionId: 'session-1',
      provider: 'claude',
      outcome: 'completed',
    });
    await expect(
      runtime.discover({
        taskId: associatedTask.id,
        request: new Request('http://station'),
      }),
    ).resolves.toMatchObject({
      kind: expect.stringMatching(/opened|existing/),
    });
    const records = await runtime.history({
      taskId: associatedTask.id,
      request: new Request('http://station'),
    });
    expect(records).toMatchObject({
      kind: 'available',
      records: [
        {
          principal: {
            kind: 'agent',
            agentId: 'agent-1',
            ownerOperatorId: 'owner-1',
          },
          body: { kind: 'live-work-started', sessionId: 'session-1' },
        },
        {
          principal: { kind: 'agent', agentId: 'agent-1' },
          body: {
            kind: 'live-work-finished',
            sessionId: 'session-1',
            outcome: 'completed',
          },
        },
      ],
    });
    await runtime.close();
    store.close();
  });

  test('reconstructs a terminal agent room record from the durable-session reader after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-room-runtime-'));
    directories.push(directory);
    const store = new EventStore(join(directory, 'orchestration.sqlite'));
    const associatedTask: TaskRecord = {
      ...task,
      agentId: 'agent-1',
      sessionId: 'session-terminal',
      createdBy: 'owner-1',
    };
    const readAgentLifecycle = vi.fn(async () => ({
      provider: 'claude',
      outcome: 'failed' as const,
    }));
    const composed = runtimeComposition(store, {
      taskRecord: associatedTask,
      readAgentLifecycle,
    });

    await composed.runtime.reconcileAgentLifecycles([associatedTask.id]);
    const history = await composed.runtime.history({
      taskId: associatedTask.id,
      request: new Request('http://station'),
    });
    expect(readAgentLifecycle).toHaveBeenCalledWith({
      sessionId: 'session-terminal',
    });
    expect(history).toMatchObject({
      kind: 'available',
      records: [
        { body: { kind: 'live-work-started', sessionId: 'session-terminal' } },
        {
          body: {
            kind: 'live-work-finished',
            sessionId: 'session-terminal',
            outcome: 'failed',
          },
        },
      ],
    });
    await composed.runtime.close();
    store.close();
  });

  test('reconstructs the exact running agent provider and run link after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-room-runtime-'));
    directories.push(directory);
    const store = new EventStore(join(directory, 'orchestration.sqlite'));
    const associatedTask: TaskRecord = {
      ...task,
      agentId: 'agent-1',
      sessionId: 'session-running',
      createdBy: 'owner-1',
    };
    const readAgentLifecycle = vi.fn(async () => ({
      provider: 'task-dispatch',
    }));
    const composed = runtimeComposition(store, {
      taskRecord: associatedTask,
      readAgentLifecycle,
    });
    await composed.runtime.reconcileAgentLifecycles([associatedTask.id]);
    const live = await composed.runtime.live({
      taskId: associatedTask.id,
      request: new Request('http://station'),
      command: 'join',
    });
    expect(readAgentLifecycle).toHaveBeenCalledWith({
      sessionId: 'session-running',
    });
    expect(live).toMatchObject({
      kind: 'available',
      snapshot: {
        snapshot: {
          participants: expect.arrayContaining([
            expect.objectContaining({
              actor: expect.objectContaining({
                kind: 'agent',
                label: 'agent-1',
              }),
              work: expect.objectContaining({
                sessionId: 'session-running',
                runId: 'orchestration:task-dispatch:session-running',
              }),
              publication: 'published',
            }),
          ]),
        },
      },
    });
    await composed.runtime.close();
    store.close();
  });

  test('uses one room-wide policy epoch across paired devices and the associated agent', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-room-runtime-'));
    directories.push(directory);
    const store = new EventStore(join(directory, 'orchestration.sqlite'));
    const associatedTask: TaskRecord = {
      ...task,
      createdBy: 'operator-1',
    };
    const composed = runtimeComposition(store, {
      taskRecord: associatedTask,
      requestAuthority: {
        resolve: async (request) => {
          const deviceId = request.headers.get('x-room-device');
          return deviceId === 'device-one' || deviceId === 'device-two'
            ? {
                kind: 'granted' as const,
                operatorId: 'operator-1',
                deviceId,
                policyRevision: `credential:${deviceId}`,
              }
            : { kind: 'revoked' as const };
        },
      },
    });
    const first = new Request('http://station', {
      headers: { 'x-room-device': 'device-one' },
    });
    const second = new Request('http://station', {
      headers: { 'x-room-device': 'device-two' },
    });
    await composed.runtime.discover({ taskId: task.id, request: first });
    // Task dispatch and status transitions legitimately mutate updatedAt. They
    // must not revoke a room whose policy has not changed.
    Object.assign(associatedTask, {
      agentId: 'agent-1',
      sessionId: 'session-policy',
      status: 'in_progress' as const,
      dispatchedAt: '2026-08-20T00:01:00.000Z',
      updatedAt: '2026-08-20T00:01:00.000Z',
    });
    await composed.runtime.message({
      taskId: task.id,
      request: first,
      proposalId: 'message-one',
      text: 'one',
    });
    await composed.runtime.message({
      taskId: task.id,
      request: second,
      proposalId: 'message-two',
      text: 'two',
    });
    await composed.runtime.publishAgentStarted({
      task: associatedTask,
      dispatch: {
        id: 'dispatch-policy',
        taskId: task.id,
        sessionId: 'session-policy',
        provider: 'claude',
        outcome: 'started',
        createdAt: task.createdAt,
        sourceSurface: 'task-dispatch',
      },
      session: {
        provider: 'claude',
        threadId: 'session-policy',
        status: 'running',
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      },
      links: [],
    });
    const history = await composed.runtime.history({
      taskId: task.id,
      request: first,
    });
    if (history.kind !== 'available') throw new Error('expected history');
    expect(
      new Set(history.records.map((record) => record.envelope.policyRevision))
        .size,
    ).toBe(1);
    expect(history.records.map((record) => record.principal.kind)).toEqual([
      'operator',
      'operator',
      'agent',
    ]);
    await composed.runtime.close();
    store.close();
  });
  test('keeps one fresh-generation live room per exact task document and derives the human actor', async () => {
    const { runtime } = fixture();
    const request = new Request('http://station');
    const joined = await runtime.live({
      taskId: 'task-1',
      request,
      command: 'join',
    });
    expect(joined).toMatchObject({
      kind: 'available',
      result: { outcome: 'joined' },
    });
    if (joined.kind !== 'available') throw new Error('expected live room');
    const heartbeat = await runtime.live({
      taskId: 'task-1',
      request,
      command: 'heartbeat',
    });
    expect(heartbeat).toMatchObject({
      kind: 'available',
      generation: joined.generation,
      result: { outcome: 'updated' },
    });
  });

  test('refreshes a same-principal rejoin while rotating only its private grant', async () => {
    const { runtime } = fixture();
    const request = new Request('http://station');
    await expect(
      runtime.live({ taskId: task.id, request, command: 'join' }),
    ).resolves.toMatchObject({
      kind: 'available',
      result: { outcome: 'joined' },
    });
    await expect(
      runtime.live({ taskId: task.id, request, command: 'announce' }),
    ).resolves.toMatchObject({
      kind: 'available',
      result: { outcome: 'updated' },
    });
    const refreshed = await runtime.live({
      taskId: task.id,
      request,
      command: 'join',
    });
    expect(refreshed).toMatchObject({
      kind: 'available',
      result: { outcome: 'refreshed' },
    });
    if (refreshed.kind !== 'available') throw new Error('expected refresh');
    const participant =
      refreshed.snapshot.outcome === 'available'
        ? refreshed.snapshot.snapshot.participants[0]
        : undefined;
    expect(participant?.publication).toBe('published');
    expect(refreshed.viewerActorId).toBe(participant?.actor.actorId);
  });

  test('does not publish a cursor when its actor is revoked across the worker read', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-room-cursor-fence-'));
    directories.push(directory);
    const store = new EventStore(join(directory, 'orchestration.sqlite'));
    const backing = store.createProjectTaskRoomWorkingState();
    let armed = false;
    let actorARevoked = false;
    const working = {
      ...backing,
      read: async (input: Parameters<typeof backing.read>[0]) => {
        const result = await backing.read(input);
        if (armed) actorARevoked = true;
        return result;
      },
    };
    const runtime = new ProjectTaskRoomRuntime({
      taskGraph: { readTaskView: (id) => (id === task.id ? task : null) },
      projectForId: (id) =>
        id === task.projectId ? { id, slug: 'project' } : undefined,
      history: (authority) =>
        store.createProjectTaskRoomHistory({
          capabilities: authority.capabilities,
          agents: authority.agents,
        }),
      working,
      requestAuthority: {
        resolve: async (request) => {
          const deviceId = request.headers.get('x-room-device');
          return deviceId === 'actor-b' ||
            (deviceId === 'actor-a' && !actorARevoked)
            ? {
                kind: 'granted' as const,
                operatorId: 'operator-1',
                deviceId,
                policyRevision: 'pairing-v1',
              }
            : { kind: 'revoked' as const };
        },
      },
    });
    const actorA = new Request('http://station', {
      headers: { 'x-room-device': 'actor-a' },
    });
    const actorB = new Request('http://station', {
      headers: { 'x-room-device': 'actor-b' },
    });
    for (const request of [actorA, actorB]) {
      await runtime.live({ taskId: task.id, request, command: 'join' });
      await runtime.live({ taskId: task.id, request, command: 'announce' });
    }
    const document = await runtime.document({
      taskId: task.id,
      request: actorA,
    });
    if (
      (document.kind !== 'snapshot' && document.kind !== 'delta') ||
      !document.revision
    )
      throw new Error('expected document revision');
    const delivered: unknown[] = [];
    const subscribed = await runtime.subscribe({
      taskId: task.id,
      request: actorB,
      emit: (event) => delivered.push(event),
    });
    if (subscribed.kind !== 'subscribed')
      throw new Error('expected actor B subscription');
    subscribed.activate();
    armed = true;
    await expect(
      runtime.live({
        taskId: task.id,
        request: actorA,
        command: 'cursor',
        generation: subscribed.initial.generation,
        workingRevision: document.revision,
        selection: { anchor: 0, focus: 0 },
      }),
    ).resolves.toEqual({ kind: 'not-found' });
    armed = false;
    const heartbeat = await runtime.live({
      taskId: task.id,
      request: actorB,
      command: 'heartbeat',
    });
    expect(heartbeat).toMatchObject({
      kind: 'available',
      snapshot: { outcome: 'available', snapshot: { cursors: [] } },
    });
    await vi.waitFor(() =>
      expect(
        delivered
          .filter(
            (
              event,
            ): event is {
              type: string;
              snapshot?: { snapshot?: { cursors?: unknown[] } };
            } =>
              !!event &&
              typeof event === 'object' &&
              (event as { type?: unknown }).type === 'live',
          )
          .flatMap((event) => event.snapshot?.snapshot?.cursors ?? []),
      ).toEqual([]),
    );
    subscribed.unsubscribe();
    await runtime.close();
    store.close();
  });

  test('distinguishes paired-device live actors and renews a same-device TTL closure safely', async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), 'station-room-runtime-'));
    directories.push(directory);
    const store = new EventStore(join(directory, 'orchestration.sqlite'));
    const composed = runtimeComposition(store, {
      requestAuthority: {
        resolve: async (request) => {
          const deviceId = request.headers.get('x-room-device');
          return deviceId === 'device-one' || deviceId === 'device-two'
            ? {
                kind: 'granted' as const,
                operatorId: 'operator-1',
                deviceId,
                policyRevision: `credential:${deviceId}`,
              }
            : { kind: 'revoked' as const };
        },
      },
    });
    const first = new Request('http://station', {
      headers: { 'x-room-device': 'device-one' },
    });
    const second = new Request('http://station', {
      headers: { 'x-room-device': 'device-two' },
    });
    vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z'));
    await composed.runtime.discover({ taskId: task.id, request: first });
    await composed.runtime.live({
      taskId: task.id,
      request: first,
      command: 'join',
    });
    await composed.runtime.live({
      taskId: task.id,
      request: first,
      command: 'announce',
    });
    const beforeRefresh = await composed.runtime.recovery({
      taskId: task.id,
      request: first,
    });
    if (beforeRefresh.kind !== 'available')
      throw new Error('expected recovery');
    const priorTtl = (beforeRefresh.value as LiveWorkRecoveryState)
      .lifecycles[0]?.identity.ttlClosureRequestId;
    vi.setSystemTime(new Date('2026-08-20T00:00:10.000Z'));
    await expect(
      composed.runtime.live({
        taskId: task.id,
        request: first,
        command: 'join',
      }),
    ).resolves.toMatchObject({ result: { outcome: 'refreshed' } });
    const afterRefresh = await composed.runtime.recovery({
      taskId: task.id,
      request: first,
    });
    if (afterRefresh.kind !== 'available') throw new Error('expected recovery');
    expect(
      (afterRefresh.value as LiveWorkRecoveryState).lifecycles[0]?.identity
        .ttlClosureRequestId,
    ).not.toBe(priorTtl);

    await composed.runtime.live({
      taskId: task.id,
      request: second,
      command: 'join',
    });
    const secondAnnounced = await composed.runtime.live({
      taskId: task.id,
      request: second,
      command: 'announce',
    });
    if (secondAnnounced.kind !== 'available') throw new Error('expected live');
    expect(
      new Set(
        secondAnnounced.snapshot.outcome === 'available'
          ? secondAnnounced.snapshot.snapshot.participants.map(
              (participant) => participant.actor.actorId,
            )
          : [],
      ).size,
    ).toBe(2);

    vi.setSystemTime(new Date('2026-08-20T00:00:41.000Z'));
    await expect(
      composed.runtime.subscriptionCadence({ taskId: task.id, request: first }),
    ).resolves.toBe(true);
    const history = await composed.runtime.history({
      taskId: task.id,
      request: first,
    });
    if (history.kind !== 'available') throw new Error('expected history');
    expect(
      history.records.some(
        (record) =>
          record.body.kind === 'live-work-presence-ended' &&
          record.body.reason === 'expired',
      ),
    ).toBe(true);
    await composed.runtime.close();
    store.close();
  });

  test('uses one monotonic time for material checkpoints and cadence projections', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-room-runtime-'));
    directories.push(directory);
    const store = new EventStore(join(directory, 'orchestration.sqlite'));
    const { runtime } = runtimeComposition(store);
    const request = new Request('http://station');
    const seedClock = vi.spyOn(Date, 'now').mockReturnValue(100);
    await runtime.discover({ taskId: task.id, request });
    await runtime.live({
      taskId: task.id,
      request,
      command: 'join',
    });
    seedClock.mockRestore();
    const materialClock = vi
      .spyOn(Date, 'now')
      // Old code sampled this in the pre-effect checkpoint, then used 150 for
      // the command and rejected it against the live session's safe clock.
      .mockReturnValueOnce(200)
      .mockReturnValueOnce(150);
    const announced = await runtime.live({
      taskId: task.id,
      request,
      command: 'announce',
    });
    expect(announced).toMatchObject({
      kind: 'available',
      result: { outcome: 'updated' },
      snapshot: { outcome: 'available' },
    });
    expect(materialClock).toHaveBeenCalledTimes(1);
    materialClock.mockRestore();

    const cadenceClock = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(31_000)
      .mockReturnValueOnce(30_000);
    await expect(
      runtime.subscriptionCadence({ taskId: task.id, request }),
    ).resolves.toBe(true);
    expect(cadenceClock).toHaveBeenCalledTimes(1);
    await runtime.close();
    store.close();
  });

  test('admits the intended 120 live transitions per minute without two checkpoint exports per command', async () => {
    const { runtime } = fixture();
    const request = new Request('http://station');
    await runtime.live({ taskId: task.id, request, command: 'join' });
    let outcome: unknown;
    for (let index = 0; index < 119; index += 1)
      outcome = await runtime.live({
        taskId: task.id,
        request,
        command: 'heartbeat',
      });
    expect(outcome).toMatchObject({ result: { outcome: 'updated' } });
  });

  test('admits 40 paired devices through 80 join and announce commands without internal budget charges', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-room-runtime-'));
    directories.push(directory);
    const store = new EventStore(join(directory, 'orchestration.sqlite'));
    const { runtime } = runtimeComposition(store, {
      requestAuthority: {
        resolve: async (request) => {
          const deviceId = request.headers.get('x-room-device');
          return deviceId && /^device-[0-9]+$/.test(deviceId)
            ? {
                kind: 'granted' as const,
                operatorId: 'operator-1',
                deviceId,
                policyRevision: `credential:${deviceId}`,
              }
            : { kind: 'revoked' as const };
        },
      },
    });
    const requests = Array.from(
      { length: 40 },
      (_, index) =>
        new Request('http://station', {
          headers: { 'x-room-device': `device-${index}` },
        }),
    );
    await runtime.discover({ taskId: task.id, request: requests[0]! });
    for (const request of requests)
      await expect(
        runtime.live({ taskId: task.id, request, command: 'join' }),
      ).resolves.toMatchObject({ result: { outcome: 'joined' } });
    for (const request of requests)
      await expect(
        runtime.live({ taskId: task.id, request, command: 'announce' }),
      ).resolves.toMatchObject({ result: { outcome: 'updated' } });
    await runtime.close();
    store.close();
  }, 30_000);
  test('derives scope and opaque authority from the server request, never the body', async () => {
    const { runtime, calls } = fixture();
    expect(
      await runtime.discover({
        taskId: 'task-1',
        request: new Request('http://station'),
      }),
    ).toMatchObject({
      kind: 'opened',
      scope: {
        projectId: 'project-1',
        projectSlug: 'project',
        taskId: 'task-1',
      },
    });
    await runtime.message({
      taskId: 'task-1',
      request: new Request('http://station'),
      proposalId: 'message-1',
      text: 'hello',
    });
    expect(calls[0]).toMatchObject({
      intent: {
        proposalId: 'message-1',
        body: { kind: 'human-message', text: 'hello' },
      },
    });
    expect(JSON.stringify(calls[0])).not.toContain('operator-1');
  });

  test('rechecks paired-device authority after a recovery checkpoint before material append', async () => {
    const { runtime, calls, recoveryValues } = fixture({
      revokeAfterRecoveryCheckpoint: true,
    });
    const request = new Request('http://station');
    await expect(
      runtime.live({ taskId: task.id, request, command: 'join' }),
    ).resolves.toMatchObject({ kind: 'available' });
    await expect(
      runtime.live({
        taskId: task.id,
        request,
        command: 'announce',
      }),
    ).resolves.toEqual({ kind: 'not-found' });
    expect(calls).toEqual([]);
    expect(recoveryValues().at(-1)).toMatchObject({
      state: { pending: [] },
      armedIntentIds: [],
    });
    expect(
      (recoveryValues().at(-1) as { authorities?: unknown[] }).authorities,
    ).toHaveLength(1);
  });

  test('returns no live projection when a checkpoint revokes the exact paired device', async () => {
    const { runtime } = fixture({ revokeOnRecoveryWrite: 1 });
    await expect(
      runtime.live({
        taskId: task.id,
        request: new Request('http://station'),
        command: 'join',
      }),
    ).resolves.toEqual({ kind: 'not-found' });
  });

  test('withholds a successful material result when its post-effect checkpoint revokes the device', async () => {
    const { runtime, calls } = fixture({ revokeOnRecoveryWrite: 4 });
    const request = new Request('http://station');
    await runtime.live({ taskId: task.id, request, command: 'join' });
    await expect(
      runtime.live({ taskId: task.id, request, command: 'announce' }),
    ).resolves.toEqual({ kind: 'not-found' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      intent: { body: { kind: 'live-work-started' } },
    });
  });

  test('awaits a finish history settlement before checkpointing its recovery image', async () => {
    const { runtime, calls } = fixture();
    const request = new Request('http://station');
    await runtime.live({
      taskId: task.id,
      request,
      command: 'join',
      requestId: 'join',
    });
    await runtime.live({
      taskId: task.id,
      request,
      command: 'announce',
      requestId: 'announce',
    });
    await expect(
      runtime.live({
        taskId: task.id,
        request,
        command: 'finish',
        requestId: 'finish',
        outcome: 'completed',
      }),
    ).resolves.toMatchObject({
      kind: 'available',
      result: { outcome: 'updated' },
    });
    expect(
      calls.some(
        (call) =>
          (call as { intent?: { body?: { kind?: string } } }).intent?.body
            ?.kind === 'live-work-finished',
      ),
    ).toBe(true);
  });

  test('makes missing task, changed authority, and hosted mode content-free unavailable', async () => {
    const ordinary = fixture().runtime;
    expect(
      await ordinary.discover({
        taskId: 'missing',
        request: new Request('http://station'),
      }),
    ).toEqual({ kind: 'not-found' });
    expect(
      await fixture({ revoked: true }).runtime.discover({
        taskId: 'task-1',
        request: new Request('http://station'),
      }),
    ).toEqual({ kind: 'not-found' });
    expect(
      await fixture({ hosted: true }).runtime.discover({
        taskId: 'task-1',
        request: new Request('http://station'),
      }),
    ).toEqual({ kind: 'not-found' });
  });

  test('revalidates the exact request principal after a working-state read before disclosure', async () => {
    let revoked = false;
    const guarded = new ProjectTaskRoomRuntime({
      taskGraph: { readTaskView: (id) => (id === task.id ? task : null) },
      projectForId: (id) =>
        id === task.projectId ? { id, slug: 'project' } : undefined,
      history: () =>
        ({
          open: async () => ({ kind: 'unavailable' }),
          read: async () => ({ kind: 'unavailable' }),
          append: async () => ({ kind: 'unavailable' }),
          close: async () => ({ kind: 'closed' }),
        }) as ProjectTaskRoomAuthority,
      working: {
        read: async () => {
          revoked = true;
          return { kind: 'snapshot' as const, revision: 'one', text: 'secret' };
        },
        settle: async () => ({ kind: 'unavailable' as const }),
        receipt: async () => ({ kind: 'missing' as const }),
        readRevisionPublication: async () => ({ kind: 'missing' as const }),
        markRevisionPublication: async () => 'unavailable' as const,
        removeRevisionPublication: async () => 'unavailable' as const,
        recovery: async () => 'unavailable' as const,
        readRecovery: async () => ({ kind: 'unavailable' as const }),
        privateSnapshot: async () => undefined,
        agentLifecycle: async () => 'stored' as const,
        readAgentLifecycles: async () => [],
        removeAgentLifecycle: async () => 'removed' as const,
        watch: () => () => {},
        close: async () => {},
      },
      requestAuthority: {
        resolve: async () =>
          revoked
            ? { kind: 'revoked' as const }
            : {
                kind: 'granted' as const,
                operatorId: 'operator-1',
                deviceId: 'device-1',
                policyRevision: 'pairing-v1',
              },
      },
    });
    await expect(
      guarded.document({
        taskId: task.id,
        request: new Request('http://station'),
      }),
    ).resolves.toEqual({ kind: 'not-found' });
    await guarded.close();
  });

  test('releases the room watch immediately when initial subscription authorization fails', async () => {
    const { runtime, watches, unwatches } = fixture({
      revokeAfterWorkingRead: true,
    });
    await expect(
      runtime.subscribe({
        taskId: task.id,
        request: new Request('http://station'),
        emit: () => {},
      }),
    ).resolves.toEqual({ kind: 'not-found' });
    expect(watches()).toBe(1);
    expect(unwatches()).toBe(1);
    await runtime.close();
    expect(unwatches()).toBe(1);
  });

  test('plans atom operations privately and settles only the exact issued receipt', async () => {
    const { runtime, settled } = fixture();
    const request = new Request('http://station');
    const plan = await runtime.editPlan({
      taskId: 'task-1',
      request,
      intentId: 'browser-intent',
      desiredText: 'hello',
      selection: { anchor: 5, focus: 5 },
    });
    expect(plan).toMatchObject({
      kind: 'planned',
      optimistic: { text: 'hello' },
      operationCount: 1,
    });
    expect(JSON.stringify(plan)).not.toContain('operationId');
    if (plan.kind !== 'planned') throw new Error('expected plan');
    expect(
      await runtime.submitBatch({
        taskId: 'task-1',
        request,
        intentId: plan.intentId,
        intentDigest: '0'.repeat(64),
      }),
    ).toEqual({ kind: 'rejected' });
    expect(
      await runtime.submitBatch({
        taskId: 'task-1',
        request,
        intentId: plan.intentId,
        intentDigest: plan.digest,
      }),
    ).toMatchObject({ kind: 'committed', text: 'next' });
    expect(settled).toHaveLength(1);
    expect(JSON.stringify(settled[0])).toContain('hello');
    expect(
      await runtime.submitBatch({
        taskId: 'task-1',
        request,
        intentId: plan.intentId,
        intentDigest: plan.digest,
      }),
    ).toMatchObject({ kind: 'committed' });
    expect(settled).toHaveLength(2);
  });

  test('does not hold a durable document projection behind an ephemeral live reauthorization', async () => {
    let holdLiveDelivery = false;
    let liveDeliveryBlocked = false;
    let liveDeliveryHeld = false;
    let releaseLiveDelivery = () => {};
    const liveDeliveryGate = new Promise<void>((resolve) => {
      releaseLiveDelivery = resolve;
    });
    const authority: ProjectTaskRoomRequestAuthority = {
      resolve: async (request) => {
        if (
          holdLiveDelivery &&
          !liveDeliveryHeld &&
          request.headers.get('x-room-device') === 'slow-subscriber'
        ) {
          liveDeliveryHeld = true;
          liveDeliveryBlocked = true;
          await liveDeliveryGate;
        }
        return {
          kind: 'granted',
          operatorId: 'operator-1',
          deviceId: request.headers.get('x-room-device') ?? 'writer',
          policyRevision: 'pairing-v1',
        };
      },
    };
    const { runtime } = fixture({ requestAuthority: authority });
    const writer = new Request('http://station', {
      headers: { 'x-room-device': 'writer' },
    });
    const subscriber = new Request('http://station', {
      headers: { 'x-room-device': 'slow-subscriber' },
    });
    const delivered: unknown[] = [];
    const subscription = await runtime.subscribe({
      taskId: task.id,
      request: subscriber,
      emit: (event) => delivered.push(event),
    });
    if (subscription.kind !== 'subscribed')
      throw new Error('expected subscription');
    subscription.activate();

    holdLiveDelivery = true;
    await runtime.live({
      taskId: task.id,
      request: writer,
      command: 'typing',
      active: true,
    });
    await vi.waitFor(() => expect(liveDeliveryBlocked).toBe(true));

    try {
      const plan = await runtime.editPlan({
        taskId: task.id,
        request: writer,
        intentId: 'prioritized-document',
        desiredText: 'durable text',
        selection: { anchor: 12, focus: 12 },
      });
      if (plan.kind !== 'planned') throw new Error('expected edit plan');
      await expect(
        runtime.submitBatch({
          taskId: task.id,
          request: writer,
          intentId: plan.intentId,
          intentDigest: plan.digest,
        }),
      ).resolves.toMatchObject({ kind: 'committed', text: 'next' });
      await vi.waitFor(() =>
        expect(
          delivered.some(
            (event) =>
              !!event &&
              typeof event === 'object' &&
              (event as { type?: unknown }).type === 'document',
          ),
        ).toBe(true),
      );
    } finally {
      releaseLiveDelivery();
      subscription.unsubscribe();
      await runtime.close();
    }
  });

  test('reauthorizes a durable document delivery exactly once', async () => {
    const resolvedDevices: string[] = [];
    const authority: ProjectTaskRoomRequestAuthority = {
      resolve: async (request) => {
        const deviceId = request.headers.get('x-room-device') ?? 'writer';
        resolvedDevices.push(deviceId);
        return {
          kind: 'granted',
          operatorId: 'operator-1',
          deviceId,
          policyRevision: 'pairing-v1',
        };
      },
    };
    const { runtime } = fixture({ requestAuthority: authority });
    const writer = new Request('http://station', {
      headers: { 'x-room-device': 'writer' },
    });
    const subscriber = new Request('http://station', {
      headers: { 'x-room-device': 'subscriber' },
    });
    const delivered: unknown[] = [];
    const subscription = await runtime.subscribe({
      taskId: task.id,
      request: subscriber,
      emit: (event) => delivered.push(event),
    });
    if (subscription.kind !== 'subscribed')
      throw new Error('expected subscription');
    subscription.activate();
    resolvedDevices.length = 0;

    try {
      const plan = await runtime.editPlan({
        taskId: task.id,
        request: writer,
        intentId: 'single-delivery-authorization',
        desiredText: 'durable text',
        selection: { anchor: 12, focus: 12 },
      });
      if (plan.kind !== 'planned') throw new Error('expected edit plan');
      await runtime.submitBatch({
        taskId: task.id,
        request: writer,
        intentId: plan.intentId,
        intentDigest: plan.digest,
      });
      await vi.waitFor(() =>
        expect(
          delivered.some(
            (event) =>
              !!event &&
              typeof event === 'object' &&
              (event as { type?: unknown }).type === 'document',
          ),
        ).toBe(true),
      );
      expect(
        resolvedDevices.filter((device) => device === 'subscriber'),
      ).toHaveLength(1);
    } finally {
      subscription.unsubscribe();
      await runtime.close();
    }
  });

  test('returns a durable duplicate after restart without retaining atom operations', async () => {
    const { runtime } = fixture({ receipt: 'duplicate' });
    const durableSettlement = vi.fn();
    expect(
      await runtime.submitBatch({
        taskId: 'task-1',
        request: new Request('http://station'),
        intentId: 'settled-before-restart',
        intentDigest: 'a'.repeat(64),
        onDurableSettlementForDiagnostic: durableSettlement,
      }),
    ).toMatchObject({ kind: 'duplicate', text: 'hello' });
    expect(durableSettlement).toHaveBeenCalledOnce();
  });

  test('fails closed rather than publishing a room from corrupt recovery state', async () => {
    const { runtime } = fixture({ corruptRecovery: true });
    expect(
      await runtime.live({
        taskId: 'task-1',
        request: new Request('http://station'),
        command: 'join',
      }),
    ).toEqual({ kind: 'unavailable' });
  });

  test('fails closed when a valid-shaped recovery image is bound to another room row', async () => {
    const documentId = `project-task-document-v1:${createHash('sha256')
      .update('project-1\u0000task-1')
      .digest('hex')}`;
    const scope = {
      projectId: 'project-1',
      taskId: 'task-1',
      surfaceId: documentId,
      sessionId: 'old-generation',
      channelId: `room:${documentId}`,
    };
    const source = new LiveWorkSession(
      scope,
      {},
      {},
      {
        recoveryAuthority: { authorize: () => true },
      },
    );
    const exported = source.exportRecovery(
      { kind: 'system', recoveryId: 'room-recovery:old-generation', scope },
      1,
    );
    if (exported.outcome !== 'available') throw new Error('expected recovery');
    const { runtime, calls } = fixture({
      recoveryValue: {
        ...exported.state,
        scope: { ...exported.state.scope, projectId: 'foreign-project' },
      },
    });
    await expect(
      runtime.live({
        taskId: task.id,
        request: new Request('http://station'),
        command: 'join',
      }),
    ).resolves.toEqual({ kind: 'unavailable' });
    expect(calls).toEqual([]);
  });

  test('close fences a recovery still awaiting its private persistence read', async () => {
    let release: ((value: { kind: 'unavailable' }) => void) | undefined;
    const pending = new Promise<{ kind: 'unavailable' }>((resolve) => {
      release = resolve;
    });
    const { runtime } = fixture({ readRecovery: async () => pending });
    const attempt = runtime.live({
      taskId: 'task-1',
      request: new Request('http://station'),
      command: 'join',
    });
    await runtime.close();
    release?.({ kind: 'unavailable' });
    await expect(attempt).resolves.toEqual({ kind: 'unavailable' });
  });

  test('retries a material pending intent once, then starts a fresh room without presence', async () => {
    const documentId = `project-task-document-v1:${createHash('sha256')
      .update('project-1\u0000task-1')
      .digest('hex')}`;
    const scope = {
      projectId: 'project-1',
      taskId: 'task-1',
      surfaceId: documentId,
      sessionId: 'old-generation',
      channelId: `room:${documentId}`,
    };
    const actorId = `human:${createHash('sha256')
      .update('operator-1\u0000device-1')
      .digest('hex')}`;
    let sourceHistoryAttempts = 0;
    const source = new LiveWorkSession(
      scope,
      {},
      {
        history: {
          asynchronous: true,
          commit: async () =>
            ++sourceHistoryAttempts === 1
              ? { state: 'committed', receipt: {} }
              : { state: 'indeterminate' },
        },
      },
      {
        identityAuthority: {
          resolve: ({ actorId }) => ({
            state: 'AVAILABLE',
            identity: {
              actor: { actorId, kind: 'human', label: actorId },
              occurrenceId: `old-generation:${actorId}`,
              sessionId: 'old-generation',
              workName: 'Recovered work',
              workState: 'working',
              startedAt: 1,
              ttlClosureRequestId: 'old-generation:ttl',
            },
          }),
        },
        recoveryAuthority: { authorize: () => true },
      },
    );
    const authorization = {
      actorId,
      scope,
      capabilities: new Set([
        'join',
        'announce',
        'write',
        'read',
        'history-read',
      ] as const),
    };
    expect(
      source.join({ actorId, requestId: 'join' }, authorization, 1),
    ).toMatchObject({ outcome: 'joined' });
    expect(
      await source.announceAsync(
        { actorId, requestId: 'announce' },
        authorization,
        2,
      ),
    ).toMatchObject({ outcome: 'updated' });
    expect(
      source.finish(
        { actorId, requestId: 'finish', outcome: 'completed' },
        authorization,
        3,
      ),
    ).toMatchObject({ outcome: 'degraded' });
    const recovered = source.exportRecovery(
      { kind: 'system', recoveryId: 'room-recovery:old-generation', scope },
      4,
    );
    if (recovered.outcome !== 'available') throw new Error('expected recovery');
    const { runtime, calls } = fixture({
      recoveryValue: {
        schemaVersion: 'station.project-task-room-runtime-recovery/v1',
        state: recovered.state,
        armedIntentIds: recovered.state.pending.map(
          (pending) => pending.intent.intentId,
        ),
        authorities: [
          {
            token: 'finish',
            principal: {
              kind: 'granted',
              operatorId: 'operator-1',
              deviceId: 'device-1',
              policyRevision: 'pairing-v1',
            },
          },
          {
            token: 'old-generation:ttl',
            principal: {
              kind: 'granted',
              operatorId: 'operator-1',
              deviceId: 'device-1',
              policyRevision: 'pairing-v1',
            },
          },
        ],
      },
    });
    const joined = await runtime.live({
      taskId: 'task-1',
      request: new Request('http://station'),
      command: 'join',
    });
    expect(
      calls.filter(
        (call) =>
          (call as { intent?: { body?: { kind?: string } } }).intent?.body
            ?.kind === 'live-work-finished',
      ),
    ).toHaveLength(1);
    expect(joined).toMatchObject({
      kind: 'available',
      result: { outcome: 'joined' },
    });
    if (joined.kind !== 'available') throw new Error('expected fresh room');
    expect(joined.generation).not.toBe('old-generation');
    expect(joined.snapshot).toMatchObject({
      outcome: 'available',
      snapshot: { participants: [{ actor: { actorId: expect.any(String) } }] },
    });
  });

  test('persists a successful announce lifecycle before restart so its TTL closure emits exactly once', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-room-runtime-'));
    directories.push(directory);
    const path = join(directory, 'orchestration.sqlite');
    const request = new Request('http://station');
    const sourceStore = new EventStore(path);
    const source = runtimeComposition(sourceStore);
    await source.runtime.discover({ taskId: task.id, request });
    await source.runtime.live({ taskId: task.id, request, command: 'join' });
    await expect(
      source.runtime.live({ taskId: task.id, request, command: 'announce' }),
    ).resolves.toMatchObject({ result: { outcome: 'updated' } });
    await source.runtime.close();
    sourceStore.close();

    const restartedStore = new EventStore(path);
    const restarted = runtimeComposition(restartedStore);
    await expect(
      restarted.runtime.live({ taskId: task.id, request, command: 'join' }),
    ).resolves.toMatchObject({ result: { outcome: 'joined' } });
    const recoveredHistory = await restarted.runtime.history({
      taskId: task.id,
      request,
    });
    if (recoveredHistory.kind !== 'available')
      throw new Error('expected durable history');
    expect(
      recoveredHistory.records.filter(
        (record) => record.body.kind === 'live-work-started',
      ),
    ).toHaveLength(1);
    expect(
      recoveredHistory.records.filter(
        (record) => record.body.kind === 'live-work-presence-ended',
      ),
    ).toHaveLength(1);
    await restarted.runtime.close();
    restartedStore.close();

    const secondStore = new EventStore(path);
    const second = runtimeComposition(secondStore);
    const dedupedHistory = await second.runtime.history({
      taskId: task.id,
      request,
    });
    if (dedupedHistory.kind !== 'available')
      throw new Error('expected durable history');
    expect(
      dedupedHistory.records.filter(
        (record) => record.body.kind === 'live-work-presence-ended',
      ),
    ).toHaveLength(1);
    await second.runtime.close();
    secondStore.close();
  }, 20_000);

  test('hard-exit after durable start reconstructs exactly one closure with no pending recovery', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-room-runtime-'));
    directories.push(directory);
    const path = join(directory, 'orchestration.sqlite');
    const child = hardExitRoomRuntime(path, 'post-commit');
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(86);

    const restartedStore = new EventStore(path);
    const restarted = runtimeComposition(restartedStore);
    const request = new Request('http://station');
    await expect(
      restarted.runtime.live({ taskId: task.id, request, command: 'join' }),
    ).resolves.toMatchObject({ result: { outcome: 'joined' } });
    const history = await restarted.runtime.history({
      taskId: task.id,
      request,
    });
    if (history.kind !== 'available') throw new Error('expected history');
    expect(
      history.records.filter(
        (record) => record.body.kind === 'live-work-started',
      ),
    ).toHaveLength(1);
    expect(
      history.records.filter(
        (record) => record.body.kind === 'live-work-presence-ended',
      ),
    ).toHaveLength(1);
    const recovery = await restarted.runtime.recovery({
      taskId: task.id,
      request,
    });
    expect(recovery).toMatchObject({
      kind: 'available',
      value: { pending: [] },
    });
    await restarted.runtime.close();
    restartedStore.close();
  }, 30_000);

  test('hard-exit after an unarmed prepared write never replays a revoked start', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-room-runtime-'));
    directories.push(directory);
    const path = join(directory, 'orchestration.sqlite');
    const child = hardExitRoomRuntime(path, 'prepared');
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(88);

    const restartedStore = new EventStore(path);
    const restarted = runtimeComposition(restartedStore);
    const request = new Request('http://station');
    await expect(
      restarted.runtime.live({ taskId: task.id, request, command: 'join' }),
    ).resolves.toMatchObject({ result: { outcome: 'joined' } });
    const history = await restarted.runtime.history({
      taskId: task.id,
      request,
    });
    if (history.kind !== 'available') throw new Error('expected history');
    expect(
      history.records.filter(
        (record) => record.body.kind === 'live-work-started',
      ),
    ).toHaveLength(0);
    const recovery = await restarted.runtime.recovery({
      taskId: task.id,
      request,
    });
    expect(recovery).toMatchObject({
      kind: 'available',
      value: { pending: [] },
    });
    await restarted.runtime.close();
    restartedStore.close();
  }, 30_000);

  test('discarding one unarmed prepared block preserves an earlier armed participant closure', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-room-runtime-'));
    directories.push(directory);
    const path = join(directory, 'orchestration.sqlite');
    const child = hardExitRoomRuntime(path, 'mixed-prepared');
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(88);

    const restartedStore = new EventStore(path);
    const restarted = runtimeComposition(restartedStore);
    const request = new Request('http://station');
    await expect(
      restarted.runtime.live({ taskId: task.id, request, command: 'join' }),
    ).resolves.toMatchObject({ result: { outcome: 'joined' } });
    const history = await restarted.runtime.history({
      taskId: task.id,
      request,
    });
    if (history.kind !== 'available') throw new Error('expected history');
    expect(
      history.records.filter(
        (record) => record.body.kind === 'live-work-started',
      ),
    ).toHaveLength(1);
    expect(
      history.records.filter(
        (record) => record.body.kind === 'live-work-presence-ended',
      ),
    ).toHaveLength(1);
    const recovery = await restarted.runtime.recovery({
      taskId: task.id,
      request,
    });
    expect(recovery).toMatchObject({
      kind: 'available',
      value: { pending: [] },
    });
    await restarted.runtime.close();
    restartedStore.close();
  }, 30_000);

  test('recovers a post-commit lost room response across real EventStore instances without duplicating history', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-room-runtime-'));
    directories.push(directory);
    const path = join(directory, 'orchestration.sqlite');
    const request = new Request('http://station');
    const sourceStore = new EventStore(path);
    const source = runtimeComposition(sourceStore, {
      unavailableAfterCommitOnce: true,
    });

    await expect(
      source.runtime.discover({ taskId: task.id, request }),
    ).resolves.toMatchObject({ kind: 'opened' });
    expect(
      await source.runtime.live({
        taskId: task.id,
        request,
        command: 'join',
        requestId: 'join-before-loss',
      }),
    ).toMatchObject({ kind: 'available', result: { outcome: 'joined' } });
    const lost = await source.runtime.live({
      taskId: task.id,
      request,
      command: 'announce',
      requestId: 'stable-announce-proposal',
    });
    expect(lost).toMatchObject({
      kind: 'available',
      result: { outcome: 'degraded', state: 'indeterminate' },
    });
    if (lost.kind !== 'available') throw new Error('expected live room');
    const sourceRecovery = await source.runtime.recovery({
      taskId: task.id,
      request,
    });
    if (sourceRecovery.kind !== 'available')
      throw new Error('expected pending recovery');
    const sourcePending = sourceRecovery.value as LiveWorkRecoveryState;
    expect(sourceRecovery.generation).toBe(lost.generation);
    const pendingAnnouncement = sourcePending.pending.find(
      (pending) => pending.intent.kind === 'announce',
    );
    expect(pendingAnnouncement).toMatchObject({
      intent: { intentId: expect.any(String), kind: 'announce' },
    });
    if (!pendingAnnouncement) throw new Error('expected pending announce');

    await expect(source.runtime.close()).resolves.toEqual({ kind: 'closed' });
    expect(sourceStore.close()).toEqual({ kind: 'closed' });

    const restartedStore = new EventStore(path);
    const restarted = runtimeComposition(restartedStore);
    const subscribed = await restarted.runtime.subscribe({
      taskId: task.id,
      request,
      emit: () => {},
    });
    expect(subscribed).toMatchObject({
      kind: 'subscribed',
      initial: {
        generation: expect.any(String),
        live: {
          outcome: 'available',
          snapshot: { participants: [], panes: [], cursors: [], typing: [] },
        },
      },
    });
    if (subscribed.kind !== 'subscribed')
      throw new Error('expected subscription');
    expect(subscribed.initial.generation).not.toBe(lost.generation);
    // A real history append revalidates at admission, before dispatch, and
    // immediately before its SQLite commit. One three-check retry reached the
    // durable identity, whose single record below proves it was a duplicate.
    expect(restarted.lifecycleAppendChecks()).toBeGreaterThan(0);
    expect(restarted.appendOutcomes()).toContain('duplicate');

    const recovered = await restarted.runtime.recovery({
      taskId: task.id,
      request,
    });
    expect(recovered).toMatchObject({
      kind: 'available',
      value: { pending: [] },
    });
    const durable = await restarted.runtime.history({
      taskId: task.id,
      request,
    });
    expect(durable).toMatchObject({ kind: 'available' });
    if (durable.kind !== 'available') throw new Error('expected history');
    const recoveredAnnouncement = durable.records.filter(
      (record) =>
        record.envelope.proposal.proposalId ===
        pendingAnnouncement.intent.intentId,
    );
    expect(recoveredAnnouncement).toHaveLength(1);
    expect(
      await restarted.runtime.live({
        taskId: task.id,
        request,
        command: 'join',
        requestId: 'join-after-recovery',
      }),
    ).toMatchObject({ kind: 'available', result: { outcome: 'joined' } });

    subscribed.unsubscribe();
    await expect(restarted.runtime.close()).resolves.toEqual({
      kind: 'closed',
    });
    expect(restartedStore.close()).toEqual({ kind: 'closed' });
  }, 20_000);
});
