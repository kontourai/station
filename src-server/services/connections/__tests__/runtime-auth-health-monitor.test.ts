import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { BedrockAdapter } from '../../../providers/adapters/bedrock-adapter.js';
import { OllamaAdapter } from '../../../providers/adapters/ollama-adapter.js';
import { EventBus } from '../../orchestration/event-bus.js';
import {
  clearsRuntimeAuthHealth,
  isRuntimeAuthenticationFailure,
  RuntimeAuthHealthMonitor,
} from '../runtime-auth-health-monitor.js';

function runtimeEvent(
  provider: string,
  event: Record<string, unknown>,
): Record<string, unknown> {
  return {
    event: {
      eventId: 'event-1',
      provider,
      threadId: 'thread-1',
      createdAt: new Date().toISOString(),
      ...event,
    },
  };
}

describe('runtime auth health monitor', () => {
  afterEach(() => {
    vi.useRealTimers();
    // archive#3587 review MEDIUM-1: every `vi.spyOn(console, 'warn')` in
    // this file only calls `mockRestore()` AFTER its own assertions — so a
    // failing assertion on ONE test's spy (asserted before `mockRestore()`
    // runs) leaves that spy in place. `@vitest/spy`'s `vi.spyOn` on an
    // already-spied method returns the EXISTING spy with its call history
    // intact rather than installing a fresh one (verified against
    // `node_modules/@vitest/spy/dist/index.js`), and neither
    // `vitest.config.ts` (`restoreMocks` is not set) nor `vitest.setup.ts`
    // clears it — so every subsequent test's spy silently accumulates the
    // leaked test's warn calls too, turning one real failure into a cascade
    // of unrelated-looking failures across the rest of this file. This
    // restores ALL mocks (spies included) after every test regardless of
    // whether the test's own `mockRestore()` ran, so one red stays one red.
    vi.restoreAllMocks();
  });

  test.each([
    [
      'Refresh token was already used and access token could not be refreshed',
      undefined,
    ],
    ['Unauthorized', undefined],
    ['Please log in again', undefined],
    ['Request failed', 'invalid_grant'],
    ['Invalid API key provided', undefined],
    ['OAuth token has expired', undefined],
    ['Invalid x-api-key provided', undefined],
    ['Request failed', 'authentication_error'],
  ])('recognizes an authentication failure: %s', (message, code) => {
    expect(isRuntimeAuthenticationFailure({ message, code })).toBe(true);
  });

  test.each([
    ['Rate limit exceeded', undefined],
    ['The model does not exist', undefined],
    ['Permission denied for this tool', undefined],
    ['Network connection failed', 'ECONNRESET'],
    ['Unauthorized', 'ABORT_ERR'],
    ['Unauthorized', 'abort_error'],
    ['Unauthorized', 'AbortError'],
    ['Authentication failed: credentials rejected', 'request_aborted'],
    ['Authentication request was interrupted', 'invalid_grant'],
  ])('does not classify an unrelated runtime failure: %s', (message, code) => {
    expect(isRuntimeAuthenticationFailure({ message, code })).toBe(false);
  });

  // archive#3509 fix round FIX 2: executes clearsRuntimeAuthHealth's
  // rejection path directly. archive#3587 update: `'other'` DOES now reach
  // this predicate through the live EventBus path — `WELL_FORMED_FINISH_REASONS`
  // (the monitor's malformed check) accepts it as well-formed, so
  // `onServerEvent` calls `clearsRuntimeAuthHealth('other')` for real; this
  // file's dedicated archive#3587 test below exercises that end-to-end
  // coupling. An arbitrary unrecognized string and `undefined` still cannot
  // reach this predicate through the live path (the malformed check refuses
  // both before `onServerEvent` ever calls it) — this remains the reachable
  // proof for those two: the predicate itself, in isolation, fails closed.
  test.each(['stop', 'tool-calls', 'max-tokens'])(
    "clearsRuntimeAuthHealth('%s') is true",
    (finishReason) => {
      expect(clearsRuntimeAuthHealth(finishReason)).toBe(true);
    },
  );

  test.each(['cancelled', 'other', 'unrecognized-future-value', ''])(
    "clearsRuntimeAuthHealth('%s') is false",
    (finishReason) => {
      expect(clearsRuntimeAuthHealth(finishReason)).toBe(false);
    },
  );

  test('clearsRuntimeAuthHealth(undefined) is false', () => {
    expect(clearsRuntimeAuthHealth(undefined)).toBe(false);
  });

  test('temporarily blocks a provider without retaining the raw error', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T12:00:00.000Z'));
    const bus = new EventBus();
    const changed = vi.fn();
    bus.subscribe((event) => {
      if (event.event === SERVER_EVENTS.RUNTIME_HEALTH_CHANGED) changed(event);
    });
    const monitor = new RuntimeAuthHealthMonitor(bus, { ttlMs: 60_000 });

    bus.emit(
      SERVER_EVENTS.ORCHESTRATION_EVENT,
      runtimeEvent('codex', {
        method: 'runtime.error',
        severity: 'error',
        message:
          'Refresh token secret-token-value was already used and access token could not be refreshed',
      }),
    );

    expect(monitor.getFailure('codex')).toEqual({
      observedAt: '2026-07-13T12:00:00.000Z',
      expiresAt: '2026-07-13T12:01:00.000Z',
    });
    expect(JSON.stringify(monitor.getFailure('codex'))).not.toContain(
      'secret-token-value',
    );
    expect(changed).toHaveBeenCalledWith({
      event: SERVER_EVENTS.RUNTIME_HEALTH_CHANGED,
      data: { provider: 'codex', status: 'authentication_failed' },
    });

    vi.advanceTimersByTime(60_000);
    expect(monitor.getFailure('codex')).toBeNull();
    expect(changed).toHaveBeenLastCalledWith({
      event: SERVER_EVENTS.RUNTIME_HEALTH_CHANGED,
      data: { provider: 'codex', status: 'recheck_due' },
    });
    monitor.dispose();
  });

  test('clears a provider immediately after a successful turn', () => {
    const bus = new EventBus();
    const monitor = new RuntimeAuthHealthMonitor(bus);
    bus.emit(
      SERVER_EVENTS.ORCHESTRATION_EVENT,
      runtimeEvent('claude', {
        method: 'runtime.error',
        severity: 'error',
        message: 'Authentication failed: credentials rejected',
      }),
    );
    expect(monitor.getFailure('claude')).not.toBeNull();

    bus.emit(
      SERVER_EVENTS.ORCHESTRATION_EVENT,
      runtimeEvent('claude', {
        method: 'turn.completed',
        turnId: 'turn-1',
        finishReason: 'stop',
      }),
    );

    expect(monitor.getFailure('claude')).toBeNull();
    monitor.dispose();
  });

  // archive#3545: the user-visible harm this issue exists to fix, proven
  // END TO END rather than with a hand-typed stand-in for the adapter's
  // output. Before the fix, `BedrockAdapter` published `turn.completed` with
  // `finishReason: 'other'` for every successful turn — Bedrock's stream
  // never surfaced its own `finishReason` at all
  // (`AiSdkLLMProvider.createStream` never read ai-sdk's `result.finishReason`
  // promise), and `normalizeFinishReason` collapsed that absence into
  // `'other'`. `WELL_FORMED_FINISH_REASONS`, at the time this test was
  // written, excluded `'other'` and rejected it as malformed instead, so
  // a Bedrock auth failure could never clear from a real recovery, and the
  // exponential backoff streak never reset. Fixed two layers: the producer
  // now propagates ai-sdk's own `finishReason` (mapped onto station's
  // vocabulary — see ai-sdk-llm-provider.test.ts), and the adapter's
  // `normalizeFinishReason`/`?? 'stop'` fallback still only applies to a
  // genuinely absent value.
  //
  // archive#3545 delta review round 3: this used to hard-code a single
  // `finishReason: 'stop'` fixture. That is the FAITHFUL, ordinary-case shape
  // post-fix, but it means this test no longer drives the absence path at
  // all — round 1's original defect (`normalizeFinishReason` collapsing
  // `undefined` into `'other'`) reddened this exact test; a fixture that
  // never supplies `undefined` cannot. `test.each` over both the ordinary
  // shape (`finishReason: 'stop'`) and the fallback shape (no `finishReason`
  // key — the producer's own promise rejected/resolved non-string) restores
  // that coverage: BOTH must clear the failure and reset the streak, and
  // BOTH must reproduce round 1's defect when re-injected.
  //
  // This drives an actual `BedrockAdapter` through `sendTurn` and bridges
  // its own published events onto the shared bus the way
  // `OrchestrationService`'s `for await` loop over `adapter.streamEvents()`
  // does in production, then asserts BOTH halves of the harm are fixed: the
  // failure clears, and a SECOND consecutive failure gets the BASE ttl again
  // rather than the doubled (streak=2) ttl it would get if `resetStreak`
  // never fired — `failureStreaks` has no public getter, so the
  // escalating-backoff ttl is the only observable proof of a reset streak.
  test.each([
    {
      label: 'ordinary shape (finishReason: "stop")',
      finishChunk: { type: 'finish' as const, finishReason: 'stop' as const },
    },
    {
      label: 'fallback shape (no finishReason key)',
      finishChunk: { type: 'finish' as const },
    },
  ])(
    'station#3545: a real Bedrock turn.completed produced by BedrockAdapter itself (not a synthetic event) — $label — clears a recorded auth failure and resets the failure streak',
    async ({ finishChunk }) => {
      const bus = new EventBus();
      const monitor = new RuntimeAuthHealthMonitor(bus);

      bus.emit(
        SERVER_EVENTS.ORCHESTRATION_EVENT,
        runtimeEvent('bedrock', {
          method: 'runtime.error',
          severity: 'error',
          message: 'Authentication failed: credentials rejected',
        }),
      );
      const first = monitor.getFailure('bedrock');
      expect(first).not.toBeNull();
      const firstTtlMs =
        new Date(first!.expiresAt).getTime() -
        new Date(first!.observedAt).getTime();

      const createStream = vi.fn(async function* () {
        yield { type: 'text-delta' as const, content: 'Completed output' };
        yield finishChunk;
      });
      const adapter = new BedrockAdapter(
        {},
        {
          modelCatalog: { resolveModelId: async (modelId: string) => modelId },
          llm: { createStream } as any,
        },
      );
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
      await adapter.startSession({
        provider: 'bedrock',
        threadId: 'thread-1',
        modelId: 'model-a',
      });
      await adapter.sendTurn({ threadId: 'thread-1', input: 'hi' });

      let sawCompletion = false;
      for (let index = 0; index < 8; index += 1) {
        const next = await iterator.next();
        if (!next.value) break;
        bus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, { event: next.value });
        if ((next.value as { method?: string }).method === 'turn.completed') {
          sawCompletion = true;
          break;
        }
      }
      expect(sawCompletion).toBe(true);
      expect(monitor.getFailure('bedrock')).toBeNull();

      bus.emit(
        SERVER_EVENTS.ORCHESTRATION_EVENT,
        runtimeEvent('bedrock', {
          method: 'runtime.error',
          severity: 'error',
          message: 'Authentication failed: credentials rejected',
        }),
      );
      const second = monitor.getFailure('bedrock');
      expect(second).not.toBeNull();
      const secondTtlMs =
        new Date(second!.expiresAt).getTime() -
        new Date(second!.observedAt).getTime();
      expect(secondTtlMs).toBe(firstTtlMs);
      monitor.dispose();
    },
  );

  // archive#3587 review "Pin the auth-erasure coupling permanently": the
  // harm HIGH-1 fixed (archive#3596, folded into archive#3586's own change)
  // was that a FAILED Ollama turn could erase its own recorded auth
  // failure — both halves of that composition look correct in isolation
  // (`OllamaAdapter` throws on an error chunk; `RuntimeAuthHealthMonitor`
  // only clears on `stop`/`tool-calls`/`max-tokens`), and only the WIRING
  // between them is the actual claim: a thrown `runtime.error`, not a
  // `turn.completed`, is what reaches this monitor for a failed Ollama
  // turn. That composition decays silently if either half changes without
  // the other noticing — mirrors the Bedrock `test.each` above (a real
  // adapter driven through `sendTurn`, bridged onto the shared bus the way
  // `OrchestrationService`'s `for await` loop does in production), but
  // proves the OPPOSITE outcome: the failure must survive, not clear.
  test('station#3596/#3586: a real Ollama turn that fails via a yielded error chunk does NOT clear a recorded auth failure', async () => {
    const bus = new EventBus();
    const monitor = new RuntimeAuthHealthMonitor(bus);

    bus.emit(
      SERVER_EVENTS.ORCHESTRATION_EVENT,
      runtimeEvent('ollama', {
        method: 'runtime.error',
        severity: 'error',
        message: 'Authentication failed: credentials rejected',
      }),
    );
    expect(monitor.getFailure('ollama')).not.toBeNull();

    const llm = {
      listModelCatalog: vi.fn(async () => ({
        source: 'live',
        models: [{ id: 'model-a', name: 'Model A' }],
      })),
      createStream: vi.fn(async function* () {
        yield { type: 'text-delta' as const, content: 'Partial ' };
        yield {
          type: 'error' as const,
          error: 'provider stream failed mid-generation',
        };
      }),
    };
    const adapter = new OllamaAdapter('http://ollama.test', {
      llm: llm as any,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    await adapter.startSession({
      provider: 'ollama',
      threadId: 'thread-1',
      modelId: 'model-a',
    });
    // Deliberately NOT `.rejects.toThrow(...)` as a hard gate here: an
    // assertion that stops the test the instant `sendTurn` fails to reject
    // would catch a REGRESSION (the throw removed) at that gate and never
    // reach the auth-failure assertion below at all — proving only "the
    // adapter stopped throwing," not this test's actual claim, "a failed
    // turn does not clear the recorded auth failure." Let it settle either
    // way, then read the bridged events and the monitor's own state — the
    // exact two facts a real regression would falsify, and the exact shape
    // of the reviewer's own throwaway probe that first surfaced this harm.
    const sendTurnOutcome = await adapter
      .sendTurn({ threadId: 'thread-1', input: 'hi' })
      .then(() => ({ rejected: false as const }))
      .catch((error: unknown) => ({ rejected: true as const, error }));

    let sawRuntimeError = false;
    let sawTurnCompleted = false;
    for (let index = 0; index < 8; index += 1) {
      const next = await iterator.next();
      if (!next.value) break;
      bus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, { event: next.value });
      const method = (next.value as { method?: string }).method;
      if (method === 'runtime.error') {
        sawRuntimeError = true;
        break;
      }
      if (method === 'turn.completed') {
        sawTurnCompleted = true;
        break;
      }
    }

    // The primary claim first, so a regression fails here with the exact
    // signature the reviewer's throwaway probe found ("expected null not to
    // be null" — the failed turn erased its own recorded auth failure), not
    // buried behind an earlier, less specific assertion.
    expect(monitor.getFailure('ollama')).not.toBeNull();
    // Supporting facts: why it's still non-null.
    expect(sendTurnOutcome.rejected).toBe(true);
    expect(sawRuntimeError).toBe(true);
    expect(sawTurnCompleted).toBe(false);
    monitor.dispose();
  });

  test('station#3509: a user-initiated cancellation is not a malformed turn.completed', () => {
    const bus = new EventBus();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const monitor = new RuntimeAuthHealthMonitor(bus);
    bus.emit(
      SERVER_EVENTS.ORCHESTRATION_EVENT,
      runtimeEvent('codex', {
        method: 'runtime.error',
        severity: 'error',
        message: 'Authentication failed: credentials rejected',
      }),
    );
    expect(monitor.getFailure('codex')).not.toBeNull();

    // A deliberate user cancellation publishes `turn.completed` with
    // `finishReason: 'cancelled'` outside the `runtime.error` path. The real
    // producers are codex (`mapTurnFinishReason` maps `turn.status ===
    // 'interrupted'` to `'cancelled'`) and ACP (`mapAcpStopReasonToFinishReason`
    // maps `StopReason: 'cancelled'` straight through) — NOT "every adapter":
    // bedrock/ollama route their own interrupt handling through `turn.aborted`
    // instead (archive#3466), muse routes an interrupt to `runtime.error`, and
    // claude's `turn.completed` only ever carries `'tool-calls'`/`'stop'`.
    // This must not throw `RuntimeAuthHealthEventDiagnostic`. Fix round FIX 3:
    // unlike a genuine content-producing completion, it must NOT clear the
    // recorded auth failure either — a cancellation is not evidence the
    // provider authenticated, and this record is provider-scoped (a
    // cancellation on some OTHER thread must not erase this one's failure).
    bus.emit(
      SERVER_EVENTS.ORCHESTRATION_EVENT,
      runtimeEvent('codex', {
        method: 'turn.completed',
        turnId: 'turn-1',
        finishReason: 'cancelled',
      }),
    );

    expect(monitor.getFailure('codex')).not.toBeNull();
    expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
    monitor.dispose();
  });

  test.each(['stop', 'tool-calls', 'max-tokens'])(
    // archive#3509 fix round MEDIUM 2: PROVIDER_PROVEN_FINISH_REASONS is an
    // allowlist, not WELL_FORMED_FINISH_REASONS minus 'cancelled'/'other' —
    // this pins its full, exact membership (all three clear) rather than
    // just one representative member.
    "station#3509 fix round FIX 3: a genuine content-producing completion ('%s') still clears the recorded auth failure",
    (finishReason) => {
      const bus = new EventBus();
      const monitor = new RuntimeAuthHealthMonitor(bus);
      bus.emit(
        SERVER_EVENTS.ORCHESTRATION_EVENT,
        runtimeEvent('codex', {
          method: 'runtime.error',
          severity: 'error',
          message: 'Authentication failed: credentials rejected',
        }),
      );
      expect(monitor.getFailure('codex')).not.toBeNull();

      bus.emit(
        SERVER_EVENTS.ORCHESTRATION_EVENT,
        runtimeEvent('codex', {
          method: 'turn.completed',
          turnId: 'turn-1',
          finishReason,
        }),
      );

      expect(monitor.getFailure('codex')).toBeNull();
      monitor.dispose();
    },
  );

  test("station#3509 fix round FIX 3: a cancellation on one thread does not clear a DIFFERENT thread's recorded auth failure for the same provider", () => {
    const bus = new EventBus();
    const monitor = new RuntimeAuthHealthMonitor(bus);
    bus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, {
      event: {
        eventId: 'event-thread-a',
        provider: 'codex',
        threadId: 'thread-a',
        createdAt: new Date().toISOString(),
        method: 'runtime.error',
        severity: 'error',
        message: 'Authentication failed: credentials rejected',
      },
    });
    expect(monitor.getFailure('codex')).not.toBeNull();

    // Provider-scoped failure record, so a cancellation on a DIFFERENT
    // thread for the SAME provider must not clear it — the record says
    // nothing about which thread's turn is completing.
    bus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, {
      event: {
        eventId: 'event-thread-b',
        provider: 'codex',
        threadId: 'thread-b',
        createdAt: new Date().toISOString(),
        method: 'turn.completed',
        turnId: 'turn-on-thread-b',
        finishReason: 'cancelled',
      },
    });

    expect(monitor.getFailure('codex')).not.toBeNull();
    monitor.dispose();
  });

  // archive#3509 follow-up, archive#3587 rewrite: `finishReason: 'other'` is
  // NOT a failed completion — it means "unclassified" (archive#3545 fixed
  // the Bedrock producer that used to publish `'other'` for every ordinary
  // successful turn; this test's ORIGINAL name asserted that inverted
  // model). It pins a permanent property of this monitor: an unclassified
  // finish reason never has clear authority — see
  // `PROVIDER_PROVEN_FINISH_REASONS`.
  //
  // Before archive#3587, this test's only assertion (`getFailure` still
  // non-null) could not distinguish "well-formed, correctly withheld clear
  // authority" from "diagnosed as MALFORMED, never reached the clear
  // decision at all" — both produce an unchanged failure record, and the
  // monitor was doing the latter (`onServerEvent` threw
  // `RuntimeAuthHealthEventDiagnostic` before `clear()` was ever
  // considered). That is precisely the gap archive#3587 fixed: a
  // well-formed `'other'` tripped the malformed diagnostic. This version
  // proves BOTH halves — the diagnostic must NOT fire (spying on
  // `console.warn`, since `EventBus` catches a thrown diagnostic and warns
  // rather than propagating it — a silent throw would otherwise look
  // identical to a clean pass here) AND the failure must still not clear.
  // A guardrail whose rejection path never executes is unproven; this test
  // now proves the ACCEPTANCE path executes too.
  test("a well-formed finishReason: 'other' does not trip the malformed diagnostic, and still does not clear a recorded auth failure", () => {
    const bus = new EventBus();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const monitor = new RuntimeAuthHealthMonitor(bus);
    bus.emit(
      SERVER_EVENTS.ORCHESTRATION_EVENT,
      runtimeEvent('codex', {
        method: 'runtime.error',
        severity: 'error',
        message: 'Unauthorized',
      }),
    );
    bus.emit(
      SERVER_EVENTS.ORCHESTRATION_EVENT,
      runtimeEvent('codex', {
        method: 'turn.completed',
        turnId: 'turn-1',
        finishReason: 'other',
      }),
    );

    // Half 1: well-formed, not malformed. Pre-fix, this event alone made
    // EventBus's listener catch fire and console.warn once; this asserts it
    // did not.
    expect(warning).not.toHaveBeenCalled();
    // Half 2: still no clear authority. The auth failure recorded by the
    // first event must survive untouched.
    expect(monitor.getFailure('codex')).not.toBeNull();
    warning.mockRestore();
    monitor.dispose();
  });

  test('ignores malformed events and ACP runtime errors', () => {
    const bus = new EventBus();
    const monitor = new RuntimeAuthHealthMonitor(bus);
    bus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, { event: null });
    bus.emit(
      SERVER_EVENTS.ORCHESTRATION_EVENT,
      runtimeEvent('acp', {
        method: 'runtime.error',
        severity: 'error',
        message: 'Unauthorized',
      }),
    );
    expect(monitor.getFailure('acp')).toBeNull();
    monitor.dispose();
  });

  test('ignores unrelated canonical runtime methods without a health diagnostic', () => {
    const bus = new EventBus();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const monitor = new RuntimeAuthHealthMonitor(bus);
    bus.emit(
      SERVER_EVENTS.ORCHESTRATION_EVENT,
      runtimeEvent('codex', {
        method: 'runtime.warning',
        severity: 'warning',
        message: 'Authentication token will expire soon',
      }),
    );

    expect(monitor.getFailure('codex')).toBeNull();
    expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
    monitor.dispose();
  });

  test('uses capped exponential windows independently for each provider', () => {
    let wallClockMs = Date.parse('2026-07-13T12:00:00.000Z');
    let monotonicMs = 0;
    const bus = new EventBus();
    const monitor = new RuntimeAuthHealthMonitor(bus, {
      ttlMs: 100,
      maxTtlMs: 400,
      now: () => new Date(wallClockMs),
      monotonicNow: () => monotonicMs,
    });

    const fail = (provider: 'claude' | 'codex') => {
      bus.emit(
        SERVER_EVENTS.ORCHESTRATION_EVENT,
        runtimeEvent(provider, {
          method: 'runtime.error',
          severity: 'error',
          message: 'Authentication failed: credentials rejected',
        }),
      );
    };

    fail('codex');
    expect(monitor.getFailure('codex')?.expiresAt).toBe(
      '2026-07-13T12:00:00.100Z',
    );
    wallClockMs += 1;
    monotonicMs += 1;
    fail('codex');
    expect(monitor.getFailure('codex')?.expiresAt).toBe(
      '2026-07-13T12:00:00.201Z',
    );
    wallClockMs += 1;
    monotonicMs += 1;
    fail('codex');
    expect(monitor.getFailure('codex')?.expiresAt).toBe(
      '2026-07-13T12:00:00.402Z',
    );
    wallClockMs += 1;
    monotonicMs += 1;
    fail('codex');
    expect(monitor.getFailure('codex')?.expiresAt).toBe(
      '2026-07-13T12:00:00.403Z',
    );

    fail('claude');
    expect(monitor.getFailure('claude')?.expiresAt).toBe(
      '2026-07-13T12:00:00.103Z',
    );
    monitor.dispose();
  });

  test('resets the failure streak only after a successful terminal outcome', () => {
    let monotonicMs = 0;
    const bus = new EventBus();
    const monitor = new RuntimeAuthHealthMonitor(bus, {
      ttlMs: 100,
      maxTtlMs: 400,
      now: () => new Date('2026-07-13T12:00:00.000Z'),
      monotonicNow: () => monotonicMs,
    });
    const fail = () =>
      bus.emit(
        SERVER_EVENTS.ORCHESTRATION_EVENT,
        runtimeEvent('codex', {
          method: 'runtime.error',
          severity: 'error',
          message: 'Unauthorized',
        }),
      );

    fail();
    monotonicMs += 1;
    fail();
    expect(monitor.getFailure('codex')?.expiresAt).toBe(
      '2026-07-13T12:00:00.200Z',
    );

    bus.emit(
      SERVER_EVENTS.ORCHESTRATION_EVENT,
      runtimeEvent('codex', {
        method: 'turn.completed',
        turnId: 'turn-1',
        finishReason: 'stop',
      }),
    );
    monotonicMs += 1;
    fail();
    expect(monitor.getFailure('codex')?.expiresAt).toBe(
      '2026-07-13T12:00:00.100Z',
    );
    monitor.dispose();
  });

  test('uses monotonic expiry even when wall clock evidence moves backwards', () => {
    let wallClockMs = Date.parse('2026-07-13T12:00:00.000Z');
    let monotonicMs = 0;
    const bus = new EventBus();
    const monitor = new RuntimeAuthHealthMonitor(bus, {
      ttlMs: 100,
      maxTtlMs: 100,
      now: () => new Date(wallClockMs),
      monotonicNow: () => monotonicMs,
    });
    bus.emit(
      SERVER_EVENTS.ORCHESTRATION_EVENT,
      runtimeEvent('codex', {
        method: 'runtime.error',
        severity: 'error',
        message: 'Unauthorized',
      }),
    );

    wallClockMs -= 24 * 60 * 60 * 1000;
    monotonicMs = 99;
    expect(monitor.getFailure('codex')).not.toBeNull();
    monotonicMs = 100;
    expect(monitor.getFailure('codex')).toBeNull();
    monitor.dispose();
  });

  test('replaces an in-flight provider window without allowing the stale timer to expire it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T12:00:00.000Z'));
    const bus = new EventBus();
    const monitor = new RuntimeAuthHealthMonitor(bus, {
      ttlMs: 100,
      maxTtlMs: 400,
      now: () => new Date(Date.now()),
      monotonicNow: () => Date.now(),
    });
    const fail = () =>
      bus.emit(
        SERVER_EVENTS.ORCHESTRATION_EVENT,
        runtimeEvent('codex', {
          method: 'runtime.error',
          severity: 'error',
          message: 'Unauthorized',
        }),
      );

    fail();
    vi.advanceTimersByTime(50);
    fail();
    vi.advanceTimersByTime(50);
    expect(monitor.getFailure('codex')).not.toBeNull();
    vi.advanceTimersByTime(150);
    expect(monitor.getFailure('codex')).toBeNull();
    monitor.dispose();
  });

  test('counts a re-entrant same-provider failure without losing its streak', () => {
    let monotonicMs = 0;
    const bus = new EventBus();
    const monitor = new RuntimeAuthHealthMonitor(bus, {
      ttlMs: 100,
      maxTtlMs: 400,
      now: () => new Date('2026-07-13T12:00:00.000Z'),
      monotonicNow: () => monotonicMs,
    });
    let nested = false;
    bus.subscribe((event) => {
      if (
        nested ||
        event.event !== SERVER_EVENTS.RUNTIME_HEALTH_CHANGED ||
        event.data?.status !== 'authentication_failed'
      ) {
        return;
      }
      nested = true;
      monotonicMs += 1;
      bus.emit(
        SERVER_EVENTS.ORCHESTRATION_EVENT,
        runtimeEvent('codex', {
          method: 'runtime.error',
          severity: 'error',
          message: 'Unauthorized',
        }),
      );
    });

    bus.emit(
      SERVER_EVENTS.ORCHESTRATION_EVENT,
      runtimeEvent('codex', {
        method: 'runtime.error',
        severity: 'error',
        message: 'Unauthorized',
      }),
    );

    expect(monitor.getFailure('codex')?.expiresAt).toBe(
      '2026-07-13T12:00:00.200Z',
    );
    monitor.dispose();
  });

  test('never records interrupted runtime outcomes as authentication failures', () => {
    const bus = new EventBus();
    const monitor = new RuntimeAuthHealthMonitor(bus);
    bus.emit(
      SERVER_EVENTS.ORCHESTRATION_EVENT,
      runtimeEvent('codex', {
        method: 'runtime.error',
        severity: 'error',
        code: 'request_aborted',
        message: 'Authentication request was interrupted',
      }),
    );
    expect(monitor.getFailure('codex')).toBeNull();
    monitor.dispose();
  });

  test('rejects invalid timing configuration and a regressing monotonic clock', () => {
    const bus = new EventBus();
    expect(() => new RuntimeAuthHealthMonitor(bus, { ttlMs: 0 })).toThrow(
      'Runtime authentication health timing configuration is invalid.',
    );
    expect(
      () => new RuntimeAuthHealthMonitor(bus, { ttlMs: 100, maxTtlMs: 99 }),
    ).toThrow('Runtime authentication health timing configuration is invalid.');
    expect(
      () => new RuntimeAuthHealthMonitor(bus, { maxProviders: 0 }),
    ).toThrow('Runtime authentication health timing configuration is invalid.');

    let monotonicMs = 10;
    const monitor = new RuntimeAuthHealthMonitor(bus, {
      ttlMs: 100,
      now: () => new Date('2026-07-13T12:00:00.000Z'),
      monotonicNow: () => monotonicMs,
    });
    bus.emit(
      SERVER_EVENTS.ORCHESTRATION_EVENT,
      runtimeEvent('codex', {
        method: 'runtime.error',
        severity: 'error',
        message: 'Unauthorized',
      }),
    );
    monotonicMs = 9;
    expect(() => monitor.getFailure('codex')).toThrow(
      'Runtime authentication health monotonic clock moved backwards.',
    );
    monitor.dispose();
  });

  test.each([
    ['com.example.plugin', '2026-07-13T12:00:00Z'],
    ['plugin_runtime', '2026-07-13T12:00:00.1Z'],
    ['9provider', '2026-07-13T12:00:00.123456789Z'],
  ])(
    'accepts open ProviderKind %s and canonical timestamp %s',
    (provider, createdAt) => {
      const bus = new EventBus();
      const monitor = new RuntimeAuthHealthMonitor(bus);
      bus.emit(
        SERVER_EVENTS.ORCHESTRATION_EVENT,
        runtimeEvent(provider, {
          eventId: `event-${provider}`,
          createdAt,
          method: 'runtime.error',
          severity: 'error',
          message: 'Unauthorized',
        }),
      );

      expect(monitor.getFailure(provider)).not.toBeNull();
      monitor.dispose();
    },
  );

  test('emits one generic diagnostic for a malformed relevant event without retaining its contents', () => {
    const bus = new EventBus();
    const changed = vi.fn();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bus.subscribe((event) => {
      if (event.event === SERVER_EVENTS.RUNTIME_HEALTH_CHANGED) changed(event);
    });
    const monitor = new RuntimeAuthHealthMonitor(bus);
    const validError = {
      eventId: 'event-1',
      provider: 'codex',
      threadId: 'thread-1',
      createdAt: '2026-07-13T12:00:00.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'Unauthorized',
    };

    bus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, {
      event: {
        ...validError,
        provider: 'plugin\nsecret-token-value',
      },
    });

    expect(monitor.getFailure('codex')).toBeNull();
    expect(changed).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      'Event listener threw; keeping the subscription:',
      SERVER_EVENTS.ORCHESTRATION_EVENT,
      expect.objectContaining({
        name: 'RuntimeAuthHealthEventDiagnostic',
        message: 'Runtime authentication health event is invalid.',
      }),
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain(
      'secret-token-value',
    );
    warning.mockRestore();
    monitor.dispose();
  });

  test.each([
    {
      eventId: '',
      provider: 'codex',
      threadId: 'thread-1',
      createdAt: '2026-07-13T12:00:00.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'Unauthorized',
    },
    {
      eventId: 'event-2',
      provider: 'codex',
      threadId: 'thread-1',
      createdAt: '2026-07-13',
      method: 'runtime.error',
      severity: 'error',
      message: 'Unauthorized',
    },
    {
      eventId: 'event-3',
      provider: 'codex',
      threadId: 'thread-1',
      createdAt: '07/13/2026 12:00:00',
      method: 'runtime.error',
      severity: 'error',
      message: 'Unauthorized',
    },
    {
      eventId: 'event-4',
      provider: 'codex',
      threadId: 'thread-1',
      createdAt: '2026-07-13T12:00:00+01:00',
      method: 'runtime.error',
      severity: 'error',
      message: 'Unauthorized',
    },
    {
      eventId: 'event-5',
      provider: ' codex ',
      threadId: 'thread-1',
      createdAt: '2026-07-13T12:00:00.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'Unauthorized',
    },
    {
      eventId: 'event-6',
      provider: 'codex',
      threadId: ' ',
      createdAt: '2026-07-13T12:00:00.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'Unauthorized',
    },
    {
      eventId: 'event-7',
      provider: 'codex',
      threadId: 'thread-1',
      createdAt: '2026-02-30T12:00:00.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'Unauthorized',
    },
    {
      eventId: 'event-8',
      provider: 'codex',
      threadId: 'thread-1',
      createdAt: '2026-07-13T12:00:00.000Z',
      method: 'runtime.error',
      severity: 'warning',
      message: 'Unauthorized',
    },
    {
      eventId: 'event-9',
      provider: 'codex',
      threadId: 'thread-1',
      createdAt: '2026-07-13T12:00:00.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'Unauthorized '.repeat(512),
    },
    {
      // archive#3509: `cancelled` is now an accepted finish reason (a
      // deliberate user action, not a malformation) — this case pins that a
      // MISSING finish reason is still diagnosed as malformed. Omission
      // (rather than the literal `'other'`) is deliberate (fix round FIX 4):
      // `finishReason` is optional and its absence is diagnosed malformed at
      // the same check, so this exercises a genuinely distinct branch from
      // the literal-`'other'` case covered elsewhere in this file — not
      // because a literal `'other'` would have been wrong here.
      // archive#3587 correction: a literal `'other'` fixture in this spot
      // would NO LONGER be malformed — `WELL_FORMED_FINISH_REASONS` now
      // includes it (see `runtime-auth-health-monitor.ts`). This is the one
      // remaining genuinely-malformed shape for a `turn.completed`: an
      // absent `finishReason`, not an unrecognized-but-present one.
      eventId: 'event-10',
      provider: 'codex',
      threadId: 'thread-1',
      createdAt: '2026-07-13T12:00:00.000Z',
      method: 'turn.completed',
      turnId: 'turn-1',
    },
  ])('diagnoses malformed relevant event without mutation: %o', (event) => {
    const bus = new EventBus();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const monitor = new RuntimeAuthHealthMonitor(bus);
    bus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, { event });

    expect(monitor.getFailure('codex')).toBeNull();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warning.mock.calls)).not.toContain(
      JSON.stringify(event),
    );
    warning.mockRestore();
    monitor.dispose();
  });

  test('does not let malformed terminal events clear a recorded failure', () => {
    const bus = new EventBus();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const monitor = new RuntimeAuthHealthMonitor(bus);
    bus.emit(
      SERVER_EVENTS.ORCHESTRATION_EVENT,
      runtimeEvent('codex', {
        method: 'runtime.error',
        severity: 'error',
        message: 'Unauthorized',
      }),
    );

    for (const event of [
      {
        eventId: 'event-2',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: '2026-07-13T12:00:00.000Z',
        method: 'turn.completed',
        finishReason: 'stop',
      },
      {
        // archive#3509: `cancelled` is now accepted, so this case uses a
        // MISSING finish reason to stay genuinely malformed — in-vocabulary
        // (the field is optional and its absence is diagnosed malformed too)
        // and a genuinely distinct branch from the literal `'other'` case
        // covered elsewhere in this file (fix round FIX 4). archive#3587
        // correction: a literal `'other'` here would NO LONGER be malformed
        // (`WELL_FORMED_FINISH_REASONS` now includes it) — the two fixtures
        // used to exercise different code paths to the same "still
        // malformed" outcome; now only the missing-field fixture is
        // malformed at all. `'other'`'s "does not clear" half is covered
        // separately, without a throw, by this file's dedicated archive#3587
        // test.
        eventId: 'event-3',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: '2026-07-13T12:00:00.000Z',
        method: 'turn.completed',
        turnId: 'turn-1',
      },
    ]) {
      bus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, { event });
    }

    expect(monitor.getFailure('codex')).not.toBeNull();
    // Both malformed events throw the identical diagnostic message, so
    // EventBus's per-listener same-message throttle (event-bus.ts) collapses
    // them into one warning rather than two.
    expect(warning).toHaveBeenCalledTimes(1);
    warning.mockRestore();
    monitor.dispose();
  });

  test('keeps provider streak state bounded without silently evicting it', () => {
    const bus = new EventBus();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const monitor = new RuntimeAuthHealthMonitor(bus, {
      maxProviders: 2,
    });
    const fail = (provider: string) =>
      bus.emit(
        SERVER_EVENTS.ORCHESTRATION_EVENT,
        runtimeEvent(provider, {
          method: 'runtime.error',
          severity: 'error',
          message: 'Unauthorized',
        }),
      );

    fail('codex');
    fail('claude');
    for (const provider of ['bedrock', 'ollama', 'muse', 'plugin-runtime']) {
      fail(provider);
    }
    expect(monitor.getFailure('codex')).not.toBeNull();
    expect(monitor.getFailure('claude')).not.toBeNull();
    expect(monitor.getFailure('bedrock')).toBeNull();
    expect(warning).toHaveBeenCalledWith(
      'Event listener threw; keeping the subscription:',
      SERVER_EVENTS.ORCHESTRATION_EVENT,
      expect.objectContaining({
        name: 'RuntimeAuthHealthCapacityError',
        message:
          'Runtime authentication health provider capacity is exhausted.',
      }),
    );

    bus.emit(
      SERVER_EVENTS.ORCHESTRATION_EVENT,
      runtimeEvent('codex', {
        method: 'turn.completed',
        turnId: 'turn-1',
        finishReason: 'stop',
      }),
    );
    fail('bedrock');
    expect(monitor.getFailure('bedrock')).not.toBeNull();
    warning.mockRestore();
    monitor.dispose();
  });

  test('deactivates its old listener and timer before a restarted monitor observes one transition', () => {
    vi.useFakeTimers();
    const bus = new EventBus();
    const transitions: unknown[] = [];
    bus.subscribe((event) => {
      if (event.event === SERVER_EVENTS.RUNTIME_HEALTH_CHANGED) {
        transitions.push(event.data);
      }
    });
    const oldMonitor = new RuntimeAuthHealthMonitor(bus, { ttlMs: 100 });
    bus.emit(
      SERVER_EVENTS.ORCHESTRATION_EVENT,
      runtimeEvent('codex', {
        method: 'runtime.error',
        severity: 'error',
        message: 'Unauthorized',
      }),
    );
    oldMonitor.dispose();

    bus.emit(
      SERVER_EVENTS.ORCHESTRATION_EVENT,
      runtimeEvent('codex', {
        method: 'runtime.error',
        severity: 'error',
        message: 'Unauthorized',
      }),
    );
    vi.advanceTimersByTime(100);
    expect(transitions).toEqual([
      { provider: 'codex', status: 'authentication_failed' },
    ]);

    const restartedMonitor = new RuntimeAuthHealthMonitor(bus, { ttlMs: 100 });
    bus.emit(
      SERVER_EVENTS.ORCHESTRATION_EVENT,
      runtimeEvent('codex', {
        method: 'runtime.error',
        severity: 'error',
        message: 'Unauthorized',
      }),
    );
    expect(transitions).toEqual([
      { provider: 'codex', status: 'authentication_failed' },
      { provider: 'codex', status: 'authentication_failed' },
    ]);
    restartedMonitor.dispose();
  });
});
