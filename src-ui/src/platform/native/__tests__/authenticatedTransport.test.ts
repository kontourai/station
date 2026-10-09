import {
  exchangeDevicePairing,
  setNativePairingExchangeTransport,
} from '@kontourai/station-connect/device-pairing';
import { pairingScopePresetString } from '@kontourai/station-contracts';
import {
  authenticatedFetch,
  ChatHttpError,
  sendExecutionMessage,
  setClientCredentialResolver,
} from '@kontourai/station-sdk/client';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { completeVerifiedPairing } from '../../../../../packages/connect/src/react/pairingCompletion.js';
import { nativePairingExchangeTransport } from '../pairingTransport';

type BrokerMessage =
  | {
      type: 'response';
      status: number;
      headers: Record<string, string>;
      bodyLength?: number | null;
    }
  | { type: 'chunk'; bytes: number[] }
  | { type: 'end' }
  | { type: 'error'; code: string; detail?: string };

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(),
  channels: [] as Array<(message: BrokerMessage) => void>,
}));

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    constructor(callback: (message: BrokerMessage) => void) {
      bridge.channels.push(callback);
    }
  },
  invoke: bridge.invoke,
}));

import { nativeAuthenticatedTransport } from '../authenticatedTransport';

function emit(message: BrokerMessage): void {
  const callback = bridge.channels.at(-1);
  if (!callback) throw new Error('native broker channel was not registered');
  callback(message);
}

test('blocks credential requests after the development HTTP exception is removed', async () => {
  vi.stubGlobal('localStorage', { getItem: () => null });
  try {
    await expect(
      nativeAuthenticatedTransport('http://100.77.142.114:3492/api/agents'),
    ).rejects.toThrow('HTTP permission was removed');
  } finally {
    vi.unstubAllGlobals();
  }
});

