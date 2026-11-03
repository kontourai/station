import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ProviderSession } from '@kontourai/station-contracts/provider';
import { expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type {
  ProviderSendTurnInput,
  ProviderSessionStartInput,
} from '../../../providers/adapter-shape.js';
import { isSqliteContentionError } from '../../../utils/sqlite-wal.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import {
  OrchestrationCommandDispatchError,
  OrchestrationService,
} from '../orchestration-service.js';

const makeTempDir = trackTempDirs();

/** Echoes the start metadata on `session.started`, as every real adapter does. */
class EchoingAdapter extends GateTestAdapter {
  constructor(private readonly deferred = false) {
    super();
  }
  private announceStart?: () => void;
  publishStarted() {
    if (!this.announceStart) throw new Error('Session has not started');
    this.announceStart();
  }
  readonly sessions = new Map<string, ProviderSession>();
  readonly turns: ProviderSendTurnInput[] = [];
  override async startSession(input: ProviderSessionStartInput) {
    const session = await super.startSession(input);
    this.sessions.set(input.threadId, session);
    this.announceStart = () =>
      this.events.push({
        eventId: randomUUID(),
        provider: this.provider,
        threadId: input.threadId,
        sessionId: input.threadId,
        method: 'session.started',
        createdAt: session.createdAt,
        metadata: input.metadata,
      });
    if (!this.deferred) this.publishStarted();
    return session;
  }
  override async sendTurn(input: ProviderSendTurnInput) {
    this.turns.push(input);
    return { threadId: input.threadId, turnId: `turn-${this.turns.length}` };
  }
  override async hasSession(threadId?: string) {
    return !!threadId && this.sessions.has(threadId);
  }
  override async listSessions() {
    return [...this.sessions.values()];
  }
}

// #4480: the owner-bearing `session.started` reaches the store through the
// zero-timeout observed-event publish. Under contention that append retries
// asynchronously. An adapter that announces after startSession returns keeps
// deferred-start semantics; its accepted owner can send during the retry.
test('a deferred start owner can send a turn while its contended session.started publish is still retrying', async () => {
  const path = join(makeTempDir('start-owner-contention-'), 'events.sqlite');
  const store = new EventStore(path);
  const adapter = new EchoingAdapter(true);
  const sessions = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: new EventBus(),
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  let contended = 0;
  let holdRetry = true;
  const releaseRetry = () => {
    holdRetry = false;
  };
  const attempt = store.withImmediateWriteAttempt.bind(store);
  vi.spyOn(store, 'withImmediateWriteAttempt').mockImplementation((publish) => {
    if (!holdRetry) return attempt(publish);
    contended += 1;
    // A real peer writer: the publish fails with genuine SQLITE_BUSY.
    const peer = new DatabaseSync(path, { timeout: 0 });
    try {
      peer.exec('BEGIN IMMEDIATE');
      return attempt(publish);
    } finally {
      peer.exec('ROLLBACK');
      peer.close();
    }
  });
  try {
    const threadId = 'delegated-session';
    await sessions.dispatch(
      {
        type: 'startSession',
        input: {
          provider: 'claude',
          threadId,
          cwd: process.cwd(),
          metadata: { userId: 'owner' },
        },
      },
      { userId: 'owner' },
    );
    adapter.publishStarted();
    await vi.waitFor(() => expect(contended).toBeGreaterThan(0));
    expect(contended).toBeGreaterThanOrEqual(1);
    // The durable owner is not written yet: this is the hosted window.
    expect(store.findSessionOwnerUserId(threadId)).toBeUndefined();

    // The pending start owner widens nothing for anyone else.
    const refused = await sessions
      .dispatchWithReceipt(
        { type: 'sendTurn', input: { threadId, input: 'not mine' } },
        { userId: 'someone-else' },
      )
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(OrchestrationCommandDispatchError);
    expect((refused as OrchestrationCommandDispatchError).receipt.status).toBe(
      'rejected',
    );
    expect((refused as Error).message).toBe(`Session not found: ${threadId}`);

    const sent = await sessions.dispatchWithReceipt(
      { type: 'sendTurn', input: { threadId, input: 'Investigate' } },
      { userId: 'owner' },
    );
    expect(sent.receipt.status).toBe('accepted');
    expect(adapter.turns.map((turn) => turn.input)).toEqual(['Investigate']);

    releaseRetry();
    await vi.waitFor(() =>
      expect(store.findSessionOwnerUserId(threadId)).toBe('owner'),
    );
  } finally {
    releaseRetry();
    await sessions.shutdown();
    store.close();
  }
});

