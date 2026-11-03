import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ProviderSession } from '@kontourai/station-contracts/provider';
import {
  type TenantExecutionContext,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
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
const threadId = 'delegated-session';
const tenantOne: TenantExecutionContext = {
  tenantId: tenantId('tenant-one'),
  source: 'session',
};
const tenantTwo: TenantExecutionContext = {
  tenantId: tenantId('tenant-two'),
  source: 'session',
};

/**
 * Echoes the start metadata on `session.started`, as every real adapter does.
 * `echoUserId` rewrites the echoed owner; `null` drops it.
 */
class EchoingAdapter extends GateTestAdapter {
  readonly sessions = new Map<string, ProviderSession>();
  readonly turns: ProviderSendTurnInput[] = [];
  /** When set, `startSession` returns only after its event is stored. */
  settledBeforeReturn?: EventStore;
  constructor(private readonly echoUserId?: string | null) {
    super();
  }
  override async startSession(input: ProviderSessionStartInput) {
    const session = await super.startSession(input);
    this.sessions.set(input.threadId, session);
    const metadata = { ...input.metadata };
    if (this.echoUserId === null) delete metadata.userId;
    else if (this.echoUserId !== undefined) metadata.userId = this.echoUserId;
    this.events.push({
      eventId: randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      sessionId: input.threadId,
      method: 'session.started',
      createdAt: session.createdAt,
      metadata,
    });
    const store = this.settledBeforeReturn;
    if (store)
      await vi.waitFor(() =>
        expect(
          store.latestEventByMethod(input.threadId, 'session.started'),
        ).toBeDefined(),
      );
    return session;
  }
  override async sendTurn(input: ProviderSendTurnInput) {
    this.turns.push(input);
    return { threadId: input.threadId, turnId: `turn-${this.turns.length}` };
  }
  override async stopSession(threadId: string) {
    this.sessions.delete(threadId);
  }
  override async hasSession(threadId?: string) {
    return !!threadId && this.sessions.has(threadId);
  }
  override async listSessions() {
    return [...this.sessions.values()];
  }
}

/**
 * A real event store whose zero-timeout observed-event publish meets a real
 * peer writer (genuine SQLITE_BUSY). `contend: 'first'` fails only the first
 * attempt and holds the retry until `release()`, so the start's
 * `session.started` is provably unsettled while the test decides; `'all'`
 * fails every attempt, so the publish gives up.
 */
function fixture(
  options: {
    echoUserId?: string | null;
    contend?: 'first' | 'all';
    hosted?: boolean;
  } = {},
) {
  const path = join(makeTempDir('start-owner-contention-'), 'events.sqlite');
  const store = new EventStore(path);
  const adapter = new EchoingAdapter(options.echoUserId);
  const sessions = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: new EventBus(),
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn() },
    ...(options.hosted
      ? {
          requireTenantExecutionContext: () => true,
          validateRecoveredTenantExecutionContext: (
            context: TenantExecutionContext | undefined,
          ) =>
            context?.tenantId === tenantOne.tenantId ||
            context?.tenantId === tenantTwo.tenantId
              ? context
              : undefined,
        }
      : {}),
  });
  const contend = options.contend ?? 'first';
  let attempts = 0;
  const attempt = store.withImmediateWriteAttempt.bind(store);
  vi.spyOn(store, 'withImmediateWriteAttempt').mockImplementation((publish) => {
    attempts += 1;
    if (contend === 'first' && attempts > 1) return attempt(publish);
    const peer = new DatabaseSync(path, { timeout: 0 });
    try {
      peer.exec('BEGIN IMMEDIATE');
      return attempt(publish);
    } finally {
      peer.exec('ROLLBACK');
      peer.close();
    }
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const retryReached = vi.fn();
  const waitForWrite = store.waitForPublicationWrite.bind(store);
  vi.spyOn(store, 'waitForPublicationWrite').mockImplementation(
    async (thread, signal) => {
      retryReached(thread);
      if (contend === 'first') await held;
      return waitForWrite(thread, signal);
    },
  );
  const start = (
    ownerStamp: string,
    context: {
      userId?: string;
      tenantExecutionContext?: TenantExecutionContext;
    },
  ) =>
    sessions.dispatchWithReceipt(
      {
        type: 'startSession',
        input: {
          provider: 'claude',
          threadId,
          cwd: process.cwd(),
          metadata: { userId: ownerStamp },
        },
      },
      context,
    );
  const send = (userId: string, tenant?: TenantExecutionContext) =>
    sessions
      .dispatchWithReceipt(
        { type: 'sendTurn', input: { threadId, input: `from ${userId}` } },
        { userId, ...(tenant ? { tenantExecutionContext: tenant } : {}) },
      )
      .then(
        (result) => result.receipt.status,
        (error: unknown) => {
          expect(error).toBeInstanceOf(OrchestrationCommandDispatchError);
          return `refused: ${(error as Error).message}`;
        },
      );
  const admits = (userId: string, tenant?: TenantExecutionContext) =>
    sessions.canUserMutateSession(threadId, userId, tenant);
  return {
    store,
    adapter,
    sessions,
    start,
    send,
    admits,
    release,
    attempts: () => attempts,
    /** The first publish attempt failed and its retry is being held. */
    retrying: () =>
      vi.waitFor(() => expect(retryReached).toHaveBeenCalledWith(threadId)),
    close: async () => {
      release();
      await sessions.shutdown();
      store.close();
    },
  };
}

// #4480: the owner-bearing `session.started` reaches the store through the
// zero-timeout observed-event publish. Under contention that append retries
// asynchronously, and a turn sent right after the accepted start (a
// delegation's initial turn) must still be admitted for its owner.
test('a start owner can send a turn while its contended session.started publish is still retrying', async () => {
  const f = fixture();
  try {
    await f.start('owner', { userId: 'owner' });
    await f.retrying();
    // The durable owner is not written yet: this is the hosted window.
    expect(f.store.findSessionOwnerUserId(threadId)).toBeUndefined();

    // The pending start owner widens nothing for anyone else.
    expect(await f.send('someone-else')).toBe(
      `refused: Session not found: ${threadId}`,
    );
    expect(await f.send('owner')).toBe('accepted');
    expect(f.adapter.turns.map((turn) => turn.input)).toEqual(['from owner']);

    f.release();
    await vi.waitFor(() =>
      expect(f.store.findSessionOwnerUserId(threadId)).toBe('owner'),
    );
  } finally {
    await f.close();
  }
});

test('a durable owner the adapter echoed differently replaces the start stamp', async () => {
  const f = fixture({ echoUserId: 'other' });
  try {
    await f.start('owner', { userId: 'owner' });
    await f.retrying();
    expect(f.admits('owner')).toBe(true);
    f.release();
    await vi.waitFor(() =>
      expect(f.store.findSessionOwnerUserId(threadId)).toBe('other'),
    );
    expect(f.admits('owner')).toBe(false);
    expect(f.admits('other')).toBe(true);
    expect(await f.send('owner')).toBe(
      `refused: Session not found: ${threadId}`,
    );
  } finally {
    await f.close();
  }
});

test('an echo that drops the owner leaves the session ownerless for commands too', async () => {
  const f = fixture({ echoUserId: null });
  try {
    await f.start('owner', { userId: 'owner' });
    await f.retrying();
    expect(f.admits('owner')).toBe(true);
    f.release();
    await vi.waitFor(() =>
      expect(
        f.store.latestEventByMethod(threadId, 'session.started'),
      ).toBeDefined(),
    );
    expect(f.store.findSessionOwnerUserId(threadId)).toBeUndefined();
    // Reads refuse an ownerless session; commands now agree.
    expect(f.admits('owner')).toBe(false);
  } finally {
    await f.close();
  }
});

test('a start whose session.started settled before the start hook binds no interim owner', async () => {
  const f = fixture({ echoUserId: null });
  try {
    f.release();
    f.adapter.settledBeforeReturn = f.store;
    await f.start('owner', { userId: 'owner' });
    expect(f.store.findSessionOwnerUserId(threadId)).toBeUndefined();
    expect(f.admits('owner')).toBe(false);
  } finally {
    await f.close();
  }
});

test('a session.started publish that gives up leaves no interim owner', async () => {
  const f = fixture({ contend: 'all' });
  try {
    await f.start('owner', { userId: 'owner' });
    // Three contended attempts, then the publish is abandoned.
    await vi.waitFor(() => expect(f.attempts()).toBeGreaterThanOrEqual(3));
    await vi.waitFor(() => expect(f.admits('owner')).toBe(false));
    expect(f.store.findSessionOwnerUserId(threadId)).toBeUndefined();
    expect(await f.send('owner')).toBe(
      `refused: Session not found: ${threadId}`,
    );
  } finally {
    await f.close();
  }
});

test('a start stamped for another principal binds no interim owner', async () => {
  const f = fixture();
  try {
    await f.start('mallory', { userId: 'alice' });
    await f.retrying();
    expect(f.admits('mallory')).toBe(false);
    expect(f.admits('alice')).toBe(false);
  } finally {
    await f.close();
  }
});

test('stopping the session in the window ends the interim owner', async () => {
  const f = fixture();
  try {
    await f.start('owner', { userId: 'owner' });
    await f.retrying();
    expect(f.admits('owner')).toBe(true);
    await f.sessions.dispatchWithReceipt(
      { type: 'stopSession', threadId },
      { userId: 'owner' },
    );
    expect(f.store.findSessionOwnerUserId(threadId)).toBeUndefined();
    expect(f.admits('owner')).toBe(false);
  } finally {
    await f.close();
  }
});

test('discarding the draft in the window ends the interim owner', async () => {
  const f = fixture();
  try {
    await f.start('owner', { userId: 'owner' });
    await f.retrying();
    await f.sessions.dispatchWithReceipt(
      { type: 'discardDraft', threadId },
      { userId: 'owner' },
    );
    expect(f.admits('owner')).toBe(false);
    expect(await f.send('owner')).toMatch(/^refused: /);
  } finally {
    await f.close();
  }
});

test('a start that fails after the start hook leaves no interim owner', async () => {
  const f = fixture();
  try {
    const policy = (
      f.sessions as unknown as {
        flowPolicy: { bindPolicyHooksToSession: (...args: unknown[]) => void };
      }
    ).flowPolicy;
    vi.spyOn(policy, 'bindPolicyHooksToSession').mockImplementation(() => {
      throw new Error('binding failed');
    });
    await expect(f.start('owner', { userId: 'owner' })).rejects.toThrow(
      'binding failed',
    );
    expect(f.admits('owner')).toBe(false);
  } finally {
    await f.close();
  }
});

test('a hosted interim owner is refused under another tenant', async () => {
  const f = fixture({ hosted: true });
  try {
    await f.start('owner', {
      userId: 'owner',
      tenantExecutionContext: tenantOne,
    });
    await f.retrying();
    expect(f.store.findSessionOwnerUserId(threadId)).toBeUndefined();
    expect(f.admits('owner', tenantTwo)).toBe(false);
    expect(f.admits('owner', tenantOne)).toBe(true);
  } finally {
    await f.close();
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
