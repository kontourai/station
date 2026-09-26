/**
 * Client coordinator unit tests (kontourai/station#1418, #1419) against a
 * scripted fake transport. Every scenario proves the coordinator always
 * settles the truth for an admitted effect — `applied`, `aborted`, or a
 * no-effectId `cancelled` when the admission's own fate is unknown — never
 * silence, and never a guess.
 */

import type {
  PluginCommandEffectAdmissionRequest,
  PluginCommandEffectContent,
  PluginCommandEffectSettlementRequest,
  PluginCommandEffectSettlementResult,
} from '@kontourai/station-contracts/plugin-command-effect';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createPluginCommandEffectCoordinator,
  PLUGIN_COMMAND_EFFECT_ADMISSION_TIMEOUT_MS,
  PLUGIN_COMMAND_EFFECT_COORDINATOR_MAX_IN_FLIGHT,
  PLUGIN_COMMAND_EFFECT_RETAINED_SETTLEMENT_MAX,
  type PluginCommandEffectAdmitOutcome,
  type PluginCommandEffectRunInput,
  type PluginCommandEffectStorageLike,
  type PluginCommandEffectTransport,
  type PluginCommandEffectWindowLike,
} from '../plugin-command-effect-coordinator';

/**
 * Flushes pending microtasks WITHOUT advancing the fake timer clock — unlike
 * `vi.waitFor`, which is fake-timer-aware and may advance timers as part of
 * its poll loop. Used where a test needs the synchronous receipt-processing
 * step to finish (it resolves through a couple of promise ticks) before a
 * scheduled ack-flush timer would otherwise fire.
 */
async function flushMicrotasks(times = 5) {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeStorage(
  initial: Record<string, string> = {},
): PluginCommandEffectStorageLike {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

type Lifecycle = 'pagehide' | 'pageshow';
function fakeWindow(): PluginCommandEffectWindowLike & {
  fire(type: Lifecycle, event?: { persisted?: boolean }): void;
} {
  const listeners = new Map<Lifecycle, Set<(event: never) => void>>();
  return {
    addEventListener: (type, listener) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener as never);
      listeners.set(type, set);
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener as never);
    },
    fire: (type, event = {}) => {
      for (const listener of listeners.get(type) ?? []) {
        (listener as (event: { persisted?: boolean }) => void)(event);
      }
    },
  };
}

interface AdmitCall {
  apiBase: string;
  pluginId: string;
  request: PluginCommandEffectAdmissionRequest;
  resolve(outcome: PluginCommandEffectAdmitOutcome): void;
  reject(reason?: unknown): void;
}

interface SettleCall {
  apiBase: string;
  request: PluginCommandEffectSettlementRequest;
  options: { keepalive: boolean };
  resolve(results: readonly PluginCommandEffectSettlementResult[] | null): void;
}

function scriptedTransport() {
  const admitCalls: AdmitCall[] = [];
  const settleCalls: SettleCall[] = [];
  const transport: PluginCommandEffectTransport = {
    admit: (apiBase, pluginId, request) => {
      const call = deferred<PluginCommandEffectAdmitOutcome>();
      admitCalls.push({
        apiBase,
        pluginId,
        request,
        resolve: call.resolve,
        reject: call.reject,
      });
      return call.promise;
    },
    settle: (apiBase, request, options) => {
      const call = deferred<
        readonly PluginCommandEffectSettlementResult[] | null
      >();
      settleCalls.push({
        apiBase,
        request,
        options,
        resolve: call.resolve,
      });
      return call.promise;
    },
  };
  return { transport, admitCalls, settleCalls };
}

function baseInput(
  overrides: Partial<PluginCommandEffectRunInput> = {},
): PluginCommandEffectRunInput {
  return {
    apiBase: 'http://station.test',
    pluginId: 'demo',
    commandId: 'demo.command',
    installationGeneration: 'gen-1',
    target: { kind: 'destination', destinationId: 'plugins' },
    currentGeneration: () => 'gen-1',
    apply: () => true,
    ...overrides,
  };
}

