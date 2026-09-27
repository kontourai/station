import { randomBytes, randomUUID } from 'node:crypto';
// Module-mocked below; the native adapter must serve through this seam.
import { serveApplicationChannel } from '@kontourai/station-connect/application-channel';
import type {
  ApprovedStationConnectionTrust,
  StationConnectionSigningKey,
} from '@kontourai/station-contracts/connection-proof';
import type { SelfHostedBrokerNativeClientSurfaceV2 } from '@kontourai/station-contracts/self-hosted-broker';
import {
  connectionDescriptionDigest,
  createStationConnectionProofVerifier,
  signStationConnectionProof,
  stationConnectionSigningKeyId,
} from '@kontourai/station-shared/connection-proof';
import { exportJWK, generateKeyPair } from 'jose';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createNativeV2PionApplicationAdapter } from '../../../services/connections/native-v2-pion-application-adapter.js';
import { createSelfHostedBrokerPionRuntime } from '../self-hosted-broker-pion-runtime.js';

vi.mock('@kontourai/station-connect/application-channel', () => {
  const captured: Array<Record<string, unknown>> = [];
  return {
    serveApplicationChannel: (
      channel: {
        send(m: string): void;
        close(): void;
        subscribe(a: (v: unknown) => void, b: () => void): () => void;
      },
      _origin: string,
      application: unknown,
    ) => {
      const entry = { channel, application, closeCalls: 0 };
      captured.push(entry);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        entry.closeCalls += 1;
        try {
          channel.close();
        } catch {
          // Best-effort in fake.
        }
      };
    },
    __captured: captured,
  };
});

const NONCE = randomBytes(32).toString('base64url');
const FP_CLIENT = Array(32).fill('AA').join(':');
const FP_STATION = Array(32).fill('BB').join(':');
const OFFER_SDP = `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 ${FP_CLIENT}\r\n`;
const ANSWER_SDP = `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 ${FP_STATION}\r\n`;

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('test_wait_timeout');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface NativeHarness {
  trust: ApprovedStationConnectionTrust;
  current: ApprovedStationConnectionTrust | null;
  surface: SelfHostedBrokerNativeClientSurfaceV2;
  stationSigningKeyId: string;
  capturedNativeAnswer: Record<string, unknown> | undefined;
  nativeOffersRequests: Array<Record<string, unknown>>;
  nativeOffersQueue: Array<Record<string, unknown> | null>;
  nativeAccept:
    | ((channel: {
        send(m: string): void;
        close(): void;
        subscribe(a: (v: unknown) => void, b: () => void): () => void;
      }) => void)
    | undefined;
  nativeStartCalls: number;
  nativeCloseCalls: number;
  withdrawCalls: number;
  statuses: Array<{ state: string; phase: string; reason?: string }>;
  /** When set, the fake native peer start blocks until released. */
  startGate?: Promise<void>;
  releaseStart?: () => void;
}