test('the injected peer writer is real contention for the zero-timeout publish', () => {
  const path = join(makeTempDir('start-owner-contention-'), 'events.sqlite');
  const store = new EventStore(path);
  const peer = new DatabaseSync(path, { timeout: 0 });
  try {
    peer.exec('BEGIN IMMEDIATE');
    let thrown: unknown;
    try {
      store.withImmediateWriteAttempt(() => {
        store.upsertSession({
          provider: 'claude',
          threadId: 'probe',
          status: 'ready',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        return true;
      });
    } catch (error) {
      thrown = error;
    }
    expect(isSqliteContentionError(thrown)).toBe(true);
  } finally {
    peer.exec('ROLLBACK');
    peer.close();
    store.close();
  }
});

test.each(['transient', 'deadline'] as const)(
  'start acknowledgement waits for session.started publication under %s contention',
  async (mode) => {
    const threadId = `start-publication-${mode}`;
    const owner = 'start-publication-owner';
    const store = new EventStore(
      join(makeTempDir('start-commit-'), 'events.sqlite'),
    );
    const adapter = new EchoingAdapter();
    const sessions = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(adapter),
      eventBus: new EventBus(),
      eventStore: store,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const append = store.appendEvent.bind(store);
    let attempts = 0;
    vi.spyOn(store, 'appendEvent').mockImplementation((event, ...rest) => {
      if (event.method === 'session.started' && event.threadId === threadId) {
        attempts++;
        if (mode === 'deadline' || attempts === 1)
          throw Object.assign(new Error('database is locked'), {
            code: 'SQLITE_BUSY',
          });
      }
      return append(event, ...rest);
    });
    try {
      const outcome = await sessions.sessionCommands.execute(
        {
          type: 'start-session',
          input: { threadId, provider: 'claude', metadata: { userId: owner } },
        },
        { userId: owner },
      );
      if (mode === 'deadline') {
        expect(outcome.status).toBe('indeterminate');
        expect(
          store.latestEventByMethod(threadId, 'session.started'),
        ).toBeUndefined();
        expect(sessions.sessionRecordedOwnerId(threadId)).toBeUndefined();
        await expect(
          sessions.dispatchWithReceipt(
            {
              type: 'sendTurn',
              input: { threadId, input: 'unconfirmed start cannot send' },
            },
            { userId: owner },
          ),
        ).rejects.toThrow(`Session not found: ${threadId}`);
        expect(adapter.turns).toEqual([]);
      } else {
        expect(outcome.status).toBe('accepted');
        expect(
          store.latestEventByMethod(threadId, 'session.started')?.payload,
        ).toMatchObject({
          threadId,
          method: 'session.started',
          metadata: { userId: owner },
        });
        expect(sessions.sessionRecordedOwnerId(threadId)).toBe(owner);
        await sessions.dispatchWithReceipt(
          {
            type: 'sendTurn',
            input: { threadId, input: 'immediate authorized send' },
          },
          { userId: owner },
        );
        expect(adapter.turns.map((turn) => turn.input)).toEqual([
          'immediate authorized send',
        ]);
        expect(attempts).toBeGreaterThanOrEqual(2);
      }
    } finally {
      await sessions.shutdown();
      store.close();
    }
  },
);

test('a publication-timeout smoke retains its failed-stop handle without a durable start', async () => {
  const store = new EventStore(
    join(makeTempDir('start-smoke-retained-'), 'events.sqlite'),
  );
  const adapter = new EchoingAdapter();
  vi.spyOn(adapter, 'stopSession').mockRejectedValue(new Error('stop failed'));
  const append = store.appendEvent.bind(store);
  vi.spyOn(store, 'appendEvent').mockImplementation((event, ...rest) => {
    if (event.method === 'session.started')
      throw Object.assign(new Error('database is locked'), {
        code: 'SQLITE_BUSY',
      });
    return append(event, ...rest);
  });
  const sessions = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: new EventBus(),
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  sessions.initialize();
  try {
    const result = await sessions.runConnectionSmoke({
      connectionId: 'claude',
      provider: 'claude',
      cwd: process.cwd(),
      timeoutMs: 500,
    });
    expect(result).toMatchObject({ ok: false, reasonCode: 'cleanup-failed' });
    expect(adapter.sessions.size).toBe(1);
    const retained = store.readSessions();
    expect(retained).toHaveLength(1);
    expect(
      store.latestEventByMethod(retained[0]!.threadId, 'session.started'),
    ).toBeUndefined();
    expect(
      sessions.sessionRecordedOwnerId(retained[0]!.threadId),
    ).toBeUndefined();
  } finally {
    await sessions.shutdown();
    store.close();
  }
});

test('stops a session completed by an adapter replaced during launch', async () => {
  const store = new EventStore(
    join(makeTempDir('start-replaced-'), 'events.sqlite'),
  );
  const launching = new EchoingAdapter(true);
  let resolveStart!: (session: ProviderSession) => void;
  const started = new Promise<ProviderSession>((resolve) => {
    resolveStart = resolve;
  });
  const start = vi
    .spyOn(launching, 'startSession')
    .mockReturnValueOnce(started);
  const stop = vi
    .spyOn(launching, 'stopSession')
    .mockImplementation(async (threadId) => {
      launching.sessions.delete(threadId);
    });
  const registry = createGateTestRegistry(launching);
  const sessions = new OrchestrationService({
    adapterRegistry: registry,
    eventBus: new EventBus(),
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  try {
    const launch = sessions.dispatch({
      type: 'startSession',
      input: { threadId: 'start-race', provider: 'claude', cwd: process.cwd() },
    });
    await vi.waitFor(() => expect(start).toHaveBeenCalled());
    vi.spyOn(registry, 'get').mockReturnValue(new EchoingAdapter(true));
    const session: ProviderSession = {
      provider: 'claude',
      threadId: 'start-race',
      status: 'ready',
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
    };
    launching.sessions.set(session.threadId, session);
    resolveStart(session);
    await expect(launch).rejects.toThrow('replaced while');
    expect(stop).toHaveBeenCalledWith('start-race');
    expect(launching.sessions.size).toBe(0);
    expect(
      store.readSessions().find((row) => row.threadId === 'start-race'),
    ).toBeUndefined();
  } finally {
    await sessions.shutdown();
    store.close();
  }
});
