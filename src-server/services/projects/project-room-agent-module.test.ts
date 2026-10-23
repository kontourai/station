import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
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
    let fail = false;
    let completed = false;
    const execution: ProjectRoomAgentExecution = {
      async prepare() {
        return { label: 'Registered Agent' };
      },
      async launch(_, recheck) {
        recheck();
        launches++;
        if (fail) throw new Error('secret provider stderr');
      },
      async answer() {
        return completed ? { turnId: 'turn', text: 'Selected answer' } : null;
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
      get launches() {
        return launches;
      },
      revoke() {
        current = false;
      },
      complete() {
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
        await runtime.module.request(f.authority, f.input);
        expect(launchError).toBeUndefined();
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