function receiptFor(
  call: AdmitCall,
  overrides: Partial<PluginCommandEffectAdmissionRequest> = {},
  content: PluginCommandEffectContent = {
    kind: 'navigate',
    destinationId: 'plugins',
  },
) {
  return {
    effectId: `effect-${call.request.requestId}`,
    requestId: overrides.requestId ?? call.request.requestId,
    pluginId: 'demo',
    commandId: call.request.commandId,
    installationGeneration: call.request.installationGeneration,
    effect: content,
  };
}

describe('plugin command effect coordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('admission then a matching receipt applies and settles `applied`', async () => {
    const { transport, admitCalls, settleCalls } = scriptedTransport();
    const coordinator = createPluginCommandEffectCoordinator({
      transport,
      storage: fakeStorage(),
      windowLike: fakeWindow(),
    });
    const apply = vi.fn(() => true);
    coordinator.runCommand(baseInput({ apply }));
    await vi.waitFor(() => expect(admitCalls).toHaveLength(1));
    admitCalls[0].resolve({
      kind: 'admitted',
      receipt: receiptFor(admitCalls[0]),
    });
    await vi.waitFor(() => expect(settleCalls).toHaveLength(1));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(settleCalls[0].request.items).toEqual([
      {
        requestId: admitCalls[0].request.requestId,
        effectId: `effect-${admitCalls[0].request.requestId}`,
        outcome: 'applied',
      },
    ]);
    settleCalls[0].resolve([
      { requestId: admitCalls[0].request.requestId, status: 'settled' },
    ]);
    await vi.waitFor(() => expect(coordinator._debug.inFlightCount).toBe(0));
  });

  test('an invalidation seen before the receipt aborts without calling apply (order 1)', async () => {
    const { transport, admitCalls, settleCalls } = scriptedTransport();
    const coordinator = createPluginCommandEffectCoordinator({
      transport,
      storage: fakeStorage(),
      windowLike: fakeWindow(),
    });
    const apply = vi.fn(() => true);
    let generation = 'gen-1';
    coordinator.runCommand(
      baseInput({ apply, currentGeneration: () => generation }),
    );
    await vi.waitFor(() => expect(admitCalls).toHaveLength(1));
    // The SSE invalidation is observed BEFORE the admission's own receipt.
    generation = 'gen-2';
    admitCalls[0].resolve({
      kind: 'admitted',
      receipt: receiptFor(admitCalls[0]),
    });
    await vi.waitFor(() => expect(settleCalls).toHaveLength(1));
    expect(apply).not.toHaveBeenCalled();
    expect(settleCalls[0].request.items[0]).toMatchObject({
      outcome: 'aborted',
    });
  });

  test('a receipt that beats the invalidation still applies, and the later change is a no-op here (order 2)', async () => {
    const { transport, admitCalls, settleCalls } = scriptedTransport();
    const coordinator = createPluginCommandEffectCoordinator({
      transport,
      storage: fakeStorage(),
      windowLike: fakeWindow(),
    });
    const apply = vi.fn(() => true);
    const generation = 'gen-1';
    coordinator.runCommand(
      baseInput({ apply, currentGeneration: () => generation }),
    );
    await vi.waitFor(() => expect(admitCalls).toHaveLength(1));
    // Receipt arrives while the coordinator's own view of the generation is
    // still the one it requested; the invalidation has not been observed
    // yet from here (it is proven at the server by the withdrawal capture,
    // not by this client-side optimisation).
    admitCalls[0].resolve({
      kind: 'admitted',
      receipt: receiptFor(admitCalls[0]),
    });
    await vi.waitFor(() => expect(settleCalls).toHaveLength(1));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(settleCalls[0].request.items[0]).toMatchObject({
      outcome: 'applied',
    });
  });

  test('a dropped ack is retried and idempotent (already-settled counts as done)', async () => {
    const { transport, admitCalls, settleCalls } = scriptedTransport();
    const coordinator = createPluginCommandEffectCoordinator({
      transport,
      storage: fakeStorage(),
      windowLike: fakeWindow(),
    });
    coordinator.runCommand(baseInput());
    await vi.waitFor(() => expect(admitCalls).toHaveLength(1));
    admitCalls[0].resolve({
      kind: 'admitted',
      receipt: receiptFor(admitCalls[0]),
    });
    await vi.waitFor(() => expect(settleCalls).toHaveLength(1));
    // The ack is dropped (network error): the coordinator must retry it.
    settleCalls[0].resolve(null);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(settleCalls).toHaveLength(2));
    expect(settleCalls[1].request.items).toEqual(settleCalls[0].request.items);
    settleCalls[1].resolve([
      {
        requestId: settleCalls[1].request.items[0].requestId,
        status: 'already-settled',
      },
    ]);
    await vi.waitFor(() => expect(coordinator._debug.inFlightCount).toBe(0));
  });

  test('a settlement that keeps failing keeps retrying past the first backoff step (station#1418/#1419 review round 2, HIGH)', async () => {
    // `backoffFor(1) === BACKOFF_START_MS` (1000ms), so a coordinator that
    // reschedules its next flush at a FIXED 1000ms delay still coincidentally
    // catches the record's first retry. `backoffFor(2) === 2000ms` is where a
    // fixed reschedule diverges from the record's own growing backoff: it
    // fires too early, finds nothing ready (`pendingGroups` excludes a record
    // whose `nextAttemptAt` is still in the future), and nothing re-arms a
    // timer for it — the record silently stops retrying forever. This drives
    // three failed cycles and asserts every one is attempted.
    const { transport, admitCalls, settleCalls } = scriptedTransport();
    const coordinator = createPluginCommandEffectCoordinator({
      transport,
      storage: fakeStorage(),
      windowLike: fakeWindow(),
    });
    coordinator.runCommand(baseInput());
    await vi.waitFor(() => expect(admitCalls).toHaveLength(1));
    admitCalls[0].resolve({
      kind: 'admitted',
      receipt: receiptFor(admitCalls[0]),
    });
    await vi.waitFor(() => expect(settleCalls).toHaveLength(1));

    // Cycle 1 fails.
    settleCalls[0].resolve(null);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(settleCalls).toHaveLength(2));

    // Cycle 2 fails — this is the cycle a fixed-delay reschedule misses.
    settleCalls[1].resolve(null);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(settleCalls).toHaveLength(3));

    // Cycle 3 fails too; still retrying.
    settleCalls[2].resolve(null);
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.waitFor(() => expect(settleCalls).toHaveLength(4));

    settleCalls[3].resolve([
      { requestId: admitCalls[0].request.requestId, status: 'settled' },
    ]);
    await vi.waitFor(() => expect(coordinator._debug.inFlightCount).toBe(0));
  });

  test('a lost admission response (never resolves) times out into a no-effectId cancel', async () => {
    const { transport, admitCalls, settleCalls } = scriptedTransport();
    const coordinator = createPluginCommandEffectCoordinator({
      transport,
      storage: fakeStorage(),
      windowLike: fakeWindow(),
    });
    coordinator.runCommand(baseInput());
    await vi.waitFor(() => expect(admitCalls).toHaveLength(1));
    // The admission promise never settles at all.
    await vi.advanceTimersByTimeAsync(
      PLUGIN_COMMAND_EFFECT_ADMISSION_TIMEOUT_MS + 1,
    );
    await vi.waitFor(() => expect(settleCalls).toHaveLength(1));
    expect(settleCalls[0].request.items).toEqual([
      { requestId: admitCalls[0].request.requestId, outcome: 'cancelled' },
    ]);
  });

  test('a network error on admission also settles a no-effectId cancel', async () => {
    const { transport, admitCalls, settleCalls } = scriptedTransport();
    const coordinator = createPluginCommandEffectCoordinator({
      transport,
      storage: fakeStorage(),
      windowLike: fakeWindow(),
    });
    const notify = vi.fn();
    coordinator.runCommand(baseInput({ notify }));
    await vi.waitFor(() => expect(admitCalls).toHaveLength(1));
    admitCalls[0].reject(new Error('network down'));
    await vi.waitFor(() => expect(settleCalls).toHaveLength(1));
    expect(settleCalls[0].request.items).toEqual([
      { requestId: admitCalls[0].request.requestId, outcome: 'cancelled' },
    ]);
    expect(notify).toHaveBeenCalled();
  });

  test('a refusal never enters the outbox (nothing was ever admitted)', async () => {
    const { transport, admitCalls, settleCalls } = scriptedTransport();
    const coordinator = createPluginCommandEffectCoordinator({
      transport,
      storage: fakeStorage(),
      windowLike: fakeWindow(),
    });
    const notify = vi.fn();
    coordinator.runCommand(baseInput({ notify }));
    await vi.waitFor(() => expect(admitCalls).toHaveLength(1));
    admitCalls[0].resolve({ kind: 'refused', reason: 'capacity' });
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    expect(settleCalls).toHaveLength(0);
    expect(coordinator._debug.inFlightCount).toBe(0);
  });

  test('a draft-revision CAS failure (apply returns false) settles `aborted`', async () => {
    const { transport, admitCalls, settleCalls } = scriptedTransport();
    const coordinator = createPluginCommandEffectCoordinator({
      transport,
      storage: fakeStorage(),
      windowLike: fakeWindow(),
    });
    // Simulates the composer draft having changed between the request and
    // the receipt (edit, clear, chat removal and recreation): the caller's
    // own `apply` encapsulates that CAS and reports failure.
    coordinator.runCommand(baseInput({ apply: () => false }));
    await vi.waitFor(() => expect(admitCalls).toHaveLength(1));
    admitCalls[0].resolve({
      kind: 'admitted',
      receipt: receiptFor(
        admitCalls[0],
        {},
        {
          kind: 'seed-composer',
          sessionId: 'session-1',
          text: 'draft text',
        },
      ),
    });
    await vi.waitFor(() => expect(settleCalls).toHaveLength(1));
    expect(settleCalls[0].request.items[0]).toMatchObject({
      outcome: 'aborted',
    });
  });

  test('apply() throwing settles `aborted` instead of leaving the record in-flight forever', async () => {
    const { transport, admitCalls, settleCalls } = scriptedTransport();
    const coordinator = createPluginCommandEffectCoordinator({
      transport,
      storage: fakeStorage(),
      windowLike: fakeWindow(),
    });
    const notify = vi.fn();
    // A misbehaving apply implementation throws mid-effect. The residual is
    // documented on `PluginCommandEffectRunInput.apply`: this settles
    // `aborted` (never left forever in-flight, never an unhandled rejection).
    coordinator.runCommand(
      baseInput({
        notify,
        apply: () => {
          throw new Error('apply blew up mid-effect');
        },
      }),
    );
    await vi.waitFor(() => expect(admitCalls).toHaveLength(1));
    admitCalls[0].resolve({
      kind: 'admitted',
      receipt: receiptFor(admitCalls[0]),
    });
    await vi.waitFor(() => expect(settleCalls).toHaveLength(1));
    expect(settleCalls[0].request.items[0]).toMatchObject({
      outcome: 'aborted',
    });
    settleCalls[0].resolve([
      { requestId: admitCalls[0].request.requestId, status: 'settled' },
    ]);
    await vi.waitFor(() => expect(coordinator._debug.inFlightCount).toBe(0));
  });

  test('a mismatched receipt is aborted without calling apply, but still settled with its effectId', async () => {
    const { transport, admitCalls, settleCalls } = scriptedTransport();
    const coordinator = createPluginCommandEffectCoordinator({
      transport,
      storage: fakeStorage(),
      windowLike: fakeWindow(),
    });
    const apply = vi.fn(() => true);
    coordinator.runCommand(baseInput({ apply, commandId: 'demo.expected' }));
    await vi.waitFor(() => expect(admitCalls).toHaveLength(1));
    admitCalls[0].resolve({
      kind: 'admitted',
      // Answers a DIFFERENT commandId than the one requested.
      receipt: { ...receiptFor(admitCalls[0]), commandId: 'demo.other' },
    });
    await vi.waitFor(() => expect(settleCalls).toHaveLength(1));
    expect(apply).not.toHaveBeenCalled();
    expect(settleCalls[0].request.items[0]).toMatchObject({
      outcome: 'aborted',
      effectId: `effect-${admitCalls[0].request.requestId}`,
    });
  });

  test('a stale document: a reload keeps the documentId but mints a new documentKey', () => {
    const storage = fakeStorage();
    const first = createPluginCommandEffectCoordinator({
      transport: scriptedTransport().transport,
      storage,
      windowLike: fakeWindow(),
    });
    const documentIdBefore = first._debug.documentId;
    const documentKeyBefore = first._debug.documentKey;
    first.dispose();
    // A reload: a brand new module instance, same persisted storage.
    const second = createPluginCommandEffectCoordinator({
      transport: scriptedTransport().transport,
      storage,
      windowLike: fakeWindow(),
    });
    expect(second._debug.documentId).toBe(documentIdBefore);
    expect(second._debug.documentKey).not.toBe(documentKeyBefore);
    second.dispose();
  });

  test('a reload mints a distinct documentKey, so a settlement the old incarnation dispatches cannot be mistaken for the new one', async () => {
    const storage = fakeStorage();
    const { transport, admitCalls, settleCalls } = scriptedTransport();
    const first = createPluginCommandEffectCoordinator({
      transport,
      storage,
      windowLike: fakeWindow(),
    });
    first.runCommand(baseInput());
    await vi.waitFor(() => expect(admitCalls).toHaveLength(1));
    admitCalls[0].resolve({
      kind: 'admitted',
      receipt: receiptFor(admitCalls[0]),
    });
    // Drive an actual settlement dispatch through the transport seam before
    // tearing this incarnation down (its ack never got a response).
    await vi.waitFor(() => expect(settleCalls).toHaveLength(1));
    const oldSettlementKey = settleCalls[0].request.documentKey;
    first.dispose();

    // A reload: a brand new module instance, same persisted storage (same
    // documentId survives), a fresh in-memory documentKey (never persisted).
    const { transport: secondTransport, admitCalls: secondAdmitCalls } =
      scriptedTransport();
    const second = createPluginCommandEffectCoordinator({
      transport: secondTransport,
      storage,
      windowLike: fakeWindow(),
    });
    second.runCommand(baseInput());
    await vi.waitFor(() => expect(secondAdmitCalls).toHaveLength(1));
    // The document is the same one (persisted id), but this incarnation's own
    // dispatched admission proves it cannot forge — or be mistaken for — the
    // earlier incarnation's settlement key. This is the property that would
    // fail if the key were shared/reused across incarnations.
    expect(secondAdmitCalls[0].request.documentId).toBe(
      admitCalls[0].request.documentId,
    );
    expect(secondAdmitCalls[0].request.documentKey).not.toBe(oldSettlementKey);
    second.dispose();
  });

  test('pagehide flushes immediately with keepalive ONLY when told this document is same-origin-cookie-auth-eligible; a bfcache pageshow resumes a failed flush', async () => {
    const { transport, admitCalls, settleCalls } = scriptedTransport();
    const windowLike = fakeWindow();
    const coordinator = createPluginCommandEffectCoordinator({
      transport,
      storage: fakeStorage(),
      windowLike,
    });
    // Production wiring calls this from a live signal derived from
    // credentialState/isTauri/brokerRoute (#1418/#1419 review, MEDIUM). The
    // false-default case (native, browser-relay, or no signal yet) is its
    // own test below.
    coordinator.setCookieAuthEligible(true);
    coordinator.runCommand(baseInput());
    await vi.waitFor(() => expect(admitCalls).toHaveLength(1));
    admitCalls[0].resolve({
      kind: 'admitted',
      receipt: receiptFor(admitCalls[0]),
    });
    // Let the synchronous receipt-processing step complete (microtasks only
    // — the fake timer clock stays at 0, so the scheduled ack-flush timer it
    // arms has NOT fired yet) before pagehide interrupts it.
    await flushMicrotasks();
    expect(settleCalls).toHaveLength(0);
    windowLike.fire('pagehide');
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0].options.keepalive).toBe(true);
    // The keepalive request never got a response (page was suspended).
    settleCalls[0].resolve(null);
    // bfcache restore: the SAME JS heap resumes with the same document key.
    windowLike.fire('pageshow', { persisted: true });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(settleCalls).toHaveLength(2));
    expect(settleCalls[1].options.keepalive).toBe(false);
    settleCalls[1].resolve([
      {
        requestId: settleCalls[1].request.items[0].requestId,
        status: 'settled',
      },
    ]);
    await vi.waitFor(() => expect(coordinator._debug.inFlightCount).toBe(0));
  });

  test('pagehide attempts the normal authenticated transport (no keepalive) by DEFAULT — before any cookie-auth-eligibility signal has ever arrived (#1418/#1419 review, MEDIUM)', async () => {
    const { transport, admitCalls, settleCalls } = scriptedTransport();
    const windowLike = fakeWindow();
    const coordinator = createPluginCommandEffectCoordinator({
      transport,
      storage: fakeStorage(),
      windowLike,
    });
    // `setCookieAuthEligible` is never called: this is native, a
    // browser-relay/broker connection, or simply too early for the live
    // signal to have arrived yet. `credentials: 'include'` cannot carry any
    // of those, so a bare `keepalive` fetch must never be used for them.
    coordinator.runCommand(baseInput());
    await vi.waitFor(() => expect(admitCalls).toHaveLength(1));
    admitCalls[0].resolve({
      kind: 'admitted',
      receipt: receiptFor(admitCalls[0]),
    });
    await flushMicrotasks();
    windowLike.fire('pagehide');
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0].options.keepalive).toBe(false);
  });

  test("a retained record keeps its OWN captured same-origin-cookie-auth eligibility across a switch, not the coordinator's CURRENT value (station#1418/#1419 review round 2, HIGH)", async () => {
    const { transport, admitCalls, settleCalls } = scriptedTransport();
    const windowLike = fakeWindow();
    const coordinator = createPluginCommandEffectCoordinator({
      transport,
      storage: fakeStorage(),
      windowLike,
    });
    const apply = vi.fn(() => true);
    // Admitted while this document's credential is NOT same-origin-cookie
    // eligible (native, browser-relay, or simply the default before any
    // signal has arrived).
    coordinator.runCommand(baseInput({ apply }));
    await vi.waitFor(() => expect(admitCalls).toHaveLength(1));
    admitCalls[0].resolve({
      kind: 'admitted',
      receipt: receiptFor(admitCalls[0]),
    });
    await flushMicrotasks();

    // Switch Stations. The reset's own flush attempt (keepalive always
    // false there) is left unresolved, so the record is retained without
    // its `attempts`/`nextAttemptAt` ever advancing.
    coordinator.resetForAuthorityChange();
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0].options.keepalive).toBe(false);
    expect(coordinator._debug.retainedSettlementCount).toBe(1);

    // The NEW Station's live signal says THIS document is now same-origin-
    // cookie-auth eligible. That describes the NEW identity — it must not
    // retroactively apply to a record retained from the OLD one.
    coordinator.setCookieAuthEligible(true);

    windowLike.fire('pagehide');
    expect(settleCalls).toHaveLength(2);
    // The retained record's OWN capture at admission time was `false`; the
    // coordinator's current (now `true`) flag must never override it.
    expect(settleCalls[1].options.keepalive).toBe(false);
  });

  test('a Station/authority switch drops in-flight state and mints a fresh identity', async () => {
    const { transport, admitCalls } = scriptedTransport();
    const storage = fakeStorage();
    const coordinator = createPluginCommandEffectCoordinator({
      transport,
      storage,
      windowLike: fakeWindow(),
    });
    const documentIdBefore = coordinator._debug.documentId;
    const documentKeyBefore = coordinator._debug.documentKey;
    const apply = vi.fn(() => true);
    coordinator.runCommand(baseInput({ apply }));
    await vi.waitFor(() => expect(admitCalls).toHaveLength(1));
    coordinator.resetForAuthorityChange();
    expect(coordinator._debug.inFlightCount).toBe(0);
    expect(coordinator._debug.documentKey).not.toBe(documentKeyBefore);
    // The new Station is a different ledger; a fresh documentId too.
    expect(coordinator._debug.documentId).not.toBe(documentIdBefore);
    // A receipt for the OLD identity's request arrives late: it must be
    // dropped, never applied under the new identity.
    admitCalls[0].resolve({
      kind: 'admitted',
      receipt: receiptFor(admitCalls[0]),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(apply).not.toHaveBeenCalled();
  });

  test('a DECIDED record survives an authority reset and keeps retrying under its own old identity until it settles', async () => {
    const { transport, admitCalls, settleCalls } = scriptedTransport();
    const storage = fakeStorage();
    const coordinator = createPluginCommandEffectCoordinator({
      transport,
      storage,
      windowLike: fakeWindow(),
    });
    const apply = vi.fn(() => true);
    coordinator.runCommand(baseInput({ apply }));
    await vi.waitFor(() => expect(admitCalls).toHaveLength(1));
    admitCalls[0].resolve({
      kind: 'admitted',
      receipt: receiptFor(admitCalls[0]),
    });
    // The receipt-processing step schedules an immediate (0ms) flush.
    await vi.advanceTimersByTimeAsync(0);
    expect(settleCalls).toHaveLength(1);
    const oldDocumentKey = settleCalls[0].request.documentKey;
    // The ack is dropped (network error): the coordinator must retry it.
    // Resolved (not left pending) before the reset below, so the reset's own
    // flush attempt cannot race a still-in-flight settle call for the same
    // record.
    settleCalls[0].resolve(null);
    await flushMicrotasks();
    expect(coordinator._debug.inFlightCount).toBe(1);

    // Station/authority switch while this decided record is mid-backoff.
    coordinator.resetForAuthorityChange();
    expect(coordinator._debug.documentKey).not.toBe(oldDocumentKey);
    // It does not count against the NEW identity's bounded admission
    // capacity…
    expect(coordinator._debug.inFlightCount).toBe(0);
    // …but it is not lost: retained, still carrying its OLD identity.
    expect(coordinator._debug.retainedSettlementCount).toBe(1);

    // Its already-scheduled retry fires and keeps using the OLD identity —
    // mismatched from the coordinator's now-live one, never the new one.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settleCalls).toHaveLength(2);
    expect(settleCalls[1].request.documentKey).toBe(oldDocumentKey);
    expect(settleCalls[1].request.documentKey).not.toBe(
      coordinator._debug.documentKey,
    );
    settleCalls[1].resolve([
      { requestId: admitCalls[0].request.requestId, status: 'settled' },
    ]);
    await flushMicrotasks();
    expect(coordinator._debug.retainedSettlementCount).toBe(0);
  });

  test('retainedSettlements is bounded by count: excess entries are dropped oldest-first with a console.warn naming the effect (station#1418/#1419 review round 2, HIGH)', async () => {
    // Without a bound, a settlement that can never authenticate again (its
    // Station is no longer active) would grow this map by one on every
    // subsequent switch and live for the tab's lifetime.
    const { transport, admitCalls } = scriptedTransport();
    const coordinator = createPluginCommandEffectCoordinator({
      transport,
      storage: fakeStorage(),
      windowLike: fakeWindow(),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // One more than the bound: each command is admitted, applied, and
    // survives its own Station switch, so every one ends up retained.
    for (
      let index = 0;
      index < PLUGIN_COMMAND_EFFECT_RETAINED_SETTLEMENT_MAX + 1;
      index += 1
    ) {
      coordinator.runCommand(baseInput());
      const call = admitCalls[admitCalls.length - 1];
      call.resolve({ kind: 'admitted', receipt: receiptFor(call) });
      await flushMicrotasks();
      coordinator.resetForAuthorityChange();
    }
    expect(coordinator._debug.retainedSettlementCount).toBe(
      PLUGIN_COMMAND_EFFECT_RETAINED_SETTLEMENT_MAX,
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('exceeded the retained-settlement count bound'),
    );
    warnSpy.mockRestore();
  });

  test('cancelRequest marks a request cancelled before its receipt arrives, settling `aborted`', async () => {
    const { transport, admitCalls, settleCalls } = scriptedTransport();
    const coordinator = createPluginCommandEffectCoordinator({
      transport,
      storage: fakeStorage(),
      windowLike: fakeWindow(),
    });
    const apply = vi.fn(() => true);
    coordinator.runCommand(baseInput({ apply }));
    await vi.waitFor(() => expect(admitCalls).toHaveLength(1));
    coordinator.cancelRequest(admitCalls[0].request.requestId);
    admitCalls[0].resolve({
      kind: 'admitted',
      receipt: receiptFor(admitCalls[0]),
    });
    await vi.waitFor(() => expect(settleCalls).toHaveLength(1));
    expect(apply).not.toHaveBeenCalled();
    expect(settleCalls[0].request.items[0]).toMatchObject({
      outcome: 'aborted',
    });
  });

  test('a full in-flight map refuses a new command locally without ever calling admit', () => {
    const { transport, admitCalls } = scriptedTransport();
    const coordinator = createPluginCommandEffectCoordinator({
      transport,
      storage: fakeStorage(),
      windowLike: fakeWindow(),
    });
    for (
      let index = 0;
      index < PLUGIN_COMMAND_EFFECT_COORDINATOR_MAX_IN_FLIGHT;
      index += 1
    ) {
      coordinator.runCommand(baseInput());
    }
    expect(admitCalls).toHaveLength(
      PLUGIN_COMMAND_EFFECT_COORDINATOR_MAX_IN_FLIGHT,
    );
    const notify = vi.fn();
    coordinator.runCommand(baseInput({ notify }));
    expect(admitCalls).toHaveLength(
      PLUGIN_COMMAND_EFFECT_COORDINATOR_MAX_IN_FLIGHT,
    );
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('progress'));
  });

  test('cancel-refused is retried, not dropped, and does not block other items settling', async () => {
    const { transport, admitCalls, settleCalls } = scriptedTransport();
    const coordinator = createPluginCommandEffectCoordinator({
      transport,
      storage: fakeStorage(),
      windowLike: fakeWindow(),
    });
    coordinator.runCommand(baseInput());
    await vi.waitFor(() => expect(admitCalls).toHaveLength(1));
    // The admission's own fate is unknown -> a no-effectId cancel is queued.
    admitCalls[0].reject(new Error('network down'));
    await vi.waitFor(() => expect(settleCalls).toHaveLength(1));
    settleCalls[0].resolve([
      { requestId: admitCalls[0].request.requestId, status: 'cancel-refused' },
    ]);
    expect(coordinator._debug.inFlightCount).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(settleCalls).toHaveLength(2));
    settleCalls[1].resolve([
      { requestId: admitCalls[0].request.requestId, status: 'cancel-recorded' },
    ]);
    await vi.waitFor(() => expect(coordinator._debug.inFlightCount).toBe(0));
  });

  test('a navigation-guard block (apply returns false for the guard reason) settles `aborted`', async () => {
    const { transport, admitCalls, settleCalls } = scriptedTransport();
    const coordinator = createPluginCommandEffectCoordinator({
      transport,
      storage: fakeStorage(),
      windowLike: fakeWindow(),
    });
    const notify = vi.fn();
    // Mirrors CommandPalette's navigate-intent `apply`: it checks
    // `navigationStore.wouldNavigationGuardBlock()` itself and reports
    // failure without calling `navigate()`.
    let guardActive = true;
    coordinator.runCommand(
      baseInput({
        notify,
        apply: () => {
          if (guardActive) {
            notify('Unsaved changes are blocking navigation.');
            return false;
          }
          return true;
        },
      }),
    );
    await vi.waitFor(() => expect(admitCalls).toHaveLength(1));
    admitCalls[0].resolve({
      kind: 'admitted',
      receipt: receiptFor(admitCalls[0]),
    });
    await vi.waitFor(() => expect(settleCalls).toHaveLength(1));
    expect(settleCalls[0].request.items[0]).toMatchObject({
      outcome: 'aborted',
    });
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Unsaved changes'),
    );
    guardActive = false;
  });
});