describe('native authenticated transport', () => {
  test('retries a pre-HTTP DNS miss with fresh native request identity and rechecks authority', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command !== 'station_native_http_request') return;
      attempts += 1;
      queueMicrotask(() => {
        if (attempts === 1)
          emit({
            type: 'error',
            code: 'transport_dns',
            detail: 'DNS unavailable',
          });
        else {
          emit({ type: 'response', status: 204, headers: {}, bodyLength: 0 });
          emit({ type: 'end' });
        }
      });
    });
    const guard = vi.fn();
    const init = {
      method: 'POST',
      body: '{"decision":"acceptForSession"}',
      authorityGuard: guard,
    };
    const pending = nativeAuthenticatedTransport(
      'https://station.example.test/api/orchestration/commands',
      init,
    );
    await vi.advanceTimersByTimeAsync(750);
    expect((await pending).status).toBe(204);
    const calls = bridge.invoke.mock.calls.filter(
      ([command]) => command === 'station_native_http_request',
    );
    expect(calls).toHaveLength(2);
    expect(calls[0][1].request.requestId).not.toBe(
      calls[1][1].request.requestId,
    );
    expect(calls[0][1].request.body).toEqual(calls[1][1].request.body);
    expect(guard.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  test('does not replay an approval after an HTTP 503 or an uncertain transport timeout', async () => {
    for (const outcome of ['response', 'timeout'] as const) {
      bridge.invoke.mockReset();
      bridge.invoke.mockImplementation(async (command: string) => {
        if (command !== 'station_native_http_request') return;
        queueMicrotask(() => {
          if (outcome === 'response') {
            emit({ type: 'response', status: 503, headers: {}, bodyLength: 0 });
            emit({ type: 'end' });
          } else
            emit({
              type: 'error',
              code: 'transport_timeout',
              detail: 'Timed out',
            });
        });
      });
      const pending = nativeAuthenticatedTransport(
        'https://station.example.test/api/orchestration/commands',
        { method: 'POST', body: '{}' },
      );
      if (outcome === 'response') expect((await pending).status).toBe(503);
      else
        await expect(pending).rejects.toMatchObject({
          code: 'transport_timeout',
        });
      expect(
        bridge.invoke.mock.calls.filter(
          ([command]) => command === 'station_native_http_request',
        ),
      ).toHaveLength(1);
    }
  });

  test('stops pre-HTTP DNS retries at three attempts', async () => {
    vi.useFakeTimers();
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command === 'station_native_http_request')
        queueMicrotask(() => emit({ type: 'error', code: 'transport_dns' }));
    });
    const outcome = nativeAuthenticatedTransport(
      'https://station.example.test/api/orchestration/commands',
      { method: 'POST', body: '{}' },
    );
    const refused = expect(outcome).rejects.toMatchObject({
      code: 'transport_dns',
    });
    await vi.advanceTimersByTimeAsync(1000);
    await refused;
    expect(
      bridge.invoke.mock.calls.filter(
        ([command]) => command === 'station_native_http_request',
      ),
    ).toHaveLength(3);
  });

  beforeEach(() => {
    bridge.invoke.mockReset();
    bridge.channels.length = 0;
  });

  afterEach(() => {
    setNativePairingExchangeTransport();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test.each([204, 205, 304])(
    'completes an empty HTTP %s response without constructing a forbidden body',
    async (status) => {
      bridge.invoke.mockResolvedValue(undefined);
      const pending = nativeAuthenticatedTransport(
        'https://station.example.test/api/empty',
      );
      await vi.waitFor(() => expect(bridge.invoke).toHaveBeenCalled());
      expect(() =>
        emit({ type: 'response', status, headers: {}, bodyLength: 0 }),
      ).not.toThrow();
      emit({ type: 'end' });
      const response = await pending;
      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
      await expect(response.text()).resolves.toBe('');
    },
  );

  test('streams status, safe headers, and chunks without a renderer bearer', async () => {
    const secretCanary = 'native-keyring-secret-canary';
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command === 'station_native_http_request') {
        queueMicrotask(() => {
          emit({
            type: 'response',
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
          emit({
            type: 'chunk',
            bytes: [...new TextEncoder().encode('{"error":"denied"}')],
          });
          emit({ type: 'end' });
        });
      }
    });

    const response = await nativeAuthenticatedTransport(
      'https://station.example.test/api/system/status',
      { headers: { Accept: 'application/json' } },
    );

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe('{"error":"denied"}');
    const requestCall = bridge.invoke.mock.calls.find(
      ([command]) => command === 'station_native_http_request',
    );
    expect(requestCall).toBeTruthy();
    expect(JSON.stringify(requestCall)).not.toContain(secretCanary);
    expect(JSON.stringify(requestCall)).not.toMatch(/authorization|cookie/i);
  });

  test('rechecks captured authority before native dispatch and after body serialization', async () => {
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command === 'station_native_http_request') {
        queueMicrotask(() => {
          emit({ type: 'response', status: 200, headers: {} });
          emit({ type: 'end' });
        });
      }
    });
    const authorityGuard = vi.fn();
    await nativeAuthenticatedTransport(
      'https://station.example.test/api/tasks',
      {
        method: 'POST',
        body: 'serialized body',
        authorityGuard,
      } as RequestInit,
    );
    expect(authorityGuard).toHaveBeenCalledTimes(2);
    expect(
      bridge.invoke.mock.calls.filter(
        ([command]) => command === 'station_native_http_request',
      ),
    ).toHaveLength(1);
  });

  test('forwards an opaque scoped binding and never falls back to active-profile selection', async () => {
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command === 'station_native_http_request') {
        queueMicrotask(() => {
          emit({ type: 'response', status: 200, headers: {} });
          emit({ type: 'end' });
        });
      }
    });
    await nativeAuthenticatedTransport(
      'https://station.example.test/api/tasks',
      {
        expectedBindingId: '11111111-1111-4111-8111-111111111111',
      } as RequestInit,
    );
    const request = bridge.invoke.mock.calls.find(
      ([command]) => command === 'station_native_http_request',
    )?.[1] as { request: { expectedBindingId?: string } };
    expect(request.request.expectedBindingId).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
  });

  // station#2327: the reserved liveness slot is opt-in per request, and an
  // ordinary request must never carry the flag by default.
  test('forwards the liveness-probe flag only when the caller set it', async () => {
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command === 'station_native_http_request') {
        queueMicrotask(() => {
          emit({ type: 'response', status: 200, headers: {} });
          emit({ type: 'end' });
        });
      }
    });
    await nativeAuthenticatedTransport(
      'https://station.example.test/api/system/identity',
      { livenessProbe: true } as RequestInit,
    );
    await nativeAuthenticatedTransport(
      'https://station.example.test/api/system/capabilities',
    );
    const requests = bridge.invoke.mock.calls
      .filter(([command]) => command === 'station_native_http_request')
      .map(
        ([, args]) => (args as { request: Record<string, unknown> }).request,
      );
    expect(requests[0]?.livenessProbe).toBe(true);
    expect(requests[1]).not.toHaveProperty('livenessProbe');
  });

  test('forwards the shared client-origin header through the native broker without a renderer credential', async () => {
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command === 'station_native_http_request') {
        queueMicrotask(() => {
          emit({ type: 'response', status: 200, headers: {} });
          emit({ type: 'end' });
        });
      }
    });

    await nativeAuthenticatedTransport(
      'https://station.example.test/api/system/capabilities',
      { headers: { 'X-Station-Client-Origin': '1;desktop;nightly' } },
    );

    const requestCall = bridge.invoke.mock.calls.find(
      ([command]) => command === 'station_native_http_request',
    );
    const request = requestCall?.[1] as {
      request: { headers: Record<string, string> };
    };
    expect(request.request.headers['x-station-client-origin']).toBe(
      '1;desktop;nightly',
    );
    expect(request.request.headers.authorization).toBeUndefined();
    expect(request.request.headers.cookie).toBeUndefined();
  });

  test('normalizes a truncated length-delimited body to the typed transport error', async () => {
    const partialJson = '{"success":true';
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command === 'station_native_http_request') {
        queueMicrotask(() => {
          emit({
            type: 'response',
            status: 200,
            headers: { 'content-type': 'application/json' },
            bodyLength: new TextEncoder().encode(partialJson).length + 1,
          });
          emit({
            type: 'chunk',
            bytes: [...new TextEncoder().encode(partialJson)],
          });
          emit({ type: 'end' });
        });
      }
    });

    const response = await nativeAuthenticatedTransport(
      'https://station.example.test/api/projects/example',
    );

    await expect(response.json()).rejects.toMatchObject({
      code: 'transport',
      message: 'Native Station request failed: incomplete response body',
    });
  });

  test('brokers a cross-origin mobile-host request without renderer credentials', async () => {
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command === 'station_native_http_request') {
        queueMicrotask(() => {
          emit({ type: 'response', status: 200, headers: {} });
          emit({ type: 'end' });
        });
      }
    });

    await nativeAuthenticatedTransport(
      'https://phone-target.tailnet.test/api/system/status',
      { method: 'GET' },
    );

    expect(bridge.invoke).toHaveBeenCalledWith(
      'station_native_http_request',
      expect.objectContaining({
        request: expect.objectContaining({
          url: 'https://phone-target.tailnet.test/api/system/status',
          method: 'GET',
        }),
      }),
    );
    expect(JSON.stringify(bridge.invoke.mock.calls)).not.toMatch(
      /authorization|bearer|credential/i,
    );
  });

  test('aborts a quiet stream after response headers and cancels native I/O', async () => {
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command === 'station_native_http_request') {
        queueMicrotask(() =>
          emit({ type: 'response', status: 200, headers: {} }),
        );
      }
    });
    const controller = new AbortController();
    const response = await nativeAuthenticatedTransport(
      'https://station.example.test/api/events',
      { signal: controller.signal },
    );
    const pendingRead = response.body?.getReader().read();

    controller.abort();

    await expect(pendingRead).rejects.toThrow(/cancelled/);
    expect(bridge.invoke).toHaveBeenCalledWith(
      'station_native_http_cancel',
      expect.objectContaining({ requestId: expect.any(String) }),
    );
  });

  /**
   * archive#1818 — the fault this proves against: a rejected
   * `invoke('station_native_http_request')` used to be collapsed with
   * `String(error)`, which stringifies the `NativeCommandError` object Rust
   * now rejects with (`{ code, message }`) to the useless
   * `"[object Object]"` and discards the `code`
   * `classifyNativeTransportRefusal` needs to tell "credential unreadable"
   * apart from "genuinely unreachable". This asserts the thrown `Error`
   * carries `.code` unchanged from the rejection.
   */
  const queueRefusal = {
    code: 'transport_capacity',
    message:
      '64/64 waiting; 8/8 ordinary requests active. This request has not been sent.',
    capacity: {
      pendingRequests: 64,
      pendingLimit: 64,
      activeRequests: 20,
      activeLimit: 32,
      originRequests: 8,
      originRequestLimit: 8,
      originStreams: 12,
      originStreamLimit: 12,
      retryAfterMs: 250,
      occupants: [
        {
          method: 'GET',
          routeCategory: 'config',
          ageMs: 30_000,
          phase: 'receiving-body',
          stream: false,
          sameOrigin: true,
        },
      ],
      queueHead: {
        method: 'GET',
        routeCategory: 'system',
        ageMs: 15_000,
        phase: 'waiting-for-admission',
        stream: false,
        sameOrigin: true,
      },
    },
  };

  function startCapacityRefusal() {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command === 'station_native_http_request') throw queueRefusal;
    });
  }

  test('backs off a pre-dispatch queue refusal and sends the preserved POST when space returns', async () => {
    startCapacityRefusal();
    const pending = nativeAuthenticatedTransport(
      'https://station.example.test/api/orchestration/chat',
      {
        method: 'POST',
        body: 'send once',
        expectedBindingId: 'captured-binding',
      } as RequestInit,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(bridge.invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(bridge.invoke).toHaveBeenCalledTimes(2);
    bridge.invoke.mockImplementation(async () => {
      emit({ type: 'response', status: 200, headers: {} });
      emit({ type: 'chunk', bytes: [...new TextEncoder().encode('accepted')] });
      emit({ type: 'end' });
    });
    await vi.advanceTimersByTimeAsync(500);
    const response = await pending;
    await expect(response.text()).resolves.toBe('accepted');
    expect(bridge.invoke).toHaveBeenCalledTimes(3);
    const attempts = bridge.invoke.mock.calls.map(([, args]) => args.request);
    expect(attempts[0]).toMatchObject({
      method: 'POST',
      body: [...new TextEncoder().encode('send once')],
      expectedBindingId: 'captured-binding',
    });
    expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[2]).toEqual(attempts[0]);
  });

  test('bounds automatic retries and preserves the latest capacity diagnosis', async () => {
    startCapacityRefusal();
    const pending = nativeAuthenticatedTransport(
      'https://station.example.test/api/tasks',
    );
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'transport_capacity',
      capacity: queueRefusal.capacity,
      message: expect.stringContaining('after 6 retries'),
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(bridge.invoke).toHaveBeenCalledTimes(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('cancels during back-off without dispatching again', async () => {
    startCapacityRefusal();
    const controller = new AbortController();
    const pending = nativeAuthenticatedTransport(
      'https://station.example.test/api/tasks',
      { signal: controller.signal },
    );
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'cancelled',
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await assertion;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(
      bridge.invoke.mock.calls.filter(
        ([command]) => command === 'station_native_http_request',
      ),
    ).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('rechecks authority after back-off before resending', async () => {
    startCapacityRefusal();
    const authorityGuard = vi.fn();
    const pending = nativeAuthenticatedTransport(
      'https://station.example.test/api/tasks',
      { authorityGuard } as RequestInit,
    );
    const assertion = expect(pending).rejects.toThrow(
      'Station selection changed',
    );
    await vi.advanceTimersByTimeAsync(0);
    authorityGuard.mockImplementation(() => {
      throw new Error('Station selection changed');
    });
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
    expect(bridge.invoke).toHaveBeenCalledTimes(1);
  });

  test.each([
    {
      refusal: { code: 'transport_capacity', message: 'stream allowance full' },
      init: undefined,
    },
    {
      refusal: {
        ...queueRefusal,
        capacity: { ...queueRefusal.capacity, pendingLimit: '64' },
      },
      init: undefined,
    },
    {
      refusal: {
        ...queueRefusal,
        capacity: { ...queueRefusal.capacity, pendingRequests: 0 },
      },
      init: undefined,
    },
    { refusal: queueRefusal, init: { livenessProbe: true } as RequestInit },
    {
      refusal: queueRefusal,
      init: { headers: { Accept: 'text/event-stream' } },
    },
  ])(
    'does not replay capacity refusals without a valid ordinary queue admission snapshot: %j',
    async ({ refusal, init }) => {
      startCapacityRefusal();
      bridge.invoke.mockRejectedValue(refusal);
      await expect(
        nativeAuthenticatedTransport(
          'https://station.example.test/api/system/identity',
          init,
        ),
      ).rejects.toMatchObject({ code: 'transport_capacity' });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(bridge.invoke).toHaveBeenCalledTimes(1);
    },
  );

  test('never retries a capacity error delivered on an admitted response channel', async () => {
    startCapacityRefusal();
    bridge.invoke.mockImplementation(async () =>
      emit({
        type: 'error',
        code: 'transport_capacity',
        detail: 'admitted channel failure',
      }),
    );
    await expect(
      nativeAuthenticatedTransport(
        'https://station.example.test/api/orchestration/chat',
        { method: 'POST', body: 'possible effect' },
      ),
    ).rejects.toMatchObject({ code: 'transport_capacity' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(bridge.invoke).toHaveBeenCalledTimes(1);
  });

  test('preserves a stale-ACL credential-store refusal from native transport', async () => {
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command === 'station_native_http_request') {
        // Exact code emitted before any server request when an ad-hoc bundle
        // replacement can no longer read the prior keychain ACL.
        throw {
          code: 'credential_store_unreadable',
          message: 'read OS credential store: errSecAuthFailed',
        };
      }
    });

    const pending = nativeAuthenticatedTransport(
      'https://station.example.test/api/system/status',
    );

    await expect(pending).rejects.toMatchObject({
      code: 'credential_store_unreadable',
    });
  });

  test('preserves transport detail without changing the stable machine code', async () => {
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command === 'station_native_http_request') {
        queueMicrotask(() =>
          emit({
            type: 'error',
            code: 'transport',
            detail: 'Station refused the connection.',
          }),
        );
      }
    });

    const pending = nativeAuthenticatedTransport(
      'https://station.example.test/api/chat',
    );

    await expect(pending).rejects.toMatchObject({
      code: 'transport',
      message: 'Native Station request failed: Station refused the connection.',
    });
  });

  /** A command not yet converted to `NativeCommandError` still rejects with
   * a bare string — preserved as the error's text, with `code` falling back
   * to that same text (an unrecognized code, not a crash). */
  /**
   * archive#1818: a legacy/uncoded rejection's raw
   * prose must NOT become `.code` — that would let a future `.code`
   * consumer accidentally match on a sentence, reopening the FFI-boundary
   * prose-matching this mechanism replaced. The message itself is still
   * preserved for logs/humans.
   */
  test('leaves .code unset (never the raw prose) for a legacy (uncoded) invoke rejection', async () => {
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command === 'station_native_http_request') {
        throw 'Station has no host-authorized active Station';
      }
    });

    const pending = nativeAuthenticatedTransport(
      'https://station.example.test/api/system/status',
    );

    let caught: unknown;
    await pending.catch((error) => {
      caught = error;
    });
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: unknown }).code).toBeUndefined();
    expect((caught as Error).message).toContain(
      'Station has no host-authorized active Station',
    );
  });

  test('cancels native I/O when the response consumer cancels the stream', async () => {
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command === 'station_native_http_request') {
        queueMicrotask(() =>
          emit({ type: 'response', status: 200, headers: {} }),
        );
      }
    });
    const response = await nativeAuthenticatedTransport(
      'https://station.example.test/api/events',
    );

    await response.body?.cancel();

    expect(bridge.invoke).toHaveBeenCalledWith(
      'station_native_http_cancel',
      expect.objectContaining({ requestId: expect.any(String) }),
    );
  });

  test('keeps a native paired bearer host-owned while loopback scope enforcement decides mutations', async () => {
    const endpoint = 'http://127.0.0.1:3141';
    const hostRecords = new Map([
      [
        'pairing-read-only',
        {
          bearer: 'host-only-loopback-read-only-bearer',
          scope: pairingScopePresetString('read-only'),
        },
      ],
      [
        'pairing-standard',
        {
          bearer: 'host-only-loopback-standard-bearer',
          scope: pairingScopePresetString('standard'),
        },
      ],
    ]);
    const runtimeHttpPath =
      '../../../../../src-server/runtime/bootstrap/runtime-http.js';
    const { configureRuntimeHttp } = await import(runtimeHttpPath);
    const app = new Hono();
    const scopeByBearer = new Map(
      [...hostRecords.values()].map((record) => [record.bearer, record.scope]),
    );
    configureRuntimeHttp({
      app,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
        trace() {},
        fatal() {},
        child() {
          return this;
        },
        setLevel() {},
        getLevel() {
          return 'info';
        },
      },
      eventBus: { emit() {} },
      security: {
        verifyCredential: (candidate: string) => scopeByBearer.has(candidate),
        resolveGrantedScope: (candidate: string) =>
          scopeByBearer.get(candidate),
        allowedOrigins: [],
      },
    });
    app.all('*', (context) => context.json({ reached: true }));
    let issuedPreset: 'read-only' | 'standard' = 'read-only';
    let activeCredentialRef: string | undefined;

    bridge.invoke.mockImplementation(
      async (command: string, args?: unknown) => {
        if (command === 'station_native_pairing_exchange') {
          const credentialRef = `pairing-${issuedPreset}`;
          return {
            ok: true,
            environmentId: 'environment-loopback',
            device: {
              id: `device-${issuedPreset}`,
              name: 'Desktop',
              scope: pairingScopePresetString(issuedPreset),
              kind: 'device',
              createdAt: 1,
              lastUsedAt: null,
              revokedAt: null,
            },
            credentialHandle: `host-handle-${issuedPreset}`,
            credentialRef: { kind: 'station-bearer', id: credentialRef },
          };
        }
        if (command === 'station_native_http_request') {
          const request = (
            args as {
              request: {
                headers: Record<string, string>;
                method: string;
                url: string;
              };
            }
          ).request;
          const record = activeCredentialRef
            ? hostRecords.get(activeCredentialRef)
            : undefined;
          if (!record) throw new Error('host has no active paired credential');
          expect(request.headers.authorization).toBeUndefined();
          expect(request.headers.cookie).toBeUndefined();
          const response = await app.request(
            request.url,
            {
              method: request.method,
              headers: {
                ...request.headers,
                Authorization: `Bearer ${record.bearer}`,
              },
            },
            {
              incoming: { socket: { remoteAddress: '127.0.0.1' } },
            } as never,
          );
          const bytes = [...new Uint8Array(await response.arrayBuffer())];
          queueMicrotask(() => {
            emit({
              type: 'response',
              status: response.status,
              headers: Object.fromEntries(response.headers.entries()),
            });
            if (bytes.length > 0) emit({ type: 'chunk', bytes });
            emit({ type: 'end' });
          });
        }
        return undefined;
      },
    );
    setNativePairingExchangeTransport(nativePairingExchangeTransport);

    const commitVerifiedPairing = vi.fn(
      async (input: {
        connectionId: string;
        credential?: string;
        credentialHandle?: string;
        nextCredentialRef?: { kind: 'station-bearer'; id: string };
      }) => {
        expect(input.credential).toBeUndefined();
        expect(input.credentialHandle).toBe(`host-handle-${issuedPreset}`);
        expect(input.nextCredentialRef).toEqual({
          kind: 'station-bearer',
          id: `pairing-${issuedPreset}`,
        });
        activeCredentialRef = input.nextCredentialRef?.id;
        return input.connectionId;
      },
    );
    const setCredential = vi.fn();
    const markDeviceSession = vi.fn();
    const setActiveConnection = vi.fn(async () => undefined);

    const pairAndMutate = async (preset: 'read-only' | 'standard') => {
      issuedPreset = preset;
      const result = await exchangeDevicePairing({
        endpoint,
        offerId: 'offer',
        proof: 'proof',
        requestId: 'request',
        clientInstanceId: '11111111-1111-4111-8111-111111111111',
        operationId:
          preset === 'read-only'
            ? '22222222-2222-4222-8222-222222222221'
            : '22222222-2222-4222-8222-222222222222',
        browserSession: false,
      });
      expect(result).toMatchObject({
        browserSession: false,
        credentialHandle: `host-handle-${preset}`,
        credentialRef: {
          kind: 'station-bearer',
          id: `pairing-${preset}`,
        },
        device: { scope: pairingScopePresetString(preset) },
      });
      expect(result.credential).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(
        'host-only-loopback-read-only-bearer',
      );

      await completeVerifiedPairing(
        {
          commitVerifiedPairing,
          setActiveConnection,
          setCredential,
          markDeviceSession,
        },
        {
          connectionId: 'connection-loopback',
          name: 'Local Station',
          endpoint,
        },
        { ...result, endpoint },
      );
      return nativeAuthenticatedTransport(`${endpoint}/api/projects`, {
        method: 'POST',
      });
    };

    const readOnly = await pairAndMutate('read-only');
    expect(readOnly.status).toBe(403);
    await expect(readOnly.json()).resolves.toEqual({
      error: { code: 'insufficient_scope' },
    });

    const standard = await pairAndMutate('standard');
    expect(standard.status).toBe(200);
    await expect(standard.json()).resolves.toEqual({ reached: true });
    expect(setCredential).not.toHaveBeenCalled();
    expect(markDeviceSession).not.toHaveBeenCalled();
    expect(setActiveConnection).toHaveBeenCalledTimes(2);
  });
});

