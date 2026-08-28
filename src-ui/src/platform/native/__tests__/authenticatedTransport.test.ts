import {
  exchangeDevicePairing,
  setNativePairingExchangeTransport,
} from '@kontourai/station-connect/device-pairing';
import { pairingScopePresetString } from '@kontourai/station-contracts';
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

describe('native authenticated transport', () => {
  beforeEach(() => {
    bridge.invoke.mockReset();
    bridge.channels.length = 0;
  });

  afterEach(() => setNativePairingExchangeTransport());

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
 * archive#1818 1 : a legacy/uncoded rejection's raw
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
