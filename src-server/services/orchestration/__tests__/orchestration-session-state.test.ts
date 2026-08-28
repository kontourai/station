import { ENGINE_SESSION_BINDING_DEAD_CODE } from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test, vi } from 'vitest';
import type {
  ProviderAdapterShape,
  ProviderSession,
} from '../../../providers/adapter-shape.js';
import { waitForReceipt } from '../../infra/receipt-bus.js';
import type { SessionAnswerabilityObservation } from '../open-requests.js';
import {
  buildAgentRunSummary,
  buildOrchestrationSessionSummary,
  classifyAgentRunFailure,
  isAgentRunRetryEligible,
  projectOrchestrationEventToReadModel,
  type RecoveredSessionStartOptions,
  recoverOrchestrationSessions,
  resolveOrchestrationAdapterForThread,
  SESSION_RECOVERY_FAILED_CODE,
  startRecoveredOrchestrationSession,
  trackOrchestrationSession,
} from '../orchestration-session-state.js';

/**
 * archive#3476: the engine-start half of recovery, which boot no longer runs.
 * Every test that used to assert `adapter.startSession` was called BY
 * `recoverOrchestrationSessions` now asserts it against this instead — the
 * pipeline is the same code, moved to the moment a session is first used.
 */
const startRecovered = (input: {
  session: ProviderSession;
  adapter: ProviderAdapterShape;
  options?: Partial<RecoveredSessionStartOptions>;
}) =>
  startRecoveredOrchestrationSession({
    session: input.session,
    adapter: input.adapter,
    options: {
      assertAdapterReady: async () => {},
      trackStartedSession: () => {},
      logger: { warn: vi.fn() },
      ...input.options,
    },
  });

/**
 * The process-local half of the answerability decoration
 * (archive#1778). These tests are about the builder's MERGE behaviour, so
 * every call states the observation explicitly rather than hiding it behind
 * a shim — the required option is the enforcement mechanism, and a test
 * helper that supplied it implicitly would be the first place it stopped
 * being enforced.
 */
const OBSERVATION: SessionAnswerabilityObservation = {
  threadAttachment: 'detached',
  providerRegistered: true,
  observedBy: 'test-instance#0',
  observedAt: '2026-08-03T00:00:00.000Z',
};

