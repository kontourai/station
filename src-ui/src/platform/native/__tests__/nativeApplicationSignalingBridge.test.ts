import { describe, expect, it, vi } from 'vitest';
import { createNativeApplicationSignalingBridge } from '../nativeApplicationSignalingBridge';
import { createNativeDiagnosticEchoBridge } from '../nativeDiagnosticEchoBridge';

const binding = {
  profileName: 'Workstation',
  profileRevision: 12,
  scope: {
    stationId: '11111111-1111-4111-8111-111111111111',
    enrollmentId: '22222222-2222-4222-8222-222222222222',
    routingGeneration: 4,
  },
  surface: {
    kind: 'station-native' as const,
    appIdentifier: 'io.kontourai.station.dev',
    channel: 'dev' as const,
    clientInstanceId: '33333333-3333-4333-8333-333333333333',
    keyThumbprint: 'A'.repeat(43),
  },
  trustRevision: 8,
  stationId: '11111111-1111-4111-8111-111111111111',
  enrollmentId: '22222222-2222-4222-8222-222222222222',
  generation: 3,
  signingKey: { kty: 'EC' as const, crv: 'P-256' as const, x: 'x', y: 'y' },
};

const peer = {
  version: 'station-native-application-peer/v1',
  peerHandle: 'H'.repeat(43),
  nonce: 'N'.repeat(43),
  connectionId: binding.surface.clientInstanceId,
  expiresAt: Date.now() + 90_000,
};

const bindingRequest = {
  profileName: 'Workstation',
  expectedProfileRevision: 12,
};

const APPLICATION_COMMANDS = [
  'station_native_relay_application_binding',
  'station_native_application_peer_prepare',
  'station_native_application_peer_open',
  'station_native_application_peer_read',
  'station_native_application_peer_sign',
  'station_native_application_peer_close',
];

const requestGuard = (args?: Record<string, unknown>) => {
  if (!args || Object.keys(args).length !== 1 || !args.request)
    throw new Error('Tauri command is missing its named binding request');
  return args.request as Record<string, unknown>;
};

const peerAnswer = {
  version: 'station-broker-native-connection-answer/v2',
  answerSdp: 'verified-answer-sdp',
  stationProof: 'opaque-station-proof',
  expiresAt: peer.expiresAt - 10_000,
};

