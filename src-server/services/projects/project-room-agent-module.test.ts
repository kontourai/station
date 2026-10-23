import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import { PROJECT_ROOM_LIMITS } from '@kontourai/station-contracts/project-room';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../__test-utils__/orchestration-gate-test-harness.js';
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
  const cleanup: (() => void | Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of cleanup.reverse()) await close();
    cleanup.length = 0;
  });
  function fixture() {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'room-agent-')));
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
      () => rmSync(home, { recursive: true, force: true }),
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
  it('real canonical start reaches the adapter only while the captured compute authority remains current', async () => {
    for (const revokeAtSpawn of [false, true]) {
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
          finishReason: 'stop',
          outputText: 'Canonical selected answer',
        });
        await vi.waitFor(async () =>
          expect(
            (await runtime.module.reconcile(f.authority, handle.requestId))
              .state,
          ).toBe('published'),
        );
        expect(
          f.room.store
            .history(f.authority.scope)
            .messages.map((message) => message.text),
        ).toEqual(['Canonical selected answer']);
      }
      expect(start).toHaveBeenCalledTimes(revokeAtSpawn ? 0 : 1);
      expect(send).toHaveBeenCalledTimes(revokeAtSpawn ? 0 : 1);
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
