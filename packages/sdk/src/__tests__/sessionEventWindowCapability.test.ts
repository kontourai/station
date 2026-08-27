import {
  PUBLIC_HANDSHAKE_SCHEMA_VERSION,
  REMOTE_AUTH_PROTOCOL_VERSION,
  STATION_COMPAT_MIN_CLIENT_PROTOCOL,
  STATION_COMPAT_PROTOCOL_VERSION,
} from '@kontourai/station-contracts/environment-security';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  claimSessionEventWindowCapabilityRecovery,
  fetchSessionEventWindowCapability,
  invalidateSessionEventWindowCapabilityCache,
  resetSessionEventWindowCapabilityCache,
  resetSessionEventWindowCapabilityRecovery,
  SESSION_EVENT_WINDOW_CAPABILITY_RETRY_MS,
} from '../sessionEventWindowCapability.js';

const validHandshake = {
  schemaVersion: PUBLIC_HANDSHAKE_SCHEMA_VERSION,
  environmentId: 'environment-fixture',
  authentication: {
    scheme: 'bearer',
    protocolVersion: REMOTE_AUTH_PROTOCOL_VERSION,
  },
  transports: {
    http: REMOTE_AUTH_PROTOCOL_VERSION,
    sse: REMOTE_AUTH_PROTOCOL_VERSION,
    websocket: REMOTE_AUTH_PROTOCOL_VERSION,
  },
  compatibility: {
    serverVersion: '0.4.1',
    protocolVersion: STATION_COMPAT_PROTOCOL_VERSION,
    minClientProtocol: STATION_COMPAT_MIN_CLIENT_PROTOCOL,
  },
};

