import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ProviderSession } from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
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
import type { IProviderAdapterRegistry } from '../../../providers/provider-interfaces.js';
import { isSqliteContentionError } from '../../../utils/sqlite-wal.js';
import { createConversationForkContext } from '../conversation-fork-context.js';
import { readConversationContextSeedPin } from '../conversation-handoff-module.js';
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
  deferred = false;
  private announceStart?: () => void;
  publishStarted() {
    this.announceStart?.();
    this.announceStart = undefined;
  }
  readonly sessions = new Map<string, ProviderSession>();
  readonly turns: ProviderSendTurnInput[] = [];
  /** When set, `startSession` returns only after its event is stored. */
  settledBeforeReturn?: EventStore;
  /** False models an engine that dies before it reports its start. */
  emitStart = true;
  /** Runs just before `session.started` is queued. */
  beforeStartEvent?: (threadId: string) => void;
  /** Runs after `session.started` is queued, before `startSession` returns. */
  beforeReturn?: () => Promise<void>;
  constructor(private readonly echoUserId?: string | null) {
    super();
  }
  override async startSession(input: ProviderSessionStartInput) {
    const session = await super.startSession(input);
    this.sessions.set(input.threadId, session);
    const metadata = { ...input.metadata };
    if (this.echoUserId === null) delete metadata.userId;
    else if (this.echoUserId !== undefined) metadata.userId = this.echoUserId;
    const announce = () => {
      this.beforeStartEvent?.(input.threadId);
      if (this.emitStart)
        this.events.push({
          eventId: randomUUID(),
          provider: this.provider,
          threadId: input.threadId,
          sessionId: input.threadId,
          method: 'session.started',
          createdAt: session.createdAt,
          metadata,
        });
    };
    if (this.deferred && !this.beforeReturn && !this.settledBeforeReturn)
      this.announceStart = announce;
    else announce();
    await this.beforeReturn?.();
    const store = this.settledBeforeReturn;
    if (store)
      await vi.waitFor(() =>
        expect(
          store.latestEventByMethod(input.threadId, 'session.started'),
        ).toBeDefined(),
      );
    return session;
  }
  /** Event ids in the order the service's consumer pulled them. */
  readonly pulled: string[] = [];
  override async *streamEvents(options?: {
    signal?: AbortSignal;
  }): AsyncIterable<CanonicalRuntimeEvent> {
    for await (const event of super.streamEvents(options)) {
      this.pulled.push(event.eventId);
      yield event;
    }
  }
  /**
   * Resolves once every event queued before it has been fully consumed: the
   * consumer pulls the marker only after the previous event's handling.
   */
  async drained() {
    const marker = randomUUID();
    this.events.push({
      eventId: marker,
      provider: this.provider,
      threadId: 'drain-marker',
      sessionId: 'drain-marker',
      method: 'session.configured',
      createdAt: new Date().toISOString(),
    });
    await vi.waitFor(() => expect(this.pulled).toContain(marker));
  }
  exit(threadId: string) {
    this.events.push({
      eventId: randomUUID(),
      provider: this.provider,
      threadId,
      sessionId: threadId,
      method: 'session.exited',
      createdAt: new Date().toISOString(),
      exitCode: 1,
      reason: 'The engine exited.',
    });
  }
  override async sendTurn(input: ProviderSendTurnInput) {
    this.turns.push(input);
    return { threadId: input.threadId, turnId: `turn-${this.turns.length}` };
  }
  override async stopSession(threadId?: string) {
    if (threadId) this.sessions.delete(threadId);
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
 * fails every attempt, so the publish gives up; `'none'` never contends.
 */
function fixture(
  options: {
    echoUserId?: string | null;
    contend?: 'first' | 'all' | 'none';
    hosted?: boolean;
    /** Personal access: `account-reader` reads `owner`'s conversations. */
    personalAccess?: boolean;
    thread?: string;
    /**
     * Starts on a replaced adapter's registry with no change notice, so the
     * replaced adapter's consumer keeps running; `replace()` swaps it out.
     */
    replaceable?: boolean;
  } = {},
) {
  const thread = options.thread ?? threadId;
  const warn = vi.fn();
  const path = join(makeTempDir('start-owner-contention-'), 'events.sqlite');
  const store = new EventStore(path);
  const adapter = new EchoingAdapter(options.echoUserId);
  // Exercise the fallback only for adapters that announce after start returns.
  adapter.deferred = true;
  const announceDeferred = <T>(result: T): T => {
    adapter.publishStarted();
    return result;
  };
  const replaced = new EchoingAdapter();
  let current: EchoingAdapter = options.replaceable ? replaced : adapter;
  const registry: IProviderAdapterRegistry = {
    register() {},
    get: (provider) => (provider === current.provider ? current : undefined),
    list: () => [current],
  };
  const sessions = new OrchestrationService({
    adapterRegistry: options.replaceable
      ? registry
      : createGateTestRegistry(adapter),
    eventBus: new EventBus(),
    eventStore: store,
    logger: { debug: vi.fn(), warn },
    resolveSessionAgent: async (input) => ({
      ...input,
      agent: { slug: 'claude' },
    }),
    ...(options.personalAccess
      ? {
          personalConversationAccess: {
            canRead: (reader: string, owner: string) =>
              reader === 'account-reader' && owner === 'owner',
            ownerIds: () => ['owner'],
          },
        }
      : {}),
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
  let released = false;
  const release = () => {
    released = true;
  };
  const retryReached = vi.fn();
  const attempt = store.withImmediateWriteAttempt.bind(store);
  vi.spyOn(store, 'withImmediateWriteAttempt').mockImplementation((publish) => {
    attempts += 1;
    if (attempts > 1) retryReached(thread);
    if (contend === 'none' || (contend === 'first' && released && attempts > 1))
      return attempt(publish);
    const peer = new DatabaseSync(path, { timeout: 0 });
    try {
      peer.exec('BEGIN IMMEDIATE');
      return attempt(publish);
    } finally {
      peer.exec('ROLLBACK');
      peer.close();
    }
  });
  const start = (
    ownerStamp: string,
    context: {
      userId?: string;
      tenantExecutionContext?: TenantExecutionContext;
    },
  ) =>
    sessions
      .dispatchWithReceipt(
        {
          type: 'startSession',
          input: {
            provider: 'claude',
            threadId: thread,
            cwd: process.cwd(),
            metadata: { userId: ownerStamp },
          },
        },
        context,
      )
      .then(announceDeferred);
  /**
   * A ready replay-seed fork of `owner`'s conversation into `thread`, started
   * the way a foreground send starts it: stamped with the requester.
   */
  const startFork = (requester: string) => {
    const snapshot = createConversationForkContext({
      forkEventId: 'fork-event',
      sourceConversationId: 'source',
      sourceSessionId: 'source',
      sourceAgent: 'claude',
      targetConversationId: thread,
      targetAgent: 'claude',
      ownerUserId: 'owner',
      branchPointTurnId: 'turn-one',
      sourceTitle: 'Source',
      createdAt: new Date().toISOString(),
      messages: [
        {
          id: 'answer',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Hi' }],
        },
      ],
    });
    store.reserveConversationForkContext(snapshot);
    store.publishConversationForkContext(
      {
        eventId: 'fork-event',
        provider: 'station',
        threadId: 'source',
        method: 'conversation.forked',
        sourceConversationId: 'source',
        targetConversationId: thread,
        targetAgent: 'claude',
        sourceSessionId: 'source',
        branchPointTurnId: 'turn-one',
        forkedAt: snapshot.createdAt,
        createdAt: snapshot.createdAt,
        contextDigest: snapshot.digest,
        continuation: 'replay-seed',
      },
      snapshot.digest,
    );
    // The start below takes the fork path: a ready reference for `thread`.
    expect(store.conversationForkContextReference(thread)?.state).toBe('ready');
    const origin = { contextId: 'fork-event', contextDigest: snapshot.digest };
    return sessions
      .startSessionInternal(
        {
          type: 'start-session',
          input: {
            provider: 'claude',
            threadId: thread,
            cwd: process.cwd(),
            metadata: {
              userId: requester,
              agentSlug: 'claude',
              forkContextOrigin: origin,
              forkSeedCarrier: {
                ...origin,
                seedDigest: readConversationContextSeedPin(snapshot.seedPinJson)
                  .seedDigest,
                clientTurnId: 'fork-turn',
              },
            },
          },
        },
        { userId: requester },
        {},
      )
      .then(announceDeferred);
  };
  const send = (userId: string, tenant?: TenantExecutionContext) =>
    sessions
      .dispatchWithReceipt(
        {
          type: 'sendTurn',
          input: { threadId: thread, input: `from ${userId}` },
        },
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
    sessions.canUserMutateSession(thread, userId, tenant);
  return {
    store,
    adapter,
    sessions,
    thread,
    warn,
    replaced,
    /** Make `adapter` current; the replaced adapter's consumer keeps running. */
    replace: () => {
      sessions.initialize();
      current = adapter;
    },
    start,
    startFork,
    send,
    admits,
    release,
    attempts: () => attempts,
    /** The first publish attempt failed and its retry is being held. */
    retrying: () =>
      vi.waitFor(() => expect(retryReached).toHaveBeenCalledWith(thread)),
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
test('a deferred start owner can send a turn while its contended session.started publish is still retrying', async () => {
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

// Regression coverage: the durable owner stays authoritative once it lands.
test('regression: a durable owner the adapter echoed differently replaces the start stamp', async () => {
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
    // Contention exhausts the asynchronous publication budget.
    await vi.waitFor(() => expect(f.attempts()).toBeGreaterThanOrEqual(3));
    await vi.waitFor(() => expect(f.admits('owner')).toBe(false), {
      timeout: 7500,
    });
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

// Regression coverage: teardown on stop already ends the interim owner.
test('regression: stopping the session in the window ends the interim owner', async () => {
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

// Regression coverage: discard teardown already ends the interim owner.
test('regression: discarding the draft in the window ends the interim owner', async () => {
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

test('a start that fails after the start hook leaves no interim owner, even when its cleanup fails', async () => {
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
    // A failed provider stop skips the cleanup's thread teardown.
    vi.spyOn(f.adapter, 'stopSession').mockRejectedValue(
      new Error('stop failed'),
    );
    await expect(f.start('owner', { userId: 'owner' })).rejects.toThrow(
      'binding failed',
    );
    expect(f.admits('owner')).toBe(false);
  } finally {
    await f.close();
  }
});

// Regression coverage: the hosted tenant check runs before any owner.
test('regression: a hosted interim owner is refused under another tenant', async () => {
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

test('a start whose session.started publish gave up before the start hook binds no interim owner', async () => {
  const f = fixture({ contend: 'all' });
  try {
    // The engine reports its start, and the publish exhausts its retries
    // (nothing is appended) before startSession returns.
    f.adapter.beforeReturn = () =>
      vi.waitFor(
        () =>
          expect(f.warn).toHaveBeenCalledWith(
            'Provider adapter event stream stopped',
            expect.anything(),
          ),
        { timeout: 7500 },
      );
    await expect(f.start('owner', { userId: 'owner' })).rejects.toMatchObject({
      receipt: { status: 'indeterminate' },
    });
    expect(
      f.store.latestEventByMethod(threadId, 'session.started'),
    ).toBeUndefined();
    expect(f.admits('owner')).toBe(false);
  } finally {
    await f.close();
  }
});

test('a start event lost to a store fault before publishing leaves no interim owner', async () => {
  const f = fixture({ contend: 'none' });
  try {
    let armed = false;
    const read = f.store.listSessionProjectionEvents.bind(f.store);
    vi.spyOn(f.store, 'listSessionProjectionEvents').mockImplementation(
      (thread, ...rest) => {
        if (armed && thread === threadId) {
          armed = false;
          throw Object.assign(new Error('database is locked'), { errcode: 5 });
        }
        return read(thread, ...rest);
      },
    );
    // Fault the lifecycle normalization of exactly the start event.
    f.adapter.beforeStartEvent = () => {
      armed = true;
    };
    await f.start('owner', { userId: 'owner' });
    await vi.waitFor(() =>
      expect(f.warn).toHaveBeenCalledWith(
        'Provider adapter event stream stopped',
        expect.anything(),
      ),
    );
    expect(
      f.store.latestEventByMethod(threadId, 'session.started'),
    ).toBeUndefined();
    expect(f.admits('owner')).toBe(false);
  } finally {
    await f.close();
  }
});

test('an engine that exits before reporting its start ends the interim owner', async () => {
  const f = fixture({ contend: 'none' });
  try {
    f.adapter.emitStart = false;
    await f.start('owner', { userId: 'owner' });
    expect(f.admits('owner')).toBe(true);
    f.adapter.exit(threadId);
    await vi.waitFor(() => expect(f.admits('owner')).toBe(false), {
      timeout: 7500,
    });
  } finally {
    await f.close();
  }
});

test('an exit forgets the settled start', async () => {
  const f = fixture({ contend: 'none' });
  try {
    const settled = (
      f.sessions as unknown as { settledStartEvents: Set<string> }
    ).settledStartEvents;
    await f.start('owner', { userId: 'owner' });
    await vi.waitFor(() => expect(settled.has(threadId)).toBe(true));
    f.adapter.exit(threadId);
    await vi.waitFor(() => expect(settled.has(threadId)).toBe(false));
  } finally {
    await f.close();
  }
});

test('a start event that settles after teardown is not remembered', async () => {
  const f = fixture();
  try {
    const internals = f.sessions as unknown as {
      settledStartEvents: Set<string>;
    };
    await f.start('owner', { userId: 'owner' });
    await f.retrying();
    await f.sessions.dispatchWithReceipt(
      { type: 'discardDraft', threadId },
      { userId: 'owner' },
    );
    f.release();
    // The consumer finishes handling the held start before pulling the marker.
    await f.adapter.drained();
    expect(
      f.store.latestEventByMethod(threadId, 'session.started'),
    ).toBeUndefined();
    expect(f.admits('owner')).toBe(false);
    expect(internals.settledStartEvents.has(threadId)).toBe(false);
  } finally {
    await f.close();
  }
});

test('an engine that exits before the start hook leaves no interim owner', async () => {
  const f = fixture({ contend: 'none' });
  try {
    f.adapter.emitStart = false;
    // The engine dies while startSession is still pending.
    f.adapter.beforeReturn = async () => {
      f.adapter.exit(threadId);
      await f.adapter.drained();
    };
    await f.start('owner', { userId: 'owner' });
    expect(f.store.findSessionOwnerUserId(threadId)).toBeUndefined();
    expect(f.admits('owner')).toBe(false);
  } finally {
    await f.close();
  }
});

test('a replaced adapter late exit cannot end the current adapter start window', async () => {
  const f = fixture({ contend: 'none', replaceable: true });
  try {
    f.replace();
    // The current adapter's stream is not consumed (no change notice), so
    // its start window stays open.
    await f.start('owner', { userId: 'owner' });
    expect(f.admits('owner')).toBe(true);
    f.replaced.exit(threadId);
    await f.replaced.drained();
    expect(f.replaced.pulled.length).toBeGreaterThanOrEqual(2);
    // Still no durable owner: only the interim owner can admit here.
    expect(f.store.findSessionOwnerUserId(threadId)).toBeUndefined();
    expect(f.admits('owner')).toBe(true);
  } finally {
    await f.close();
  }
});

test('a fork started by its owner admits the owner while its start publish retries', async () => {
  const f = fixture({ thread: 'child', personalAccess: true });
  try {
    const started = await f.startFork('owner');
    expect(started.status, JSON.stringify(started)).toBe('accepted');
    await f.retrying();
    expect(f.store.findSessionOwnerUserId('child')).toBeUndefined();
    expect(f.admits('owner')).toBe(true);
    expect(f.admits('stranger')).toBe(false);
  } finally {
    await f.close();
  }
});

test('a fork started by a personal-access reader binds the reader, whose stamp becomes durable', async () => {
  const f = fixture({ thread: 'child', personalAccess: true });
  try {
    const started = await f.startFork('account-reader');
    expect(started.status, JSON.stringify(started)).toBe('accepted');
    await f.retrying();
    expect(f.admits('account-reader')).toBe(true);
    // account-reader may read owner's conversations, so only this tells the
    // bound principal apart: owner passes only if owner was bound.
    expect(f.admits('owner')).toBe(false);
    expect(f.admits('stranger')).toBe(false);
    f.release();
    await vi.waitFor(() =>
      expect(f.store.findSessionOwnerUserId('child')).toBe('account-reader'),
    );
    expect(f.admits('account-reader')).toBe(true);
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
  const stop = vi.spyOn(launching, 'stopSession');
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