describe('orchestration-session-state', () => {
  test('resolveOrchestrationAdapterForThread caches discovered ownership', async () => {
    const threadProviders = new Map<string, 'bedrock' | 'claude' | 'codex'>();
    const bedrock = {
      provider: 'bedrock',
      hasSession: vi.fn().mockResolvedValue(false),
    } as unknown as ProviderAdapterShape;
    const claude = {
      provider: 'claude',
      hasSession: vi.fn().mockResolvedValue(true),
    } as unknown as ProviderAdapterShape;

    const adapter = await resolveOrchestrationAdapterForThread({
      threadId: 'thread-1',
      threadProviders,
      requireAdapter: (provider) => {
        if (provider === 'claude') return claude;
        return bedrock;
      },
      adapters: [bedrock, claude],
    });

    expect(adapter).toBe(claude);
    expect(threadProviders.get('thread-1')).toBe('claude');
  });

  test('projectOrchestrationEventToReadModel persists closed sessions', () => {
    const threadProviders = new Map<string, 'bedrock' | 'claude' | 'codex'>();
    const sessionReadModel = new Map<string, ProviderSession>();
    const eventStore = {
      upsertSession: vi.fn(),
      markSessionClosed: vi.fn(),
    } as any;

    trackOrchestrationSession({
      threadProviders,
      sessionReadModel,
      session: {
        provider: 'claude',
        threadId: 'thread-2',
        status: 'running',
        createdAt: '2026-04-11T00:00:00.000Z',
        updatedAt: '2026-04-11T00:00:00.000Z',
      },
    });

    projectOrchestrationEventToReadModel({
      event: {
        provider: 'claude',
        threadId: 'thread-2',
        method: 'session.exited',
        createdAt: '2026-04-11T00:00:05.000Z',
      } as any,
      threadProviders,
      sessionReadModel,
      eventStore,
    });

    expect(sessionReadModel.get('thread-2')).toMatchObject({
      status: 'closed',
    });
    expect(eventStore.markSessionClosed).toHaveBeenCalledWith(
      'thread-2',
      'claude',
    );
    expect(eventStore.upsertSession).not.toHaveBeenCalled();
  });

  /**
   * archive#3476, the whole point of the issue. Boot recovery restores state
   * and starts NOTHING. Asserted against the adapter's own `startSession`
   * rather than any process count, because that is the call the ACP adapter
   * turns into a subprocess.
   */
  test('recoverOrchestrationSessions restores every persisted session and starts ZERO engines', async () => {
    const recovered: ProviderSession[] = [];
    const adapter = {
      provider: 'claude',
      startSession: vi.fn(),
      // archive#3476: recovery asks whether the adapter already holds each
      // thread. After a restart every in-tree adapter answers false.
      hasSession: vi.fn().mockResolvedValue(false),
    } as unknown as ProviderAdapterShape;
    const sessions = Array.from({ length: 5 }, (_, index) => ({
      provider: 'claude' as const,
      threadId: `thread-${index}`,
      status: 'running' as const,
      model: 'sonnet',
      cwd: '/workspace/project',
      persistSession: true,
      createdAt: '2026-04-10T23:00:00.000Z',
      updatedAt: '2026-04-11T00:00:00.000Z',
    }));
    const eventStore = {
      readSessions: vi.fn().mockReturnValue(sessions),
      upsertSession: vi.fn(),
      markSessionClosed: vi.fn(),
      appendEventIfAbsent: vi.fn(),
    } as any;

    await recoverOrchestrationSessions({
      adapterRegistry: {
        get: (provider) => (provider === 'claude' ? adapter : undefined),
        list: () => [adapter],
        register() {},
      },
      eventStore,
      trackSession: (session) => {
        recovered.push(session);
      },
      logger: { warn: vi.fn() },
    });

    expect(adapter.startSession).not.toHaveBeenCalled();
    // ...and the sessions are all there: listed, addressable, resumable.
    expect(recovered.map((session) => session.threadId)).toEqual([
      'thread-0',
      'thread-1',
      'thread-2',
      'thread-3',
      'thread-4',
    ]);
    expect(recovered[0]).toMatchObject({
      status: 'running',
      cwd: '/workspace/project',
      createdAt: '2026-04-10T23:00:00.000Z',
    });
  });

  /**
   * archive#3476: attachment is DERIVED, and both directions matter. Binding
   * the registry's adapter unconditionally — which is what recovery used to
   * do, on the strength of having started an engine — would assert this
   * process holds a thread it merely restored a row for, and
   * `projectRequestAnswerability` reads exactly that fact.
   */
  test('recoverOrchestrationSessions binds the adapter only when the adapter says it already holds the thread', async () => {
    const held = 'thread-still-held';
    const notHeld = 'thread-not-held';
    const adapter = {
      provider: 'claude',
      startSession: vi.fn(),
      hasSession: vi.fn(async (threadId: string) => threadId === held),
    } as unknown as ProviderAdapterShape;
    const trackSession = vi.fn();

    await recoverOrchestrationSessions({
      adapterRegistry: {
        get: (provider) => (provider === 'claude' ? adapter : undefined),
        list: () => [adapter],
        register() {},
      },
      eventStore: {
        readSessions: vi.fn().mockReturnValue(
          [held, notHeld].map((threadId) => ({
            provider: 'claude',
            threadId,
            status: 'running',
            createdAt: '2026-08-19T00:00:00.000Z',
            updatedAt: '2026-08-19T00:00:01.000Z',
          })),
        ),
        upsertSession: vi.fn(),
        markSessionClosed: vi.fn(),
      } as any,
      trackSession,
      logger: { warn: vi.fn() },
    });

    expect(adapter.startSession).not.toHaveBeenCalled();
    expect(trackSession).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: held }),
      adapter,
    );
    expect(trackSession).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: notHeld }),
      undefined,
    );
  });

  test('a throwing hasSession does not sink the pass — that session is restored as not attached', async () => {
    const adapter = {
      provider: 'claude',
      startSession: vi.fn(),
      hasSession: vi.fn(async (threadId: string) => {
        if (threadId === 'thread-hostile') throw new Error('plugin exploded');
        return false;
      }),
    } as unknown as ProviderAdapterShape;
    const trackSession = vi.fn();

    await recoverOrchestrationSessions({
      adapterRegistry: {
        get: (provider) => (provider === 'claude' ? adapter : undefined),
        list: () => [adapter],
        register() {},
      },
      eventStore: {
        readSessions: vi.fn().mockReturnValue(
          ['thread-hostile', 'thread-after'].map((threadId) => ({
            provider: 'claude',
            threadId,
            status: 'running',
            createdAt: '2026-08-19T00:00:00.000Z',
            updatedAt: '2026-08-19T00:00:01.000Z',
          })),
        ),
        upsertSession: vi.fn(),
        markSessionClosed: vi.fn(),
      } as any,
      trackSession,
      logger: { warn: vi.fn() },
    });

    expect(trackSession).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-hostile' }),
      undefined,
    );
    // The session AFTER the throwing one is what proves containment.
    expect(trackSession).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-after' }),
      undefined,
    );
  });

  test('recoverOrchestrationSessions publishes the completed receipt for every restored thread', async () => {
    const adapter = {
      provider: 'acp',
      startSession: vi.fn(),
      hasSession: vi.fn().mockResolvedValue(false),
    } as unknown as ProviderAdapterShape;
    const completed = waitForReceipt(
      (receipt) => receipt.kind === 'session.recovery.completed',
    );

    await recoverOrchestrationSessions({
      adapterRegistry: {
        get: () => adapter,
        list: () => [adapter],
        register() {},
      },
      eventStore: {
        readSessions: vi.fn().mockReturnValue([
          {
            provider: 'acp',
            threadId: 'damaged-metadata',
            status: 'ready',
            createdAt: '2026-07-30T00:00:00.000Z',
            updatedAt: '2026-07-30T00:00:01.000Z',
          },
          {
            provider: 'acp',
            threadId: 'healthy-session',
            status: 'ready',
            createdAt: '2026-07-30T00:00:00.000Z',
            updatedAt: '2026-07-30T00:00:01.000Z',
          },
        ]),
        upsertSession: vi.fn(),
        appendEventIfAbsent: vi.fn(),
      } as any,
      trackSession: vi.fn(),
      logger: { warn: vi.fn() },
    });

    await expect(completed).resolves.toMatchObject({
      kind: 'session.recovery.completed',
      attemptedCount: 2,
      threadIds: ['damaged-metadata', 'healthy-session'],
    });
  });

  test('startRecoveredOrchestrationSession replays the persisted start input and preserves createdAt', async () => {
    const started: ProviderSession[] = [];
    const adapter = {
      provider: 'claude',
      startSession: vi.fn().mockResolvedValue({
        provider: 'claude',
        threadId: 'thread-3',
        status: 'ready',
        model: 'sonnet',
        createdAt: '2026-04-11T01:00:00.000Z',
        updatedAt: '2026-04-11T01:00:00.000Z',
      }),
    } as unknown as ProviderAdapterShape;
    const eventStore = { upsertSession: vi.fn() } as any;

    await startRecovered({
      session: {
        provider: 'claude',
        threadId: 'thread-3',
        status: 'running',
        model: 'sonnet',
        cwd: '/workspace/project',
        persistSession: true,
        createdAt: '2026-04-10T23:00:00.000Z',
        updatedAt: '2026-04-11T00:00:00.000Z',
      },
      adapter,
      options: {
        eventStore,
        trackStartedSession: (session) => {
          started.push(session);
        },
      },
    });

    expect(adapter.startSession).toHaveBeenCalledWith({
      threadId: 'thread-3',
      provider: 'claude',
      modelId: 'sonnet',
      cwd: '/workspace/project',
      resumeCursor: undefined,
      persistSession: true,
      metadata: undefined,
    });
    expect(started).toEqual([
      expect.objectContaining({
        threadId: 'thread-3',
        createdAt: '2026-04-10T23:00:00.000Z',
      }),
    ]);
    expect(eventStore.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-3',
        createdAt: '2026-04-10T23:00:00.000Z',
      }),
    );
  });

  test('scopes recovery readiness to the persisted external connection', async () => {
    const adapter = {
      provider: 'acp',
      startSession: vi.fn().mockResolvedValue({
        provider: 'acp',
        threadId: 'thread-opencode',
        status: 'ready',
        createdAt: '2026-07-30T00:00:00.000Z',
        updatedAt: '2026-07-30T00:00:01.000Z',
      }),
    } as unknown as ProviderAdapterShape;
    const assertAdapterReady = vi.fn().mockResolvedValue(undefined);

    await startRecovered({
      session: {
        provider: 'acp',
        threadId: 'thread-opencode',
        status: 'ready',
        cwd: '/workspace/project',
        persistSession: true,
        createdAt: '2026-07-30T00:00:00.000Z',
        updatedAt: '2026-07-30T00:00:01.000Z',
      },
      adapter,
      options: {
        eventStore: { upsertSession: vi.fn() } as any,
        readSessionStartMetadata: () => ({ connectionId: 'opencode' }),
        assertAdapterReady,
      },
    });

    expect(assertAdapterReady).toHaveBeenCalledWith(adapter, 'opencode');
  });

  test('recovery applies the shared launch gate before ACP readiness or adapter start', async () => {
    const adapter = {
      provider: 'acp',
      startSession: vi.fn(),
    } as unknown as ProviderAdapterShape;
    const assertAdapterReady = vi.fn();
    const prepareModelLaunch = vi.fn(() => {
      throw new Error(
        'model-override-unsupported: resume-override-unsupported',
      );
    });

    await expect(
      startRecovered({
        session: {
          provider: 'acp',
          threadId: 'legacy-acp-recovery',
          status: 'ready',
          model: 'historical-echo-only',
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
        adapter,
        options: {
          eventStore: {
            appendEventIfAbsent: vi.fn(),
            upsertSession: vi.fn(),
          } as any,
          assertAdapterReady,
          prepareModelLaunch,
        },
      }),
    ).rejects.toThrow('model-override-unsupported');

    expect(prepareModelLaunch).toHaveBeenCalledWith(
      adapter,
      expect.objectContaining({ threadId: 'legacy-acp-recovery' }),
      'historical-echo-only',
    );
    expect(assertAdapterReady).not.toHaveBeenCalled();
    expect(adapter.startSession).not.toHaveBeenCalled();
  });

  /**
   * archive#3476: the failure surface. A session whose engine cannot start
   * must report that truthfully at the moment of use — the caller's turn
   * fails, and the durable archive#1090 evidence is left behind — never a
   * silent success.
   */
  test('startRecoveredOrchestrationSession reports a damaged metadata read rather than starting anyway', async () => {
    const adapter = {
      provider: 'acp',
      startSession: vi.fn(),
    } as unknown as ProviderAdapterShape;
    const eventStore = {
      upsertSession: vi.fn(),
      appendEventIfAbsent: vi.fn(),
    } as any;

    await expect(
      startRecovered({
        session: {
          provider: 'acp',
          threadId: 'damaged-metadata',
          status: 'ready',
          createdAt: '2026-07-30T00:00:00.000Z',
          updatedAt: '2026-07-30T00:00:01.000Z',
        },
        adapter,
        options: {
          eventStore,
          readSessionStartMetadata: () => {
            throw new Error('invalid persisted event payload');
          },
        },
      }),
    ).rejects.toThrow('invalid persisted event payload');

    expect(adapter.startSession).not.toHaveBeenCalled();
    expect(eventStore.appendEventIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'damaged-metadata',
        code: SESSION_RECOVERY_FAILED_CODE,
      }),
    );
    expect(eventStore.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'damaged-metadata',
        status: 'error',
      }),
    );
  });

  /**
   * archive#1090. Reproduced live on origin/main (1e5b45d2): an ACP session
   * whose connection's `args` were edited fails `acpConnectionFingerprint`,
   * recovery throws "This conversation was started under a different engine
   * connection configuration and cannot be resumed", and the row went
   * `ready` → `closed`. The message reached the server log and nothing else —
   * the thread's events still ended at `session.configured`, and the closed
   * row is skipped by every later recovery pass, so retrying never helped.
   */
  describe('#1090 a refused resume stays visible and recoverable', () => {
    const failingRecovery = () => {
      const adapter = {
        provider: 'acp',
        startSession: vi.fn(async () => {
          throw new Error(
            'This conversation was started under a different engine connection configuration and cannot be resumed.',
          );
        }),
      } as unknown as ProviderAdapterShape;
      const session = {
        provider: 'acp' as const,
        threadId: 'thread-refused',
        status: 'ready' as const,
        cwd: '/tmp/one',
        resumeCursor: {
          acpSessionId: 'native-1',
          connectionId: 'oc',
          connectionFingerprint: 'aaaaaaaaaaaaaaaa',
        },
        createdAt: '2026-07-28T00:00:00.000Z',
        updatedAt: '2026-07-28T00:00:01.000Z',
      };
      const eventStore = {
        readSessions: vi.fn().mockReturnValue([session]),
        upsertSession: vi.fn(),
        markSessionClosed: vi.fn(),
        appendEventIfAbsent: vi.fn(),
      } as any;
      return { adapter, eventStore, session };
    };

    // archive#3476: the refusal now surfaces when the conversation is next
    // used rather than at boot. Everything the user sees is unchanged — that
    // is what these assertions pin.
    const run = async (adapter: any, eventStore: any, session: any) =>
      startRecovered({ session, adapter, options: { eventStore } }).catch(
        () => undefined,
      );

    test('does not close the conversation, and preserves its cwd and resume cursor', async () => {
      const { adapter, eventStore, session } = failingRecovery();

      await run(adapter, eventStore, session);

      expect(eventStore.markSessionClosed).not.toHaveBeenCalled();
      expect(eventStore.upsertSession).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-refused',
          status: 'error',
          cwd: '/tmp/one',
          resumeCursor: session.resumeCursor,
          createdAt: '2026-07-28T00:00:00.000Z',
        }),
      );
    });

    test("puts the adapter's own reason on the thread where a person can read it", async () => {
      const { adapter, eventStore, session } = failingRecovery();

      await run(adapter, eventStore, session);

      expect(eventStore.appendEventIfAbsent).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-refused',
          provider: 'acp',
          method: 'runtime.error',
          severity: 'error',
          code: SESSION_RECOVERY_FAILED_CODE,
          retriable: true,
          message: expect.stringContaining(
            'started under a different engine connection configuration',
          ),
        }),
      );
      expect(eventStore.appendEventIfAbsent.mock.calls[0][0].message).toContain(
        'This conversation could not be reopened',
      );
    });

    test('classifies as a retryable recovery failure rather than an opaque one', () => {
      const kind = classifyAgentRunFailure({
        method: 'runtime.error',
        code: SESSION_RECOVERY_FAILED_CODE,
        message: 'This conversation could not be reopened: …',
      } as any);
      expect(kind).toBe('runtime_recovery');
      expect(isAgentRunRetryEligible(kind)).toBe(true);
    });

    test('records the same failure under one stable event id across restarts', async () => {
      const first = failingRecovery();
      await run(first.adapter, first.eventStore, first.session);
      const second = failingRecovery();
      await run(second.adapter, second.eventStore, second.session);

      // `appendEventIfAbsent` is INSERT OR IGNORE on eventId — a stable id is
      // what stops "leave it recoverable" from appending an identical error to
      // the transcript on every boot.
      expect(
        first.eventStore.appendEventIfAbsent.mock.calls[0][0].eventId,
      ).toBe(second.eventStore.appendEventIfAbsent.mock.calls[0][0].eventId);
      expect(
        first.eventStore.appendEventIfAbsent.mock.calls[0][0].eventId,
      ).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });

  /**
   * archive#1827. A dead engine binding (e.g. Claude's `--resume`d session
   * reporting "No conversation found with session ID: ...") is a
   * STRUCTURALLY different failure from archive#1090's refused resume above, and
   * this suite must prove BOTH directions never collapse into each other:
   *  - a terminal engine answer (this describe block) stops being replayed
   *    — `status: 'dead'`, skipped by recovery, `resumeCursor` untouched.
   *  - a recoverable config refusal (archive#1090 above) is UNCHANGED by this
   *    fix — still `status: 'error'`, still replayed on every boot, still
   *    keeps its `resumeCursor`. The regression test at the end of this
   *    block re-runs recovery on an ALREADY-`error` session (the archive#1090
   *    steady state) and asserts the adapter is retried exactly as before.
   */
  describe('station#1827 a dead engine binding stops being replayed, without regressing #1090', () => {
    test('projectOrchestrationEventToReadModel marks the session dead (not closed) on the engine-binding-dead code, and preserves resumeCursor', () => {
      const threadProviders = new Map<string, 'bedrock' | 'claude' | 'codex'>();
      const sessionReadModel = new Map<string, ProviderSession>();
      const eventStore = {
        upsertSession: vi.fn(),
        markSessionClosed: vi.fn(),
      } as any;
      const resumeCursor = 'd434e194-cc2e-4edc-8733-d8645c512fab';

      trackOrchestrationSession({
        threadProviders,
        sessionReadModel,
        session: {
          provider: 'claude',
          threadId: 'thread-dead',
          status: 'running',
          resumeCursor,
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      });

      projectOrchestrationEventToReadModel({
        event: {
          provider: 'claude',
          threadId: 'thread-dead',
          method: 'runtime.error',
          severity: 'error',
          code: ENGINE_SESSION_BINDING_DEAD_CODE,
          retriable: false,
          message:
            'No conversation found with session ID: d434e194-cc2e-4edc-8733-d8645c512fab',
          createdAt: '2026-08-01T00:00:05.000Z',
        } as any,
        threadProviders,
        sessionReadModel,
        eventStore,
      });

      expect(sessionReadModel.get('thread-dead')).toMatchObject({
        status: 'dead',
        resumeCursor,
      });
      // The whole point: `dead` must NOT route through `markSessionClosed`
      // (that NULLs `resumeCursor` — the exact archive#1090 data loss this
      // must not repeat).
      expect(eventStore.markSessionClosed).not.toHaveBeenCalled();
      expect(eventStore.upsertSession).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'dead', resumeCursor }),
      );
    });

    test('an ordinary runtime.error (no dead-binding code) leaves status untouched — #1090 byte-for-byte', () => {
      const threadProviders = new Map<string, 'bedrock' | 'claude' | 'codex'>();
      const sessionReadModel = new Map<string, ProviderSession>();
      const eventStore = {
        upsertSession: vi.fn(),
        markSessionClosed: vi.fn(),
      } as any;

      trackOrchestrationSession({
        threadProviders,
        sessionReadModel,
        session: {
          provider: 'acp',
          threadId: 'thread-recoverable',
          status: 'error',
          resumeCursor: { acpSessionId: 'native-1' },
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      });

      projectOrchestrationEventToReadModel({
        event: {
          provider: 'acp',
          threadId: 'thread-recoverable',
          method: 'runtime.error',
          severity: 'error',
          code: SESSION_RECOVERY_FAILED_CODE,
          retriable: true,
          message: 'This conversation could not be reopened: …',
          createdAt: '2026-08-01T00:00:05.000Z',
        } as any,
        threadProviders,
        sessionReadModel,
        eventStore,
      });

      expect(sessionReadModel.get('thread-recoverable')).toMatchObject({
        status: 'error',
      });
      expect(eventStore.markSessionClosed).not.toHaveBeenCalled();
    });

    test('recoverOrchestrationSessions skips a dead session — it is not even restored into the read model', async () => {
      const adapter = {
        provider: 'claude',
        startSession: vi.fn(),
        hasSession: vi.fn().mockResolvedValue(false),
      } as unknown as ProviderAdapterShape;
      const eventStore = {
        readSessions: vi.fn().mockReturnValue([
          {
            provider: 'claude',
            threadId: 'thread-dead-2',
            status: 'dead',
            resumeCursor: 'dead-native-id',
            cwd: '/workspace/project',
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:05.000Z',
          },
        ]),
        upsertSession: vi.fn(),
        markSessionClosed: vi.fn(),
        appendEventIfAbsent: vi.fn(),
      } as any;
      const trackSession = vi.fn();

      await recoverOrchestrationSessions({
        adapterRegistry: {
          get: (provider) => (provider === 'claude' ? adapter : undefined),
          list: () => [adapter],
          register() {},
        },
        eventStore,
        trackSession,
        logger: { warn: vi.fn() },
      });

      expect(trackSession).not.toHaveBeenCalled();
      expect(adapter.startSession).not.toHaveBeenCalled();
      expect(eventStore.markSessionClosed).not.toHaveBeenCalled();
      expect(eventStore.upsertSession).not.toHaveBeenCalled();
    });

    test('regression proof: recoverOrchestrationSessions STILL restores an #1090 error session (unaffected by the dead-binding skip)', async () => {
      const adapter = {
        provider: 'acp',
        startSession: vi.fn(),
        hasSession: vi.fn().mockResolvedValue(false),
      } as unknown as ProviderAdapterShape;
      const eventStore = {
        // The archive#1090 steady state: a session a prior recovery pass already
        // marked `error` (config-refusal), still carrying its resumeCursor.
        readSessions: vi.fn().mockReturnValue([
          {
            provider: 'acp',
            threadId: 'thread-still-recoverable',
            status: 'error',
            resumeCursor: { acpSessionId: 'native-1', connectionId: 'oc' },
            cwd: '/tmp/one',
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:30:00.000Z',
          },
        ]),
        upsertSession: vi.fn(),
        markSessionClosed: vi.fn(),
      } as any;
      const trackSession = vi.fn();

      await recoverOrchestrationSessions({
        adapterRegistry: {
          get: (provider) => (provider === 'acp' ? adapter : undefined),
          list: () => [adapter],
          register() {},
        },
        eventStore,
        trackSession,
        logger: { warn: vi.fn() },
      });

      expect(trackSession).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-still-recoverable',
          status: 'error',
          resumeCursor: { acpSessionId: 'native-1', connectionId: 'oc' },
        }),
        // No adapter: nothing in this process holds the thread yet.
        undefined,
      );
    });
  });

  /**
   * archive#3476: this used to be a silent `continue` at boot — the ACP
   * adapter logged "prerequisites missing" 14 times on the measured server
   * and the user was told nothing. Reported at first use instead, so the
   * turn fails with the reason and the row stays retryable (archive#1090).
   */
  test('startRecoveredOrchestrationSession reports unmet adapter prerequisites and keeps the session recoverable', async () => {
    const eventStore = {
      upsertSession: vi.fn(),
      markSessionClosed: vi.fn(),
      appendEventIfAbsent: vi.fn(),
    } as any;
    const adapter = {
      provider: 'claude',
      startSession: vi.fn(),
    } as unknown as ProviderAdapterShape;

    await expect(
      startRecovered({
        session: {
          provider: 'claude',
          threadId: 'thread-5',
          status: 'running',
          model: 'sonnet',
          createdAt: '2026-04-10T23:00:00.000Z',
          updatedAt: '2026-04-11T00:00:00.000Z',
        },
        adapter,
        options: {
          eventStore,
          assertAdapterReady: async () => {
            throw new Error('ollama not ready yet');
          },
        },
      }),
    ).rejects.toThrow('ollama not ready yet');

    expect(adapter.startSession).not.toHaveBeenCalled();
    expect(eventStore.markSessionClosed).not.toHaveBeenCalled();
    expect(eventStore.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-5', status: 'error' }),
    );
    expect(eventStore.appendEventIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-5',
        code: SESSION_RECOVERY_FAILED_CODE,
        message: expect.stringContaining('ollama not ready yet'),
      }),
    );
  });

  test("startRecoveredOrchestrationSession recovers an acp session via the cursor's connectionId when no metadata survives", async () => {
    const recovered: ProviderSession[] = [];
    const adapter = {
      provider: 'acp',
      // Mirrors AcpAdapter.startReservedSession's archive#895 wave B connection
      // lookup: metadata.connectionId first, else the resume cursor's
      // connectionId — never an unconditional throw when metadata is
      // absent.
      startSession: vi.fn(async (input: any) => {
        const connectionId =
          input.metadata?.connectionId ?? input.resumeCursor?.connectionId;
        if (!connectionId) {
          throw new Error('Unknown ACP connection: (none provided)');
        }
        return {
          provider: 'acp',
          threadId: input.threadId,
          status: 'ready',
          cwd: input.cwd,
          resumeCursor: input.resumeCursor,
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-01T00:00:00.000Z',
        };
      }),
    } as unknown as ProviderAdapterShape;
    const eventStore = {
      upsertSession: vi.fn(),
      markSessionClosed: vi.fn(),
    } as any;

    await startRecovered({
      session: {
        provider: 'acp',
        threadId: 'thread-acp-resume',
        status: 'running',
        cwd: '/workspace/project',
        resumeCursor: { acpSessionId: 'native-kiro', connectionId: 'kiro' },
        createdAt: '2026-06-30T00:00:00.000Z',
        updatedAt: '2026-06-30T00:00:05.000Z',
      },
      adapter,
      options: {
        eventStore,
        trackStartedSession: (session) => {
          recovered.push(session);
        },
        // No persisted metadata survives for this thread.
        readSessionStartMetadata: () => undefined,
      },
    });

    expect(adapter.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-acp-resume',
        provider: 'acp',
        resumeCursor: { acpSessionId: 'native-kiro', connectionId: 'kiro' },
      }),
    );
    expect(eventStore.markSessionClosed).not.toHaveBeenCalled();
    expect(recovered).toEqual([
      expect.objectContaining({
        threadId: 'thread-acp-resume',
        status: 'ready',
      }),
    ]);
  });

  test('recovers attached sessions into the read model without adapter ownership', async () => {
    const attached: ProviderSession = {
      provider: 'claude',
      threadId: 'external:claude:session-1',
      status: 'running',
      controlMode: 'read-only-attached',
      attachedSource: {
        kind: 'claude-transcript',
        externalSessionId: 'session-1',
      },
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    };
    const adapter = {
      provider: 'claude',
      startSession: vi.fn(),
      hasSession: vi.fn().mockResolvedValue(false),
    } as unknown as ProviderAdapterShape;
    const trackSession = vi.fn();

    await recoverOrchestrationSessions({
      adapterRegistry: {
        get: () => adapter,
        list: () => [adapter],
        register() {},
      },
      eventStore: {
        readSessions: vi.fn().mockReturnValue([attached]),
        upsertSession: vi.fn(),
        markSessionClosed: vi.fn(),
      } as any,
      trackSession,
      logger: { warn: vi.fn() },
    });

    expect(trackSession).toHaveBeenCalledWith(attached);
    expect(adapter.startSession).not.toHaveBeenCalled();
  });

  /**
   * archive#3476: the second half. Without it, every session boot recovery
   * restored would fail its first use with "No provider session found".
   */
  test('resolveOrchestrationAdapterForThread materialises a session no adapter holds', async () => {
    const threadProviders = new Map<string, 'bedrock' | 'claude' | 'codex'>();
    const claude = {
      provider: 'claude',
      hasSession: vi.fn().mockResolvedValue(false),
    } as unknown as ProviderAdapterShape;
    const materializeSession = vi.fn().mockResolvedValue(claude);

    const adapter = await resolveOrchestrationAdapterForThread({
      threadId: 'restored-thread',
      threadProviders,
      requireAdapter: () => claude,
      adapters: [claude],
      materializeSession,
    });

    expect(materializeSession).toHaveBeenCalledWith('restored-thread');
    expect(adapter).toBe(claude);
    expect(threadProviders.get('restored-thread')).toBe('claude');
  });

  test('resolveOrchestrationAdapterForThread keeps the historical throw when nothing can be materialised', async () => {
    const claude = {
      provider: 'claude',
      hasSession: vi.fn().mockResolvedValue(false),
    } as unknown as ProviderAdapterShape;

    await expect(
      resolveOrchestrationAdapterForThread({
        threadId: 'unknown-thread',
        threadProviders: new Map(),
        requireAdapter: () => claude,
        adapters: [claude],
        materializeSession: async () => undefined,
      }),
    ).rejects.toThrow('No provider session found for thread: unknown-thread');
  });

  test('buildOrchestrationSessionSummary merges persisted and loaded state with event metadata', () => {
    expect(
      buildOrchestrationSessionSummary({
        answerability: OBSERVATION,
        persisted: {
          provider: 'claude',
          threadId: 'thread-4',
          status: 'ready',
          model: 'claude-sonnet',
          createdAt: '2026-04-11T00:00:00.000Z',
          updatedAt: '2026-04-11T00:00:01.000Z',
        },
        loaded: {
          provider: 'claude',
          threadId: 'thread-4',
          status: 'running',
          model: 'claude-sonnet',
          createdAt: '2026-04-11T00:00:00.000Z',
          updatedAt: '2026-04-11T00:00:03.000Z',
        },
        events: [
          {
            provider: 'claude',
            threadId: 'thread-4',
            eventId: 'evt-1',
            createdAt: '2026-04-11T00:00:02.000Z',
            method: 'session.configured',
            sessionId: 'thread-4',
            metadata: {
              taskId: 'task-worker-1',
              environmentId: 'env-current',
              environmentName: 'Current environment',
              connectionId: 'codex-runtime',
              projectSlug: 'station',
              parentTaskId: 'parent-task',
              delegation: { mode: 'isolated-child' },
              userId: 'secret-user-id',
              tunnelUrl: 'http://127.0.0.1:12345',
            },
          } as any,
          {
            provider: 'claude',
            threadId: 'thread-4',
            eventId: 'evt-2',
            createdAt: '2026-04-11T00:00:03.000Z',
            method: 'turn.started',
            turnId: 'turn-1',
          } as any,
          {
            provider: 'claude',
            threadId: 'thread-4',
            eventId: 'evt-3',
            createdAt: '2026-04-11T00:00:05.000Z',
            method: 'turn.completed',
            turnId: 'turn-1',
          } as any,
        ],
      }),
    ).toEqual({
      provider: 'claude',
      threadId: 'thread-4',
      environmentId: 'env-current',
      status: 'running',
      controlMode: 'station-owned',
      // archive#1778: the whole-shape assertion, so the decoration must be
      // stated here too — a `completed` session that this process does not
      // hold cannot answer anything, which is the `past_resume` arm.
      answerability: {
        answerable: false,
        qualification: 'past_resume',
        observedBy: OBSERVATION.observedBy,
        observedAt: OBSERVATION.observedAt,
      },
      model: 'claude-sonnet',
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:03.000Z',
      isLoaded: true,
      isPersisted: true,
      eventCount: 3,
      lastEventAt: '2026-04-11T00:00:05.000Z',
      lastEventMethod: 'turn.completed',
      hasActiveTurn: false,
      lifecycleState: 'completed',
      previousLifecycleState: 'running',
      transitionReason: 'turn_completed',
      transitionSource: 'runtime',
      pendingReview: false,
      projectSlug: 'station',
      delegation: {
        taskId: 'task-worker-1',
        environmentId: 'env-current',
        environmentName: 'Current environment',
        connectionId: 'codex-runtime',
        projectSlug: 'station',
        parentTaskId: 'parent-task',
        mode: 'isolated-child',
      },
    });
  });

  // archive#3408: both delegated-task launch writers persist
  // `targetKind: 'agent'` in the binding event, but this reducer used to drop
  // any targetKind other than 'station-agent'|'agent-app' — so the session
  // summary's delegation record for the caller's OWN locally-launched task
  // carried no target binding at all, and `station delegate events` refused
  // the task while `station delegate status` (reading the raw binding event)
  // accepted it. The projection must carry the target — and, because this is a
  // session-list-visible record, still nothing else the binding happens to
  // hold: `userId` is in the input here and deliberately absent from the
  // whole-shape expectation, exactly as `tunnelUrl` is above.
  test('projects the local-launch agent binding into the delegation record without disclosing the binding user (station#3408)', () => {
    const summary = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted: {
        provider: 'station-agent',
        threadId: 'task:local',
        status: 'ready',
        createdAt: '2026-08-19T00:00:00.000Z',
        updatedAt: '2026-08-19T00:00:01.000Z',
      },
      events: [
        {
          provider: 'station-agent',
          threadId: 'task:local',
          eventId: 'evt-local-1',
          createdAt: '2026-08-19T00:00:01.000Z',
          method: 'session.configured',
          sessionId: 'task:local',
          metadata: {
            taskId: 'task:local',
            environmentId: 'env-current',
            targetKind: 'agent',
            targetId: 'reviewer',
            userId: 'shared-user',
          },
        } as any,
      ],
    });

    expect(summary.delegation).toEqual({
      taskId: 'task:local',
      environmentId: 'env-current',
      targetKind: 'agent',
      targetId: 'reviewer',
    });
  });

  test('projects station-owned control for legacy session records', () => {
    const summary = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted: {
        provider: 'claude',
        threadId: 'legacy-thread',
        status: 'ready',
        createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:00.000Z',
      },
    });

    expect(summary.controlMode).toBe('station-owned');
    expect(summary.effectiveModel).toBeUndefined();
    expect(summary.effectiveModelOptions).toBeUndefined();
  });

  test('retains the original accepted launch plan without deriving reported identity', () => {
    const summary = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted: {
        provider: 'codex',
        threadId: 'launch-plan-thread',
        status: 'ready',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:01:00.000Z',
      },
      events: [
        {
          provider: 'codex',
          threadId: 'launch-plan-thread',
          eventId: 'launch-plan-start',
          createdAt: '2026-08-01T00:00:00.000Z',
          method: 'session.configured',
          sessionId: 'launch-plan-thread',
          model: 'applied-at-start',
          metadata: {
            modelLaunchPlan: {
              kind: 'engine-selected',
              evidence: 'adapter-declared',
            },
            effectiveModel: 'requested-but-not-reported',
            modelSelectionReceipt: {
              requestedModel: 'requested-but-not-reported',
              appliedModel: 'applied-at-start',
            },
          },
        },
        {
          provider: 'codex',
          threadId: 'launch-plan-thread',
          eventId: 'launch-plan-resume',
          createdAt: '2026-08-01T00:01:00.000Z',
          method: 'session.configured',
          sessionId: 'launch-plan-thread',
          metadata: {
            effectiveModel: 'requested-after-resume',
            modelSelectionReceipt: {
              requestedModel: 'requested-after-resume',
            },
          },
        },
      ] as any,
    });

    expect(summary.modelLaunchPlan).toEqual({
      kind: 'engine-selected',
      evidence: 'adapter-declared',
    });
    expect(summary.requestedModel).toBe('requested-after-resume');
    expect(summary.appliedModel).toBe('applied-at-start');
    expect(summary.reportedModel).toBeUndefined();
  });

  test('projects durable conversation and Environment identity independently from a child session thread', () => {
    const summary = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted: {
        provider: 'claude',
        threadId: 'child-session-2',
        status: 'ready',
        createdAt: '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:01:00.000Z',
      },
      events: [
        {
          provider: 'claude',
          threadId: 'child-session-2',
          eventId: 'configured-child-session',
          createdAt: '2026-08-24T00:00:00.000Z',
          method: 'session.configured',
          sessionId: 'child-session-2',
          metadata: {
            conversationId: 'durable-conversation-1',
            environmentId: 'station-environment-a',
            modelSelectionReceipt: {
              requestedModel: 'claude-sonnet',
              appliedModel: 'claude-sonnet',
            },
          },
        },
      ] as any,
    });

    expect(summary).toMatchObject({
      threadId: 'child-session-2',
      conversationId: 'durable-conversation-1',
      environmentId: 'station-environment-a',
      appliedModel: 'claude-sonnet',
    });

    const otherStation = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted: {
        provider: 'claude',
        threadId: 'child-session-3',
        status: 'ready',
        createdAt: '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:01:00.000Z',
      },
      events: [
        {
          provider: 'claude',
          threadId: 'child-session-3',
          eventId: 'configured-other-station',
          createdAt: '2026-08-24T00:00:00.000Z',
          method: 'session.configured',
          sessionId: 'child-session-3',
          metadata: {
            conversationId: 'durable-conversation-1',
            environmentId: 'station-environment-b',
          },
        },
      ] as any,
    });
    expect(otherStation).toMatchObject({
      conversationId: 'durable-conversation-1',
      environmentId: 'station-environment-b',
    });
    expect(otherStation.environmentId).not.toBe(summary.environmentId);
  });

  test('keeps legacy ACP model echoes requested-only and projects typed accepted facts', () => {
    const base = {
      provider: 'acp',
      threadId: 'legacy-acp-model',
      status: 'ready' as const,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    const legacy = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted: base,
      events: [
        {
          provider: 'acp',
          threadId: base.threadId,
          eventId: 'legacy-echo',
          createdAt: base.createdAt,
          method: 'session.configured',
          sessionId: base.threadId,
          model: 'metadata-only-echo',
        },
      ] as any,
    });
    expect(legacy.appliedModel).toBeUndefined();

    const accepted = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted: { ...base, provider: 'claude' },
      events: [
        {
          provider: 'claude',
          threadId: base.threadId,
          eventId: 'accepted-change',
          createdAt: base.updatedAt,
          method: 'turn.started',
          turnId: 'turn-1',
          metadata: {
            modelSelectionReceipt: {
              requestedModel: 'requested-claude',
              appliedModel: 'applied-claude',
            },
          },
        },
      ] as any,
    });
    expect(accepted.requestedModel).toBe('requested-claude');
    expect(accepted.appliedModel).toBe('applied-claude');
  });

  test('derives a bounded display title from the first meaningful turn and preserves cwd', () => {
    const summary = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted: {
        provider: 'codex',
        threadId: 'title-thread',
        status: 'ready',
        cwd: '/Users/brian/dev/github/kontourai/station',
        createdAt: '2026-07-30T00:00:00.000Z',
        updatedAt: '2026-07-30T00:00:00.000Z',
      },
      events: [
        {
          provider: 'codex',
          threadId: 'title-thread',
          eventId: 'title-1',
          createdAt: '2026-07-30T00:00:00.000Z',
          method: 'turn.started',
          turnId: 'turn-1',
          prompt: ' [Timezone: America/Denver]  Ship   the Home history fix ',
        },
        {
          provider: 'codex',
          threadId: 'title-thread',
          eventId: 'title-2',
          createdAt: '2026-07-30T00:01:00.000Z',
          method: 'turn.started',
          turnId: 'turn-2',
          prompt: 'This later prompt must not replace the first title',
        },
      ] as any,
    });

    expect(summary.displayTitle).toBe('Ship the Home history fix');
    expect(summary.cwd).toBe('/Users/brian/dev/github/kontourai/station');
  });

  test('skips timezone-only prompts, bounds long titles, and remains compatible with promptless history', () => {
    const base = {
      provider: 'codex' as const,
      threadId: 'bounded-title-thread',
      status: 'ready' as const,
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
    };
    const bounded = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted: base,
      events: [
        {
          provider: 'codex',
          threadId: base.threadId,
          eventId: 'timezone-only',
          createdAt: base.createdAt,
          method: 'turn.started',
          turnId: 'turn-1',
          prompt: '[Timezone: America/Denver]',
        },
        {
          provider: 'codex',
          threadId: base.threadId,
          eventId: 'long-title',
          createdAt: base.updatedAt,
          method: 'turn.started',
          turnId: 'turn-2',
          prompt: 'a'.repeat(140),
        },
      ] as any,
    });
    expect(bounded.displayTitle).toHaveLength(120);
    expect(bounded.displayTitle).toMatch(/…$/);
    expect(
      buildOrchestrationSessionSummary({
        answerability: OBSERVATION,
        persisted: base,
      }).displayTitle,
    ).toBeUndefined();
  });

  test('truncates a prompt title by Unicode code point without splitting an emoji', () => {
    const summary = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted: {
        provider: 'codex',
        threadId: 'emoji-title-thread',
        status: 'ready',
        createdAt: '2026-07-30T00:00:00.000Z',
        updatedAt: '2026-07-30T00:00:00.000Z',
      },
      events: [
        {
          provider: 'codex',
          threadId: 'emoji-title-thread',
          eventId: 'emoji-title',
          createdAt: '2026-07-30T00:00:00.000Z',
          method: 'turn.started',
          turnId: 'turn-1',
          prompt: `${'a'.repeat(118)}😀bc`,
        },
      ] as any,
    });

    expect(summary.displayTitle).toBe(`${'a'.repeat(118)}😀…`);
    expect(Array.from(summary.displayTitle ?? '')).toHaveLength(120);
    expect(summary.displayTitle).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });

  test('projects the latest provider-confirmed effective model and bounded options', () => {
    const summary = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted: {
        provider: 'claude',
        threadId: 'model-history',
        status: 'ready',
        createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:02.000Z',
      },
      events: [
        {
          provider: 'claude',
          threadId: 'model-history',
          eventId: 'configured',
          createdAt: '2026-07-22T00:00:00.000Z',
          method: 'session.configured',
          sessionId: 'model-history',
          metadata: {
            effectiveModel: 'sonnet',
            effectiveModelOptions: { effort: 'medium' },
          },
        } as any,
        {
          provider: 'claude',
          threadId: 'model-history',
          eventId: 'turn',
          createdAt: '2026-07-22T00:00:02.000Z',
          method: 'turn.started',
          turnId: 'turn-1',
          metadata: {
            effectiveModel: 'opus[1m]',
            effectiveModelOptions: {
              effort: 'high',
              fastMode: true,
              ignored: { secret: true },
            },
          },
        } as any,
      ],
    });

    expect(summary).toMatchObject({
      effectiveModel: 'opus[1m]',
      effectiveModelOptions: { effort: 'high', fastMode: true },
    });
    expect(summary.effectiveModelOptions).not.toHaveProperty('ignored');
  });

  test('projects an explicit empty option set so resume clears stale controls', () => {
    const summary = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted: {
        provider: 'claude',
        threadId: 'model-reset',
        status: 'ready',
        createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:01.000Z',
      },
      events: [
        {
          provider: 'claude',
          threadId: 'model-reset',
          eventId: 'reset',
          createdAt: '2026-07-22T00:00:01.000Z',
          method: 'turn.started',
          turnId: 'turn-reset',
          metadata: {
            effectiveModel: 'opus',
            effectiveModelOptions: {},
          },
        } as any,
      ],
    });

    expect(summary).toMatchObject({
      effectiveModel: 'opus',
      effectiveModelOptions: {},
    });
  });

  test('station#1182: projects reportedModel from turn.completed metadata, distinct from effectiveModel', () => {
    const summary = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted: {
        provider: 'claude',
        threadId: 'reported-model-thread',
        status: 'ready',
        createdAt: '2026-07-28T00:00:00.000Z',
        updatedAt: '2026-07-28T00:00:02.000Z',
      },
      events: [
        {
          provider: 'claude',
          threadId: 'reported-model-thread',
          eventId: 'configured',
          createdAt: '2026-07-28T00:00:00.000Z',
          method: 'session.configured',
          sessionId: 'reported-model-thread',
          metadata: { effectiveModel: 'claude-fable-5' },
        } as any,
        {
          provider: 'claude',
          threadId: 'reported-model-thread',
          eventId: 'turn-completed',
          createdAt: '2026-07-28T00:00:02.000Z',
          method: 'turn.completed',
          turnId: 'turn-1',
          metadata: { reportedModel: 'claude-opus-4-5-20260101' },
        } as any,
      ],
    });

    expect(summary.effectiveModel).toBe('claude-fable-5');
    expect(summary.reportedModel).toBe('claude-opus-4-5-20260101');
    expect(summary.reportedModel).not.toBe(summary.effectiveModel);
  });

  test('station#1182: reportedModel is absent (never defaulted to effectiveModel) when no event ever reported one', () => {
    const summary = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted: {
        provider: 'bedrock',
        threadId: 'no-report-thread',
        status: 'ready',
        createdAt: '2026-07-28T00:00:00.000Z',
        updatedAt: '2026-07-28T00:00:00.000Z',
      },
      events: [
        {
          provider: 'bedrock',
          threadId: 'no-report-thread',
          eventId: 'configured',
          createdAt: '2026-07-28T00:00:00.000Z',
          method: 'session.configured',
          sessionId: 'no-report-thread',
          metadata: { effectiveModel: 'anthropic.claude-opus-4-5' },
        } as any,
      ],
    });

    expect(summary.effectiveModel).toBe('anthropic.claude-opus-4-5');
    expect(summary.reportedModel).toBeUndefined();
    expect('reportedModel' in summary).toBe(false);
  });

  test('station#1182: a persisted session from before this field existed still loads (back-compat)', () => {
    const summary = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted: {
        provider: 'claude',
        threadId: 'legacy-no-reportedmodel',
        status: 'ready',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      events: [
        {
          provider: 'claude',
          threadId: 'legacy-no-reportedmodel',
          eventId: 'legacy-turn',
          createdAt: '2026-01-01T00:00:00.000Z',
          method: 'turn.completed',
          turnId: 'turn-legacy',
          // No `metadata` at all — the shape every event persisted before
          // this field existed.
        } as any,
      ],
    });

    expect(summary.reportedModel).toBeUndefined();
    expect(summary.status).toBe('ready');
  });

  test("station#1182 fix round: a Codex #903 model-switch restatement (session.configured with no metadata, then turn.started on the new model) must not surface the PREVIOUS generation's reportedModel as if it confirms the current model", () => {
    const summary = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted: {
        provider: 'codex',
        threadId: 'model-switch-thread',
        status: 'ready',
        createdAt: '2026-07-28T00:00:00.000Z',
        updatedAt: '2026-07-28T00:00:03.000Z',
      },
      events: [
        // Generation A: session starts on model A, Codex's thread/start
        // response independently confirms it.
        {
          provider: 'codex',
          threadId: 'model-switch-thread',
          eventId: 'configured-a',
          createdAt: '2026-07-28T00:00:00.000Z',
          method: 'session.configured',
          sessionId: 'model-switch-thread',
          model: 'gpt-5-codex',
          metadata: {
            effectiveModel: 'gpt-5-codex',
            reportedModel: 'gpt-5-codex-resolved-A',
          },
        } as any,
        {
          provider: 'codex',
          threadId: 'model-switch-thread',
          eventId: 'turn-1-started',
          createdAt: '2026-07-28T00:00:01.000Z',
          method: 'turn.started',
          turnId: 'turn-1',
          metadata: { effectiveModel: 'gpt-5-codex' },
        } as any,
        {
          provider: 'codex',
          threadId: 'model-switch-thread',
          eventId: 'turn-1-completed',
          createdAt: '2026-07-28T00:00:01.500Z',
          method: 'turn.completed',
          turnId: 'turn-1',
        } as any,
        // archive#903 restatement on the NEXT turn's sendTurn: session.configured
        // republished with the new model at the top level, no `metadata` at
        // all (codex-adapter.ts:762-776) — followed by turn.started, whose
        // effectiveModel now correctly reflects model B but which carries no
        // reportedModel of its own.
        {
          provider: 'codex',
          threadId: 'model-switch-thread',
          eventId: 'configured-b-restate',
          createdAt: '2026-07-28T00:00:02.000Z',
          method: 'session.configured',
          sessionId: 'model-switch-thread',
          model: 'gpt-5.1-codex',
        } as any,
        {
          provider: 'codex',
          threadId: 'model-switch-thread',
          eventId: 'turn-2-started',
          createdAt: '2026-07-28T00:00:03.000Z',
          method: 'turn.started',
          turnId: 'turn-2',
          metadata: { effectiveModel: 'gpt-5.1-codex' },
        } as any,
      ],
    });

    expect(summary.effectiveModel).toBe('gpt-5.1-codex');
    // The honest outcome once the current model can no longer be correlated
    // to a reportedModel: absent, never the previous generation's value.
    expect(summary.reportedModel).toBeUndefined();
  });

  test("station#1182 fix round: a Claude model switch with no session.configured republish (sendTurn moves record.session.model directly) must not surface a prior turn's reportedModel as current", () => {
    const summary = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted: {
        provider: 'claude',
        threadId: 'claude-switch-thread',
        status: 'ready',
        createdAt: '2026-07-28T00:00:00.000Z',
        updatedAt: '2026-07-28T00:00:02.000Z',
      },
      events: [
        {
          provider: 'claude',
          threadId: 'claude-switch-thread',
          eventId: 'configured',
          createdAt: '2026-07-28T00:00:00.000Z',
          method: 'session.configured',
          sessionId: 'claude-switch-thread',
          metadata: { effectiveModel: 'claude-fable-5' },
        } as any,
        {
          provider: 'claude',
          threadId: 'claude-switch-thread',
          eventId: 'turn-1-started',
          createdAt: '2026-07-28T00:00:00.500Z',
          method: 'turn.started',
          turnId: 'turn-1',
          metadata: { effectiveModel: 'claude-fable-5' },
        } as any,
        {
          provider: 'claude',
          threadId: 'claude-switch-thread',
          eventId: 'turn-1-completed',
          createdAt: '2026-07-28T00:00:01.000Z',
          method: 'turn.completed',
          turnId: 'turn-1',
          // Claude's per-turn assistant-message model, the only channel
          // Claude ever reports a model through (claude-adapter.ts's
          // sendTurn/session.configured never call reportedModelMetadata).
          metadata: { reportedModel: 'claude-opus-4-5-20260101' },
        } as any,
        // Mid-session switch: claude-adapter.ts's sendTurn calls
        // record.query.setModel and updates record.session.model directly —
        // no matching session.configured republish at all. The switch only
        // shows up via the next turn.started's effectiveModel.
        {
          provider: 'claude',
          threadId: 'claude-switch-thread',
          eventId: 'turn-2-started',
          createdAt: '2026-07-28T00:00:01.500Z',
          method: 'turn.started',
          turnId: 'turn-2',
          metadata: { effectiveModel: 'claude-fable-6' },
        } as any,
      ],
    });

    expect(summary.effectiveModel).toBe('claude-fable-6');
    // Absent, not the previous turn's confirmed identity for a different
    // model — the correlation to the new model has not been established yet.
    expect(summary.reportedModel).toBeUndefined();
  });

  test('projects attached-session project scope without creating delegation state', () => {
    const summary = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted: {
        provider: 'claude',
        threadId: 'external:claude:session-1',
        status: 'running',
        controlMode: 'read-only-attached',
        createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:00.000Z',
      },
      events: [
        {
          provider: 'claude',
          threadId: 'external:claude:session-1',
          eventId: 'attached-configured',
          createdAt: '2026-07-22T00:00:00.000Z',
          method: 'session.configured',
          sessionId: 'external:claude:session-1',
          metadata: { projectSlug: 'alpha' },
        } as any,
      ],
    });

    expect(summary.projectSlug).toBe('alpha');
    expect(summary.delegation).toBeUndefined();
  });

  // archive#1462: the ambiguity marker must survive replay, or the session
  // projects as merely "Unassigned" and the reason is lost.
  test('projects an ambiguous attached-session attribution instead of a slug', () => {
    const summary = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted: {
        provider: 'claude',
        threadId: 'external:claude:session-ambiguous',
        status: 'running',
        controlMode: 'read-only-attached',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
      events: [
        {
          provider: 'claude',
          threadId: 'external:claude:session-ambiguous',
          eventId: 'attached-configured',
          createdAt: '2026-08-01T00:00:00.000Z',
          method: 'session.configured',
          sessionId: 'external:claude:session-ambiguous',
          metadata: {
            projectAttribution: 'ambiguous',
            projectCandidates: ['alpha', 'beta'],
          },
        } as any,
      ],
    });

    expect(summary.projectSlug).toBeUndefined();
    expect(summary.projectAttribution).toEqual({
      state: 'ambiguous',
      candidates: ['alpha', 'beta'],
    });
  });

  // archive#1462 FIX ROUND, L2. A bounded list rendered as if exhaustive is
  // an honesty gap inside the honesty feature: 16 of 20 names read as "these
  // are the candidates".
  test('counts the candidates it bounded away instead of rendering a prefix as the whole list', () => {
    const summary = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted: {
        provider: 'claude',
        threadId: 'external:claude:session-many',
        status: 'running',
        controlMode: 'read-only-attached',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
      events: [
        {
          provider: 'claude',
          threadId: 'external:claude:session-many',
          eventId: 'attached-configured-many',
          createdAt: '2026-08-01T00:00:00.000Z',
          method: 'session.configured',
          sessionId: 'external:claude:session-many',
          metadata: {
            projectAttribution: 'ambiguous',
            projectCandidates: Array.from(
              { length: 20 },
              (_, index) => `project-${String(index).padStart(2, '0')}`,
            ),
          },
        } as any,
      ],
    });

    expect(summary.projectAttribution?.candidates).toHaveLength(16);
    expect(summary.projectAttribution?.omittedCandidates).toBe(4);
  });

  // archive#1462 FIX ROUND, H1 read side. The old reader scanned backwards
  // for the newest event WITH A SLUG and skipped ambiguity markers on the
  // way, so a stale slug outranked a newer correction that had already
  // landed. Newest-attribution-wins is the whole point.
  test('a newer ambiguity marker beats an older slug on the same thread', () => {
    const base = {
      provider: 'claude' as const,
      threadId: 'external:claude:session-corrected',
      sessionId: 'external:claude:session-corrected',
      method: 'session.configured' as const,
    };
    const summary = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted: {
        provider: 'claude',
        threadId: 'external:claude:session-corrected',
        status: 'running',
        controlMode: 'read-only-attached',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
      events: [
        {
          ...base,
          eventId: 'stale',
          createdAt: '2026-08-01T00:00:00.000Z',
          metadata: { projectSlug: 'beta' },
        } as any,
        {
          ...base,
          eventId: 'corrected',
          createdAt: '2026-08-01T00:00:01.000Z',
          metadata: {
            projectAttribution: 'ambiguous',
            projectCandidates: ['alpha', 'beta'],
          },
        } as any,
      ],
    });

    expect(summary.projectSlug).toBeUndefined();
    expect(summary.projectAttribution).toEqual({
      state: 'ambiguous',
      candidates: ['alpha', 'beta'],
    });
  });

  // The reverse direction, which the same single scan has to get right: a
  // correction back to a confident slug must not be outranked by the older
  // ambiguity marker either.
  test('a newer slug beats an older ambiguity marker on the same thread', () => {
    const base = {
      provider: 'claude' as const,
      threadId: 'external:claude:session-repaired',
      sessionId: 'external:claude:session-repaired',
      method: 'session.configured' as const,
    };
    const summary = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted: {
        provider: 'claude',
        threadId: 'external:claude:session-repaired',
        status: 'running',
        controlMode: 'read-only-attached',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
      events: [
        {
          ...base,
          eventId: 'stale-ambiguous',
          createdAt: '2026-08-01T00:00:00.000Z',
          metadata: {
            projectAttribution: 'ambiguous',
            projectCandidates: ['alpha', 'beta'],
          },
        } as any,
        {
          ...base,
          eventId: 'repaired',
          createdAt: '2026-08-01T00:00:01.000Z',
          metadata: { projectSlug: 'beta' },
        } as any,
      ],
    });

    expect(summary.projectSlug).toBe('beta');
    expect(summary.projectAttribution).toBeUndefined();
  });

  // archive#1463: the delegation record discloses an unverified cross-machine
  // slug join rather than letting the slug read as a proven binding.
  test('projects an unverified cross-machine project slug join', () => {
    const summary = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted: {
        provider: 'claude',
        threadId: 'task-remote',
        status: 'running',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
      events: [
        {
          provider: 'claude',
          threadId: 'task-remote',
          eventId: 'delegated-configured',
          createdAt: '2026-08-01T00:00:00.000Z',
          method: 'session.configured',
          sessionId: 'task-remote',
          metadata: {
            taskId: 'task-remote',
            projectSlug: 'station',
            projectSlugJoin: 'unverified-cross-machine',
          },
        } as any,
      ],
    });

    expect(summary.delegation?.projectSlug).toBe('station');
    expect(summary.delegation?.projectSlugJoin).toBe(
      'unverified-cross-machine',
    );
  });

  test('keeps delegation project scope ahead of attached-session metadata', () => {
    const summary = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted: {
        provider: 'claude',
        threadId: 'external:claude:session-2',
        status: 'running',
        controlMode: 'read-only-attached',
        createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:01.000Z',
      },
      events: [
        {
          provider: 'claude',
          threadId: 'external:claude:session-2',
          eventId: 'delegated-configured',
          createdAt: '2026-07-22T00:00:00.000Z',
          method: 'session.configured',
          sessionId: 'external:claude:session-2',
          metadata: { taskId: 'task-1', projectSlug: 'delegated-project' },
        } as any,
        {
          provider: 'claude',
          threadId: 'external:claude:session-2',
          eventId: 'attached-configured',
          createdAt: '2026-07-22T00:00:01.000Z',
          method: 'session.configured',
          sessionId: 'external:claude:session-2',
          metadata: { projectSlug: 'attached-project' },
        } as any,
      ],
    });

    expect(summary.projectSlug).toBe('delegated-project');
  });

  // archive#761: deploy.sh's active-session drain check reads hasActiveTurn off
  // GET /api/orchestration/sessions/loaded to decide whether restarting the
  // service would kill an in-flight turn.
  describe('hasActiveTurn (#761 deploy-drain)', () => {
    const baseSession: ProviderSession = {
      provider: 'claude',
      threadId: 'drain-thread',
      status: 'ready',
      createdAt: '2026-07-24T00:00:00.000Z',
      updatedAt: '2026-07-24T00:00:00.000Z',
    };

    test('is false for a session with no turns yet', () => {
      const summary = buildOrchestrationSessionSummary({
        answerability: OBSERVATION,
        persisted: baseSession,
      });
      expect(summary.hasActiveTurn).toBe(false);
    });

    test('is true once turn.started fires with no matching completion', () => {
      const summary = buildOrchestrationSessionSummary({
        answerability: OBSERVATION,
        persisted: baseSession,
        events: [
          {
            provider: 'claude',
            threadId: 'drain-thread',
            eventId: 'evt-1',
            createdAt: '2026-07-24T00:00:01.000Z',
            method: 'turn.started',
            turnId: 'turn-1',
          } as any,
        ],
      });
      expect(summary.hasActiveTurn).toBe(true);
    });

    test('is false again once turn.completed matches the open turn', () => {
      const summary = buildOrchestrationSessionSummary({
        answerability: OBSERVATION,
        persisted: baseSession,
        events: [
          {
            provider: 'claude',
            threadId: 'drain-thread',
            eventId: 'evt-1',
            createdAt: '2026-07-24T00:00:01.000Z',
            method: 'turn.started',
            turnId: 'turn-1',
          } as any,
          {
            provider: 'claude',
            threadId: 'drain-thread',
            eventId: 'evt-2',
            createdAt: '2026-07-24T00:00:02.000Z',
            method: 'turn.completed',
            turnId: 'turn-1',
          } as any,
        ],
      });
      expect(summary.hasActiveTurn).toBe(false);
    });

    test('is false once turn.aborted matches the open turn', () => {
      const summary = buildOrchestrationSessionSummary({
        answerability: OBSERVATION,
        persisted: baseSession,
        events: [
          {
            provider: 'claude',
            threadId: 'drain-thread',
            eventId: 'evt-1',
            createdAt: '2026-07-24T00:00:01.000Z',
            method: 'turn.started',
            turnId: 'turn-1',
          } as any,
          {
            provider: 'claude',
            threadId: 'drain-thread',
            eventId: 'evt-2',
            createdAt: '2026-07-24T00:00:02.000Z',
            method: 'turn.aborted',
            turnId: 'turn-1',
          } as any,
        ],
      });
      expect(summary.hasActiveTurn).toBe(false);
    });

    test('stays true through intra-turn streaming/tool events (not just the instant after turn.started)', () => {
      const summary = buildOrchestrationSessionSummary({
        answerability: OBSERVATION,
        persisted: baseSession,
        events: [
          {
            provider: 'claude',
            threadId: 'drain-thread',
            eventId: 'evt-1',
            createdAt: '2026-07-24T00:00:01.000Z',
            method: 'turn.started',
            turnId: 'turn-1',
          } as any,
          {
            provider: 'claude',
            threadId: 'drain-thread',
            eventId: 'evt-2',
            createdAt: '2026-07-24T00:00:02.000Z',
            method: 'content.text-delta',
            itemId: 'item-1',
            delta: 'hello',
          } as any,
          {
            provider: 'claude',
            threadId: 'drain-thread',
            eventId: 'evt-3',
            createdAt: '2026-07-24T00:00:03.000Z',
            method: 'tool.started',
            itemId: 'tool-1',
            toolName: 'bash',
          } as any,
        ],
      });
      // lastEventMethod has moved on to tool.started, but the turn is still
      // open — hasActiveTurn must track the lifecycle fold, not the last
      // event's method.
      expect(summary.lastEventMethod).toBe('tool.started');
      expect(summary.hasActiveTurn).toBe(true);
    });

    test('stays true while an in-turn approval request is open (not yet resolved or completed)', () => {
      const summary = buildOrchestrationSessionSummary({
        answerability: OBSERVATION,
        persisted: baseSession,
        events: [
          {
            provider: 'claude',
            threadId: 'drain-thread',
            eventId: 'evt-1',
            createdAt: '2026-07-24T00:00:01.000Z',
            method: 'turn.started',
            turnId: 'turn-1',
          } as any,
          {
            provider: 'claude',
            threadId: 'drain-thread',
            eventId: 'evt-2',
            createdAt: '2026-07-24T00:00:02.000Z',
            method: 'request.opened',
            requestId: 'req-1',
            requestType: 'approval',
          } as any,
        ],
      });
      expect(summary.lifecycleState).toBe('review_pending');
      expect(summary.hasActiveTurn).toBe(true);
    });

    test('is false once session.configured fires but no turn has ever started (lifecycleState is queued here — configured is not work)', () => {
      const summary = buildOrchestrationSessionSummary({
        answerability: OBSERVATION,
        persisted: baseSession,
        events: [
          {
            provider: 'claude',
            threadId: 'drain-thread',
            eventId: 'evt-1',
            createdAt: '2026-07-24T00:00:01.000Z',
            method: 'session.configured',
            sessionId: 'drain-thread',
          } as any,
        ],
      });
      // Was 'running' until archive#1073: this test's own name used to record that
      // as a deliberate quirk ("not the signal used"), which is precisely the
      // conflation that made a restart re-open every session it re-attached.
      // The subject of this test — hasActiveTurn being false — is unchanged.
      expect(summary.lifecycleState).toBe('queued');
      expect(summary.hasActiveTurn).toBe(false);
    });

    test('is false once the session exits with no open turn', () => {
      const summary = buildOrchestrationSessionSummary({
        answerability: OBSERVATION,
        persisted: baseSession,
        events: [
          {
            provider: 'claude',
            threadId: 'drain-thread',
            eventId: 'evt-1',
            createdAt: '2026-07-24T00:00:01.000Z',
            method: 'session.exited',
            sessionId: 'drain-thread',
            reason: 'orchestration_shutdown',
          } as any,
        ],
      });
      expect(summary.hasActiveTurn).toBe(false);
    });

    // Review finding (2026-07-24): none of the four adapters that can fail a
    // turn ever emit turn.aborted/turn.completed on failure — only
    // runtime.error. Without runtime.error in the closing set, the latest
    // tracked event stays turn.started forever and hasActiveTurn is
    // permanently stuck true, rotting the deploy-drain safety property. Each
    // test below mirrors one adapter's actual failure event shape.

    test('is false after a claude-adapter-shaped fatal error (consumeMessages catch: runtime.error, no turnId, no closing turn event)', () => {
      const summary = buildOrchestrationSessionSummary({
        answerability: OBSERVATION,
        persisted: baseSession,
        events: [
          {
            provider: 'claude',
            threadId: 'drain-thread',
            eventId: 'evt-1',
            createdAt: '2026-07-24T00:00:01.000Z',
            method: 'turn.started',
            turnId: 'turn-1',
          } as any,
          {
            provider: 'claude',
            threadId: 'drain-thread',
            eventId: 'evt-2',
            createdAt: '2026-07-24T00:00:02.000Z',
            method: 'runtime.error',
            severity: 'error',
            message: 'Claude model "claude-sonnet" failed: stream closed',
          } as any,
        ],
      });
      expect(summary.hasActiveTurn).toBe(false);
    });

    test("is false after a codex-adapter-shaped turn error ('error' notification: runtime.error with turnId + retriable, no closing turn event)", () => {
      const summary = buildOrchestrationSessionSummary({
        answerability: OBSERVATION,
        persisted: baseSession,
        events: [
          {
            provider: 'codex',
            threadId: 'drain-thread',
            eventId: 'evt-1',
            createdAt: '2026-07-24T00:00:01.000Z',
            method: 'turn.started',
            turnId: 'turn-1',
          } as any,
          {
            provider: 'codex',
            threadId: 'drain-thread',
            eventId: 'evt-2',
            createdAt: '2026-07-24T00:00:02.000Z',
            method: 'runtime.error',
            turnId: 'turn-1',
            severity: 'error',
            message: 'Codex runtime error',
            retriable: true,
            details: { additionalDetails: undefined },
          } as any,
        ],
      });
      expect(summary.hasActiveTurn).toBe(false);
    });

    test('is false after a station-agent-adapter-shaped stream failure (mapStationAgentStreamEvent error case: runtime.error with code+turnId+retriable, no closing turn event)', () => {
      const summary = buildOrchestrationSessionSummary({
        answerability: OBSERVATION,
        persisted: baseSession,
        events: [
          {
            provider: 'station-agent',
            threadId: 'drain-thread',
            eventId: 'evt-1',
            createdAt: '2026-07-24T00:00:01.000Z',
            method: 'turn.started',
            turnId: 'turn-1',
          } as any,
          {
            provider: 'station-agent',
            threadId: 'drain-thread',
            eventId: 'evt-2',
            createdAt: '2026-07-24T00:00:02.000Z',
            method: 'request.opened',
            requestId: 'req-1',
            requestType: 'approval',
          } as any,
          {
            provider: 'station-agent',
            threadId: 'drain-thread',
            eventId: 'evt-3',
            createdAt: '2026-07-24T00:00:03.000Z',
            method: 'runtime.error',
            turnId: 'turn-1',
            severity: 'error',
            message: 'Station agent turn failed',
            code: 'station_agent_turn_failed',
            retriable: true,
          } as any,
        ],
      });
      expect(summary.hasActiveTurn).toBe(false);
    });

    test('is false after an acp-adapter-shaped prompt rejection (prompt().catch(): runtime.error, no closing turn event)', () => {
      const summary = buildOrchestrationSessionSummary({
        answerability: OBSERVATION,
        persisted: baseSession,
        events: [
          {
            provider: 'acp',
            threadId: 'drain-thread',
            eventId: 'evt-1',
            createdAt: '2026-07-24T00:00:01.000Z',
            method: 'turn.started',
            turnId: 'turn-1',
          } as any,
          {
            provider: 'acp',
            threadId: 'drain-thread',
            eventId: 'evt-2',
            createdAt: '2026-07-24T00:00:02.000Z',
            method: 'runtime.error',
            severity: 'error',
            message: 'ACP process exited unexpectedly',
          } as any,
        ],
      });
      expect(summary.hasActiveTurn).toBe(false);
    });

    test('is true again once a new turn.started follows a prior runtime.error (a fresh turn reopens the session)', () => {
      const summary = buildOrchestrationSessionSummary({
        answerability: OBSERVATION,
        persisted: baseSession,
        events: [
          {
            provider: 'claude',
            threadId: 'drain-thread',
            eventId: 'evt-1',
            createdAt: '2026-07-24T00:00:01.000Z',
            method: 'turn.started',
            turnId: 'turn-1',
          } as any,
          {
            provider: 'claude',
            threadId: 'drain-thread',
            eventId: 'evt-2',
            createdAt: '2026-07-24T00:00:02.000Z',
            method: 'runtime.error',
            severity: 'error',
            message: 'Claude model "claude-sonnet" failed: stream closed',
          } as any,
          {
            provider: 'claude',
            threadId: 'drain-thread',
            eventId: 'evt-3',
            createdAt: '2026-07-24T00:00:03.000Z',
            method: 'turn.started',
            turnId: 'turn-2',
          } as any,
        ],
      });
      expect(summary.hasActiveTurn).toBe(true);
    });
  });

  test('buildAgentRunSummary keeps a completed run completed across a reattach (#1073)', () => {
    const base = {
      provider: 'codex' as const,
      threadId: 'thread-reattach-run',
      sessionId: 'thread-reattach-run',
    };
    const run = buildAgentRunSummary({
      answerability: OBSERVATION,
      persisted: {
        provider: 'codex',
        threadId: 'thread-reattach-run',
        status: 'ready',
        createdAt: '2026-07-28T10:00:00.000Z',
        updatedAt: '2026-07-28T11:00:00.000Z',
      },
      events: [
        {
          ...base,
          eventId: 'evt-ra-1',
          createdAt: '2026-07-28T10:00:00.000Z',
          method: 'session.started',
          initialState: 'created',
        } as any,
        {
          ...base,
          eventId: 'evt-ra-2',
          createdAt: '2026-07-28T10:00:01.000Z',
          method: 'turn.started',
          turnId: 'turn-1',
          prompt: 'go',
        } as any,
        {
          ...base,
          eventId: 'evt-ra-3',
          createdAt: '2026-07-28T10:00:09.000Z',
          method: 'turn.completed',
          turnId: 'turn-1',
          finishReason: 'stop',
        } as any,
        // Service restart: the adapter re-publishes session.started with
        // initialState 'created'. Pre-#1073 this reset the run to
        // 'starting'.
        {
          ...base,
          eventId: 'evt-ra-4',
          createdAt: '2026-07-28T11:00:00.000Z',
          method: 'session.started',
          initialState: 'created',
        } as any,
      ],
    });
    expect(run.status).toBe('completed');
  });

  // archive#3558: codex's `turn/completed` notification handler publishes a
  // terminal for whatever turnId the notification names, with NO identity
  // comparison against the turn the session currently considers active — a
  // late `turn.completed(turn-1)` can arrive after `turn.started(turn-2)`.
  // `deriveLifecycleTransition` (session-lifecycle-service.ts) already
  // refuses that stale terminal via `acceptsTurnTerminalEvent`, so
  // `buildOrchestrationSessionSummary`'s `lifecycleState`/`hasActiveTurn`
  // correctly keep reading turn-2 as open. Before this fix,
  // `deriveAgentRunStatus` had no such guard: `case 'turn.completed'` set
  // `status = 'completed'` unconditionally, so `buildAgentRunSummary` — fed
  // the IDENTICAL events — disagreed and reported the run `completed` (with
  // a fabricated `completedAt`) for a session the sibling summary still
  // reported `running`. `buildAgentRunSummary`'s own docblock exists to
  // forbid exactly this disagreement.
  test('buildAgentRunSummary does not report completed for a stale turn.completed naming a turn the session has moved past (station#3558)', () => {
    const base = {
      provider: 'codex' as const,
      threadId: 'thread-3558-stale-terminal',
      sessionId: 'thread-3558-stale-terminal',
    };
    const persisted: ProviderSession = {
      provider: 'codex',
      threadId: 'thread-3558-stale-terminal',
      status: 'running',
      createdAt: '2026-08-18T00:00:00.000Z',
      updatedAt: '2026-08-18T00:00:03.000Z',
    };
    const events = [
      {
        ...base,
        eventId: 'evt-1',
        createdAt: '2026-08-18T00:00:01.000Z',
        method: 'turn.started',
        turnId: 'turn-1',
        prompt: 'first turn',
      } as any,
      {
        ...base,
        eventId: 'evt-2',
        createdAt: '2026-08-18T00:00:02.000Z',
        method: 'turn.started',
        turnId: 'turn-2',
        prompt: 'second turn, please retry',
      } as any,
      // The stale/orphan terminal: codex's own late `turn/completed(turn-1)`
      // arriving after turn-2 has already started.
      {
        ...base,
        eventId: 'evt-3',
        createdAt: '2026-08-18T00:00:03.000Z',
        method: 'turn.completed',
        turnId: 'turn-1',
        finishReason: 'other',
      } as any,
    ];

    const summary = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted,
      events,
    });
    // The sibling fold already refuses the stale terminal (pre-existing
    // guard) — pinned here so the two assertions below are read against a
    // known-good baseline, not assumed.
    expect(summary.lifecycleState).toBe('running');
    expect(summary.hasActiveTurn).toBe(true);

    const run = buildAgentRunSummary({
      answerability: OBSERVATION,
      persisted,
      events,
    });
    // The fix: `deriveAgentRunStatus` now applies the SAME identity guard,
    // so it agrees with the lifecycle fold instead of reporting the run
    // `completed` off a turn the session has moved past.
    expect(run.status).not.toBe('completed');
    expect(run.status).toBe('running');
    expect(run.completedAt).toBeUndefined();
  });

  // archive#3581 (FIXED — this test used to PIN the gap; it now asserts the
  // corrected contract). Filed from archive#3557/#3558 fix-round review BLOCK 2:
  // the guard the test above exercises used to be INERT once a
  // `runtime.error` (or `session.exited`) preceded the stale terminal.
  // `nextActiveTurnId` resolves either of those methods to `activeTurnId =
  // undefined` with no `preserveDeferredRetry` in either fold's own loop,
  // and `acceptsTurnTerminalEvent(event, undefined)` is unconditionally
  // `true` for any terminal that names a turn — so the identity check both
  // folds applied could not distinguish "no turn has ever started" from
  // "the session's tracked turn was just cleared by an error".
  //
  // THE FIX IS NOT "stop treating `activeTurnId === undefined` as
  // anything-goes once it got there via a real turn's own error/exit" — an
  // earlier draft of this comment said that, and it is wrong: in
  // `event-store.test.ts`'s `a same-turn retry-then-complete still reports
  // completed after turn-scoping` non-regression test, the identity anchor
  // ALSO reaches `undefined`-equivalent via a real turn's own error
  // (`runtime.error(turn-1)`), and that case must still ACCEPT the following
  // `turn.completed(turn-1)`. Provenance of `undefined` is not the
  // discriminator. The discriminator is TURN IDENTITY: same-turn retry
  // (the error names turn-1, the terminal also names turn-1) accepts; this
  // test's sequence (the error names turn-2, the stale terminal names
  // turn-1) rejects. The fix: `projectSessionLifecycle` and
  // `deriveAgentRunStatus` (and `findTerminalFailureEvent`) now fold
  // `nextTurnIdentityAnchor` instead of `nextActiveTurnId` for the local
  // variable that feeds `acceptsTurnTerminalEvent` — that fold RETAINS the
  // cleared turn's id as a last-known value instead of discarding it, and
  // `acceptsTurnTerminalEvent` (unchanged) accepts a terminal naming that
  // last-known id, or accepts freely only when no turn has ever started.
  //
  // This was a REAL, not merely theoretical, gap: `orchestration-service.ts`'s
  // `readSession` (the session detail reader) feeds
  // `buildOrchestrationSessionSummary` the FULL unbounded event log via
  // `eventStore.listEvents(threadId)` — not the turn-scoped bounded
  // projection `listSessionProjectionEvents` returns — so archive#3557's
  // `latestTerminalEventForTurn` turn-scoping never protected that caller,
  // nor `sessionQueries.projectConversation` (same full-log read). A THIRD,
  // narrower bypass — `conversation-history-read-service.ts`'s reader,
  // `listRecentEventsByThread(threadId, 1_000)` — is a bounded 1,000-event
  // TAIL, not the full log (archive#3581 review LOW 2: not the same claim,
  // grouped only in that it also isn't `listSessionProjectionEvents`). This
  // fold-level fix protects all three directly, without needing to touch
  // any of the three read paths — this test drives the SAME full, unbounded
  // event array `readSession`/`projectConversation` would feed them,
  // proving exactly that; the fold is prefix-agnostic, so it protects the
  // 1,000-event-tail caller identically.
  test('the turn-identity anchor protects a stale turn.completed that arrives after a runtime.error clears activeTurnId, via the FULL unbounded log readSession feeds (station#3581)', () => {
    const base = {
      provider: 'codex' as const,
      threadId: 'thread-3558-review-block-2',
      sessionId: 'thread-3558-review-block-2',
    };
    const persisted: ProviderSession = {
      provider: 'codex',
      threadId: 'thread-3558-review-block-2',
      status: 'running',
      createdAt: '2026-08-19T00:00:00.000Z',
      updatedAt: '2026-08-19T00:00:04.000Z',
    };
    const events = [
      {
        ...base,
        eventId: 'evt-1',
        createdAt: '2026-08-19T00:00:01.000Z',
        method: 'turn.started',
        turnId: 'turn-1',
        prompt: 'first turn',
      } as any,
      {
        ...base,
        eventId: 'evt-2',
        createdAt: '2026-08-19T00:00:02.000Z',
        method: 'turn.started',
        turnId: 'turn-2',
        prompt: 'second turn, please retry',
      } as any,
      // Closes turn-2 with a real failure, clearing `activeTurnId` to
      // `undefined` in BOTH folds (no `preserveDeferredRetry` in either
      // loop) — the guard's protection depends on `activeTurnId` still
      // naming turn-2, and this is the event that erases it.
      {
        ...base,
        eventId: 'evt-3',
        createdAt: '2026-08-19T00:00:03.000Z',
        method: 'runtime.error',
        severity: 'error',
        message: 'usage limit reached',
        retriable: false,
        turnId: 'turn-2',
      } as any,
      // The stale/orphan terminal, same as the guarded test above — but now
      // arriving with `activeTurnId` already `undefined`.
      {
        ...base,
        eventId: 'evt-4',
        createdAt: '2026-08-19T00:00:04.000Z',
        method: 'turn.completed',
        turnId: 'turn-1',
        finishReason: 'other',
      } as any,
    ];

    const summary = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted,
      events,
    });
    // FIXED: reads `failed` (turn-2's real failure) — the stale turn-1
    // completion is rejected by the identity anchor, which still names
    // turn-2 (retained across the `runtime.error` that used to discard it),
    // so `deriveLifecycleTransition`'s `turn.completed` case returns `null`
    // and the fold stays at `failed`, the state `runtime.error` set.
    expect(summary.lifecycleState).toBe('failed');
    expect(summary.blockedReason).toBe('usage limit reached');

    const run = buildAgentRunSummary({
      answerability: OBSERVATION,
      persisted,
      events,
    });
    // FIXED, mirrored: `buildAgentRunSummary` agrees with the lifecycle fold
    // (the disagreement archive#3558's guard exists to close does not reappear),
    // and now also recovers the failureKind/failureMessage/retryEligible
    // the issue's own description named as lost — `findTerminalFailureEvent`
    // was rewritten to fold forward with the same identity guard, so the
    // stale turn.completed(turn-1) no longer makes it discard turn-2's real
    // runtime.error when walking back for a cause.
    expect(run.status).toBe('failed');
    expect(run.failureKind).toBe('agent_error');
    expect(run.failureMessage).toBe('usage limit reached');
    expect(run.retryEligible).toBe(false);
  });

  // archive#3557/#3558 fix-round review BLOCK 3: a user Stop on codex
  // publishes BOTH a `turn.aborted` (synchronous, from `interruptTurn`,
  // `codex-adapter.ts:1531-1541`, `reason: 'interrupted'`) and a later
  // `turn.completed` for the SAME turn id (codex's own async confirmation,
  // `codex-adapter-notifications.ts`'s `'turn/completed'` case,
  // `finishReason: mapTurnFinishReason('interrupted')` ===
  // `'cancelled'` — verified in `codex-adapter-events.ts`'s
  // `mapTurnFinishReason`). Turn-scoping the terminal slot (archive#3557 fix)
  // does NOT resolve this: both events name the same turn, so
  // `latestTerminalEventForTurn`'s `ORDER BY sequence DESC` still picks
  // whichever sorts later — ordinarily `turn.completed` — and the SEPARATE,
  // unscoped `latestEventByMethods(LIFECYCLE_METHODS)` slot independently
  // surfaces the thread's overall latest lifecycle row, which for a
  // Stop-only sequence with no trailing `session.state-changed` IS that same
  // `turn.completed` row. Neither fold used to read `finishReason`, so a
  // user Stop reported `completed` instead of `cancelled`. The fix reads
  // `finishReason === 'cancelled'` on `turn.completed` in both
  // `deriveLifecycleTransition` and `deriveAgentRunStatus`, so the answer is
  // correct regardless of which of the two physical rows a given caller's
  // fact set happens to retain.
  test('a user Stop (turn.aborted then a same-turn turn.completed carrying finishReason: cancelled) reports cancelled, not completed (station#3557/#3558 review BLOCK 3)', () => {
    const base = {
      provider: 'codex' as const,
      threadId: 'thread-3558-review-block-3',
      sessionId: 'thread-3558-review-block-3',
    };
    const persisted: ProviderSession = {
      provider: 'codex',
      threadId: 'thread-3558-review-block-3',
      status: 'running',
      createdAt: '2026-08-19T00:00:00.000Z',
      updatedAt: '2026-08-19T00:00:03.000Z',
    };
    const startedThenAborted = [
      {
        ...base,
        eventId: 'evt-1',
        createdAt: '2026-08-19T00:00:01.000Z',
        method: 'turn.started',
        turnId: 'turn-1',
        prompt: 'do the thing',
      } as any,
      // Synchronous: `interruptTurn` publishes this before the RPC's async
      // confirmation arrives.
      {
        ...base,
        eventId: 'evt-2',
        createdAt: '2026-08-19T00:00:02.000Z',
        method: 'turn.aborted',
        turnId: 'turn-1',
        reason: 'interrupted',
      } as any,
    ];
    // codex's own async `turn/completed` confirmation for the SAME turn,
    // carrying the mapped cancellation `finishReason`.
    const staleCompletion = {
      ...base,
      eventId: 'evt-3',
      createdAt: '2026-08-19T00:00:03.000Z',
      method: 'turn.completed',
      turnId: 'turn-1',
      finishReason: 'cancelled',
    } as any;
    const events = [...startedThenAborted, staleCompletion];

    const summary = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted,
      events,
    });
    expect(summary.lifecycleState).toBe('canceled');

    const run = buildAgentRunSummary({
      answerability: OBSERVATION,
      persisted,
      events,
    });
    expect(run.status).toBe('cancelled');
    expect(run.status).not.toBe('completed');

    // The `turn.aborted`-only prefix (no trailing `turn.completed` yet) must
    // keep reading cancelled too — this test's power comes from the SECOND
    // event flipping a genuinely-cancelled run to `completed` pre-fix, not
    // from `turn.aborted` alone ever being ambiguous.
    const abortedOnlySummary = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted,
      events: startedThenAborted,
    });
    expect(abortedOnlySummary.lifecycleState).toBe('canceled');
  });

  // Delta-review MEDIUM on the archive#3557/#3558 fix round, FIXED HERE — this test
  // asserts the corrected behaviour and must never be relaxed. Deliberately
  // NOT tagged archive#3581: that issue is the still-open BLOCK 2 gap pinned
  // by `the turn-identity guard does not protect ...` above, whose assertions
  // must be REWRITTEN when it lands. Tagging both with one number would hand
  // whoever closes archive#3581 two tests with opposite meanings and no way to tell
  // them apart — the exact ambiguity the tag was added to remove. FIX 3's
  // `finishReason === 'cancelled'` check lives in `deriveLifecycleTransition`'s
  // SWITCH, but that function has an EARLIER return, before the switch, for
  // any event already carrying a stamped `sessionState`
  // (`session-lifecycle-service.ts` — `if (event.sessionState &&
  // !isLegacyAttachStamp(event) && !isStampedStaleCancellation) return {
  // to: event.sessionState, ... }`). Every adapter-produced `turn.completed`
  // IS stamped and persisted this way: `consumeAdapterEvents` normalizes at
  // write time (`orchestration-service.ts`'s
  // `normalizeCanonicalRuntimeEventLifecycle` call) before
  // `projectAndPublishEvent` persists it. For a codex Stop, the WRITE-TIME
  // guard already accepted the confirmation (`turn.aborted` had cleared
  // `activeTurnId`, so `acceptsTurnTerminalEvent(event, undefined)` was
  // permissively true), so every codex/ACP/muse/station-agent Stop already
  // on disk before this fix carries `sessionState: 'completed'` stamped
  // alongside `finishReason: 'cancelled'`. Without excluding that case from
  // the early return, `deriveLifecycleTransition` (-> `readSession`,
  // `listSessions`) reads the stamped `'completed'` and never reaches the
  // `finishReason` check at all, while `deriveAgentRunStatus` (which has no
  // early-return analogue and always reaches its own `finishReason` check)
  // correctly says `cancelled` — the exact two-fold disagreement archive#3558
  // exists to close, reintroduced for every already-persisted Stop by the
  // very fix that closes it for new data. This is the scenario the
  // independent review found unexercised: it grepped the orchestration
  // suites for `sessionState` near `method: 'turn.completed'` and got zero
  // hits.
  test('a STAMPED historical turn.completed(finishReason: cancelled) row still agrees across both folds', () => {
    const base = {
      provider: 'codex' as const,
      threadId: 'thread-stamped-historical-stop',
      sessionId: 'thread-stamped-historical-stop',
    };
    const persisted: ProviderSession = {
      provider: 'codex',
      threadId: 'thread-stamped-historical-stop',
      status: 'ready',
      createdAt: '2026-08-19T00:00:00.000Z',
      updatedAt: '2026-08-19T00:00:03.000Z',
    };
    const events = [
      {
        ...base,
        eventId: 'evt-1',
        createdAt: '2026-08-19T00:00:01.000Z',
        method: 'turn.started',
        turnId: 'turn-1',
        prompt: 'do the thing',
      } as any,
      {
        ...base,
        eventId: 'evt-2',
        createdAt: '2026-08-19T00:00:02.000Z',
        method: 'turn.aborted',
        turnId: 'turn-1',
        reason: 'interrupted',
      } as any,
      // A row as it was ACTUALLY persisted pre-fix, by
      // `normalizeCanonicalRuntimeEventLifecycle` at write time: stamped
      // `sessionState`/`previousState`/`transitionReason`/`transitionSource`
      // alongside the real `finishReason` the adapter published. This is
      // the historical shape on disk today for every already-completed
      // codex/ACP/muse/station-agent Stop — not a hypothetical.
      {
        ...base,
        eventId: 'evt-3',
        createdAt: '2026-08-19T00:00:03.000Z',
        method: 'turn.completed',
        turnId: 'turn-1',
        finishReason: 'cancelled',
        sessionState: 'completed',
        previousState: 'canceled',
        transitionReason: 'turn_completed',
        transitionSource: 'runtime',
      } as any,
    ];

    const summary = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted,
      events,
    });
    const run = buildAgentRunSummary({
      answerability: OBSERVATION,
      persisted,
      events,
    });
    // The two folds must AGREE — that agreement is the whole point of the
    // guard archive#3558 added. Pre-delta-review-fix, `summary.lifecycleState`
    // read `completed` (from the stamp) while `run.status` read
    // `cancelled` (from `finishReason`).
    expect(summary.lifecycleState).toBe('canceled');
    expect(run.status).toBe('cancelled');
  });

  test('buildAgentRunSummary projects engineExecution (station#1003 Phase B — replaces executionClass) as a station|external|unknown tri-state', () => {
    const base = {
      persisted: {
        provider: 'codex' as const,
        threadId: 'thread-engine',
        status: 'running' as const,
        model: 'gpt-5-codex',
        createdAt: '2026-04-11T00:00:00.000Z',
        updatedAt: '2026-04-11T00:00:01.000Z',
      },
      events: [],
    };
    expect(
      buildAgentRunSummary({
        answerability: OBSERVATION,
        ...base,
        engineExecution: 'station',
      }),
    ).toMatchObject({ engineExecution: 'station' });
    expect(
      buildAgentRunSummary({
        answerability: OBSERVATION,
        ...base,
        engineExecution: 'external',
      }),
    ).toMatchObject({ engineExecution: 'external' });
    expect(
      buildAgentRunSummary({ answerability: OBSERVATION, ...base }),
    ).toMatchObject({
      engineExecution: 'unknown',
    });
  });

  test('buildAgentRunSummary projects run status and retry metadata from events', () => {
    const run = buildAgentRunSummary({
      answerability: OBSERVATION,
      persisted: {
        provider: 'codex',
        threadId: 'thread-run',
        status: 'running',
        model: 'gpt-5-codex',
        resumeCursor: { codexThreadId: 'codex-thread-run' },
        createdAt: '2026-04-11T00:00:00.000Z',
        updatedAt: '2026-04-11T00:00:01.000Z',
      },
      events: [
        {
          provider: 'codex',
          threadId: 'thread-run',
          eventId: 'evt-config',
          createdAt: '2026-04-11T00:00:02.000Z',
          method: 'session.configured',
          sessionId: 'thread-run',
          cwd: '/repo',
        } as any,
        {
          provider: 'codex',
          threadId: 'thread-run',
          eventId: 'evt-error',
          createdAt: '2026-04-11T00:00:03.000Z',
          method: 'runtime.error',
          severity: 'error',
          message: 'Runtime offline during sendTurn',
          code: 'runtime_offline',
          retriable: true,
        } as any,
      ],
    });

    expect(run).toEqual(
      expect.objectContaining({
        runId: 'thread-run',
        sessionId: 'thread-run',
        providerId: 'codex',
        source: 'orchestration',
        engineExecution: 'unknown',
        status: 'failed',
        cwd: '/repo',
        runtimeThreadId: 'codex-thread-run',
        completedAt: '2026-04-11T00:00:03.000Z',
        failureKind: 'runtime_offline',
        failureMessage: 'Runtime offline during sendTurn',
        retryEligible: true,
        attempt: 1,
        eventCount: 2,
      }),
    );
  });

  test('buildAgentRunSummary reports waiting_for_approval without mutating execution state', () => {
    expect(
      buildAgentRunSummary({
        answerability: OBSERVATION,
        loaded: {
          provider: 'claude',
          threadId: 'thread-approval',
          status: 'running',
          createdAt: '2026-04-11T00:00:00.000Z',
          updatedAt: '2026-04-11T00:00:01.000Z',
        },
        events: [
          {
            provider: 'claude',
            threadId: 'thread-approval',
            eventId: 'evt-request',
            createdAt: '2026-04-11T00:00:02.000Z',
            method: 'request.opened',
            requestId: 'req-1',
            requestType: 'approval',
            title: 'Allow command',
          } as any,
        ],
      }),
    ).toMatchObject({
      status: 'waiting_for_approval',
      retryEligible: false,
    });
  });

  test('buildAgentRunSummary lets terminal failures override stale open requests', () => {
    expect(
      buildAgentRunSummary({
        answerability: OBSERVATION,
        loaded: {
          provider: 'codex',
          threadId: 'thread-error',
          status: 'running',
          createdAt: '2026-04-11T00:00:00.000Z',
          updatedAt: '2026-04-11T00:00:01.000Z',
        },
        events: [
          {
            provider: 'codex',
            threadId: 'thread-error',
            eventId: 'evt-request',
            createdAt: '2026-04-11T00:00:02.000Z',
            method: 'request.opened',
            requestId: 'req-1',
            requestType: 'approval',
            title: 'Allow command',
          } as any,
          {
            provider: 'codex',
            threadId: 'thread-error',
            eventId: 'evt-error',
            createdAt: '2026-04-11T00:00:03.000Z',
            method: 'runtime.error',
            severity: 'error',
            message: 'agent failed',
            code: 'agent_error',
          } as any,
        ],
      }),
    ).toMatchObject({
      status: 'failed',
      failureKind: 'agent_error',
      retryEligible: false,
    });
  });

  test('buildAgentRunSummary lets later completion override a recovered runtime error', () => {
    const run = buildAgentRunSummary({
      answerability: OBSERVATION,
      loaded: {
        provider: 'codex',
        threadId: 'thread-recovered',
        status: 'ready',
        createdAt: '2026-04-11T00:00:00.000Z',
        updatedAt: '2026-04-11T00:00:03.000Z',
      },
      events: [
        {
          provider: 'codex',
          threadId: 'thread-recovered',
          eventId: 'evt-error',
          createdAt: '2026-04-11T00:00:01.000Z',
          method: 'runtime.error',
          severity: 'error',
          message: 'Codex runtime error',
          retriable: true,
        } as any,
        {
          provider: 'codex',
          threadId: 'thread-recovered',
          eventId: 'evt-completed',
          createdAt: '2026-04-11T00:00:02.000Z',
          method: 'turn.completed',
          turnId: 'turn-1',
          finishReason: 'stop',
        } as any,
      ],
    });

    expect(run).toMatchObject({
      status: 'completed',
      retryEligible: false,
    });
    expect(run).not.toHaveProperty('failureKind');
    expect(run).not.toHaveProperty('failureMessage');
  });

  // archive#3451 finding 1: `AgentRun.status` must read `exitCode`, the same
  // observation the lifecycle fold already reads, or a crashed session sits
  // on listAgentRuns as `running` with no `completedAt` — the freshest
  // ACTIVE work.
  describe('buildAgentRunSummary session.exited status agreement (station#3451 finding 1)', () => {
    const persisted = {
      provider: 'codex' as const,
      threadId: 'thread-crash',
      status: 'running' as const,
      createdAt: '2026-08-18T00:00:00.000Z',
      updatedAt: '2026-08-18T00:00:00.000Z',
    };

    test('turn.started + session.exited{exitCode:1} reads failed, not running (the probed defect)', () => {
      const run = buildAgentRunSummary({
        answerability: OBSERVATION,
        persisted,
        events: [
          {
            provider: 'codex',
            threadId: 'thread-crash',
            eventId: 'evt-1',
            createdAt: '2026-08-18T00:00:01.000Z',
            method: 'turn.started',
            turnId: 'turn-1',
          } as any,
          {
            provider: 'codex',
            threadId: 'thread-crash',
            eventId: 'evt-2',
            createdAt: '2026-08-18T00:00:02.000Z',
            method: 'session.exited',
            exitCode: 1,
            reason: 'process-exit',
          } as any,
        ],
      });
      expect(run.status).toBe('failed');
      expect(run.completedAt).toBe('2026-08-18T00:00:02.000Z');
    });

    test('session.exited{exitCode:1} alone reads failed, not cancelled', () => {
      const run = buildAgentRunSummary({
        answerability: OBSERVATION,
        persisted,
        events: [
          {
            provider: 'codex',
            threadId: 'thread-crash',
            eventId: 'evt-3',
            createdAt: '2026-08-18T00:00:01.000Z',
            method: 'session.exited',
            exitCode: 1,
            reason: 'process-exit',
          } as any,
        ],
      });
      expect(run.status).toBe('failed');
    });

    test('session.exited{exitCode:0} reads completed even with no prior status', () => {
      const run = buildAgentRunSummary({
        answerability: OBSERVATION,
        persisted,
        events: [
          {
            provider: 'codex',
            threadId: 'thread-crash',
            eventId: 'evt-4',
            createdAt: '2026-08-18T00:00:01.000Z',
            method: 'session.exited',
            exitCode: 0,
            reason: 'completed',
          } as any,
        ],
      });
      expect(run.status).toBe('completed');
    });

    // archive#3451 finding M1: a preceding runtime.error (e.g. archive#3473's
    // synthesized orphaned-turn failure) must survive a following
    // exitCode:0 session.exited for the same crash — the exit code is a
    // fact about the OS process, not proof the turn succeeded.
    test('a preceding runtime.error survives a following exitCode:0 (M1)', () => {
      const run = buildAgentRunSummary({
        answerability: OBSERVATION,
        persisted,
        events: [
          {
            provider: 'codex',
            threadId: 'thread-crash',
            eventId: 'evt-m1-1',
            createdAt: '2026-08-18T00:00:01.000Z',
            method: 'turn.started',
            turnId: 'turn-1',
          } as any,
          {
            provider: 'codex',
            threadId: 'thread-crash',
            eventId: 'evt-m1-2',
            createdAt: '2026-08-18T00:00:02.000Z',
            method: 'runtime.error',
            severity: 'error',
            turnId: 'turn-1',
            message:
              'Codex app-server exited before the turn finished (code: 0).',
          } as any,
          {
            provider: 'codex',
            threadId: 'thread-crash',
            eventId: 'evt-m1-3',
            createdAt: '2026-08-18T00:00:03.000Z',
            method: 'session.exited',
            exitCode: 0,
            reason: 'completed',
          } as any,
        ],
      });
      expect(run.status).toBe('failed');
    });

    // Negative control: session.exited with NO exitCode (every adapter's
    // intentional stopSession/interruptTurn) must not override a status a
    // real terminal event already recorded.
    test('turn.completed + session.exited{no exitCode} keeps completed, not cancelled', () => {
      const run = buildAgentRunSummary({
        answerability: OBSERVATION,
        persisted,
        events: [
          {
            provider: 'codex',
            threadId: 'thread-crash',
            eventId: 'evt-5',
            createdAt: '2026-08-18T00:00:01.000Z',
            method: 'turn.completed',
            turnId: 'turn-1',
            finishReason: 'stop',
          } as any,
          {
            provider: 'codex',
            threadId: 'thread-crash',
            eventId: 'evt-6',
            createdAt: '2026-08-18T00:00:02.000Z',
            method: 'session.exited',
            reason: 'stopped',
          } as any,
        ],
      });
      expect(run.status).toBe('completed');
    });

    // archive#3451 fix round D6: exact parity with deriveLifecycleTransition
    // requires ALSO treating a persisted sessionStatus of 'error'/'dead' as
    // already-failed — not just an in-loop `status === 'failed'`. The
    // lifecycle fold seeds `from` from `providerStatusToLifecycleState`
    // BEFORE its loop starts, so a session whose PERSISTED status is
    // 'error' begins already at 'failed'; this fold only consulted
    // `sessionStatus` AFTER the loop, as an empty-slot fallback. Without D6,
    // a session with `sessionStatus: 'error'` and only a clean-exit-code
    // `session.exited` (no in-band runtime.error) diverged: lifecycle read
    // 'failed', the run read 'completed' — the disagreement finding 1
    // exists to prevent.
    test('sessionStatus: "error" plus session.exited{exitCode:0} and no in-band runtime.error reads failed, not completed (D6)', () => {
      const run = buildAgentRunSummary({
        answerability: OBSERVATION,
        persisted: {
          provider: 'codex',
          threadId: 'thread-crash',
          status: 'error',
          createdAt: '2026-08-18T00:00:00.000Z',
          updatedAt: '2026-08-18T00:00:00.000Z',
        },
        events: [
          {
            provider: 'codex',
            threadId: 'thread-crash',
            eventId: 'evt-d6-1',
            createdAt: '2026-08-18T00:00:02.000Z',
            method: 'session.exited',
            exitCode: 0,
            reason: 'completed',
          } as any,
        ],
      });
      expect(run.status).toBe('failed');
    });

    // Negative control: a healthy persisted status ('ready') with the same
    // clean-exit session.exited must still read 'completed' — D6 only
    // widens the "already failed" check to sessionStatus 'error'/'dead'.
    test('sessionStatus: "ready" plus session.exited{exitCode:0} still reads completed (D6 negative control)', () => {
      const run = buildAgentRunSummary({
        answerability: OBSERVATION,
        persisted: {
          provider: 'codex',
          threadId: 'thread-crash',
          status: 'ready',
          createdAt: '2026-08-18T00:00:00.000Z',
          updatedAt: '2026-08-18T00:00:00.000Z',
        },
        events: [
          {
            provider: 'codex',
            threadId: 'thread-crash',
            eventId: 'evt-d6-2',
            createdAt: '2026-08-18T00:00:02.000Z',
            method: 'session.exited',
            exitCode: 0,
            reason: 'completed',
          } as any,
        ],
      });
      expect(run.status).toBe('completed');
    });
  });

  test('classifyAgentRunFailure centralizes retry eligibility', () => {
    expect(
      isAgentRunRetryEligible(
        classifyAgentRunFailure({
          method: 'runtime.error',
          provider: 'codex',
          threadId: 'thread-timeout',
          eventId: 'evt-timeout',
          createdAt: '2026-04-11T00:00:00.000Z',
          severity: 'error',
          message: 'operation timeout',
          code: 'timeout',
        }),
      ),
    ).toBe(true);

    expect(
      isAgentRunRetryEligible(
        classifyAgentRunFailure({
          method: 'runtime.error',
          provider: 'codex',
          threadId: 'thread-agent-error',
          eventId: 'evt-agent-error',
          createdAt: '2026-04-11T00:00:00.000Z',
          severity: 'error',
          message: 'agent failed',
          code: 'agent_error',
          retriable: false,
        }),
      ),
    ).toBe(false);

    expect(
      classifyAgentRunFailure({
        method: 'runtime.error',
        provider: 'codex',
        threadId: 'thread-retry',
        eventId: 'evt-retry',
        createdAt: '2026-04-11T00:00:00.000Z',
        severity: 'error',
        message: 'Codex runtime error',
        retriable: true,
      }),
    ).toBe('runtime_recovery');
  });

  // archive#1867 review round: the `eventCount` override is the ONLY thing
  // keeping the reported total honest once a caller reads a bounded tail
  // instead of the whole log. The original coverage passed 5 events under a
  // 1,000-event cap, so tail length and true total were equal and deleting the
  // override entirely left 256 tests green. These assert the two values while
  // they DISAGREE, which is the only state that can discriminate.
  test('eventCount reports the supplied total, not the materialized tail length (station#1867)', () => {
    const base = {
      provider: 'claude' as const,
      threadId: 'bounded-count-thread',
      status: 'ready' as const,
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
    };
    // Three materialized events standing in for the tail of a much longer log.
    const tail = [
      {
        provider: 'claude',
        threadId: base.threadId,
        eventId: 'tail-1',
        createdAt: base.createdAt,
        method: 'turn.started',
        turnId: 'turn-1',
      },
      {
        provider: 'claude',
        threadId: base.threadId,
        eventId: 'tail-2',
        createdAt: base.updatedAt,
        method: 'content.text-delta',
        delta: 'x',
      },
      {
        provider: 'claude',
        threadId: base.threadId,
        eventId: 'tail-3',
        createdAt: base.updatedAt,
        method: 'turn.completed',
        turnId: 'turn-1',
      },
    ] as any;

    const summary = buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted: base,
      events: tail,
      eventCount: 13_847,
    });
    expect(summary.eventCount).toBe(13_847);
    expect(summary.eventCount).not.toBe(tail.length);

    const run = buildAgentRunSummary({
      answerability: OBSERVATION,
      persisted: base,
      events: tail,
      eventCount: 13_847,
    });
    expect(run.eventCount).toBe(13_847);
    expect(run.eventCount).not.toBe(tail.length);

    // Omitting the override still falls back to the materialized length, so
    // every caller that genuinely reads the whole log is unchanged.
    expect(
      buildOrchestrationSessionSummary({
        answerability: OBSERVATION,
        persisted: base,
        events: tail,
      }).eventCount,
    ).toBe(tail.length);
  });
});

