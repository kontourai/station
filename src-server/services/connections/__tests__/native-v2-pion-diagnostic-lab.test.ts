import { randomUUID } from 'node:crypto';
import type { ApprovedStationConnectionTrust } from '@kontourai/station-contracts/connection-proof';
import type {
  SelfHostedBrokerNativeClientSurfaceV2,
  SelfHostedBrokerNativeConnectionOfferV2,
  SelfHostedBrokerScopeV1,
} from '@kontourai/station-contracts/self-hosted-broker';
import {
  signStationConnectionProof,
  stationConnectionSigningKeyId,
} from '@kontourai/station-shared/connection-proof';
import { exportJWK, generateKeyPair } from 'jose';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createNativeV2PionDiagnosticLab,
  type NativeV2PionDiagnosticLabInput,
} from '../native-v2-pion-diagnostic-lab.js';
import { SelfHostedBrokerClient } from '../self-hosted-broker-client.js';

const CLIENT_FP = Array(32).fill('AA').join(':');
const STATION_FP = Array(32).fill('BB').join(':');
const offerSdp = `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 ${CLIENT_FP}\r\n`;
const answerSdp = `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 ${STATION_FP}\r\n`;

async function fixture() {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  const trust: ApprovedStationConnectionTrust = {
    stationId: '11111111-1111-4111-8111-111111111111',
    enrollmentId: '22222222-2222-4222-8222-222222222222',
    generation: 9,
    signingKey: {
      kty: 'EC',
      crv: 'P-256',
      x: publicJwk.x!,
      y: publicJwk.y!,
    },
  };
  const surface: SelfHostedBrokerNativeClientSurfaceV2 = {
    kind: 'station-native',
    appIdentifier: 'io.kontourai.station',
    channel: 'dev',
    clientInstanceId: randomUUID(),
    keyThumbprint: 'K'.repeat(43),
  };
  const scope: SelfHostedBrokerScopeV1 = {
    stationId: trust.stationId,
    enrollmentId: trust.enrollmentId,
    routingGeneration: 1,
    browserOrigin: 'https://lab.example',
  };
  let current: ApprovedStationConnectionTrust | null = trust;
  const trustOwner = {
    current: () => current,
    isCurrent: (expected: ApprovedStationConnectionTrust) =>
      current === expected,
    revoke: () => {
      current = null;
    },
  };
  const stationSigningKeyIdValue = await stationConnectionSigningKeyId(trust);
  const offer: SelfHostedBrokerNativeConnectionOfferV2 = {
    version: 'station-broker-native-connection-offer/v2',
    scope: {
      stationId: scope.stationId,
      enrollmentId: scope.enrollmentId,
      routingGeneration: scope.routingGeneration,
    },
    surface,
    stationSigningKeyId: stationSigningKeyIdValue,
    stationSigningGeneration: trust.generation,
    clientId: surface.clientInstanceId,
    nonce: 'N'.repeat(43),
    offerSdp,
    expiresAt: Date.now() + 60_000,
  };
  const client = new SelfHostedBrokerClient(
    'https://broker.example',
    scope,
    {
      id: 'connector-12345678',
      secret: 'S'.repeat(43),
    },
    async () => new Response('{}'),
  );
  vi.spyOn(client, 'register').mockResolvedValue({
    revision: 0,
    registeredAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  });
  const nativeOffers = vi
    .spyOn(client, 'nativeOffers')
    .mockResolvedValueOnce([offer])
    .mockResolvedValue([]);
  const answerNative = vi.spyOn(client, 'answerNative').mockResolvedValue();
  const withdraw = vi.spyOn(client, 'withdraw').mockResolvedValue();
  let messages: string[] = [];
  let onReadMessages: (() => void) | undefined;
  let closeCalls = 0;
  const startAdapter = vi.fn(async (options: Record<string, unknown>) => {
    expect(options.profile).toBe('diagnosticEcho');
    expect(options.applicationChannelLabel).toBeUndefined();
    expect(options.maxLifetimeMs).toBe(90_000);
    expect(() => (options.accept as () => void)()).toThrow(
      'native_pion_diagnostic_application_channel_forbidden',
    );
    let resolveCleanup!: () => void;
    const cleanupComplete = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });
    return {
      answer: { type: 'answer' as const, sdp: answerSdp },
      readMessages: () => {
        onReadMessages?.();
        return messages;
      },
      close: async () => {
        closeCalls++;
        resolveCleanup();
        if ((options.signal as AbortSignal).aborted)
          throw new Error('pion_close_after_abort');
      },
      cleanupComplete,
    };
  });
  const input: NativeV2PionDiagnosticLabInput = {
    scope,
    client,
    surface,
    executable: '/pion-peer',
    certificatePem: 'certificate',
    privateKeyPem: 'private-key',
    turn: { url: 'turn:127.0.0.1:3478', username: 'u', password: 'p' },
    trust: trustOwner,
    issuer: {
      issue: async (binding) =>
        await signStationConnectionProof({
          trust,
          binding,
          signingKey: pair.privateKey,
          now: Math.floor(Date.now() / 1000),
        }),
    },
  };
  return {
    input,
    offer,
    trust,
    surface,
    trustOwner,
    client,
    nativeOffers,
    answerNative,
    withdraw,
    startAdapter,
    setMessages(value: string[]) {
      messages = value;
    },
    onReadMessages(callback: () => void) {
      onReadMessages = callback;
    },
    get closeCalls() {
      return closeCalls;
    },
  };
}

