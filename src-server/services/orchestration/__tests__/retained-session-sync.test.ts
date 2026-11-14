import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  ProviderSendTurnInput,
  ProviderSessionStartInput,
} from '@kontourai/station-contracts/provider';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { afterEach, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { sessionToolRestriction } from '../session-tool-restriction.js';

const temporary = trackTempDirs();
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

class SyncAdapter extends GateTestAdapter {
  async assertContextSyncRuntime() {}
  readonly starts: { input: ProviderSessionStartInput; generation?: string }[] =
    [];
  readonly sends: { input: ProviderSendTurnInput; generation?: string }[] = [];
  private readonly live = new Set<string>();
  override async hasSession(threadId = '') {
    return this.live.has(threadId);
  }
  startGate = Promise.resolve();
  stopFails = false;
  finishReason: 'stop' | 'other' = 'stop';
  reportRuntimeError = false;
  nativeSessionIdentity(cursor: unknown) {
    return typeof cursor === 'string' ? { sessionId: cursor } : undefined;
  }
  override async startSession(input: ProviderSessionStartInput) {
    this.starts.push({
      input,
      generation: sessionToolRestriction(input.threadId)?.generation,
    });
    await this.startGate;
    this.live.add(input.threadId);
    const session = {
      ...(await super.startSession(input)),
      resumeCursor: 'same-native-session',
      persistSession: input.persistSession,
      cwd: input.cwd,
    };
    this.events.push({
      eventId: randomUUID(),
      threadId: input.threadId,
      sessionId: input.threadId,
      provider: 'claude',
      createdAt: new Date().toISOString(),
      method: 'session.started',
      metadata: { ...input.metadata, nativeResumeBindingKey: 'native-binding' },
    });
    return session;
  }
  override async stopSession(threadId = '') {
    if (this.stopFails) throw new Error('exit unknown');
    this.live.delete(threadId);
    this.events.push({
      eventId: randomUUID(),
      threadId,
      sessionId: threadId,
      provider: 'claude',
      createdAt: new Date().toISOString(),
      method: 'session.exited',
      reason: 'stopped',
    });
  }
  override async sendTurn(input: ProviderSendTurnInput) {
    this.sends.push({
      input,
      generation: sessionToolRestriction(input.threadId)?.generation,
    });
    const turnId = randomUUID();
    this.events.push({
      eventId: randomUUID(),
      threadId: input.threadId,
      turnId,
      provider: 'claude',
      createdAt: new Date().toISOString(),
      method: 'turn.started',
      invocationId: input.invocationId,
    });
    if (this.reportRuntimeError)
      this.events.push({
        eventId: randomUUID(),
        threadId: input.threadId,
        turnId,
        provider: 'claude',
        createdAt: new Date().toISOString(),
        method: 'runtime.error',
        severity: 'error',
        message: 'controlled failure',
      });
    this.events.push({
      eventId: randomUUID(),
      threadId: input.threadId,
      turnId,
      provider: 'claude',
      createdAt: new Date().toISOString(),
      method: 'turn.completed',
      finishReason: this.finishReason,
      outputText: 'ACK SYNC run',
      invocationId: input.invocationId,
    });
    return { threadId: input.threadId, turnId };
  }
}

async function fixture(persistSession = true) {
  const root = temporary('station-retained-sync-');
  const adapter = new SyncAdapter();
  const store = new EventStore(join(root, 'events.sqlite'));
  cleanup.push(async () => {
    await store.close();
  });
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventStore: store,
    eventBus: new EventBus(),
    logger: { debug() {}, warn() {} },
    idleSessionParkExitWaitMs: 100,
  });
  cleanup.push(async () => {
    await service.shutdown();
  });
  await service.dispatchWithReceipt(
    {
      type: 'startSession',
      input: {
        threadId: 'retained',
        provider: 'claude',
        persistSession,
        cwd: root,
        metadata: { userId: 'owner' },
      },
    },
    { userId: 'owner' },
  );
  await vi.waitFor(
    () =>
      expect(service.canUserMutateSession('retained', 'owner', undefined)).toBe(
        true,
      ),
    { timeout: 10_000 },
  );
  await service.dispatchWithReceipt(
    {
      type: 'sendTurn',
      input: { threadId: 'retained', input: 'original work' },
    },
    { userId: 'owner' },
  );
  await vi.waitFor(
    async () =>
      expect(
        (await service.readSession('retained', INTERNAL_SESSION_READ_SCOPE))
          ?.session.lifecycleState,
      ).toBe('idle'),
    { timeout: 10_000 },
  );
  const input = {
    threadId: 'retained',
    prompt: 'complete folded result',
    clientTurnId: 'reserved-sync',
    signal: new AbortController().signal,
    assertCurrent() {},
    context: { userId: 'owner' },
  };
  return { adapter, service, input };
}