describe('terminal attribution projection (station#4054 slice 2)', () => {
  const base = {
    provider: 'claude' as const,
    threadId: 'terminal-attribution-thread',
    sessionId: 'terminal-attribution-thread',
  };
  const persisted: ProviderSession = {
    provider: 'claude',
    threadId: base.threadId,
    status: 'running',
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
  };
  const started = {
    ...base,
    eventId: 'terminal-attribution-started',
    createdAt: '2026-08-24T00:00:01.000Z',
    method: 'turn.started' as const,
    turnId: 'turn-1',
  };

  function summary(events: CanonicalRuntimeEvent[]) {
    return buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted,
      events,
    });
  }

  function stoppedBy(initiatedBy: 'user' | 'stall'): CanonicalRuntimeEvent[] {
    return [
      started,
      {
        ...base,
        eventId: `terminal-attribution-${initiatedBy}-stop-settled`,
        createdAt: '2026-08-24T00:00:02.000Z',
        method: 'session.stop-settled' as const,
        turnId: 'turn-1',
        outcome: 'cooperative' as const,
        initiatedBy,
      },
      {
        ...base,
        eventId: `terminal-attribution-${initiatedBy}-aborted`,
        createdAt: '2026-08-24T00:00:03.000Z',
        method: 'turn.aborted' as const,
        turnId: 'turn-1',
        reason: 'stopped',
      },
    ];
  }

  test('most-specific stop attribution beats an otherwise recorded runtime error', () => {
    const events = [
      started,
      {
        ...base,
        eventId: 'terminal-attribution-error-before-stop',
        createdAt: '2026-08-24T00:00:02.000Z',
        method: 'runtime.error' as const,
        severity: 'error' as const,
        turnId: 'turn-1',
        message: 'The provider retried before the user stopped this turn.',
      },
      // No abort follows: the lifecycle remains failed, so this proves the
      // attribution order itself (user stop over matching error), not merely
      // that a later `turn.aborted` changed the terminal event.
      ...stoppedBy('user').slice(1, 2),
    ];

    expect(summary(events).terminalAttribution).toEqual({
      kind: 'requested_stop',
      detail: 'Stopped by request.',
    });
  });

  test('stall stop beats an otherwise recorded runtime error', () => {
    const events = [
      started,
      {
        ...base,
        eventId: 'terminal-attribution-error-before-stall',
        createdAt: '2026-08-24T00:00:02.000Z',
        method: 'runtime.error' as const,
        severity: 'error' as const,
        turnId: 'turn-1',
        message: 'A lower-priority error.',
      },
      ...stoppedBy('stall').slice(1, 2),
    ];

    expect(summary(events).terminalAttribution).toEqual({
      kind: 'stall_stop',
      detail: 'Station stopped it after no progress was detected.',
    });
  });

  test.each([
    ['requested then stall', ['user', 'stall']],
    ['stall then requested', ['stall', 'user']],
  ] as const)(
    'requested stop beats a duplicate stop fact (%s)',
    (_order, initiators) => {
      const stopFacts = initiators.map((initiatedBy, index) => ({
        ...base,
        eventId: `terminal-attribution-duplicate-${initiatedBy}-${index}`,
        createdAt: `2026-08-24T00:00:0${index + 2}.000Z`,
        method: 'session.stop-settled' as const,
        turnId: 'turn-1',
        outcome: 'forced' as const,
        initiatedBy,
      }));
      const aborted = {
        ...base,
        eventId: 'terminal-attribution-duplicate-aborted',
        createdAt: '2026-08-24T00:00:04.000Z',
        method: 'turn.aborted' as const,
        turnId: 'turn-1',
        reason: 'stopped',
      };

      expect(
        summary([started, ...stopFacts, aborted]).terminalAttribution,
      ).toEqual({
        kind: 'requested_stop',
        detail: 'Stopped by request.',
      });
    },
  );

  test('a prior requested stop cannot attribute a later retry failure', () => {
    const events = [
      ...stoppedBy('user'),
      {
        ...base,
        eventId: 'terminal-attribution-retry-started',
        createdAt: '2026-08-24T00:00:04.000Z',
        method: 'turn.started' as const,
        turnId: 'turn-2',
      },
      {
        ...base,
        eventId: 'terminal-attribution-retry-error',
        createdAt: '2026-08-24T00:00:05.000Z',
        method: 'runtime.error' as const,
        severity: 'error' as const,
        turnId: 'turn-2',
        message: 'The retry was refused.',
      },
    ];

    expect(summary(events).terminalAttribution).toEqual({
      kind: 'runtime_error',
      detail: 'The engine reported an error: The retry was refused.',
    });
  });

  test('a runtime-error message beats a bare exit code', () => {
    const events = [
      started,
      {
        ...base,
        eventId: 'terminal-attribution-runtime-error',
        createdAt: '2026-08-24T00:00:02.000Z',
        method: 'runtime.error' as const,
        severity: 'error' as const,
        turnId: 'turn-1',
        message: 'The model refused this request.',
      },
      {
        ...base,
        eventId: 'terminal-attribution-exit-after-error',
        createdAt: '2026-08-24T00:00:03.000Z',
        method: 'session.exited' as const,
        exitCode: 9,
      },
    ];

    expect(summary(events).terminalAttribution).toEqual({
      kind: 'runtime_error',
      detail: 'The engine reported an error: The model refused this request.',
    });
  });

  test('explicit timeout and no-output evidence beat a bare exit when no runtime message exists', () => {
    const timeout = summary([
      started,
      {
        ...base,
        eventId: 'terminal-attribution-timeout',
        createdAt: '2026-08-24T00:00:02.000Z',
        method: 'runtime.error' as const,
        severity: 'error' as const,
        turnId: 'turn-1',
        message: '',
        code: 'muse-turn-timeout',
      },
      {
        ...base,
        eventId: 'terminal-attribution-timeout-exit',
        createdAt: '2026-08-24T00:00:03.000Z',
        method: 'session.exited' as const,
        exitCode: 9,
      },
    ]);
    const noOutput = summary([
      started,
      {
        ...base,
        eventId: 'terminal-attribution-no-output',
        createdAt: '2026-08-24T00:00:02.000Z',
        method: 'runtime.error' as const,
        severity: 'error' as const,
        turnId: 'turn-1',
        message: '',
        code: 'no-output',
      },
      {
        ...base,
        eventId: 'terminal-attribution-no-output-exit',
        createdAt: '2026-08-24T00:00:03.000Z',
        method: 'session.exited' as const,
        exitCode: 9,
      },
    ]);

    expect(timeout.terminalAttribution).toEqual({
      kind: 'timeout',
      detail: 'Station ended the session after it timed out.',
    });
    expect(noOutput.terminalAttribution).toEqual({
      kind: 'no_output',
      detail: 'The engine ended without output.',
    });
  });

  test('a bare non-zero exit is attributed only when it is the terminal fact', () => {
    expect(
      summary([
        started,
        {
          ...base,
          eventId: 'terminal-attribution-bare-exit',
          createdAt: '2026-08-24T00:00:02.000Z',
          method: 'session.exited' as const,
          exitCode: 7,
        },
      ]).terminalAttribution,
    ).toEqual({ kind: 'exit', detail: 'The engine exited with code 7.' });
  });

  test('clean completion and unknown stopped causes carry no invented attribution', () => {
    const clean = summary([
      started,
      {
        ...base,
        eventId: 'terminal-attribution-completed',
        createdAt: '2026-08-24T00:00:02.000Z',
        method: 'turn.completed' as const,
        turnId: 'turn-1',
        finishReason: 'stop' as const,
      },
    ]);
    const unknown = summary([
      started,
      {
        ...base,
        eventId: 'terminal-attribution-unknown-stop',
        createdAt: '2026-08-24T00:00:02.000Z',
        method: 'turn.aborted' as const,
        turnId: 'turn-1',
        reason: 'adapter stopped',
      },
    ]);

    expect(clean.terminalAttribution).toBeUndefined();
    expect(unknown.terminalAttribution).toBeUndefined();
  });

  test('bounds an untrusted runtime message to one compact line', () => {
    const oversized = `<error>${'x'.repeat(8_000)}\nsecond line`;
    const attribution = summary([
      started,
      {
        ...base,
        eventId: 'terminal-attribution-oversized-error',
        createdAt: '2026-08-24T00:00:02.000Z',
        method: 'runtime.error' as const,
        severity: 'error' as const,
        turnId: 'turn-1',
        message: oversized,
      },
    ]).terminalAttribution;

    expect(attribution?.kind).toBe('runtime_error');
    expect(attribution?.detail?.length).toBeLessThanOrEqual(240);
    expect(attribution?.detail).not.toContain('\n');
  });

  test('keeps a useful error prefix but excludes appended stdout/stderr excerpts', () => {
    const attribution = summary([
      started,
      {
        ...base,
        eventId: 'terminal-attribution-stderr-tail',
        createdAt: '2026-08-24T00:00:02.000Z',
        method: 'runtime.error' as const,
        severity: 'error' as const,
        turnId: 'turn-1',
        message:
          'The engine rejected the request. muse stderr: raw child output',
      },
    ]).terminalAttribution;

    expect(attribution).toEqual({
      kind: 'runtime_error',
      detail: 'The engine reported an error: The engine rejected the request.',
    });
  });

  test('removes ANSI/control characters, collapses whitespace, and strips an uppercase output tail', () => {
    const attribution = summary([
      started,
      {
        ...base,
        eventId: 'terminal-attribution-sanitized-detail',
        createdAt: '2026-08-24T00:00:02.000Z',
        method: 'runtime.error' as const,
        severity: 'error' as const,
        turnId: 'turn-1',
        message:
          '\x1B[31mFirst sentence.\x1B[0m\tSecond sentence.\x07 OUTPUT: raw adapter output',
      },
    ]).terminalAttribution;

    expect(attribution).toEqual({
      kind: 'runtime_error',
      detail: 'The engine reported an error: First sentence. Second sentence.',
    });
  });
});