describe('native v2 Pion diagnostic lab composition', () => {
  afterEach(() => vi.restoreAllMocks());

  test('pollNative answers the exact trusted offer, returns bounded echo, then retires the peer', async () => {
    const f = await fixture();
    f.nativeOffers.mockResolvedValue([f.offer]);
    const sendEcho = vi.fn(() => f.setMessages(['station echo probe']));
    f.answerNative.mockImplementation(async () => {
      sendEcho();
    });
    const lab = createNativeV2PionDiagnosticLab(f.input, {
      startAdapter: f.startAdapter as never,
    });
    const signal = new AbortController().signal;
    await lab.register(signal);
    expect(await lab.pollNative(signal)).toEqual({
      observed: 1,
      answered: 1,
      diagnosticEchoes: ['station echo probe'],
    });
    expect(f.nativeOffers).toHaveBeenCalledWith(
      f.surface,
      expect.any(AbortSignal),
    );
    expect(f.nativeOffers).toHaveBeenCalledOnce();
    expect(f.answerNative).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: f.surface,
        clientId: f.offer.clientId,
        nonce: f.offer.nonce,
        stationSigningKeyId: f.offer.stationSigningKeyId,
        stationSigningGeneration: f.trust.generation,
        answerSdp,
      }),
      expect.any(AbortSignal),
    );
    expect(sendEcho).toHaveBeenCalledOnce();
    expect(f.startAdapter).toHaveBeenCalledOnce();
    expect(lab.activePeerCount).toBe(0);
    expect(f.closeCalls).toBe(1);
    await lab.close(signal);
    expect(f.withdraw).toHaveBeenCalledOnce();
  });

  test('revocation during echo collection fails closed and cleans up the peer', async () => {
    const f = await fixture();
    f.onReadMessages(() => f.trustOwner.revoke());
    const lab = createNativeV2PionDiagnosticLab(f.input, {
      startAdapter: f.startAdapter as never,
    });
    const signal = new AbortController().signal;
    await lab.register(signal);
    await expect(lab.pollNative(signal)).rejects.toThrow(
      'native_pion_diagnostic_trust_retired',
    );
    expect(lab.activePeerCount).toBe(0);
    expect(f.closeCalls).toBe(1);
    await lab.close(signal);
  });

  test('rejects diagnostic echo payloads above the per-message bound and closes the peer', async () => {
    const f = await fixture();
    f.answerNative.mockImplementation(async () => {
      f.setMessages(['x'.repeat(65_537)]);
    });
    const lab = createNativeV2PionDiagnosticLab(f.input, {
      startAdapter: f.startAdapter as never,
    });
    const signal = new AbortController().signal;
    await lab.register(signal);
    await expect(lab.pollNative(signal)).rejects.toThrow(
      'native_pion_diagnostic_echo_unbounded',
    );
    expect(lab.activePeerCount).toBe(0);
    expect(f.closeCalls).toBe(1);
    await lab.close(signal);
  });
});
