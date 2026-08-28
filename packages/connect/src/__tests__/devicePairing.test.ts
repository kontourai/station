import {
  DEVICE_PAIRING_PROTOCOL_VERSION,
  type DevicePairingOffer,
  pairingScopePresetString,
} from '@kontourai/station-contracts';
import { describe, expect, test, vi } from 'vitest';
import {
  clearPendingExchange,
  decodeDevicePairingPayload,
  describePairingRequestFailure,
  encodeDevicePairingPayload,
  exchangeDevicePairing,
  loadPendingExchange,
  observePendingPairingApproval,
  type PendingPairingExchange,
  pairingClientInstanceIdForOrigin,
  requestCurrentStationAccess,
  requestDevicePairing,
  savePendingExchange,
} from '../core/devicePairing';

function offer(): DevicePairingOffer {
  return {
    protocolVersion: DEVICE_PAIRING_PROTOCOL_VERSION,
    environmentId: '11111111-1111-4111-8111-111111111111',
    offerId: 'offer-locator-not-a-bearer-token',
    challenge: 'one-time-challenge-not-a-reusable-credential',
    manualCode: 'PAIRME2345',
    endpoint: 'https://station.example.test',
    scope: pairingScopePresetString('standard'),
    expiresAt: Date.now() + 60_000,
  };
}

describe('device pairing QR payload', () => {
  test('round-trips only a short-lived offer without the manual fallback or a credential', () => {
    const source = offer();
    const payload = encodeDevicePairingPayload(source);

    expect(payload).toMatch(/^station-pairing:v1:/);
    expect(payload).not.toContain(source.manualCode);
    expect(decodeDevicePairingPayload(payload)).toEqual({
      protocolVersion: source.protocolVersion,
      environmentId: source.environmentId,
      offerId: source.offerId,
      challenge: source.challenge,
      endpoint: source.endpoint,
      scope: source.scope,
      expiresAt: source.expiresAt,
    });
  });

  test('rejects expired, altered, and insecure remote payloads', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const expired = offer();
    expired.expiresAt = now;
    expect(
      decodeDevicePairingPayload(encodeDevicePairingPayload(expired)),
    ).toBeNull();

    const insecure = offer();
    insecure.endpoint = 'http://192.168.1.20:3141';
    expect(
      decodeDevicePairingPayload(encodeDevicePairingPayload(insecure)),
    ).toBeNull();
    expect(
      decodeDevicePairingPayload('https://station.example.test'),
    ).toBeNull();
    expect(
      decodeDevicePairingPayload('station-pairing:v1:not-base64'),
    ).toBeNull();
  });

  test('rejects a malformed or unknown scope (station#1098)', () => {
    for (const scope of ['', 'not-a-real-scope', 'orchestration:read,extra']) {
      const malformed = offer();
      malformed.scope = scope;
      expect(
        decodeDevicePairingPayload(encodeDevicePairingPayload(malformed)),
      ).toBeNull();
    }
  });

  test('accepts the read-only preset scope, not just standard', () => {
    const readOnly = offer();
    readOnly.scope = 'orchestration:read';
    expect(
      decodeDevicePairingPayload(encodeDevicePairingPayload(readOnly)),
    ).toMatchObject({ scope: 'orchestration:read' });
  });

  test('keeps raw scanner decoding additive while a caller may request canonical fields', () => {
    const source = {
      ...offer(),
      metadata: { authorization: { credential: 'benign-unknown-to-scanner' } },
    };
    const encoded = btoa(JSON.stringify(source))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const payload = `station-pairing:v1:${encoded}`;
    expect(decodeDevicePairingPayload(payload)).toMatchObject({
      environmentId: source.environmentId,
    });
    expect(
      decodeDevicePairingPayload(payload, {
        requireCanonicalOfferFields: true,
      }),
    ).toBeNull();
  });
});