/**
 * archive#3549 review round 4 (independent, Codex), HIGH.
 *
 * The live-start path's credential-profile application was fixed three times
 * over three review rounds. This path never had it: recovery applied
 * `resolveSessionAgent` and then called `adapter.startSession` directly, so a
 * pinned agent whose session was recovered after a restart ran on the
 * CONNECTION's account. The original wrong-account defect survived here the
 * entire time the other path was being corrected.
 */
describe('recovered sessions carry the agent credential pin (station#3549)', () => {
  const recoverableSession = (): ProviderSession => ({
    provider: 'bedrock',
    threadId: 'recovered-thread',
    status: 'ready',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  });

  const recoveringAdapter = () => {
    const startSession = vi.fn().mockResolvedValue({
      provider: 'bedrock',
      threadId: 'recovered-thread',
      status: 'ready',
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z',
    });
    return {
      startSession,
      adapter: {
        provider: 'bedrock',
        startSession,
      } as unknown as ProviderAdapterShape,
    };
  };

  test('applies the pin before the adapter starts', async () => {
    const { adapter, startSession } = recoveringAdapter();
    await startRecovered({
      session: recoverableSession(),
      adapter,
      options: {
        applyCredentialProfile: async (input) => ({
          ...input,
          credentialProfileRef: 'work-account',
        }),
      },
    });
    expect(startSession.mock.calls.at(-1)?.[0]?.credentialProfileRef).toBe(
      'work-account',
    );
  });

  // Deliberately NOT lenient, unlike resolveSessionAgent: that resolver
  // degrading costs a session its authored definition, which is recoverable.
  // This one degrading bills a turn to the wrong account, which is not.
  test('a failure to determine the account refuses the recovery', async () => {
    const { adapter, startSession } = recoveringAdapter();
    await expect(
      startRecovered({
        session: recoverableSession(),
        adapter,
        options: {
          applyCredentialProfile: async () => {
            throw new Error('the account this session runs on is unknown');
          },
        },
      }),
    ).rejects.toThrow(/account this session runs on is unknown/);
    // The engine must not have been started on a guessed account.
    expect(startSession).not.toHaveBeenCalled();
  });

  test('no configured resolver leaves recovery byte-identical', async () => {
    const { adapter, startSession } = recoveringAdapter();
    await startRecovered({ session: recoverableSession(), adapter });
    expect(
      startSession.mock.calls.at(-1)?.[0]?.credentialProfileRef,
    ).toBeUndefined();
  });
});

