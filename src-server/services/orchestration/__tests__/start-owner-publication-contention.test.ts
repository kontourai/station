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
  readonly sessions = new Map<string, ProviderSession>();
  readonly turns: ProviderSendTurnInput[] = [];
  override async startSession(input: ProviderSessionStartInput) {
    const session = await super.startSession(input);
    this.sessions.set(input.threadId, session);
    this.events.push({
      eventId: randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      sessionId: input.threadId,
      method: 'session.started',
      createdAt: session.createdAt,
      metadata: input.metadata,
    });
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
// asynchronously, and a turn sent right after the accepted start (a
// delegation's initial turn) must still be admitted for its owner.
test('a start owner can send a turn while its contended session.started publish is still retrying', async () => {
  const path = join(makeTempDir('start-owner-contention-'), 'events.sqlite');
  const store = new EventStore(path);
  const adapter = new EchoingAdapter();
  const sessions = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: new EventBus(),
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  let contended = 0;
  const attempt = store.withImmediateWriteAttempt.bind(store);
  vi.spyOn(store, 'withImmediateWriteAttempt').mockImplementation((publish) => {
    if (contended > 0) return attempt(publish);
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
  let releaseRetry!: () => void;
  const retryHeld = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  const retryReached = vi.fn();
  const waitForWrite = store.waitForPublicationWrite.bind(store);
  vi.spyOn(store, 'waitForPublicationWrite').mockImplementation(
    async (threadId, signal) => {
      retryReached(threadId);
      await retryHeld;
      return waitForWrite(threadId, signal);
    },
  );
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
    await vi.waitFor(() => expect(retryReached).toHaveBeenCalledWith(threadId));
    expect(contended).toBe(1);
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