describe('fetchSessionEventWindowCapability', () => {
  afterEach(() => {
    resetSessionEventWindowCapabilityCache();
    vi.unstubAllGlobals();
  });

  test('reports a transport failure as undetermined and backs off repeated probes', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error('native Station request capacity reached'));
    vi.stubGlobal('fetch', fetchMock);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await expect(
        fetchSessionEventWindowCapability('http://station.test'),
      ).resolves.toBeUndefined();
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('retains a recovery budget across remount-shaped calls until capability recovery resets it', () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(
        claimSessionEventWindowCapabilityRecovery(
          'http://station.test',
          'task:1',
        ),
      ).toBe(true);
    }
    // A freshly mounted consumer asks through the same host/session key.
    expect(
      claimSessionEventWindowCapabilityRecovery(
        'http://station.test',
        'task:1',
      ),
    ).toBe(false);
    expect(
      claimSessionEventWindowCapabilityRecovery(
        'http://station.test',
        'task:2',
      ),
    ).toBe(true);

    resetSessionEventWindowCapabilityRecovery('http://station.test', 'task:1');
    expect(
      claimSessionEventWindowCapabilityRecovery(
        'http://station.test',
        'task:1',
      ),
    ).toBe(true);
  });

  test('reports a non-success handshake as undetermined', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('busy', { status: 503 })),
    );

    await expect(
      fetchSessionEventWindowCapability('http://station.test'),
    ).resolves.toBeUndefined();
  });

  test('reports a responding host without the capability as not-capable', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ ...validHandshake, capabilities: {} }),
            { status: 200 },
          ),
        ),
    );

    await expect(
      fetchSessionEventWindowCapability('http://station.test'),
    ).resolves.toBe(false);
  });

  /**
   * station#3437 review (HIGH-1): the cache entry a resolved probe writes
   * survives for `SESSION_EVENT_WINDOW_CAPABILITY_RETRY_MS` — a manual retry
   * that only resets the recovery budget (not this cache) issues ZERO new
   * requests for up to 30s, which is the defect. `invalidateSessionEventWindowCapabilityCache`
   * must make the very next call issue a real request regardless of that TTL.
   */
  test('invalidateSessionEventWindowCapabilityCache forces the next call to issue a new request instead of returning the cached settlement', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...validHandshake, capabilities: {} }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchSessionEventWindowCapability('http://station.test');
    await fetchSessionEventWindowCapability('http://station.test');
    // Cache hit: the second call above did not re-fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    invalidateSessionEventWindowCapabilityCache('http://station.test');
    await fetchSessionEventWindowCapability('http://station.test');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  /**
   * The invalidator is scoped to ONE host — it must not disturb a different
   * host's cached settlement, which the blunt `resetSessionEventWindowCapabilityCache()`
   * would (it clears every host's cache AND every host's recovery budget).
   */
  test('invalidateSessionEventWindowCapabilityCache leaves a different apiBase entry cached', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...validHandshake, capabilities: {} }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchSessionEventWindowCapability('http://station-a.test');
    await fetchSessionEventWindowCapability('http://station-b.test');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    invalidateSessionEventWindowCapabilityCache('http://station-a.test');
    await fetchSessionEventWindowCapability('http://station-a.test');
    await fetchSessionEventWindowCapability('http://station-b.test');

    // Only station-a's invalidated entry re-fetches; station-b's stays cached.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  /**
   * station#3437 review round 2 (LOW-1): an undetermined/not-capable
   * settlement arms a timer that deletes the map entry after
   * `SESSION_EVENT_WINDOW_CAPABILITY_RETRY_MS` — but `invalidate` only ever
   * deleted the entry, never that timer. A manual invalidate + re-probe
   * that lands `true` (cached for the process lifetime, no eviction timer
   * of its own) left the STALE timer from the original `undefined`
   * settlement armed; once it fired, it deleted the entry it knew nothing
   * about — the freshly-cached capable settlement — forcing an unwanted
   * third fetch.
   */
  test('invalidating after an undetermined settlement, then re-probing capable, is not later evicted by the original stale timer', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...validHandshake,
            capabilities: { sessionEventWindow: true },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    // t=0: probe resolves `undefined` and arms an eviction timer for t=30s.
    await expect(
      fetchSessionEventWindowCapability('http://station.test'),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // t=1s: a manual retry invalidates the entry and re-probes; this
    // settlement resolves `true` and schedules NO eviction timer of its own.
    await vi.advanceTimersByTimeAsync(1_000);
    invalidateSessionEventWindowCapabilityCache('http://station.test');
    await expect(
      fetchSessionEventWindowCapability('http://station.test'),
    ).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // t=30s (from the ORIGINAL undefined settlement): the stale timer must
    // not fire and evict the capable entry that has since replaced it.
    await vi.advanceTimersByTimeAsync(SESSION_EVENT_WINDOW_CAPABILITY_RETRY_MS);
    await expect(
      fetchSessionEventWindowCapability('http://station.test'),
    ).resolves.toBe(true);
    // Still 2: the capable settlement is still cached, no orphaned eviction.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  /**
   * station#3437 review round 3 (LOW-1 follow-up / LOW-A). The round-2 fix
   * above only covers a settlement that has ALREADY armed its eviction timer
   * by the time `invalidate` runs. `invalidate` landing WHILE the probe is
   * still in flight has nothing to cancel — no timer exists yet — so the
   * stale settlement arms one afterwards, against whatever key a replacement
   * probe has since occupied.
   */
  test('invalidating while the probe is still in flight does not let the stale settlement evict a fresh re-probe (LOW-A)', async () => {
    vi.useFakeTimers();
    let resolveFirst: ((response: Response) => void) | undefined;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...validHandshake,
            capabilities: { sessionEventWindow: true },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    // t=0: probe #1 starts and stays in flight — no response yet, so no
    // eviction timer exists for `invalidate` to find and cancel.
    const p1 = fetchSessionEventWindowCapability('http://station.test');

    // The manual invalidate lands WHILE probe #1 is still pending.
    invalidateSessionEventWindowCapabilityCache('http://station.test');

    // A fresh probe #2 starts under the now-empty cache and settles `true`.
    const p2 = fetchSessionEventWindowCapability('http://station.test');
    await expect(p2).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // NOW the original in-flight probe #1 settles, undetermined.
    resolveFirst?.(new Response('busy', { status: 503 }));
    await expect(p1).resolves.toBeUndefined();

    const callsBeforeTTL = fetchMock.mock.calls.length;
    expect(callsBeforeTTL).toBe(2);

    // Probe #1's stale settlement must not arm an eviction timer against the
    // entry probe #2 now occupies.
    await vi.advanceTimersByTimeAsync(SESSION_EVENT_WINDOW_CAPABILITY_RETRY_MS);
    await expect(
      fetchSessionEventWindowCapability('http://station.test'),
    ).resolves.toBe(true);
    const callsAfterTTL = fetchMock.mock.calls.length;
    expect(callsAfterTTL).toBe(2);

    vi.useRealTimers();
  });

  /**
   * station#3437 review round 3 (LOW-C). The invalidator must cancel only
   * the NAMED host's eviction timer. Both existing "leaves a different
   * apiBase entry cached" tests are single-host at the moment invalidate
   * runs — neither has a second host's timer armed to prove the cancel is
   * scoped rather than blunt.
   */
  test("invalidating one host does not cancel a different host's pending eviction timer (LOW-C)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('busy', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    // Both hosts settle undetermined and each arms its own eviction timer.
    await expect(
      fetchSessionEventWindowCapability('http://station-a.test'),
    ).resolves.toBeUndefined();
    await expect(
      fetchSessionEventWindowCapability('http://station-b.test'),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Invalidate + re-probe station-a only.
    invalidateSessionEventWindowCapabilityCache('http://station-a.test');
    await expect(
      fetchSessionEventWindowCapability('http://station-a.test'),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Advance past station-b's OWN eviction timer's TTL. If invalidating
    // station-a incorrectly cancelled every host's timer instead of only
    // station-a's, station-b's stale entry survives forever and this
    // re-probe returns the cache instead of issuing a new request.
    await vi.advanceTimersByTimeAsync(SESSION_EVENT_WINDOW_CAPABILITY_RETRY_MS);
    const callsBeforeReprobe = fetchMock.mock.calls.length;
    await expect(
      fetchSessionEventWindowCapability('http://station-b.test'),
    ).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.length).toBe(callsBeforeReprobe + 1);

    vi.useRealTimers();
  });

  /**
   * Mirrors the invalidate case above for the blunt reset: it must also
   * cancel every pending eviction timer, not just clear the maps, or a
   * timer scheduled before the reset can still fire afterward and delete
   * whatever a later probe wrote under the same key.
   */
  test('resetSessionEventWindowCapabilityCache cancels pending eviction timers too', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...validHandshake,
            capabilities: { sessionEventWindow: true },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchSessionEventWindowCapability('http://station.test'),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resetSessionEventWindowCapabilityCache();
    await expect(
      fetchSessionEventWindowCapability('http://station.test'),
    ).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(SESSION_EVENT_WINDOW_CAPABILITY_RETRY_MS);
    await expect(
      fetchSessionEventWindowCapability('http://station.test'),
    ).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  test.each([
    null,
    {},
    { error: 'capacity reached' },
    {
      ...validHandshake,
      compatibility: {
        serverVersion: '',
        protocolVersion: 1.5,
        minClientProtocol: 1,
      },
      capabilities: {},
    },
  ])(
    'reports a malformed successful response (%j) as undetermined',
    async (body) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify(body), { status: 200 }),
          ),
      );

      await expect(
        fetchSessionEventWindowCapability('http://station.test'),
      ).resolves.toBeUndefined();
    },
  );
});
