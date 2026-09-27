import { randomUUID } from 'node:crypto';
import type {
  ApprovedStationConnectionTrust,
  StationConnectionProofBinding,
} from '@kontourai/station-contracts/connection-proof';
import type {
  SelfHostedBrokerNativeClientSurfaceV2,
  SelfHostedBrokerNativeConnectionOfferV2,
} from '@kontourai/station-contracts/self-hosted-broker';
import {
  createStationConnectionProofVerifier,
  signStationConnectionProof,
  stationConnectionSigningKeyId,
} from '@kontourai/station-shared/connection-proof';
import { exportJWK, generateKeyPair } from 'jose';
import { describe, expect, test, vi } from 'vitest';
import {
  createNativeV2PionDiagnosticAdapter,
  type NativeV2PionDiagnosticAdapterDependencies,
} from '../native-v2-pion-diagnostic-adapter.js';

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
    generation: 7,
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
  let current: ApprovedStationConnectionTrust | null = trust;
  const trustOwner = {
    current: () => current,
    isCurrent: (expected: ApprovedStationConnectionTrust) =>
      current === expected,
    retire: () => {
      current = null;
    },
  };
  const issued: StationConnectionProofBinding[] = [];
  const input = {
    surface,
    executable: '/pion-peer',
    certificatePem: 'certificate',
    privateKeyPem: 'private-key',
    turn: { url: 'turn:127.0.0.1:3478', username: 'u', password: 'p' },
    trust: trustOwner,
    issuer: {
      issue: async (binding: StationConnectionProofBinding) => {
        issued.push(binding);
        return await signStationConnectionProof({
          trust,
          binding,
          signingKey: pair.privateKey,
          now: Math.floor(Date.now() / 1000),
        });
      },
    },
  };
  const offer: SelfHostedBrokerNativeConnectionOfferV2 = {
    version: 'station-broker-native-connection-offer/v2',
    scope: {
      stationId: trust.stationId,
      enrollmentId: trust.enrollmentId,
      routingGeneration: 1,
    },
    surface,
    stationSigningKeyId: await stationConnectionSigningKeyId(trust),
    stationSigningGeneration: trust.generation,
    clientId: surface.clientInstanceId,
    nonce: 'N'.repeat(43),
    offerSdp,
    expiresAt: Date.now() + 60_000,
  };
  let closeCalls = 0;
  const makePeer = (signal: AbortSignal) => {
    let resolveCleanup!: () => void;
    const cleanupComplete = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });
    return {
      answer: { type: 'answer' as const, sdp: answerSdp },
      close: async () => {
        closeCalls++;
        resolveCleanup();
        if (signal.aborted) throw new Error('pion_close_after_abort');
      },
      cleanupComplete,
    };
  };
  const startAdapter = vi.fn(
    async (options: {
      profile: string;
      applicationChannelLabel?: string;
      signal: AbortSignal;
    }) => {
      expect(options.profile).toBe('diagnosticEcho');
      expect(options.applicationChannelLabel).toBeUndefined();
      return makePeer(options.signal);
    },
  );
  const dependencies = {
    startAdapter,
  } as unknown as NativeV2PionDiagnosticAdapterDependencies;
  return {
    trust,
    surface,
    offer,
    input,
    dependencies,
    issued,
    trustOwner,
    get closeCalls() {
      return closeCalls;
    },
  };
}

