import { beforeEach, describe, expect, test, vi } from 'vitest';

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: bridge.invoke }));

import { isTransportFailure } from '@kontourai/station-connect/device-pairing';
import { nativePairingExchangeTransport } from '../pairingTransport';

const input = {
  endpoint: 'https://station.example.test',
  offerId: 'offer',
  proof: 'proof',
  requestId: 'request',
  clientInstanceId: '11111111-1111-4111-8111-111111111111',
  operationId: '22222222-2222-4222-8222-222222222222',
};

describe('native pairing transport', () => {
  beforeEach(() => bridge.invoke.mockReset());

  test('returns only the sanitized handle and host-allocated reference', async () => {
    bridge.invoke.mockResolvedValue({
      ok: true,
      environmentId: 'environment-1',
      device: {
        id: 'device-1',
        name: 'Desktop',
        scope: 'station:interactive',
        kind: 'device',
        createdAt: 1,
        lastUsedAt: null,
        revokedAt: null,
      },
      credentialHandle: 'opaque-handle',
      credentialRef: { kind: 'station-bearer', id: 'pairing:host-ref' },
    });

    const result = await nativePairingExchangeTransport(input);

    expect(result).toMatchObject({
      credentialHandle: 'opaque-handle',
      credentialRef: { kind: 'station-bearer', id: 'pairing:host-ref' },
    });
    expect(result).not.toHaveProperty('credential');
    expect(JSON.stringify(result)).not.toContain('native-bearer-secret-canary');
  });

  test.each([
    [403, 'origin_forbidden'],
    [409, 'request_not_confirmed'],
    [410, 'offer_expired'],
    [429, 'rate_limited'],
  ])('preserves HTTP %i and error code', async (status, error) => {
    bridge.invoke.mockResolvedValue({ ok: false, status, error });

    await expect(nativePairingExchangeTransport(input)).rejects.toMatchObject({
      status,
      code: error,
    });
  });

  /**
   * archive#1818 — the parity gap the owner's follow-up flagged: a
   * rejected `invoke('station_native_pairing_exchange')` (Rust's
   * `NativeCommandError`, thrown before any `{ ok:false }` server envelope
   * exists) used to reach here as an unconverted `String(error)` /
   * un-coded rejection with no `code`. This proves the code now survives.
   */
  test('preserves the NativeCommandError code from a rejected invoke', async () => {
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command === 'station_native_pairing_exchange') {
        throw {
          code: 'invalid_endpoint',
          message: 'invalid native pairing endpoint',
        };
      }
    });

    await expect(nativePairingExchangeTransport(input)).rejects.toMatchObject({
      code: 'invalid_endpoint',
    });
  });

  /**
   * archive#1818 — the actual behavioral parity fix: the HTTP pairing
   * path's `pairingFetch` marks a request that never reached the Station
   * with `transport: true`, and `JoinDevicePairingPanel` uses
   * `isTransportFailure` to retry-with-backoff instead of failing fatally.
   * `station_native_pairing_exchange_blocking`'s own network failure now
   * reuses the SAME `network_unreachable` code
   * (`src-desktop/src/lib.rs`), and this is the TypeScript half: the
   * native transport must mark it the same way, or the exact same failure
   * gets a WORSE outcome (fatal "Pairing failed") on desktop than in a
   * browser.
   */
  test('marks a network_unreachable rejection as a transport failure, matching the HTTP path', async () => {
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command === 'station_native_pairing_exchange') {
        throw { code: 'network_unreachable', message: 'transport' };
      }
    });

    let caught: unknown;
    await nativePairingExchangeTransport(input).catch((error) => {
      caught = error;
    });

    expect(isTransportFailure(caught)).toBe(true);
  });

  /**
   * archive#1818: a legacy/uncoded rejection's raw
   * prose must NOT become `.code` — that would let a future `.code`
   * consumer accidentally match on a sentence, reopening the FFI-boundary
   * prose-matching this mechanism replaced. The message itself is still
   * preserved for logs/humans.
   */
  test('leaves .code unset (never the raw prose) for a legacy (uncoded) invoke rejection', async () => {
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command === 'station_native_pairing_exchange') {
        throw 'native pairing exchange capacity reached';
      }
    });

    let caught: unknown;
    await nativePairingExchangeTransport(input).catch((error) => {
      caught = error;
    });
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: unknown }).code).toBeUndefined();
    expect((caught as Error).message).toBe(
      'native pairing exchange capacity reached',
    );
  });

  test('passes a unique operation id and cancels that exact exchange on abort', async () => {
    let finishExchange: (() => void) | undefined;
    bridge.invoke.mockImplementation((command: string) => {
      if (command === 'station_native_pairing_exchange') {
        return new Promise<void>((resolve) => {
          finishExchange = resolve;
        });
      }
      return Promise.resolve();
    });
    const controller = new AbortController();

    const exchange = nativePairingExchangeTransport({
      ...input,
      signal: controller.signal,
    });
    controller.abort();

    await expect(exchange).rejects.toMatchObject({ code: 'cancelled' });
    expect(bridge.invoke).toHaveBeenCalledWith(
      'station_native_pairing_exchange',
      expect.objectContaining({
        request: expect.objectContaining({ operationId: input.operationId }),
      }),
    );
    expect(bridge.invoke).toHaveBeenCalledWith(
      'station_native_pairing_exchange_cancel',
      { operationId: input.operationId },
    );
    finishExchange?.();
  });
});