async function nativeHarness(
  options: {
    nativeMaxPeers?: number;
    configureNative?: boolean;
    gateStart?: boolean;
  } = {},
) {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const trust: ApprovedStationConnectionTrust = {
    stationId: randomUUID(),
    enrollmentId: randomUUID(),
    generation: 1,
    signingKey: (await exportJWK(
      pair.publicKey,
    )) as StationConnectionSigningKey,
  };
  const surface: SelfHostedBrokerNativeClientSurfaceV2 = {
    kind: 'station-native',
    appIdentifier: 'dev.kontourai.station.test',
    channel: 'dev',
    clientInstanceId: randomUUID(),
    keyThumbprint: 'A'.repeat(43),
  };
  const stationSigningKeyId = await stationConnectionSigningKeyId(trust);
  const scope = {
    stationId: trust.stationId,
    enrollmentId: trust.enrollmentId,
    routingGeneration: 1,
    browserOrigin: 'https://browser.example',
  };
  const h: NativeHarness = {
    trust,
    current: trust,
    surface,
    stationSigningKeyId,
    capturedNativeAnswer: undefined,
    nativeOffersRequests: [],
    nativeOffersQueue: [],
    nativeAccept: undefined,
    nativeStartCalls: 0,
    nativeCloseCalls: 0,
    withdrawCalls: 0,
    statuses: [],
  };
  if (options.gateStart) {
    h.startGate = new Promise<void>((resolve) => {
      h.releaseStart = resolve;
    });
  }
  const trustOwner = {
    current: () => (h.current ? structuredClone(h.current) : null),
    isCurrent: (value: ApprovedStationConnectionTrust) =>
      h.current !== null &&
      value.stationId === h.current.stationId &&
      value.enrollmentId === h.current.enrollmentId &&
      value.generation === h.current.generation &&
      JSON.stringify(value.signingKey) === JSON.stringify(h.current.signingKey),
  };
  const issuer = {
    issue: (
      binding: Parameters<typeof signStationConnectionProof>[0]['binding'],
    ) =>
      signStationConnectionProof({
        trust,
        binding,
        signingKey: pair.privateKey,
        now: Math.floor(Date.now() / 1000),
      }),
  };
  const nativeOffer = (nonce: string) => ({
    version: 'station-broker-native-connection-offer/v2',
    scope: {
      stationId: scope.stationId,
      enrollmentId: scope.enrollmentId,
      routingGeneration: scope.routingGeneration,
    },
    surface,
    stationSigningKeyId,
    stationSigningGeneration: trust.generation,
    clientId: surface.clientInstanceId,
    nonce,
    offerSdp: OFFER_SDP,
    expiresAt: Date.now() + 60_000,
  });
  const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/leases/register'))
      return jsonResponse({
        registeredAt: Date.now(),
        revision: 1,
        expiresAt: Date.now() + 60_000,
      });
    if (url.endsWith('/leases/renew'))
      return jsonResponse({ revision: 2, expiresAt: Date.now() + 60_000 });
    if (url.endsWith('/leases/withdraw')) {
      h.withdrawCalls += 1;
      return jsonResponse({ withdrawn: true });
    }
    // Browser lane stays empty so only the opt-in native lane is exercised.
    // The native path is matched first: it ends with the browser suffix too.
    if (url.endsWith('/native/connections/offers')) {
      h.nativeOffersRequests.push(
        JSON.parse(init?.body as string) as Record<string, unknown>,
      );
      const next = h.nativeOffersQueue.shift() ?? null;
      return jsonResponse({ offers: next ? [next] : [] });
    }
    if (url.endsWith('/native/connections/answer')) {
      h.capturedNativeAnswer = JSON.parse(init?.body as string) as Record<
        string,
        unknown
      >;
      return jsonResponse({ accepted: true });
    }
    if (url.endsWith('/connections/offers'))
      return jsonResponse({ offers: [] });
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal('fetch', fetchStub);

  const cleanupResolvers: Array<() => void> = [];
  const nativeStartAdapter = vi.fn(async (input: Record<string, unknown>) => {
    h.nativeStartCalls += 1;
    h.nativeAccept = input.accept as NativeHarness['nativeAccept'];
    // Deterministic mid-admission interception point.
    await h.startGate;
    let resolveCleanup!: () => void;
    const cleanupComplete = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });
    cleanupComplete.then(undefined, () => {});
    cleanupResolvers.push(resolveCleanup);
    return {
      answer: { type: 'answer' as const, sdp: ANSWER_SDP },
      close: vi.fn(async () => {
        h.nativeCloseCalls += 1;
        resolveCleanup();
      }),
      cleanupComplete,
    };
  });
  const runtime = createSelfHostedBrokerPionRuntime(
    {
      brokerOrigin: 'http://localhost:4312',
      applicationOrigin: 'https://station.example',
      scope,
      connectorCredential: { id: 'cred-id-1', secret: 'secret-1' },
      executable: '/bin/false',
      certificatePem: 'cert',
      privateKeyPem: 'key',
      turn: { url: 'turn:example', username: 'u', password: 'p' },
      trust: trustOwner,
      issuer,
      heartbeatMs: 30_000,
      renewMs: 60_000,
      pollMs: 1_000,
      maxPeerLifetimeMs: 60_000,
      maxPeers: 4,
      ...(options.configureNative === false
        ? {}
        : {
            native: {
              surface,
              ...(options.nativeMaxPeers !== undefined
                ? { maxPeers: options.nativeMaxPeers }
                : {}),
            },
          }),
      observeStatus: (status) => h.statuses.push(status),
    },
    {
      signal: new AbortController().signal,
      fetch: async () => new Response('app'),
    } as never,
    {
      startAdapter: vi.fn(async () => {
        throw new Error('unexpected browser adapter start');
      }) as never,
      createNativeAdapter: (input) =>
        createNativeV2PionApplicationAdapter(input, {
          startAdapter: nativeStartAdapter as never,
          serve: serveApplicationChannel,
        }),
    },
  );
  // Default queue: exactly one matching offer, then empty.
  h.nativeOffersQueue.push(nativeOffer(NONCE));
  return { h, runtime, nativeOffer, cleanupResolvers };
}