describe('native v2 Pion diagnostic adapter', () => {
  test('answers only diagnosticEcho offers and signs the exact native handshake', async () => {
    const f = await fixture();
    const runtime = createNativeV2PionDiagnosticAdapter(
      f.input,
      f.dependencies,
    );
    const caller = new AbortController();
    const removeListener = vi.spyOn(caller.signal, 'removeEventListener');
    const result = await runtime.adapter.answer(
      f.offer,
      f.trust,
      caller.signal,
    );
    expect(removeListener).not.toHaveBeenCalled();
    expect(runtime.activePeerCount).toBe(1);
    expect(f.issued).toHaveLength(1);
    const binding = f.issued[0]!;
    const verifier = createStationConnectionProofVerifier({
      trust: f.trust,
      expected: binding,
      isCurrent: () => true,
    });
    await expect(
      verifier.verifyAndConsume(result.stationProof),
    ).resolves.toEqual(binding);
    expect(binding).toMatchObject({
      stationId: f.trust.stationId,
      enrollmentId: f.trust.enrollmentId,
      generation: f.trust.generation,
      connectionId: f.offer.clientId,
      clientNonce: f.offer.nonce,
      clientFingerprint: CLIENT_FP,
      stationFingerprint: STATION_FP,
    });
    await result.dispose();
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(f.closeCalls).toBe(1);
    expect(runtime.activePeerCount).toBe(0);
    expect(runtime.retiringPeerCount).toBe(0);
    await runtime.close();
  });

  test('rejects a changed surface or malformed SDP before launching Pion', async () => {
    const f = await fixture();
    const runtime = createNativeV2PionDiagnosticAdapter(
      f.input,
      f.dependencies,
    );
    await expect(
      runtime.adapter.answer(
        { ...f.offer, surface: { ...f.surface, channel: 'stable' } },
        f.trust,
        new AbortController().signal,
      ),
    ).rejects.toThrow('native_pion_diagnostic_offer_invalid');
    await expect(
      runtime.adapter.answer(
        { ...f.offer, offerSdp: 'v=0\r\n' },
        f.trust,
        new AbortController().signal,
      ),
    ).rejects.toThrow('native_pion_diagnostic_fingerprint_invalid');
    expect(f.dependencies.startAdapter).not.toHaveBeenCalled();
    await runtime.close();
  });

  test('retires a newly started peer if trust changes while Pion is starting', async () => {
    const f = await fixture();
    let closeCalls = 0;
    const startAdapter = vi.fn(async (options: { signal: AbortSignal }) => {
      f.trustOwner.retire();
      let resolveCleanup!: () => void;
      const cleanupComplete = new Promise<void>((resolve) => {
        resolveCleanup = resolve;
      });
      return {
        answer: { type: 'answer' as const, sdp: answerSdp },
        close: async () => {
          closeCalls++;
          resolveCleanup();
          if (options.signal.aborted) throw new Error('pion_close_after_abort');
        },
        cleanupComplete,
      };
    });
    const runtime = createNativeV2PionDiagnosticAdapter(f.input, {
      startAdapter,
    } as unknown as NativeV2PionDiagnosticAdapterDependencies);
    await expect(
      runtime.adapter.answer(f.offer, f.trust, new AbortController().signal),
    ).rejects.toThrow('native_pion_diagnostic_trust_retired');
    expect(f.issued).toHaveLength(0);
    expect(startAdapter).toHaveBeenCalledTimes(1);
    expect(closeCalls).toBe(1);
    expect(runtime.activePeerCount).toBe(0);
    await runtime.close();
  });

  test('does not publish an issued proof after trust retires during signing', async () => {
    const f = await fixture();
    let closeCalls = 0;
    const issue = f.input.issuer.issue;
    const runtime = createNativeV2PionDiagnosticAdapter(
      {
        ...f.input,
        issuer: {
          issue: async (binding) => {
            const proof = await issue(binding);
            f.trustOwner.retire();
            return proof;
          },
        },
      },
      {
        startAdapter: async (options: { signal: AbortSignal }) => {
          let resolveCleanup!: () => void;
          const cleanupComplete = new Promise<void>((resolve) => {
            resolveCleanup = resolve;
          });
          return {
            answer: { type: 'answer' as const, sdp: answerSdp },
            close: async () => {
              closeCalls++;
              resolveCleanup();
              if (options.signal.aborted)
                throw new Error('pion_close_after_abort');
            },
            cleanupComplete,
          };
        },
      } as unknown as NativeV2PionDiagnosticAdapterDependencies,
    );
    await expect(
      runtime.adapter.answer(f.offer, f.trust, new AbortController().signal),
    ).rejects.toThrow('native_pion_diagnostic_trust_retired');
    expect(f.issued).toHaveLength(1);
    expect(closeCalls).toBe(1);
    expect(runtime.activePeerCount).toBe(0);
    await runtime.close();
  });

  test('close aborts and reaps every live diagnostic peer', async () => {
    const f = await fixture();
    const runtime = createNativeV2PionDiagnosticAdapter(
      f.input,
      f.dependencies,
    );
    const result = await runtime.adapter.answer(
      f.offer,
      f.trust,
      new AbortController().signal,
    );
    await runtime.close();
    expect(runtime.activePeerCount).toBe(0);
    expect(f.closeCalls).toBe(1);
    expect(runtime.retiringPeerCount).toBe(0);
    await expect(result.dispose()).resolves.toBeUndefined();
    expect(f.closeCalls).toBe(1);
    expect(runtime.retiringPeerCount).toBe(0);
  });

  test('close joins abort-aware startup and its late cleanup receipt', async () => {
    const f = await fixture();
    let startSignal: AbortSignal | undefined;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let resolveStartup!: (peer: {
      answer: { type: 'answer'; sdp: string };
      close(): Promise<void>;
      cleanupComplete: Promise<void>;
    }) => void;
    let releaseStartup!: () => void;
    let abortObserved = false;
    let closeCalls = 0;
    const runtime = createNativeV2PionDiagnosticAdapter(f.input, {
      startAdapter: (options: { signal: AbortSignal }) => {
        startSignal = options.signal;
        signalStarted();
        return new Promise((resolve) => {
          resolveStartup = resolve;
          releaseStartup = () =>
            resolveStartup({
              answer: { type: 'answer', sdp: answerSdp },
              close: async () => {
                closeCalls++;
                if (options.signal.aborted)
                  throw new Error('pion_close_after_abort');
              },
              cleanupComplete: Promise.resolve(),
            });
          options.signal.addEventListener(
            'abort',
            () => {
              abortObserved = true;
            },
            { once: true },
          );
        });
      },
    } as unknown as NativeV2PionDiagnosticAdapterDependencies);
    const answering = runtime.adapter.answer(
      f.offer,
      f.trust,
      new AbortController().signal,
    );
    await started;
    let closeFinished = false;
    const closing = runtime.close().then(() => {
      closeFinished = true;
    });
    expect(startSignal?.aborted).toBe(true);
    expect(abortObserved).toBe(true);
    await Promise.resolve();
    expect(closeFinished).toBe(false);
    releaseStartup();
    await expect(answering).rejects.toThrow(
      'native_pion_diagnostic_adapter_closed',
    );
    await closing;
    expect(closeFinished).toBe(true);
    expect(closeCalls).toBe(0);
    expect(runtime.activePeerCount).toBe(0);
    expect(runtime.retiringPeerCount).toBe(0);
  });

  test('close reports a startup cleanup failure from an in-flight launch', async () => {
    const f = await fixture();
    let rejectStartup!: (reason: unknown) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const startupFailure = new AggregateError(
      [new Error('pion launch failed'), new Error('pion cleanup failed')],
      'pion_adapter_startup_cleanup_failed',
    );
    const runtime = createNativeV2PionDiagnosticAdapter(f.input, {
      startAdapter: (options: { signal: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          rejectStartup = reject;
          signalStarted();
          options.signal.addEventListener('abort', () => {}, { once: true });
        });
      },
    } as unknown as NativeV2PionDiagnosticAdapterDependencies);
    const answering = runtime.adapter.answer(
      f.offer,
      f.trust,
      new AbortController().signal,
    );
    await started;
    const closing = runtime.close().then(
      () => undefined,
      (error: unknown) => error,
    );
    await Promise.resolve();
    rejectStartup(startupFailure);
    await expect(answering).rejects.toBe(startupFailure);
    const closeError = await closing;
    expect(closeError).toBeInstanceOf(AggregateError);
    expect((closeError as AggregateError).message).toBe(
      'native_pion_diagnostic_close_failed',
    );
    expect((closeError as AggregateError).errors).toContain(startupFailure);
    expect(runtime.activePeerCount).toBe(0);
    expect(runtime.retiringPeerCount).toBe(0);
  });

  test('caller abort after answer retires the established peer', async () => {
    const f = await fixture();
    const runtime = createNativeV2PionDiagnosticAdapter(
      f.input,
      f.dependencies,
    );
    const caller = new AbortController();
    const result = await runtime.adapter.answer(
      f.offer,
      f.trust,
      caller.signal,
    );
    expect(runtime.activePeerCount).toBe(1);
    caller.abort(new Error('connector_withdrawn'));
    // The retained abort listener starts close immediately; this mock rejects
    // if the actual Pion process signal was aborted before graceful close.
    expect(f.closeCalls).toBe(1);
    await result.dispose();
    expect(runtime.activePeerCount).toBe(0);
    expect(runtime.retiringPeerCount).toBe(0);
    expect(f.closeCalls).toBe(1);
    await runtime.close();
  });
});
