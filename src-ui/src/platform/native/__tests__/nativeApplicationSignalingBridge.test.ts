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

const APPLICATION_COMMANDS = [
  'station_native_relay_application_binding',
  'station_native_relay_application_open',
  'station_native_relay_application_read',
];

const requestGuard = (args?: Record<string, unknown>) => {
  if (!args || Object.keys(args).length !== 1 || !args.request)
    throw new Error('Tauri command is missing its named request argument');
  return args.request as Record<string, unknown>;
};

const bindingRequest = {
  profileName: 'Workstation',
  expectedProfileRevision: 12,
};

describe('native application signaling Tauri bridge', () => {
  it('uses only the three application commands and completes a valid signal open/read', async () => {
    const invoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        const request = requestGuard(args);
        if (command === 'station_native_relay_application_binding') {
          expect(request).toEqual(bindingRequest);
          return binding;
        }
        if (command === 'station_native_relay_application_open') {
          expect(request).toEqual({
            ...bindingRequest,
            nonce: 'nonce-01',
            offerSdp: 'application-offer-sdp',
          });
          return { expiresAt: Date.now() + 20_000 };
        }
        if (command === 'station_native_relay_application_read') {
          expect(request).toEqual({ ...bindingRequest, nonce: 'nonce-01' });
          return {
            answerSdp: 'application-answer-sdp',
            stationProof: 'proof-token',
            expiresAt: Date.now() + 20_000,
          };
        }
        throw new Error(`unexpected command ${command}`);
      },
    );
    const bridge = await createNativeApplicationSignalingBridge(
      'Workstation',
      12,
      { invoke },
    );
    const abort = new AbortController();
    const expiresAt = await bridge.signaling.open(
      {
        version: 'station-broker-native-connection-open/v2',
        scope: bridge.signaling.scope,
        surface: bridge.signaling.surface,
        nonce: 'nonce-01',
        offerSdp: 'application-offer-sdp',
      },
      abort.signal,
    );
    expect(expiresAt).toBeGreaterThan(Date.now());
    const answer = await bridge.signaling.read(
      {
        version: 'station-broker-native-connection-read/v2',
        scope: bridge.signaling.scope,
        surface: bridge.signaling.surface,
        nonce: 'nonce-01',
      },
      abort.signal,
    );
    expect(answer).toEqual({
      version: 'station-broker-native-connection-answer/v2',
      expiresAt: expect.any(Number),
      answerSdp: 'application-answer-sdp',
      stationProof: 'proof-token',
    });
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(
      APPLICATION_COMMANDS,
    );
    const serialized = JSON.stringify(invoke.mock.calls);
    expect(serialized).not.toContain('grantSecret');
    expect(serialized).not.toContain('privateKey');
    expect(serialized).not.toContain('bearer');
    expect(serialized).not.toContain('diagnostic');
  });

  it('refuses a binding from another Station or profile revision', async () => {
    const variants = [
      { ...binding, stationId: '99999999-9999-4999-8999-999999999999' },
      { ...binding, enrollmentId: '88888888-8888-4888-8888-888888888888' },
      { ...binding, profileRevision: 13 },
      { ...binding, profileName: 'Other' },
    ];
    for (const variant of variants) {
      const invoke = vi.fn(async (_command: string) => variant);
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

  it('retires trust when the re-read binding no longer matches the snapshot', async () => {
    const stale = [
      { ...binding, generation: binding.generation + 1 },
      {
        ...binding,
        scope: {
          ...binding.scope,
          routingGeneration: binding.scope.routingGeneration + 1,
        },
      },
      { ...binding, surface: { ...binding.surface, clientInstanceId: 'other' } },
      { ...binding, trustRevision: binding.trustRevision + 1 },
      {
        ...binding,
        signingKey: { ...binding.signingKey, x: 'rotated' },
      },
    ];
    for (const variant of stale) {
      let reads = 0;
      const invoke = vi.fn(async () => {
        reads++;
        return reads > 1 ? variant : binding;
      });
      const bridge = await createNativeApplicationSignalingBridge(
        'Workstation',
        12,
        { invoke },
      );
      const snapshot = bridge.trust.current();
      expect(await bridge.trust.recheck(snapshot!, 'checkpoint')).toBe(false);
      expect(bridge.trust.current()).toBeNull();
    }
  });

  it('retires trust when the re-read surface channel changes', async () => {
    let reads = 0;
    const invoke = vi.fn(async () => {
      reads++;
      return reads > 1
        ? { ...binding, surface: { ...binding.surface, channel: 'stable' as const } }
        : binding;
    });
    const bridge = await createNativeApplicationSignalingBridge(
      'Workstation',
      12,
      { invoke },
    );
    const snapshot = bridge.trust.current();
    expect(await bridge.trust.recheck(snapshot!, 'checkpoint')).toBe(false);
    expect(bridge.trust.current()).toBeNull();
  });

  it('refuses malformed open receipts and answers', async () => {
    const invoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        requestGuard(args);
        if (command === 'station_native_relay_application_binding')
          return binding;
        if (command === 'station_native_relay_application_open')
          return { expiresAt: 'soon' };
        if (command === 'station_native_relay_application_read')
          return { answerSdp: 7, stationProof: null, expiresAt: 1 };
        throw new Error(`unexpected command ${command}`);
      },
    );
    const bridge = await createNativeApplicationSignalingBridge(
      'Workstation',
      12,
      { invoke },
    );
    const abort = new AbortController().signal;
    const openInput = {
      version: 'station-broker-native-connection-open/v2' as const,
      scope: bridge.signaling.scope,
      surface: bridge.signaling.surface,
      nonce: 'nonce-01',
      offerSdp: 'application-offer-sdp',
    };
    await expect(bridge.signaling.open(openInput, abort)).rejects.toThrow(
      'native_application_open_receipt_invalid',
    );
    await expect(
      bridge.signaling.read(
        {
          version: 'station-broker-native-connection-read/v2',
          scope: openInput.scope,
          surface: openInput.surface,
          nonce: 'nonce-01',
        },
        abort,
      ),
    ).rejects.toThrow('native_application_answer_invalid');
  });

  it('refuses extra fields in host signaling results', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'station_native_relay_application_binding')
        return binding;
      if (command === 'station_native_relay_application_open')
        return { expiresAt: Date.now() + 20_000, grantBearer: 'forbidden' };
      if (command === 'station_native_relay_application_read')
        return {
          answerSdp: null,
          stationProof: null,
          expiresAt: Date.now() + 20_000,
          projectId: 'forbidden',
        };
      throw new Error(`unexpected command ${command}`);
    });
    const bridge = await createNativeApplicationSignalingBridge(
      'Workstation',
      12,
      { invoke },
    );
    const signal = new AbortController().signal;
    await expect(
      bridge.signaling.open(
        {
          version: 'station-broker-native-connection-open/v2',
          scope: bridge.signaling.scope,
          surface: bridge.signaling.surface,
          nonce: 'nonce-01',
          offerSdp: 'application-offer-sdp',
        },
        signal,
      ),
    ).rejects.toThrow('native_application_open_receipt_invalid');
    await expect(
      bridge.signaling.read(
        {
          version: 'station-broker-native-connection-read/v2',
          scope: bridge.signaling.scope,
          surface: bridge.signaling.surface,
          nonce: 'nonce-01',
        },
        signal,
      ),
    ).rejects.toThrow('native_application_answer_invalid');
  });

  it('refuses a mismatched surface on open without invoking the host', async () => {
    const invoke = vi.fn(
      async (command: string) =>
        command === 'station_native_relay_application_binding'
          ? binding
          : { expiresAt: Date.now() + 1_000 },
    );
    const bridge = await createNativeApplicationSignalingBridge(
      'Workstation',
      12,
      { invoke },
    );
    await expect(
      bridge.signaling.open(
        {
          version: 'station-broker-native-connection-open/v2',
          scope: bridge.signaling.scope,
          surface: { ...bridge.signaling.surface, clientInstanceId: 'other' },
          nonce: 'nonce-01',
          offerSdp: 'application-offer-sdp',
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('native_application_surface_mismatch');
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'station_native_relay_application_binding',
    ]);
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