async function mod(): Promise<{
  __captured: Array<{ closeCalls: number }>;
}> {
  return (await import(
    '@kontourai/station-connect/application-channel'
  )) as unknown as { __captured: Array<{ closeCalls: number }> };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('self-hosted broker pion runtime native opt-in', () => {
  test('opt-in native offer admitted only for the exact surface and current trust, with a verifiable proof', async () => {
    const { h, runtime } = await nativeHarness();
    await runtime.start();
    try {
      await waitFor(() => h.capturedNativeAnswer !== undefined);
      // The native offers request carries exactly the configured surface.
      expect(h.nativeOffersRequests.length).toBeGreaterThanOrEqual(1);
      expect(h.nativeOffersRequests[0]).toMatchObject({
        limit: 1,
        version: 'station-broker-native-connection-offer/v2',
        surface: h.surface,
      });
      // The published answer is bound to the exact surface and trust.
      expect(h.capturedNativeAnswer).toMatchObject({
        version: 'station-broker-native-connection-answer/v2',
        surface: h.surface,
        connection: {
          clientId: h.surface.clientInstanceId,
          nonce: NONCE,
          stationSigningKeyId: h.stationSigningKeyId,
          stationSigningGeneration: 1,
          answerSdp: ANSWER_SDP,
        },
      });
      const connection = h.capturedNativeAnswer!.connection as {
        stationProof: string;
      };
      const binding = {
        stationId: h.trust.stationId,
        enrollmentId: h.trust.enrollmentId,
        generation: h.trust.generation,
        connectionId: h.surface.clientInstanceId,
        clientNonce: NONCE,
        clientFingerprint: FP_CLIENT,
        stationFingerprint: FP_STATION,
        offerSha256: await connectionDescriptionDigest(OFFER_SDP),
        answerSha256: await connectionDescriptionDigest(ANSWER_SDP),
      };
      const verifier = createStationConnectionProofVerifier({
        trust: h.trust,
        expected: binding,
        isCurrent: () => true,
      });
      await expect(
        verifier.verifyAndConsume(connection.stationProof),
      ).resolves.toMatchObject({
        connectionId: h.surface.clientInstanceId,
      });
      // Post-proof channels are served through the same virtual application.
      const captured = (await mod()).__captured;
      const channelsBefore = captured.length;
      h.nativeAccept!({
        send: vi.fn(),
        close: vi.fn(),
        subscribe: () => () => undefined,
      });
      await waitFor(() => captured.length > channelsBefore);
      expect(h.statuses.at(-1)).toMatchObject({ state: 'registered' });
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });

  test('no native config: the lifecycle never requests or answers native offers', async () => {
    const { h, runtime } = await nativeHarness({ configureNative: false });
    await runtime.start();
    try {
      // At least two full poll ticks pass with the native endpoints untouched.
      await sleep(2_300);
      expect(h.nativeOffersRequests).toHaveLength(0);
      expect(h.capturedNativeAnswer).toBeUndefined();
      expect(h.nativeStartCalls).toBe(0);
      expect(h.statuses.at(-1)).toMatchObject({ state: 'registered' });
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });

  test('trust revoked mid-admission refuses the native offer before any peer is published', async () => {
    const { h, runtime, nativeOffer } = await nativeHarness({
      gateStart: true,
    });
    // A second offer would be answered after the revoked one if refusal
    // leaked; the queue keeps it waiting to prove it never dispatches.
    h.nativeOffersQueue.push(
      nativeOffer(randomBytes(32).toString('base64url')),
    );
    await runtime.start();
    try {
      await waitFor(() => h.nativeStartCalls >= 1);
      // Revoke trust while the admission is parked inside the peer start:
      // releasing must refuse the offer, never publish an answer.
      h.current = null;
      h.releaseStart!();
      await waitFor(() =>
        h.statuses.some(
          (status) => status.state === 'failed' || status.state === 'withdrawn',
        ),
      );
      expect(h.capturedNativeAnswer).toBeUndefined();
      expect(h.nativeOffersRequests).toHaveLength(1);
      expect(h.nativeStartCalls).toBe(1);
      await expect(runtime.shutdown()).rejects.toThrow(
        'native_pion_application_trust_retired',
      );
      expect(h.nativeStartCalls).toBe(1);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });

  test('data channels opened before proof verification are refused, not served', async () => {
    const { h, runtime } = await nativeHarness({ gateStart: true });
    await runtime.start();
    try {
      await waitFor(() => h.nativeStartCalls >= 1);
      const captured = (await mod()).__captured;
      const channelsBefore = captured.length;
      const early = {
        send: vi.fn(),
        close: vi.fn(),
        subscribe: () => () => undefined,
      };
      // Fired while the admission is still parked before proof verification.
      h.nativeAccept!(early);
      expect(early.close).toHaveBeenCalledTimes(1);
      h.releaseStart!();
      await waitFor(() => h.capturedNativeAnswer !== undefined);
      await sleep(50);
      expect(captured.length).toBe(channelsBefore);
      // A post-proof channel is served normally.
      const late = {
        send: vi.fn(),
        close: vi.fn(),
        subscribe: () => () => undefined,
      };
      h.nativeAccept!(late);
      expect(late.close).not.toHaveBeenCalled();
      await waitFor(() => captured.length > channelsBefore);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });

  test('shutdown closes owned native peers and joins their cleanup', async () => {
    const { h, runtime, cleanupResolvers } = await nativeHarness();
    await runtime.start();
    try {
      await waitFor(() => h.capturedNativeAnswer !== undefined);
      expect(h.nativeStartCalls).toBe(1);
    } finally {
      await runtime.shutdown();
    }
    expect(h.nativeCloseCalls).toBe(1);
    expect(h.withdrawCalls).toBe(1);
    // The fake peer's cleanup receipt was resolved through the close path.
    expect(cleanupResolvers.length).toBe(1);
    expect(h.statuses.at(-1)).toMatchObject({
      state: 'withdrawn',
      phase: 'withdrawal',
    });
  });

  test('at the owned native peer ceiling the runtime stops polling native offers instead of exceeding it', async () => {
    const { h, runtime, nativeOffer } = await nativeHarness({
      nativeMaxPeers: 1,
    });
    // Keep a steady supply of fresh offers: without the ceiling, every tick
    // would start another native peer.
    h.nativeOffersQueue.push(
      nativeOffer(randomBytes(32).toString('base64url')),
    );
    h.nativeOffersQueue.push(
      nativeOffer(randomBytes(32).toString('base64url')),
    );
    await runtime.start();
    try {
      await waitFor(() => h.capturedNativeAnswer !== undefined);
      expect(h.nativeStartCalls).toBe(1);
      // The first peer stays live (fake cleanup pending): the loop's next
      // queued offer is refused as backpressure, never admitted.
      await waitFor(() => h.nativeOffersRequests.length >= 2);
      expect(h.nativeStartCalls).toBe(1);
      // Later ticks skip the native lane entirely while at capacity, and the
      // runtime stays registered instead of failing.
      await sleep(2_300);
      expect(h.nativeOffersRequests.length).toBe(2);
      expect(h.nativeStartCalls).toBe(1);
      expect(h.statuses.at(-1)).toMatchObject({ state: 'registered' });
    } finally {
      h.nativeOffersQueue.length = 0;
      await runtime.shutdown().catch(() => undefined);
    }
  });
});