// UX audit AW-R8 (reports/2-agent-workflows/REPORT.md): the runs
// fold's half of "a session's outcome is derived from its recorded terminal
// TURN events, never from the liveness of an engine process". Station keeps
// pooled engine processes resident long after a turn ends (one engine from a
// 17:14 session was still alive 24 minutes later), so the `session.exited`
// describing that process's death arrives long after the work it hosted
// finished. These assertions are the mirror of
// `session-lifecycle-service.test.ts`'s `AW-R8` block — the two folds read the
// identical events and must not answer this one differently.
describe('a recorded turn outcome survives the engine process (AW-R8)', () => {
  const base = {
    provider: 'claude' as const,
    threadId: 'thread-3611',
    sessionId: 'thread-3611',
  };
  const persisted: ProviderSession = {
    provider: 'claude',
    threadId: 'thread-3611',
    status: 'running',
    createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:24:00.000Z',
  };
  const turnStarted = {
    ...base,
    eventId: 'evt-3611-1',
    createdAt: '2026-08-20T10:00:01.000Z',
    method: 'turn.started',
    turnId: 'turn-1',
    prompt: 'Reply with exactly: MANGO26176',
  } as any;
  const turnCompleted = {
    ...base,
    eventId: 'evt-3611-2',
    createdAt: '2026-08-20T10:00:02.000Z',
    method: 'turn.completed',
    turnId: 'turn-1',
    finishReason: 'stop',
  } as any;
  const exitedNonZero = {
    ...base,
    eventId: 'evt-3611-3',
    createdAt: '2026-08-20T10:24:00.000Z',
    method: 'session.exited',
    exitCode: 1,
    reason: 'process-exit',
  } as any;

  test('a completed turn stays completed when the pooled process later dies (exitCode 1)', () => {
    const events = [turnStarted, turnCompleted, exitedNonZero];
    const run = buildAgentRunSummary({
      answerability: OBSERVATION,
      persisted,
      events,
    });
    expect(run.status).toBe('completed');
    expect(run.failureKind).toBeUndefined();
    // The two folds must agree on the identical events.
    expect(
      buildOrchestrationSessionSummary({
        answerability: OBSERVATION,
        persisted,
        events,
      }).lifecycleState,
    ).toBe('completed');
  });

  test('a completed turn stays completed when the process is stopped with no exitCode', () => {
    const run = buildAgentRunSummary({
      answerability: OBSERVATION,
      persisted,
      events: [
        turnStarted,
        turnCompleted,
        {
          ...base,
          eventId: 'evt-3611-4',
          createdAt: '2026-08-20T10:24:00.000Z',
          method: 'session.exited',
          reason: 'stopped',
        } as any,
      ],
    });
    expect(run.status).toBe('completed');
  });

  // The persisted-status fallback must not outrank a recorded turn outcome
  // either: killing a pooled engine also marks the engine binding
  // dead/errored, which is what the tail of `deriveAgentRunStatus` reads.
  test('a persisted engine status of dead does not outrank a recorded completed turn', () => {
    const events = [turnStarted, turnCompleted, exitedNonZero];
    const run = buildAgentRunSummary({
      answerability: OBSERVATION,
      persisted: { ...persisted, status: 'dead' },
      events,
    });
    expect(run.status).toBe('completed');
    expect(
      buildOrchestrationSessionSummary({
        answerability: OBSERVATION,
        persisted: { ...persisted, status: 'dead' },
        events,
      }).lifecycleState,
    ).toBe('completed');
  });

  // Discriminating negatives — a turn with no recorded outcome DOES take the
  // exit as its outcome (archive#3451 finding 1, unchanged).
  test('a turn still in progress when the process exits abnormally is failed with the exit as reason', () => {
    const run = buildAgentRunSummary({
      answerability: OBSERVATION,
      persisted,
      events: [turnStarted, exitedNonZero],
    });
    expect(run.status).toBe('failed');
    expect(run.completedAt).toBeDefined();
  });

  test('a turn still in progress that hits runtime.error is failed with its message', () => {
    const run = buildAgentRunSummary({
      answerability: OBSERVATION,
      persisted,
      events: [
        turnStarted,
        {
          ...base,
          eventId: 'evt-3611-5',
          createdAt: '2026-08-20T10:00:03.000Z',
          method: 'runtime.error',
          severity: 'error',
          turnId: 'turn-1',
          message: 'Engine exited before the turn finished (code: 1).',
        } as any,
      ],
    });
    expect(run.status).toBe('failed');
    expect(run.failureMessage).toBe(
      'Engine exited before the turn finished (code: 1).',
    );
  });

  // The route the audit reproduced live: a session-scoped `runtime.error` with
  // no turn id, published when the pooled engine is killed after the turn.
  test('a completed turn stays completed when the pooled engine is killed afterwards', () => {
    const events = [
      turnStarted,
      turnCompleted,
      {
        ...base,
        eventId: 'evt-3611-kill',
        createdAt: '2026-08-20T10:24:00.000Z',
        method: 'runtime.error',
        severity: 'error',
        message:
          'Claude model "claude-opus-5[1m]" failed: Claude Code process terminated by signal SIGKILL',
      } as any,
    ];
    const run = buildAgentRunSummary({
      answerability: OBSERVATION,
      persisted: { ...persisted, status: 'error' },
      events,
    });
    expect(run.status).toBe('completed');
    expect(
      buildOrchestrationSessionSummary({
        answerability: OBSERVATION,
        persisted: { ...persisted, status: 'error' },
        events,
      }).lifecycleState,
    ).toBe('completed');
  });

  test("a turn's own late failure, naming that turn, still fails the run", () => {
    const run = buildAgentRunSummary({
      answerability: OBSERVATION,
      persisted,
      events: [
        turnStarted,
        { ...turnCompleted, finishReason: 'other' },
        {
          ...base,
          eventId: 'evt-3611-own-error',
          createdAt: '2026-08-20T10:00:03.000Z',
          method: 'runtime.error',
          severity: 'error',
          turnId: 'turn-1',
          message: 'usage limit reached',
        } as any,
      ],
    });
    expect(run.status).toBe('failed');
    expect(run.failureMessage).toBe('usage limit reached');
  });

  // A cancelled turn is a recorded outcome too: a user Stop must not be
  // relabelled `failed` by the process teardown it itself caused.
  test('a cancelled turn stays cancelled when the process then exits non-zero', () => {
    const run = buildAgentRunSummary({
      answerability: OBSERVATION,
      persisted,
      events: [
        turnStarted,
        {
          ...base,
          eventId: 'evt-3611-6',
          createdAt: '2026-08-20T10:00:02.000Z',
          method: 'turn.aborted',
          turnId: 'turn-1',
          reason: 'user_canceled',
        } as any,
        exitedNonZero,
      ],
    });
    expect(run.status).toBe('cancelled');
  });
});
