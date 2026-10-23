import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import { PROJECT_ROOM_LIMITS } from '@kontourai/station-contracts/project-room';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { mapTurnFinishReason } from '../../providers/adapters/codex-adapter-events.js';
import { projectRoomAgentExecution } from '../../runtime/routes/project-room-agent-runtime.js';
import { EventBus } from '../orchestration/event-bus.js';
import { EventStore } from '../orchestration/event-store.js';
import { OrchestrationService } from '../orchestration/orchestration-service.js';
import { createSessionAgentResolver } from '../orchestration/session-agent-resolution.js';
import {
  createProjectRoomAgentRuntime,
  type ProjectRoomAgentExecution,
} from './project-room-agent-module.js';
import { createProjectRoomRuntime } from './project-room-store.js';

describe('Project Room explicit agent participation', () => {
  const makeTempDir = trackTempDirs();
  const cleanup: (() => void | Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of cleanup.reverse()) await close();
    cleanup.length = 0;
  });
  function fixture() {
    const home = realpathSync(makeTempDir('room-agent-'));
    const room = createProjectRoomRuntime(home);
    let current = true;
    const authority = {
      scope: {
        stationId: 's',
        localProjectId: 'incarnation',
        portableProjectId: 'p',
        localProjectSlug: 'project',
      },
      requester: { kind: 'person' as const, id: 'owner', displayName: 'Owner' },
      executionRoot: home,
      assertCurrent() {
        if (!current) throw new Error('revoked');
      },
    };
    room.store.ensureRoom(authority.scope, authority.assertCurrent);
    let launches = 0;
    let preparations = 0;
    let fail = false;
    let completed = false;
    let terminalFailure = false;
    let answerText = 'Selected answer';
    const captures: string[] = [];
    const execution: ProjectRoomAgentExecution = {
      async prepare() {
        preparations++;
        return { label: 'Registered Agent' };
      },
      async launch(capture, recheck) {
        recheck();
        launches++;
        captures.push(capture.context);
        if (fail) throw new Error('secret provider stderr');
      },
      async answer() {
        if (terminalFailure) return { failed: true };
        return completed ? { turnId: 'turn', text: answerText } : null;
      },
      async cancel() {},
    };
    let runtime = createProjectRoomAgentRuntime(home, room.store, execution);
    cleanup.push(
      () => room.close(),
      () => runtime.close(),
    );
    const input = {
      intentId: randomUUID(),
      agentId: 'agent',
      text: 'Please answer',
    };
    return {
      authority,
      execution,
      input,
      room,
      get module() {
        return runtime.module;
      },
      captures,
      get preparations() {
        return preparations;
      },
      get launches() {
        return launches;
      },
      revoke() {
        current = false;
      },
      terminalFailure() {
        terminalFailure = true;
      },
      complete(text = 'Selected answer') {
        answerText = text;
        completed = true;
      },
      fail() {
        fail = true;
      },
      restart() {
        runtime.close();
        runtime = createProjectRoomAgentRuntime(home, room.store, execution);
      },
    };
  }
  it.each([
    'sessionId',
    'correlationId',
    'agentId',
    'agentLabel',
    'requester',
    'scope',
    'checkpoint',
    'context',
    'digest',
    'extra',
    'bytes',
  ])(
    'refuses corrupted capture %s before reading, publishing, or cancelling another Session',
    async (field) => {
      const f = fixture();
      const handle = await f.module.request(f.authority, f.input);
      const answer = vi.spyOn(f.execution, 'answer');
      const cancel = vi.spyOn(f.execution, 'cancel');
      const db = new DatabaseSync(
        join(
          f.authority.executionRoot,
          'security',
          'project-room-agent.sqlite',
        ),
      );
      try {
        const row = db
          .prepare(
            'SELECT record FROM project_room_agent_captures WHERE request_id=?',
          )
          .get(handle.requestId)!;
        const capture = JSON.parse(String(row.record));
        if (field === 'requester') capture.requester.kind = 'agent';
        else if (field === 'scope') capture.scope.localProjectId = 'other';
        else if (field === 'checkpoint')
          capture.checkpoint.roomId = randomUUID();
        else if (field === 'extra') capture.extra = true;
        else if (field !== 'bytes')
          capture[field] =
            field === 'sessionId' || field === 'correlationId'
              ? randomUUID()
              : 'substituted';
        // Relational identity must still refuse substitutions with a recomputed digest.
        if (
          [
            'sessionId',
            'correlationId',
            'agentId',
            'requester',
            'scope',
            'checkpoint',
          ].includes(field)
        ) {
          const { digest: _, ...payload } = capture;
          capture.digest = createHash('sha256')
            .update(JSON.stringify(payload))
            .digest('hex');
        }
        db.prepare(
          'UPDATE project_room_agent_captures SET record=? WHERE request_id=?',
        ).run(
          JSON.stringify(capture) + (field === 'bytes' ? ' ' : ''),
          handle.requestId,
        );
      } finally {
        db.close();
      }
      f.complete('private transcript sentinel');
      f.restart();
      await expect(
        f.module.reconcile(f.authority, handle.requestId),
      ).rejects.toThrow();
      await expect(
        f.module.cancel(f.authority, handle.requestId),
      ).rejects.toThrow();
      expect(answer).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(f.room.store.history(f.authority.scope).messages).toEqual([]);
      expect(f.module.inspect(f.authority, handle.requestId).state).toBe(
        'started',
      );
      await f.module.request(f.authority, f.input);
      expect(f.launches).toBe(1);
    },
  );
  it('closes the real database after conflicting schema construction and permits repair/reopen', () => {
    const f = fixture();
    const path = join(
      f.authority.executionRoot,
      'security',
      'project-room-agent.sqlite',
    );
    const db = new DatabaseSync(path);
    db.exec(
      'DROP TABLE project_room_agent_failures; CREATE TABLE conflict (x); CREATE INDEX project_room_agent_failures ON conflict(x)',
    );
    db.close();
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec');
    try {
      expect(() =>
        createProjectRoomAgentRuntime(
          f.authority.executionRoot,
          f.room.store,
          f.execution,
        ),
      ).toThrow();
      const failed = exec.mock.contexts.find((context) => context !== db)!;
      expect(() => failed.prepare('SELECT 1')).toThrow(/closed|not open/i);
      const repair = new DatabaseSync(path);
      repair.exec('DROP INDEX project_room_agent_failures');
      repair.close();
      const reopened = createProjectRoomAgentRuntime(
        f.authority.executionRoot,
        f.room.store,
        f.execution,
      );
      reopened.close();
    } finally {
      exec.mockRestore();
    }
  });
  it.each(['x', '\u0001'])(
    'rejects a contract-valid maximum %j prompt before reservation or preparation',
    async (unit) => {
      const f = fixture();
      const reserve = vi.spyOn(f.room.store, 'reserveRequest');
      f.input.text = unit.repeat(PROJECT_ROOM_LIMITS.textBytes);
      await expect(f.module.request(f.authority, f.input)).rejects.toThrow(
        'context exceeds limit',
      );
      f.restart();
      await expect(f.module.request(f.authority, f.input)).rejects.toThrow(
        'context exceeds limit',
      );
      expect(reserve).not.toHaveBeenCalled();
      expect(f.preparations).toBe(0);
      expect(f.room.store.listPendingRequests(f.authority.scope)).toEqual([]);
      expect(f.launches).toBe(0);
    },
  );
  it.each(['x', '\u0001'])(
    'budgets an optional maximum %j note and history without losing the mandatory prompt',
    async (unit) => {
      const f = fixture();
      const source = f.room.store.append(
        f.authority.scope,
        f.authority.requester,
        { intentId: randomUUID(), text: 'history '.repeat(1800) },
        f.authority.assertCurrent,
      );
      f.room.store.updateNote(
        f.authority.scope,
        f.authority.requester,
        {
          expectedRevision: 0,
          markdown: unit.repeat(PROJECT_ROOM_LIMITS.noteBytes),
          sourceMessageIds: [source.messageId],
        },
        f.authority.assertCurrent,
      );
      f.input.text = 'mandatory '.repeat(1100);
      const handle = await f.module.request(f.authority, f.input);
      expect(handle.state).toBe('started');
      expect(Buffer.byteLength(f.captures[0])).toBeLessThanOrEqual(
        PROJECT_ROOM_LIMITS.textBytes,
      );
      const [frame, history] = f.captures[0]
        .split('\n')
        .map((part) => JSON.parse(part));
      expect(frame.request).toBe(f.input.text);
      expect(frame.note).toBeNull();
      expect(frame.coverage).toMatchObject({
        note: 'omitted_budget',
        history: 'bounded_recent_suffix',
      });
      expect(history).toEqual([]);
      f.restart();
      await f.module.request(f.authority, f.input);
      expect(f.launches).toBe(1);
      f.complete();
      expect(
        (await f.module.reconcile(f.authority, handle.requestId)).state,
      ).toBe('published');
    },
  );
  it('includes a fitting note and history unchanged', async () => {
    const f = fixture();
    const source = f.room.store.append(
      f.authority.scope,
      f.authority.requester,
      { intentId: randomUUID(), text: 'shared source' },
      f.authority.assertCurrent,
    );
    f.room.store.updateNote(
      f.authority.scope,
      f.authority.requester,
      {
        expectedRevision: 0,
        markdown: 'reviewed note',
        sourceMessageIds: [source.messageId],
      },
      f.authority.assertCurrent,
    );
    await f.module.request(f.authority, f.input);
    const [frame, history] = f.captures[0]
      .split('\n')
      .map((part) => JSON.parse(part));
    expect(frame.note.markdown).toBe('reviewed note');
    expect(frame.coverage.note).toBe('included');
    expect(history.map((m: { text: string }) => m.text)).toEqual([
      'shared source',
    ]);
  });
  it.each(['x', '😀'])(
    'durably refuses oversized %j answers without publishing private content or retrying after reopen',
    async (unit) => {
      const f = fixture();
      const handle = await f.module.request(f.authority, f.input);
      f.complete(
        unit.repeat(PROJECT_ROOM_LIMITS.textBytes) +
          'private transcript sentinel',
      );
      expect(
        await f.module.reconcile(f.authority, handle.requestId),
      ).toMatchObject({ state: 'uncertain', failure: 'publication_failed' });
      f.restart();
      f.complete('later changed answer must not publish');
      expect(
        await f.module.reconcile(f.authority, handle.requestId),
      ).toMatchObject({ state: 'uncertain', failure: 'publication_failed' });
      await f.module.request(f.authority, f.input);
      expect(f.module.inspect(f.authority, handle.requestId).failure).toBe(
        'publication_failed',
      );
      expect(f.room.store.history(f.authority.scope).messages).toEqual([]);
      expect(f.launches).toBe(1);
    },
  );
  it('publishes a maximum-size selected answer unchanged and repairs its acknowledgement after reopen', async () => {
    const f = fixture();
    const handle = await f.module.request(f.authority, f.input);
    const text = 'x'.repeat(PROJECT_ROOM_LIMITS.textBytes);
    f.complete(text);
    const finish = vi
      .spyOn(f.room.store, 'finishPublished')
      .mockImplementationOnce(() => {
        throw new Error('lost acknowledgement');
      });
    await expect(
      f.module.reconcile(f.authority, handle.requestId),
    ).rejects.toThrow('lost acknowledgement');
    finish.mockRestore();
    f.restart();
    expect(
      (await f.module.reconcile(f.authority, handle.requestId)).state,
    ).toBe('published');
    expect(
      f.room.store.history(f.authority.scope).messages.map((m) => m.text),
    ).toEqual([text]);
  });
  it('canonical orchestration enforces compute admission, terminal cancellation, and private Session capture identity', async () => {
    for (const outcome of ['published', 'cancelled', 'revoked']) {
      const revokeAtSpawn = outcome === 'revoked';
      const f = fixture();
      const adapter = new GateTestAdapter();
      const live = new Set<string>();
      vi.spyOn(adapter, 'hasSession').mockImplementation(
        async () => live.size > 0,
      );
      const originalStart = adapter.startSession.bind(adapter);
      const start = vi
        .spyOn(adapter, 'startSession')
        .mockImplementation(async (input) => {
          const session = await originalStart(input);
          live.add(input.threadId);
          adapter.events.push({
            eventId: randomUUID(),
            provider: 'claude',
            threadId: input.threadId,
            method: 'session.started',
            sessionId: input.threadId,
            createdAt: session.createdAt,
            metadata: input.metadata,
          });
          await vi.waitFor(() =>
            expect(events.findSessionOwnerUserId(input.threadId)).toBe('owner'),
          );
          return { ...session, metadata: input.metadata, cwd: input.cwd };
        });
      const send = vi.spyOn(adapter, 'sendTurn');
      const events = new EventStore(
        join(f.authority.executionRoot, 'events.sqlite'),
      );
      const resolveAgent = createSessionAgentResolver({
        loadAgentSpec: async () => ({
          name: 'Real registry label',
          prompt: '',
        }),
        resolveToolServer: async () => null,
        resolveSkillDir: async () => null,
      });
      const sessions = new OrchestrationService({
        adapterRegistry: createGateTestRegistry(adapter),
        eventBus: new EventBus(),
        eventStore: events,
        adoptionLedger: events.createAdoptionLedger(),
        resolveSessionAgent: async (input) => {
          if (revokeAtSpawn) f.revoke();
          return resolveAgent(input);
        },
        logger: { debug() {}, warn() {} },
      });
      const execution = projectRoomAgentExecution({
        assertExecutionRoot: async () => {},
        agents: {
          async getAgent() {
            return {
              name: 'Real registry label',
              prompt: '',
              execution: { agentConnectionId: engineConnectionId('claude') },
            };
          },
        },
        sessions,
        executionTargets: {
          resolveEnvironmentAccess: async () => ({
            kind: 'current',
            apiBase: 'http://isolated.invalid',
            environmentId: 'local',
            environmentName: 'Local',
          }),
          getAgent: async () => ({
            name: 'Real registry label',
            prompt: '',
            execution: { agentConnectionId: engineConnectionId('claude') },
          }),
          getConnection: async () => ({
            id: 'claude',
            name: 'Claude',
            kind: 'agent',
            type: 'claude',
            enabled: true,
            status: 'ready',
            capabilities: ['agent-runtime'],
            config: { provider: 'claude' },
            prerequisites: [],
          }),
          getProject: async () => undefined,
          getProviderAdapter: () => adapter,
        },
        authorityForOwner: (id) =>
          sessionReadAuthorityFromRequest(id, undefined, undefined),
        commandContext: (id) => ({ userId: id }),
      });
      let launchError: unknown;
      const launch = execution.launch;
      execution.launch = async (...args) => {
        try {
          await launch(...args);
        } catch (error) {
          launchError = error;
          throw error;
        }
      };
      const runtime = createProjectRoomAgentRuntime(
        f.authority.executionRoot,
        f.room.store,
        execution,
      );
      cleanup.push(
        () => {
          events.close();
        },
        () => sessions.shutdown(),
        () => runtime.close(),
      );
      if (revokeAtSpawn)
        await expect(
          runtime.module.request(f.authority, f.input),
        ).rejects.toThrow('revoked');
      else {
        const handle = await runtime.module.request(f.authority, f.input);
        expect(launchError).toBeUndefined();
        const sessionId = start.mock.calls[0][0].threadId;
        const base = {
          invocationId: send.mock.calls[0][0].invocationId,
          provider: 'claude',
          threadId: sessionId,
          createdAt: new Date().toISOString(),
        };
        adapter.events.push({
          ...base,
          eventId: randomUUID(),
          method: 'turn.started',
          turnId: 'turn-1',
          prompt: 'Room prompt',
        });
        adapter.events.push({
          ...base,
          eventId: randomUUID(),
          method: 'content.text-delta',
          turnId: 'turn-1',
          itemId: 'answer',
          delta: 'Canonical selected answer',
        });
        adapter.events.push({
          ...base,
          eventId: randomUUID(),
          method: 'turn.completed',
          turnId: 'turn-1',
          finishReason: mapTurnFinishReason(
            outcome === 'cancelled' ? 'interrupted' : 'completed',
          ),
          outputText: 'Canonical selected answer',
        });
        await vi.waitFor(async () =>
          expect(
            (await runtime.module.reconcile(f.authority, handle.requestId))
              .state,
          ).toBe(outcome === 'cancelled' ? 'uncertain' : 'published'),
        );
        expect(
          f.room.store
            .history(f.authority.scope)
            .messages.map((message) => message.text),
        ).toEqual(outcome === 'cancelled' ? [] : ['Canonical selected answer']);
        if (outcome === 'cancelled') {
          expect(
            runtime.module.inspect(f.authority, handle.requestId).failure,
          ).toBe('execution_failed');
        } else {
          adapter.events.push({
            ...base,
            eventId: randomUUID(),
            method: 'turn.completed',
            turnId: 'turn-1',
            finishReason: 'cancelled',
          });
          expect(
            (await runtime.module.reconcile(f.authority, handle.requestId))
              .state,
          ).toBe('published');
        }
      }
      if (outcome === 'published') {
        const privateId = randomUUID();
        const privateCorrelation = randomUUID();
        await sessions.startSessionInternal(
          {
            type: 'start-session',
            input: {
              threadId: privateId,
              provider: 'claude',
              cwd: f.authority.executionRoot,
              persistSession: true,
              metadata: {
                userId: 'owner',
                agentSlug: 'agent',
                executionAgentId: 'agent',
              },
            },
          },
          { userId: 'owner' },
        );
        await sessions.dispatch(
          {
            type: 'sendTurn',
            input: {
              threadId: privateId,
              input: 'unrelated private prompt',
              clientTurnId: privateCorrelation,
            },
          },
          { userId: 'owner' },
        );
        const privateBase = {
          eventId: randomUUID(),
          invocationId: send.mock.calls.at(-1)![0].invocationId,
          provider: 'claude',
          threadId: privateId,
          createdAt: new Date().toISOString(),
          turnId: 'private-turn',
        };
        adapter.events.push({
          ...privateBase,
          method: 'turn.started',
          prompt: 'unrelated private prompt',
        });
        adapter.events.push({
          ...privateBase,
          eventId: randomUUID(),
          method: 'content.text-delta',
          itemId: 'private-answer',
          delta: 'private transcript sentinel',
        });
        adapter.events.push({
          ...privateBase,
          eventId: randomUUID(),
          method: 'turn.completed',
          finishReason: 'stop',
          outputText: 'private transcript sentinel',
        });
        const readAuthority = sessionReadAuthorityFromRequest(
          'owner',
          undefined,
          undefined,
        );
        await vi.waitFor(async () =>
          expect(
            (
              await sessions.sessionQueries.readAssistantTurn(
                {
                  type: 'assistant-turn',
                  threadId: privateId,
                  turnId: 'private-turn',
                },
                readAuthority,
              )
            ).status,
          ).toBe('found'),
        );
        const pending = await runtime.module.request(f.authority, {
          ...f.input,
          intentId: randomUUID(),
        });
        const db = new DatabaseSync(
          join(
            f.authority.executionRoot,
            'security',
            'project-room-agent.sqlite',
          ),
        );
        try {
          const capture = JSON.parse(
            String(
              db
                .prepare(
                  'SELECT record FROM project_room_agent_captures WHERE request_id=?',
                )
                .get(pending.requestId)!.record,
            ),
          );
          capture.sessionId = privateId;
          capture.correlationId = privateCorrelation;
          const { digest: _, ...payload } = capture;
          capture.digest = createHash('sha256')
            .update(JSON.stringify(payload))
            .digest('hex');
          db.prepare(
            'UPDATE project_room_agent_captures SET record=? WHERE request_id=?',
          ).run(JSON.stringify(capture), pending.requestId);
        } finally {
          db.close();
        }
        const read = vi.spyOn(sessions, 'readSession');
        const transcript = vi.spyOn(
          sessions.sessionQueries,
          'readAssistantTurn',
        );
        const dispatch = vi.spyOn(sessions, 'dispatch');
        await expect(
          runtime.module.reconcile(f.authority, pending.requestId),
        ).rejects.toThrow();
        await expect(
          runtime.module.cancel(f.authority, pending.requestId),
        ).rejects.toThrow();
        expect(read).not.toHaveBeenCalled();
        expect(transcript).not.toHaveBeenCalled();
        expect(dispatch).not.toHaveBeenCalled();
        expect(
          f.room.store
            .history(f.authority.scope)
            .messages.map((message) => message.text),
        ).toEqual(['Canonical selected answer']);
        read.mockRestore();
        transcript.mockRestore();
        dispatch.mockRestore();
      }
      expect(start).toHaveBeenCalledTimes(
        revokeAtSpawn ? 0 : outcome === 'published' ? 3 : 1,
      );
      expect(send).toHaveBeenCalledTimes(
        revokeAtSpawn ? 0 : outcome === 'published' ? 3 : 1,
      );
    }
  });
  it('loss of launch acknowledgement survives restart without replay and publishes exactly one selected answer', async () => {
    const f = fixture();
    f.fail();
    const handle = await f.module.request(f.authority, f.input);
    expect(handle.state).toBe('uncertain');
    expect(handle.failure).toBe('launch_uncertain');
    expect(handle).not.toHaveProperty('sessionId');
    expect(JSON.stringify(handle)).not.toContain('stderr');
    f.restart();
    await f.module.request(f.authority, f.input);
    expect(f.launches).toBe(1);
    expect(
      (await f.module.reconcile(f.authority, handle.requestId)).state,
    ).toBe('uncertain');
    expect(f.room.store.history(f.authority.scope).messages).toHaveLength(0);
    f.complete();
    expect(
      (await f.module.reconcile(f.authority, handle.requestId)).state,
    ).toBe('published');
    await f.module.reconcile(f.authority, handle.requestId);
    expect(
      f.room.store
        .history(f.authority.scope)
        .messages.map((m) => [m.actor.displayName, m.text]),
    ).toEqual([['Registered Agent', 'Selected answer']]);
  });
  it('exposes a fixed durable terminal failure without publishing provider diagnostics', async () => {
    const f = fixture();
    const handle = await f.module.request(f.authority, f.input);
    f.terminalFailure();
    expect(
      await f.module.reconcile(f.authority, handle.requestId),
    ).toMatchObject({ state: 'uncertain', failure: 'execution_failed' });
    f.restart();
    expect(f.module.inspect(f.authority, handle.requestId).failure).toBe(
      'execution_failed',
    );
    expect(f.room.store.history(f.authority.scope).messages).toHaveLength(0);
  });
  it('a lost publication acknowledgement is repaired after restart without a second Room message', async () => {
    const f = fixture();
    const handle = await f.module.request(f.authority, f.input);
    f.complete();
    const finish = vi
      .spyOn(f.room.store, 'finishPublished')
      .mockImplementationOnce(() => {
        throw new Error('lost acknowledgement');
      });
    await expect(
      f.module.reconcile(f.authority, handle.requestId),
    ).rejects.toThrow('lost acknowledgement');
    expect(f.room.store.history(f.authority.scope).messages).toHaveLength(1);
    finish.mockRestore();
    f.restart();
    expect(
      (await f.module.reconcile(f.authority, handle.requestId)).state,
    ).toBe('published');
    expect(f.room.store.history(f.authority.scope).messages).toHaveLength(1);
    expect(f.launches).toBe(1);
  });
  it('revocation, changed root, and cancellation fence completed Session publication', async () => {
    for (const denial of ['revoked', 'root', 'cancelled']) {
      const f = fixture();
      const handle = await f.module.request(f.authority, f.input);
      f.complete();
      if (denial === 'revoked') f.revoke();
      if (denial === 'root') f.authority.executionRoot += '/changed';
      if (denial === 'cancelled')
        await f.module.cancel(f.authority, handle.requestId);
      if (denial === 'cancelled')
        expect(
          (await f.module.reconcile(f.authority, handle.requestId)).state,
        ).toBe('cancelled');
      else
        await expect(
          f.module.reconcile(f.authority, handle.requestId),
        ).rejects.toThrow();
      expect(f.room.store.history(f.authority.scope).messages).toHaveLength(0);
    }
  });
});