test('retained sync owns activation through resume/send/teardown and ordinary dispatch cannot join its start', async () => {
  const f = await fixture();
  let release!: () => void;
  f.adapter.startGate = new Promise((resolve) => {
    release = resolve;
  });
  const sync = f.service.syncRetainedSession(f.input);
  await vi.waitFor(() => expect(f.adapter.starts).toHaveLength(2), {
    timeout: 10_000,
  });
  await expect(
    f.service.dispatchWithReceipt(
      {
        type: 'sendTurn',
        input: { threadId: 'retained', input: 'ordinary race' },
      },
      { userId: 'owner' },
    ),
  ).rejects.toThrow('group_sync_activation_changed');
  expect(f.adapter.sends).toHaveLength(1);
  release();
  expect(await sync).toMatchObject({
    sessionId: 'retained',
    nativeSessionId: 'same-native-session',
    output: 'ACK SYNC run',
    toolCalls: 0,
  });
  expect(f.adapter.starts[1].generation).toBeTruthy();
  expect(f.adapter.sends[1].generation).toBe(f.adapter.starts[1].generation);
  await f.service.dispatchWithReceipt(
    {
      type: 'sendTurn',
      input: { threadId: 'retained', input: 'ordinary restored' },
    },
    { userId: 'owner' },
  );
  expect(f.adapter.starts).toHaveLength(3);
  expect(f.adapter.starts[2].generation).toBeUndefined();
  expect(f.adapter.sends[2].generation).toBeUndefined();
});

test('an unconfirmed ordinary-process exit prevents restricted restart and provider dispatch', async () => {
  const f = await fixture();
  f.adapter.stopFails = true;
  await expect(f.service.syncRetainedSession(f.input)).rejects.toThrow(
    'exit unknown',
  );
  expect(f.adapter.starts).toHaveLength(1);
  expect(f.adapter.sends).toHaveLength(1);
  f.adapter.stopFails = false;
});

test.each(['other', 'runtime-error'] as const)(
  'refuses %s terminal authority without yielding an ACK-eligible completion',
  async (defect) => {
    const f = await fixture();
    if (defect === 'other') f.adapter.finishReason = 'other';
    else f.adapter.reportRuntimeError = true;
    await expect(f.service.syncRetainedSession(f.input)).rejects.toThrow(
      'group_sync_turn_failed',
    );
    expect(f.adapter.sends).toHaveLength(2);
  },
);

test('revocation during restricted materialization refuses the send and retains an exclusive unknown activation until stop', async () => {
  const f = await fixture();
  let release!: () => void;
  f.adapter.startGate = new Promise((resolve) => {
    release = resolve;
  });
  let current = true;
  const sync = f.service.syncRetainedSession({
    ...f.input,
    assertCurrent() {
      if (!current) throw new Error('revoked');
    },
  });
  const rejected = expect(sync).rejects.toThrow('revoked');
  await vi.waitFor(() => expect(f.adapter.starts).toHaveLength(2), {
    timeout: 10_000,
  });
  current = false;
  release();
  await rejected;
  expect(f.adapter.sends).toHaveLength(1);
  await expect(
    f.service.dispatchWithReceipt(
      { type: 'sendTurn', input: { threadId: 'retained', input: 'ordinary' } },
      { userId: 'owner' },
    ),
  ).rejects.toThrow('group_sync_activation_changed');
  await f.service.dispatchWithReceipt(
    { type: 'stopSession', threadId: 'retained' },
    { userId: 'owner' },
  );
});

test('a nonpersistent native Session refuses sync before restart or another turn', async () => {
  const f = await fixture(false);
  await expect(
    f.service.assertRetainedSessionSyncAvailable('retained', f.input.context),
  ).rejects.toThrow('group_sync_unavailable');
  await expect(f.service.syncRetainedSession(f.input)).rejects.toThrow(
    'group_sync_unavailable',
  );
  expect(f.adapter.starts).toHaveLength(1);
  expect(f.adapter.sends).toHaveLength(1);
});