describe('pairing client-instance identity', () => {
  test('keeps one opaque id per Station endpoint origin without using the device name', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const first = pairingClientInstanceIdForOrigin(
      'https://station.example.test/api/pairing',
      storage,
    );
    const sameOrigin = pairingClientInstanceIdForOrigin(
      'https://station.example.test/another-path',
      storage,
    );
    const otherOrigin = pairingClientInstanceIdForOrigin(
      'https://other.example.test',
      storage,
    );

    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(sameOrigin).toBe(first);
    expect(otherOrigin).not.toBe(first);
    expect([...values.keys()]).not.toContain('deviceName');
  });

  test('passes an exchange abort signal through the browser transport', async () => {
    const controller = new AbortController();
    const fetchSpy = vi.fn(
      (_url: URL | string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('request aborted'));
          });
        }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const exchange = exchangeDevicePairing({
        endpoint: 'https://station.example.test',
        offerId: 'offer-id',
        proof: 'proof',
        requestId: 'request-id',
        signal: controller.signal,
      });
      controller.abort();

      await expect(exchange).rejects.toMatchObject({ transport: true });
      expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('sends one stored origin identity through request and exchange without using the display name', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const requestBodies: Record<string, unknown>[] = [];
    const fetchSpy = vi.fn(async (url: URL | string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requestBodies.push(body);
      expect(body.clientInstanceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      if (!String(url).endsWith('/pairing/exchange')) {
        return new Response(JSON.stringify({}), { status: 202 });
      }
      return new Response(
        JSON.stringify({
          environmentId: '11111111-1111-4111-8111-111111111111',
          device: {
            id: 'device-id',
            name: 'Unrelated display name',
            scope: pairingScopePresetString('standard'),
            kind: 'device',
            createdAt: 1,
            revokedAt: null,
          },
          credential: 'credential',
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('fetch', fetchSpy);
    try {
      await requestDevicePairing({
        endpoint: 'https://station.example.test',
        offerId: 'offer-id',
        proof: 'proof',
        deviceName: 'Visible device name',
      });
      await requestCurrentStationAccess({
        endpoint: 'https://station.example.test',
        deviceName: 'Visible device name',
      });
      await exchangeDevicePairing({
        endpoint: 'https://station.example.test',
        offerId: 'offer-id',
        proof: 'proof',
        requestId: 'request-id',
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect([...values.keys()]).toEqual([
      'station-pairing-client-instance:v1:https://station.example.test',
    ]);
    expect(
      new Set(requestBodies.map((body) => body.clientInstanceId)).size,
    ).toBe(1);
    expect(
      requestBodies.every((body) => body.clientInstanceId !== body.deviceName),
    ).toBe(true);
  });

  test('keeps request and exchange identity stable when browser storage is unavailable', () => {
    const unavailableStorage = {
      getItem: () => {
        throw new Error('storage unavailable');
      },
      setItem: () => {
        throw new Error('storage unavailable');
      },
    };
    const endpoint = 'https://restricted-storage.station.example.test';

    const requestIdentity = pairingClientInstanceIdForOrigin(
      endpoint,
      unavailableStorage,
    );
    const exchangeIdentity = pairingClientInstanceIdForOrigin(
      endpoint,
      unavailableStorage,
    );

    expect(exchangeIdentity).toBe(requestIdentity);
    expect(requestIdentity).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  test('guards a SecurityError thrown while resolving the localStorage property', () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'localStorage',
    );
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    const endpoint = 'https://opaque-origin.station.example.test';

    try {
      const requestIdentity = pairingClientInstanceIdForOrigin(endpoint);
      const exchangeIdentity = pairingClientInstanceIdForOrigin(endpoint);
      expect(exchangeIdentity).toBe(requestIdentity);
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, 'localStorage', descriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'localStorage');
      }
    }
  });
});

/**
 * station#1711 — the pending exchange, persisted so it survives an unmount
 * (closing the panel, navigating away, the app being backgrounded/killed).
 * These test the storage functions in isolation; `DevicePairingPanel.test.tsx`
 * proves the end-to-end unmount → external confirm → remount → exchange
 * flow the persistence exists for.
 */
describe('describePairingRequestFailure (station#3158)', () => {
  /**
   * Drives the failure through the real `requestDevicePairing`, so every case
   * below reads the error object `pairingFetch` actually constructs rather
   * than a hand-shaped stand-in for it.
   */
  async function refusal(respond: () => Promise<Response>): Promise<string> {
    vi.stubGlobal('fetch', vi.fn(respond));
    try {
      const error = await requestDevicePairing({
        endpoint: 'https://station.example.test',
        offerId: 'offer-id',
        proof: 'proof',
        deviceName: 'This device',
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Error);
      return describePairingRequestFailure(error);
    } finally {
      vi.unstubAllGlobals();
    }
  }

  const refusedWith = (status: number, code?: string) =>
    refusal(
      async () =>
        new Response(JSON.stringify(code ? { error: code } : {}), { status }),
    );

  test('tells an expired code apart from one another device already claimed', async () => {
    const expired = await refusedWith(410, 'offer_expired');
    const claimed = await refusedWith(409, 'offer_unavailable');

    expect(expired).toContain('expired');
    expect(expired).toContain('Create a new code');
    expect(claimed).toContain('already been claimed by another device');
    expect(claimed).not.toContain('expired');
    expect(expired).not.toBe(claimed);
  });

  test('names a refusal by a person, and does not blame the code for it', async () => {
    const denied = await refusedWith(403, 'request_denied');

    expect(denied).toContain('denied this request');
    expect(denied).not.toMatch(/expired|already been claimed/);
  });

  test('names a rate limit and a capacity limit as the different limits they are', async () => {
    const rateLimited = await refusedWith(429, 'rate_limited');
    const atCapacity = await refusedWith(429, 'offer_capacity_reached');

    expect(rateLimited).toContain('Wait a minute');
    expect(atCapacity).toContain('as many pairing codes open as it allows');
    expect(rateLimited).not.toBe(atCapacity);
  });

  test('names an unreachable host instead of calling the code invalid', async () => {
    const unreachable = await refusal(async () => {
      throw new TypeError('Failed to fetch');
    });

    expect(unreachable).toContain('Could not reach the Station');
    expect(unreachable).not.toMatch(/expired|already been claimed|invalid/);
  });

  test('carries an unrecognized code through instead of guessing a cause', async () => {
    const unknown = await refusedWith(400, 'some_future_code');

    expect(unknown).toContain('(some_future_code)');
    expect(unknown).not.toMatch(/expired|already been claimed/);
  });

  test('falls back without a parenthetical when the host names no cause', async () => {
    const silent = await refusedWith(400);

    expect(silent).toBe(
      'This Station refused the pairing request. Create a new code on the Station and try again.',
    );
  });

  test('never renders an unbounded string a remote host put in the error field', async () => {
    // A joiner is by definition talking to a Station it has not established
    // trust in yet, so only a code-shaped token reaches the screen.
    const injected = await refusal(
      async () =>
        new Response(JSON.stringify({ error: `<b>${'pad'.repeat(200)}</b>` }), {
          status: 400,
        }),
    );

    expect(injected).not.toContain('<b>');
    expect(injected).toBe(await refusedWith(400));
  });

  test('a code-shaped but over-long token is rejected on LENGTH', async () => {
    // The test above rejects on charset — its payload contains `<`, `>` and
    // `/`, so it never exercises the 64-char bound at all. Changing {0,63} to
    // + kept every test green (station#3158 review). This one is all lowercase
    // letters, so charset cannot save it and only the length bound can.
    const overlong = await refusal(
      async () =>
        new Response(JSON.stringify({ error: 'a'.repeat(200) }), {
          status: 400,
        }),
    );

    expect(overlong).not.toContain('aaaaaaaaaa');
    expect(overlong).toBe(await refusedWith(400));
  });

  test('a code exactly at the bound is still shown', async () => {
    // The negative control: the bound must reject what is too long without
    // also swallowing a legitimate long-ish code.
    const atBound = `a${'b'.repeat(63)}`;
    const shown = await refusal(
      async () =>
        new Response(JSON.stringify({ error: atBound }), { status: 400 }),
    );

    expect(shown).toContain(atBound);
  });
});

describe('pending pairing exchange persistence', () => {
  function fakeStorage() {
    const values = new Map<string, string>();
    return {
      values,
      storage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    };
  }

  function exchange(
    overrides: Partial<PendingPairingExchange> = {},
  ): PendingPairingExchange {
    return {
      endpoint: 'https://station.example.test',
      offerId: 'offer-1',
      proof: 'proof-1',
      requestId: 'request-1',
      expiresAt: Date.now() + 60_000,
      expectedEnvironmentId: '11111111-1111-4111-8111-111111111111',
      browserSession: false,
      requestKind: 'direct',
      targetConnectionId: 'saved-station-1',
      targetConnectionLabel: 'Office Station',
      ...overrides,
    };
  }

  // station#1876: the gate needs to tell "a human has not approved this yet"
  // apart from "the host is unreachable". Both directions matter — a waiting
  // state shown over a genuine outage is the same lie as the one being fixed.
  describe('observePendingPairingApproval (station#1876)', () => {
    const ENDPOINT = 'https://station.example.test/some/path';

    test('reports a live request, with determinate progress from requestedAt', () => {
      const { storage } = fakeStorage();
      const now = 1_000_000;
      savePendingExchange(
        exchange({ requestedAt: now - 60_000, expiresAt: now + 240_000 }),
        storage,
      );

      const observed = observePendingPairingApproval(ENDPOINT, now, storage);
      expect(observed).not.toBeNull();
      expect(observed?.requestKind).toBe('direct');
      expect(observed?.remainingMs).toBe(240_000);
      // 60s elapsed of a 300s span.
      expect(observed?.elapsedFraction).toBeCloseTo(0.2, 5);
    });

    test('returns null when nothing is pending — a real outage stays an outage', () => {
      const { storage } = fakeStorage();
      expect(
        observePendingPairingApproval(ENDPOINT, Date.now(), storage),
      ).toBeNull();
    });

    test('returns null once the request has expired', () => {
      const { storage } = fakeStorage();
      const now = 1_000_000;
      savePendingExchange(exchange({ expiresAt: now - 1 }), storage);
      expect(observePendingPairingApproval(ENDPOINT, now, storage)).toBeNull();
    });

    test('does NOT delete the record it observes, unlike loadPendingExchange', () => {
      const { storage, values } = fakeStorage();
      const now = 1_000_000;
      // An expired record: `loadPendingExchange` deletes this on read. A render
      // path must never destroy the state it is describing.
      savePendingExchange(exchange({ expiresAt: now - 1 }), storage);
      const keysBefore = [...values.keys()];

      observePendingPairingApproval(ENDPOINT, now, storage);
      expect([...values.keys()]).toEqual(keysBefore);

      // The owning poll loop still reaps it, proving the two reads differ.
      loadPendingExchange(ENDPOINT, 'direct', storage);
      expect([...values.keys()]).toEqual([]);
    });

    test('omits elapsedFraction for a record written before requestedAt existed', () => {
      const { storage } = fakeStorage();
      const now = 1_000_000;
      const legacy = exchange({ expiresAt: now + 60_000 });
      delete (legacy as { requestedAt?: number }).requestedAt;
      savePendingExchange(legacy, storage);

      const observed = observePendingPairingApproval(ENDPOINT, now, storage);
      // Still reported as pending — an old record must not strand the user on
      // an error screen — but with no invented percentage.
      expect(observed?.remainingMs).toBe(60_000);
      expect(observed?.elapsedFraction).toBeUndefined();
    });

    test('reports the later-expiring request when both flows are live at one origin', () => {
      const { storage } = fakeStorage();
      const now = 1_000_000;
      savePendingExchange(
        exchange({ requestKind: 'direct', expiresAt: now + 30_000 }),
        storage,
      );
      savePendingExchange(
        exchange({ requestKind: 'code', expiresAt: now + 120_000 }),
        storage,
      );
      expect(
        observePendingPairingApproval(ENDPOINT, now, storage)?.requestKind,
      ).toBe('code');
    });
  });

  test('round-trips a saved exchange, keyed by endpoint origin and requestKind', () => {
    const { storage, values } = fakeStorage();
    const saved = exchange();
    savePendingExchange(saved, storage);

    expect([...values.keys()]).toEqual([
      'station-pairing-pending-exchange:v1:https://station.example.test:direct',
    ]);
    expect(
      loadPendingExchange(
        'https://station.example.test/some/path',
        'direct',
        storage,
      ),
    ).toEqual(saved);
    expect(
      loadPendingExchange('https://station.example.test', 'direct', storage),
    ).toMatchObject({
      targetConnectionId: 'saved-station-1',
      targetConnectionLabel: 'Office Station',
    });
    // A different origin never sees it.
    expect(
      loadPendingExchange('https://other.example.test', 'direct', storage),
    ).toBeNull();
  });

  test('treats an expired record as absent and deletes it on read', () => {
    const { storage, values } = fakeStorage();
    savePendingExchange(exchange({ expiresAt: Date.now() - 1 }), storage);

    expect(
      loadPendingExchange('https://station.example.test', 'direct', storage),
    ).toBeNull();
    // Deleted on read — not left behind for the next caller to trip over.
    expect(values.size).toBe(0);
  });

  test('treats a malformed or tampered record as absent and deletes it', () => {
    const { storage, values } = fakeStorage();
    storage.setItem(
      'station-pairing-pending-exchange:v1:https://station.example.test:direct',
      JSON.stringify({ endpoint: 'https://station.example.test' }), // missing required fields
    );

    expect(
      loadPendingExchange('https://station.example.test', 'direct', storage),
    ).toBeNull();
    expect(values.size).toBe(0);
  });

  test('clears the record for the given origin and kind only', () => {
    const { storage } = fakeStorage();
    savePendingExchange(exchange(), storage);
    savePendingExchange(
      exchange({ endpoint: 'https://other.example.test' }),
      storage,
    );

    clearPendingExchange('https://station.example.test', 'direct', storage);

    expect(
      loadPendingExchange('https://station.example.test', 'direct', storage),
    ).toBeNull();
    expect(
      loadPendingExchange('https://other.example.test', 'direct', storage),
    ).not.toBeNull();
  });

  test('never throws when storage is unavailable', () => {
    const throwingStorage = {
      getItem: () => {
        throw new Error('storage unavailable');
      },
      setItem: () => {
        throw new Error('storage unavailable');
      },
      removeItem: () => {
        throw new Error('storage unavailable');
      },
    };

    expect(() =>
      savePendingExchange(exchange(), throwingStorage),
    ).not.toThrow();
    expect(
      loadPendingExchange(
        'https://station.example.test',
        'direct',
        throwingStorage,
      ),
    ).toBeNull();
    expect(() =>
      clearPendingExchange(
        'https://station.example.test',
        'direct',
        throwingStorage,
      ),
    ).not.toThrow();
  });

  /**
   * station#1711 review (HIGH), second round — `requestKind` is now part of
   * the storage key itself (see `pendingExchangeStorageKey`), not a filter
   * applied after reading a shared origin-only slot. Requesting the 'code'
   * slot when only a 'direct' record exists reads back as absent because it
   * is a genuinely different key, not because of a value comparison after
   * the fact — and critically, it does not touch the 'direct' record, which
   * remains readable by its own kind.
   */
  test("a request for one kind never reads or deletes the other kind's record at the same origin", () => {
    const { storage } = fakeStorage();
    const direct = exchange({ requestKind: 'direct' });
    savePendingExchange(direct, storage);

    expect(
      loadPendingExchange('https://station.example.test', 'code', storage),
    ).toBeNull();
    expect(
      loadPendingExchange('https://station.example.test', 'direct', storage),
    ).toEqual(direct);
  });

  /**
   * station#1711 review (HIGH), second round — the defect this branch's
   * previous fix round left in place: `savePendingExchange` was still a
   * blind `setItem` keyed on origin alone, with no `requestKind` in the key.
   * A user starting "Request access" (direct), leaving the panel open
   * without cancelling (the deliberate #1711 survive-unmount behavior), then
   * trying "Scan QR" or "Enter manually" (code) at the same host destroyed
   * the still-open direct record — an approval granted while nobody was
   * watching became permanently uncollectible. Reachable through ordinary
   * navigation in `ConnectionManagerModalContent`; not a contrived scenario.
   */
  test('saving a code record after a direct record at the same origin does not destroy the direct record', () => {
    const { storage } = fakeStorage();
    const direct = exchange({ requestKind: 'direct', requestId: 'direct-1' });
    savePendingExchange(direct, storage);

    const code = exchange({
      requestKind: 'code',
      requestId: 'code-1',
      offerId: 'offer-2',
      proof: 'proof-2',
    });
    savePendingExchange(code, storage);

    expect(
      loadPendingExchange('https://station.example.test', 'direct', storage),
    ).toEqual(direct);
    expect(
      loadPendingExchange('https://station.example.test', 'code', storage),
    ).toEqual(code);
  });

  test('saving a direct record after a code record at the same origin does not destroy the code record', () => {
    const { storage } = fakeStorage();
    const code = exchange({ requestKind: 'code', requestId: 'code-1' });
    savePendingExchange(code, storage);

    const direct = exchange({
      requestKind: 'direct',
      requestId: 'direct-1',
      offerId: 'offer-2',
      proof: 'proof-2',
    });
    savePendingExchange(direct, storage);

    expect(
      loadPendingExchange('https://station.example.test', 'code', storage),
    ).toEqual(code);
    expect(
      loadPendingExchange('https://station.example.test', 'direct', storage),
    ).toEqual(direct);
  });

  test('clearing one kind does not clear the other kind at the same origin', () => {
    const { storage } = fakeStorage();
    const direct = exchange({ requestKind: 'direct' });
    const code = exchange({ requestKind: 'code' });
    savePendingExchange(direct, storage);
    savePendingExchange(code, storage);

    clearPendingExchange('https://station.example.test', 'direct', storage);

    expect(
      loadPendingExchange('https://station.example.test', 'direct', storage),
    ).toBeNull();
    expect(
      loadPendingExchange('https://station.example.test', 'code', storage),
    ).toEqual(code);
  });
});
