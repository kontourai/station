import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type {
  ProviderSession,
  ProviderSessionStartInput,
} from '../../../providers/adapter-shape.js';
import type { createNativeOutputGrantAuthority } from '../../../runtime/native-output-turn-grant.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import type { SessionRecoveryCoordinator } from '../session-recovery-coordinator.js';

const makeTempDir = trackTempDirs();
class RoomRestartAdapter extends GateTestAdapter {
  readonly sessions = new Map<string, ProviderSession>();
  override startSession = vi.fn(async (input: ProviderSessionStartInput) => {
    const session = {
      ...(await super.startSession(input)),
      controlMode: 'station-owned' as const,
      resumeCursor: input.resumeCursor ?? { claudeSessionId: 'native-room' },
    };
    this.sessions.set(input.threadId, session);
    return session;
  });
  override sendTurn = vi.fn(super.sendTurn.bind(this));
  override stopSession = vi.fn(async (threadId?: string) => {
    if (!threadId) return;
    this.sessions.delete(threadId);
    this.events.push({
      eventId: randomUUID(),
      provider: this.provider,
      threadId,
      sessionId: threadId,
      method: 'session.exited',
      reason: 'stopped',
      createdAt: new Date().toISOString(),
    });
  });
  override async stopAll() {
    for (const id of this.sessions.keys()) await this.stopSession(id);
  }
  override async hasSession(threadId?: string) {
    return !!threadId && this.sessions.has(threadId);
  }
  override async listSessions() {
    return [...this.sessions.values()];
  }
}
test('shutdown preserves an idle resumable room Session for an authorized reply after restart', async () => {
  const threadId = 'room-shutdown-restart';
  const eventStore = new EventStore(
    join(makeTempDir('room-restart-'), 'events.sqlite'),
  );
  const authority = sessionReadAuthorityFromRequest(
    'owner-user',
    undefined,
    undefined,
  );
  const before = new RoomRestartAdapter();
  const first = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(before),
    eventBus: new EventBus(),
    eventStore,
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  const started = await first.startSessionInternal(
    {
      type: 'start-session',
      input: {
        threadId,
        provider: 'claude',
        metadata: { userId: 'owner-user' },
      },
    },
    { userId: 'owner-user' },
    {
      roomExecutionBinding: { projectId: 'room-project', taskId: 'room-task' },
    },
  );
  expect(started.status).toBe('accepted');
  const grants: ReturnType<typeof createNativeOutputGrantAuthority> =
    Reflect.get(first, 'nativeOutputGrants');
  const grant = grants.issue(
    {
      threadId: 'another-active-thread',
      turnId: 'active-turn',
      adapterId: 'station-agent',
      principal: humanPrincipal('test', 'owner-user', 'Owner'),
      configurationLease: { revision: 1 },
    },
    { isCurrent: () => true },
  )!;
  const scope = grants.bindNativeCall(grant, 'late-call')!;
  const stop = before.stopSession.getMockImplementation()!;
  before.stopSession.mockImplementation(async (id) => {
    expect(grants.admit(scope)).toBeNull();
    await stop(id);
  });
  before.events.push({
    eventId: randomUUID(),
    provider: 'claude',
    threadId,
    sessionId: threadId,
    method: 'session.configured',
    metadata: { userId: 'owner-user' },
    createdAt: new Date().toISOString(),
  });
  for (const method of ['turn.started', 'turn.completed'] as const)
    before.events.push({
      eventId: randomUUID(),
      provider: 'claude',
      threadId,
      turnId: 'first-room-turn',
      method,
      createdAt: new Date().toISOString(),
      ...(method === 'turn.started' ? { prompt: 'first question' } : {}),
    });
  await vi.waitFor(async () =>
    expect(
      (await first.readSession(threadId, authority))?.session.lifecycleState,
    ).toBe('idle'),
  );
  await first.shutdown();
  expect(eventStore.readSessionByThread(threadId)?.status).not.toBe('closed');
  expect(
    eventStore
      .listEvents(threadId)
      .some((e) => e.payload.method === 'session.exited'),
  ).toBe(false);
  expect(before.stopSession).toHaveBeenCalledWith(threadId);
  const after = new RoomRestartAdapter();
  const restarted = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(after),
    eventBus: new EventBus(),
    eventStore,
    logger: { debug: vi.fn(), warn: vi.fn() },
  });

  try {
    const continuation = await restarted.resolveConversationContinuation(
      threadId,
      authority,
      { provider: 'claude' },
    );
    expect(continuation).toMatchObject({
      sessionId: threadId,
      startRequired: false,
    });
    const recheck = vi.fn<() => Promise<void>>(async () => {
      throw new Error('Room access revoked');
    });
    const command = {
      type: 'sendTurn' as const,
      input: { threadId, input: 'follow-up' },
    };
    await expect(
      restarted.dispatchWithReceipt(
        command,
        { userId: 'owner-user' },
        {
          receiverExecutionAdmission: { recheck },
        },
      ),
    ).rejects.toThrow('Room access revoked');
    expect(after.sendTurn).not.toHaveBeenCalled();
    recheck.mockImplementation(async () => {});
    await restarted.dispatchWithReceipt(
      command,
      { userId: 'owner-user' },
      {
        receiverExecutionAdmission: { recheck },
      },
    );
    expect(after.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId,
        resumeCursor: { claudeSessionId: 'native-room' },
      }),
    );
    expect(after.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({ threadId, input: 'follow-up' }),
    );
  } finally {
    await restarted.shutdown();
    eventStore.close();
  }
});

test.each(['binding', 'recovery'] as const)(
  'a failed %s shutdown step does not abandon provider cleanup',
  async (failure) => {
    const store = new EventStore(
      join(makeTempDir('room-shutdown-failure-'), 'events.sqlite'),
    );
    const adapter = new RoomRestartAdapter();
    const service = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(adapter),
      eventBus: new EventBus(),
      eventStore: store,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    await service.startSessionInternal(
      {
        type: 'start-session',
        input: {
          threadId: 'shutdown-binding-failure',
          provider: 'claude',
          metadata: { userId: 'owner-user' },
        },
      },
      { userId: 'owner-user' },
      {},
    );
    const recovery: SessionRecoveryCoordinator = Reflect.get(
      service,
      'recoveryCoordinator',
    );
    const lookup =
      failure === 'binding'
        ? vi
            .spyOn(store, 'readProjectTaskRoomExecutionBinding')
            .mockImplementation(() => {
              throw new Error('Room binding unavailable');
            })
        : vi.spyOn(recovery, 'dispose').mockRejectedValueOnce(
            Object.assign(new Error('Recovery shutdown unsettled'), {
              code: 'RECOVERY_SHUTDOWN_UNSETTLED',
            }),
          );
    try {
      await expect(service.shutdown()).rejects.toThrow(
        'Provider adapter shutdown failed',
      );
      expect(adapter.sessions.size).toBe(0);
    } finally {
      lookup.mockRestore();
      await recovery.dispose();
      store.close();
    }
  },
);
