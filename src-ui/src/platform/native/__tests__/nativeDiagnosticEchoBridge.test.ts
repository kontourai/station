import type { NativeDiagnosticSignalOpen } from '@kontourai/station-connect/native-diagnostic-echo';
import { describe, expect, it, vi } from 'vitest';
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

describe('native diagnostic Tauri bridge', () => {
  it('maps only host-derived scope and exact saved profile signaling fields', async () => {
    // Model the Tauri invoke argument decoder: every Rust command takes one
    // named `request` parameter, so a flattened object must fail here.
    const invoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        if (!args || Object.keys(args).length !== 1 || !args.request)
          throw new Error(
            'Tauri command is missing its named request argument',
          );
        const request = args.request as Record<string, unknown>;
        if (command === 'station_native_relay_diagnostic_binding') {
          if (
            request.profileName !== 'Workstation' ||
            request.expectedProfileRevision !== 12
          )
            throw new Error('Tauri binding request is invalid');
          return binding;
        }
        if (command === 'station_native_relay_signal_diagnostic_open') {
          if (
            request.profileName !== 'Workstation' ||
            request.expectedProfileRevision !== 12 ||
            request.nonce !== 'nonce-01' ||
            request.offerSdp !== 'bounded-offer-sdp'
          )
            throw new Error('Tauri open request is invalid');
          return { expiresAt: Date.now() + 20_000 };
        }
        if (command === 'station_native_relay_signal_diagnostic_read') {
          if (
            request.profileName !== 'Workstation' ||
            request.expectedProfileRevision !== 12 ||
            request.nonce !== 'nonce-01'
          )
            throw new Error('Tauri read request is invalid');
          return {
            answerSdp: null,
            stationProof: null,
            expiresAt: Date.now() + 20_000,
          };
        }
        throw new Error(`unexpected command ${command}`);
      },
    );
    const bridge = await createNativeDiagnosticEchoBridge('Workstation', 12, {
      invoke,
    });
    const abort = new AbortController();
    const open: NativeDiagnosticSignalOpen = {
      version: 'station-broker-native-connection-open/v2',
      scope: bridge.signaling.scope,
      surface: bridge.signaling.surface,
      nonce: 'nonce-01',
      offerSdp: 'bounded-offer-sdp',
    };
    await bridge.signaling.open(open, abort.signal);
    const answer = await bridge.signaling.read(
      {
        version: 'station-broker-native-connection-read/v2',
        scope: bridge.signaling.scope,
        surface: bridge.signaling.surface,
        nonce: open.nonce,
      },
      abort.signal,
    );
    expect(answer).toEqual({
      version: 'station-broker-native-connection-answer/v2',
      expiresAt: expect.any(Number),
      answerSdp: null,
      stationProof: null,
    });
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      'station_native_relay_diagnostic_binding',
      {
        request: {
          profileName: 'Workstation',
          expectedProfileRevision: 12,
        },
      },
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      'station_native_relay_signal_diagnostic_open',
      {
        request: {
          profileName: 'Workstation',
          expectedProfileRevision: 12,
          nonce: 'nonce-01',
          offerSdp: 'bounded-offer-sdp',
        },
      },
    );
    expect(invoke).toHaveBeenNthCalledWith(
      3,
      'station_native_relay_signal_diagnostic_read',
      {
        request: {
          profileName: 'Workstation',
          expectedProfileRevision: 12,
          nonce: 'nonce-01',
        },
      },
    );
    expect(JSON.stringify(invoke.mock.calls)).not.toContain('grantSecret');
    expect(JSON.stringify(invoke.mock.calls)).not.toContain('privateKey');
  });

  it('rejects a binding from another selected profile or revision', async () => {
    const invoke = vi.fn(async () => ({ ...binding, profileRevision: 13 }));
    await expect(
      createNativeDiagnosticEchoBridge('Workstation', 12, { invoke }),
    ).rejects.toThrow('native_diagnostic_binding_invalid');
  });

  it('authoritatively retires the trust snapshot when persisted approval is revoked', async () => {
    let statusReads = 0;
    const invoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        if (command !== 'station_native_relay_diagnostic_binding')
          throw new Error('unexpected command');
        if (!args || Object.keys(args).length !== 1 || !args.request)
          throw new Error(
            'Tauri command is missing its named request argument',
          );
        statusReads++;
        if (statusReads > 1) throw new Error('Station trust revoked');
        return binding;
      },
    );
    const bridge = await createNativeDiagnosticEchoBridge('Workstation', 12, {
      invoke,
    });
    const snapshot = bridge.trust.current();
    expect(snapshot).not.toBeNull();
    expect(
      await bridge.trust.recheck(snapshot!, 'before-remote-description'),
    ).toBe(false);
    expect(bridge.trust.current()).toBeNull();
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      'station_native_relay_diagnostic_binding',
      {
        request: {
          profileName: 'Workstation',
          expectedProfileRevision: 12,
        },
      },
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      'station_native_relay_diagnostic_binding',
      {
        request: {
          profileName: 'Workstation',
          expectedProfileRevision: 12,
        },
      },
    );
  });
});