/**
 * #3166: Station marks its own JSON answers with `x-station-envelope`, and the
 * SDK reads that marker to tell a Station refusal from an intermediary's. On
 * desktop every request goes through this broker, so the marker must survive
 * the native response and reach the SDK's request seam.
 */
describe('Station envelope marker through the native broker (#3166)', () => {
  // Pinned beside `STATION_ENVELOPE_HEADER` in packages/contracts/src/http.ts.
  const MARKER = 'x-station-envelope';
  const REFUSAL = { success: false, error: 'no', code: 'refused' };

  type BrokerReply = {
    status: number;
    headers: Record<string, string>;
    body: unknown;
  };

  /** Answer each native request with the next reply, as the broker would. */
  function brokerReplies(replies: BrokerReply[]): void {
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command !== 'station_native_http_request') return;
      const reply = replies.shift();
      if (!reply) throw new Error('unexpected native request');
      queueMicrotask(() => {
        emit({
          type: 'response',
          status: reply.status,
          headers: reply.headers,
        });
        emit({
          type: 'chunk',
          bytes: [...new TextEncoder().encode(JSON.stringify(reply.body))],
        });
        emit({ type: 'end' });
      });
    });
  }

  /** Route the SDK for `origin` through the real native transport. */
  function useNativeTransport(origin: string): void {
    setClientCredentialResolver(() => ({
      origin,
      transport: nativeAuthenticatedTransport,
    }));
  }

  async function refusalFrom(origin: string): Promise<ChatHttpError> {
    const error = await sendExecutionMessage(origin, {
      agentId: 'writer',
      message: 'hello',
      idempotencyKey: 'k1',
    } as never).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChatHttpError);
    return error as ChatHttpError;
  }

  beforeEach(() => {
    bridge.invoke.mockReset();
    bridge.channels.length = 0;
  });

  afterEach(() => {
    setClientCredentialResolver();
  });

  test('a marked Station refusal is recognised as Station’s own answer', async () => {
    // A distinct origin per test: what an origin has sent is process-wide.
    const origin = 'https://marked-refusal.station.test';
    useNativeTransport(origin);
    brokerReplies([
      {
        status: 200,
        headers: { 'content-type': 'application/json', [MARKER]: '1' },
        body: { success: true, data: [] },
      },
      {
        status: 403,
        headers: { 'content-type': 'application/json', [MARKER]: '1' },
        body: REFUSAL,
      },
    ]);

    const answer = await authenticatedFetch(`${origin}/api/anything`);
    // The seam itself: an origin that never marked falls back to body shape
    // and would also read as Station's, so the outcome alone proves nothing.
    expect(answer.headers.get(MARKER)).toBe('1');
    await answer.json();
    const error = await refusalFrom(origin);

    expect(error.status).toBe(403);
    expect(error.stationEnvelope).toBe(true);
  });

  test('after a marked answer, an unmarked refusal in Station’s shape is not Station’s', async () => {
    const origin = 'https://intermediary-refusal.station.test';
    useNativeTransport(origin);
    brokerReplies([
      {
        status: 200,
        headers: { 'content-type': 'application/json', [MARKER]: '1' },
        body: { success: true, data: [] },
      },
      {
        status: 403,
        headers: { 'content-type': 'application/json' },
        body: REFUSAL,
      },
    ]);

    await (await authenticatedFetch(`${origin}/api/anything`)).json();
    const error = await refusalFrom(origin);

    // Only reachable as `false` if the broker's marker on the first answer
    // taught the SDK that this origin marks its answers.
    expect(error.status).toBe(403);
    expect(error.stationEnvelope).toBe(false);
  });
});