describe('native application peer Tauri bridge', () => {
  it('uses distinct peer commands with exact host-owned arguments and closed results', async () => {
    const body = new Uint8Array([0, 1, 255]);
    let signedBody: number[] = [];
    const invoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === 'station_native_relay_application_binding') {
          expect(requestGuard(args)).toEqual(bindingRequest);
          return binding;
        }
        if (command === 'station_native_application_peer_prepare') {
          expect(args).toEqual(bindingRequest);
          return peer;
        }
        if (command === 'station_native_application_peer_open') {
          expect(args).toEqual({
            peerHandle: peer.peerHandle,
            offerSdp: 'bounded-offer-sdp',
          });
          return { expiresAt: peerAnswer.expiresAt };
        }
        if (command === 'station_native_application_peer_read') {
          expect(args).toEqual({ peerHandle: peer.peerHandle });
          return peerAnswer;
        }
        if (command === 'station_native_application_peer_sign') {
          if (!args) throw new Error('missing peer sign arguments');
          expect(args).toMatchObject({
            peerHandle: peer.peerHandle,
            method: 'POST',
            path: '/api/projects?slug=demo',
          });
          signedBody = (args.body as number[]).slice();
          expect(Object.keys(args).sort()).toEqual([
            'body',
            'method',
            'path',
            'peerHandle',
          ]);
          return {
            version: 'station-native-device-request-proof-result/v1',
            proof: 'header.payload.signature',
          };
        }
        if (command === 'station_native_application_peer_close') {
          expect(args).toEqual({ peerHandle: peer.peerHandle });
          return null;
        }
        throw new Error(`unexpected command ${command}`);
      },
    );
    const bridge = await createNativeApplicationSignalingBridge(
      'Workstation',
      12,
      { invoke },
    );
    expect(bridge.signaling.scope).toEqual(binding.scope);
    expect(bridge.signaling.surface).toEqual(binding.surface);

    const abort = new AbortController();
    const prepared = await bridge.signaling.prepare(abort.signal);
    expect(prepared).toEqual(peer);
    expect(
      await bridge.signaling.open(
        prepared.peerHandle,
        'bounded-offer-sdp',
        abort.signal,
      ),
    ).toBe(peerAnswer.expiresAt);
    expect(
      await bridge.signaling.read(prepared.peerHandle, abort.signal),
    ).toEqual(peerAnswer);
    expect(
      await bridge.signaling.sign(
        prepared.peerHandle,
        'POST',
        '/api/projects?slug=demo',
        body,
        abort.signal,
      ),
    ).toBe('header.payload.signature');
    body.fill(9);
    expect(signedBody).toEqual([0, 1, 255]);
    await bridge.signaling.close(prepared.peerHandle);
    await bridge.signaling.close(prepared.peerHandle);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(
      APPLICATION_COMMANDS,
    );
    const serialized = JSON.stringify(invoke.mock.calls);
    expect(serialized).not.toContain('brokerOrigin');
    expect(serialized).not.toContain('grantBearer');
    expect(serialized).not.toContain('privateKey');
    expect(serialized).not.toContain('authorization');
  });

  it('refuses a binding from another Station or profile revision', async () => {
    const variants = [
      { ...binding, stationId: '99999999-9999-4999-8999-999999999999' },
      { ...binding, enrollmentId: '88888888-8888-4888-8888-888888888888' },
      { ...binding, profileRevision: 13 },
      { ...binding, profileName: 'Other' },
    ];
    for (const variant of variants) {
      const invoke = vi.fn(
        async (_command: string, _args?: Record<string, unknown>) => variant,
      );
      await expect(
        createNativeApplicationSignalingBridge('Workstation', 12, { invoke }),
      ).rejects.toThrow('native_application_binding_invalid');
      expect(invoke.mock.calls.map(([command]) => command)).toEqual([
        'station_native_relay_application_binding',
      ]);
    }
  });

  it('retires trust when the host binding disappears on recheck', async () => {
    let reads = 0;
    const invoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        expect(command).toBe('station_native_relay_application_binding');
        requestGuard(args);
        reads++;
        if (reads > 1) throw new Error('host binding gone');
        return binding;
      },
    );
    const bridge = await createNativeApplicationSignalingBridge(
      'Workstation',
      12,
      { invoke },
    );
    const snapshot = bridge.trust.current();
    expect(snapshot).not.toBeNull();
    expect(await bridge.trust.recheck(snapshot!, 'checkpoint')).toBe(false);
    expect(bridge.trust.current()).toBeNull();
    expect(bridge.trust.isCurrent(snapshot!)).toBe(false);
  });

  it('refuses malformed peer, open, read, and Device proof result DTOs', async () => {
    const cases = [
      {
        command: 'station_native_application_peer_prepare',
        result: { ...peer, nonce: 'short' },
        action: (
          signaling: Awaited<
            ReturnType<typeof createNativeApplicationSignalingBridge>
          >['signaling'],
          signal: AbortSignal,
        ) => signaling.prepare(signal),
        error: 'native_application_peer_invalid',
      },
      {
        command: 'station_native_application_peer_open',
        result: { expiresAt: 'soon' },
        action: async (
          signaling: Awaited<
            ReturnType<typeof createNativeApplicationSignalingBridge>
          >['signaling'],
          signal: AbortSignal,
        ) => {
          const handle = await signaling.prepare(signal);
          return signaling.open(handle.peerHandle, 'offer', signal);
        },
        error: 'native_application_open_invalid',
      },
      {
        command: 'station_native_application_peer_read',
        result: { ...peerAnswer, extra: true },
        action: async (
          signaling: Awaited<
            ReturnType<typeof createNativeApplicationSignalingBridge>
          >['signaling'],
          signal: AbortSignal,
        ) => {
          const handle = await signaling.prepare(signal);
          return signaling.read(handle.peerHandle, signal);
        },
        error: 'native_application_read_invalid',
      },
      {
        command: 'station_native_application_peer_sign',
        result: {
          version: 'station-native-device-request-proof-result/v1',
          proof: 'bad proof',
        },
        action: async (
          signaling: Awaited<
            ReturnType<typeof createNativeApplicationSignalingBridge>
          >['signaling'],
          signal: AbortSignal,
        ) => {
          const handle = await signaling.prepare(signal);
          return signaling.sign(
            handle.peerHandle,
            'GET',
            '/api/projects',
            new Uint8Array(),
            signal,
          );
        },
        error: 'native_application_sign_invalid',
      },
    ];
    for (const item of cases) {
      const invoke = vi.fn(
        async (command: string, args?: Record<string, unknown>) => {
          if (command === 'station_native_relay_application_binding') {
            requestGuard(args);
            return binding;
          }
          if (
            command === item.command &&
            command === 'station_native_application_peer_prepare'
          )
            return item.result;
          if (command === 'station_native_application_peer_prepare')
            return peer;
          if (command === item.command) return item.result;
          if (command === 'station_native_application_peer_close') return null;
          return { expiresAt: peerAnswer.expiresAt };
        },
      );
      const bridge = await createNativeApplicationSignalingBridge(
        'Workstation',
        12,
        { invoke },
      );
      await expect(
        item.action(bridge.signaling, new AbortController().signal),
      ).rejects.toThrow(item.error);
      if (item.command === 'station_native_application_peer_prepare')
        expect(
          invoke.mock.calls.some(
            ([command]) => command === 'station_native_application_peer_close',
          ),
        ).toBe(true);
    }
  });

  it('preserves only the explicit ambiguous-open error for same-handle read recovery', async () => {
    const invoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === 'station_native_relay_application_binding') {
          requestGuard(args);
          return binding;
        }
        if (command === 'station_native_application_peer_prepare') return peer;
        if (command === 'station_native_application_peer_open')
          throw 'native_application_peer_open_unknown';
        if (command === 'station_native_application_peer_read')
          return peerAnswer;
        if (command === 'station_native_application_peer_close') return null;
        throw new Error(`unexpected command ${command}`);
      },
    );
    const bridge = await createNativeApplicationSignalingBridge(
      'Workstation',
      12,
      { invoke },
    );
    const signal = new AbortController().signal;
    const prepared = await bridge.signaling.prepare(signal);
    await expect(
      bridge.signaling.open(prepared.peerHandle, 'offer', signal),
    ).rejects.toThrow('native_application_peer_open_unknown');
    expect(await bridge.signaling.read(prepared.peerHandle, signal)).toEqual(
      peerAnswer,
    );
    await bridge.signaling.close(prepared.peerHandle);
    expect(
      invoke.mock.calls.filter(
        ([command]) => command === 'station_native_application_peer_open',
      ),
    ).toHaveLength(1);
    expect(
      invoke.mock.calls.filter(
        ([command]) => command === 'station_native_application_peer_read',
      ),
    ).toHaveLength(1);
  });

  it('cleans a peer returned after cancellation during prepare', async () => {
    let release!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const invoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === 'station_native_relay_application_binding') {
          requestGuard(args);
          return binding;
        }
        if (command === 'station_native_application_peer_prepare')
          return pending;
        if (command === 'station_native_application_peer_close') return null;
        throw new Error(`unexpected command ${command}`);
      },
    );
    const bridge = await createNativeApplicationSignalingBridge(
      'Workstation',
      12,
      { invoke },
    );
    const controller = new AbortController();
    const preparing = bridge.signaling.prepare(controller.signal);
    controller.abort(new Error('cancelled'));
    release(peer);
    await expect(preparing).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invoke.mock.calls).toContainEqual([
      'station_native_application_peer_close',
      { peerHandle: peer.peerHandle },
    ]);
  });

  it('prunes failed-close bookkeeping only after the host peer expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    try {
      let prepareCount = 0;
      let closeCount = 0;
      const invoke = vi.fn(
        async (command: string, args?: Record<string, unknown>) => {
          if (command === 'station_native_relay_application_binding') {
            requestGuard(args);
            return binding;
          }
          if (command === 'station_native_application_peer_prepare') {
            expect(args).toEqual(bindingRequest);
            const peerHandle = String(prepareCount++).padStart(43, '0');
            return {
              ...peer,
              peerHandle,
              expiresAt: Date.now() + 120_000,
            };
          }
          if (command === 'station_native_application_peer_close') {
            closeCount++;
            throw new Error('fixture close unavailable');
          }
          throw new Error(`unexpected command ${command}`);
        },
      );
      const bridge = await createNativeApplicationSignalingBridge(
        'Workstation',
        12,
        { invoke },
      );
      const signal = new AbortController().signal;
      const issuedHandles: string[] = [];
      for (let index = 0; index < 16; index++) {
        const prepared = await bridge.signaling.prepare(signal);
        issuedHandles.push(prepared.peerHandle);
      }
      expect(new Set(issuedHandles).size).toBe(16);
      for (const handle of issuedHandles) {
        await expect(bridge.signaling.close(handle)).rejects.toThrow(
          'native_application_peer_close_failed',
        );
        await expect(bridge.signaling.close(handle)).rejects.toThrow(
          'native_application_peer_close_failed',
        );
      }
      expect(closeCount).toBe(32);
      await expect(bridge.signaling.prepare(signal)).rejects.toThrow(
        'native_application_peer_invalid',
      );
      expect(prepareCount).toBe(16);

      vi.advanceTimersByTime(121_000);
      const recovered = await bridge.signaling.prepare(signal);
      expect(recovered.peerHandle).toBe(
        String(prepareCount - 1).padStart(43, '0'),
      );
      expect(prepareCount).toBe(17);
      expect(closeCount).toBe(32);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reserves the bounded host peer pool across concurrent prepares', async () => {
    const pending: Array<(value: unknown) => void> = [];
    let prepareCount = 0;
    const invoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === 'station_native_relay_application_binding') {
          requestGuard(args);
          return binding;
        }
        if (command === 'station_native_application_peer_prepare') {
          prepareCount++;
          return await new Promise<unknown>((resolve) => pending.push(resolve));
        }
        throw new Error(`unexpected command ${command}`);
      },
    );
    const bridge = await createNativeApplicationSignalingBridge(
      'Workstation',
      12,
      { invoke },
    );
    const signal = new AbortController().signal;
    const attempts = Array.from({ length: 17 }, () =>
      bridge.signaling.prepare(signal).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      ),
    );
    expect(prepareCount).toBe(16);
    expect(pending).toHaveLength(16);
    for (let index = 0; index < pending.length; index++)
      pending[index]!({
        ...peer,
        peerHandle: String(index).padStart(43, '0'),
        expiresAt: Date.now() + 90_000,
      });
    const results = await Promise.all(attempts);
    expect(results.filter((result) => 'value' in result)).toHaveLength(16);
    expect(results.filter((result) => 'error' in result)).toHaveLength(1);
    const refusal = results.find((result) => 'error' in result);
    expect(
      refusal && 'error' in refusal ? refusal.error : undefined,
    ).toMatchObject({
      message: 'native_application_peer_invalid',
    });
  });

  it('keeps the diagnostic bridge on its own diagnostic commands', async () => {
    const invoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        const request = requestGuard(args);
        if (command === 'station_native_relay_diagnostic_binding') {
          expect(request).toEqual(bindingRequest);
          return binding;
        }
        if (command === 'station_native_relay_signal_diagnostic_open')
          return { expiresAt: Date.now() + 20_000 };
        if (command === 'station_native_relay_signal_diagnostic_read')
          return { answerSdp: null, stationProof: null, expiresAt: 1 };
        throw new Error(`unexpected command ${command}`);
      },
    );
    const bridge = await createNativeDiagnosticEchoBridge('Workstation', 12, {
      invoke,
    });
    const abort = new AbortController().signal;
    await bridge.signaling.open(
      {
        version: 'station-broker-native-connection-open/v2',
        scope: bridge.signaling.scope,
        surface: bridge.signaling.surface,
        nonce: 'nonce-01',
        offerSdp: 'diagnostic-offer-sdp',
      },
      abort,
    );
    await bridge.signaling.read(
      {
        version: 'station-broker-native-connection-read/v2',
        scope: bridge.signaling.scope,
        surface: bridge.signaling.surface,
        nonce: 'nonce-01',
      },
      abort,
    );
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'station_native_relay_diagnostic_binding',
      'station_native_relay_signal_diagnostic_open',
      'station_native_relay_signal_diagnostic_read',
    ]);
    const snapshot = bridge.trust.current();
    expect(await bridge.trust.recheck(snapshot!, 'checkpoint')).toBe(true);
    expect(bridge.trust.current()).not.toBeNull();
  });
});
