import { randomBytes, randomUUID } from 'node:crypto';
import type {
  ApprovedStationConnectionTrust,
  StationConnectionSigningKey,
} from '@kontourai/station-contracts/connection-proof';
import {
  connectionDescriptionDigest,
  createStationConnectionProofVerifier,
  signStationConnectionProof,
} from '@kontourai/station-shared/connection-proof';
import { exportJWK, generateKeyPair } from 'jose';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createSelfHostedBrokerPionRuntime } from '../self-hosted-broker-pion-runtime.js';

vi.mock('@kontourai/station-connect/application-channel', () => {
  const captured: Array<{
    channel: {
      send(m: string): void;
      close(): void;
      subscribe(a: (v: unknown) => void, b: () => void): () => void;
    };
    inbound: Array<(v: unknown) => void>;
  }> = [];
  return {
    serveApplicationChannel: (channel: {
      send(m: string): void;
      close(): void;
      subscribe(a: (v: unknown) => void, b: () => void): () => void;
    }) => {
      const entry = { channel, inbound: [] as Array<(v: unknown) => void> };
      captured.push(entry);
      const delivered: unknown[] = [];
      const unsub = channel.subscribe(
        (value: unknown) => {
          delivered.push(value);
        },
        () => undefined,
      );
      (entry as unknown as Record<string, unknown>).delivered = delivered;
      (entry as unknown as Record<string, unknown>).unsub = unsub;
      return () => undefined;
    },
    __captured: captured,
  };
});

const CLIENT_ID = randomUUID();
const NONCE = randomBytes(32).toString('base64url');
const FP_CLIENT = Array(32).fill('AA').join(':');
const FP_STATION = Array(32).fill('BB').join(':');
const OFFER_SDP = `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 ${FP_CLIENT}\r\n`;
const ANSWER_SDP = `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 ${FP_STATION}\r\n`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function keys() {
  const pair = await generateKeyPair('ES256', { extractable: true });
  return pair;
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface Harness {
  trust: ApprovedStationConnectionTrust;
  privateKey: CryptoKey;
  current: ApprovedStationConnectionTrust | null;
  live: boolean;
  capturedProof: string | undefined;
  closeCalls: number;
  acceptCallback:
    | ((channel: {
        send(m: string): void;
        close(): void;
        subscribe(a: (v: unknown) => void, b: () => void): () => void;
      }) => void)
    | undefined;
  withdrawShouldFail: boolean;
  answerShouldFail: boolean;
}

async function harness(
  options: { maxPeers?: number; wrongIssuer?: boolean } = {},
) {
  const pair = await keys();
  const wrong = options.wrongIssuer ? await keys() : null;
  const trust: ApprovedStationConnectionTrust = {
    stationId: randomUUID(),
    enrollmentId: randomUUID(),
    generation: 1,
    signingKey: (await exportJWK(
      pair.publicKey,
    )) as StationConnectionSigningKey,
  };
  const h: Harness = {
    trust,
    privateKey: wrong ? wrong.privateKey : pair.privateKey,
    current: trust,
    live: true,
    capturedProof: undefined,
    closeCalls: 0,
    acceptCallback: undefined,
    withdrawShouldFail: false,
    answerShouldFail: false,
  };
  let offersServed = 0;
  const fetchStub = vi.fn(async (url: string) => {
    if (url.endsWith('/leases/register')) {
      return jsonResponse({
        registeredAt: Date.now(),
        revision: 1,
        expiresAt: Date.now() + 60_000,
      });
    }
    if (url.endsWith('/leases/renew')) {
      return jsonResponse({ revision: 2, expiresAt: Date.now() + 60_000 });
    }
    if (url.endsWith('/connections/offers')) {
      if (!h.live) return jsonResponse({ offers: [] });
      offersServed += 1;
      if (offersServed > 1) return jsonResponse({ offers: [] });
      return jsonResponse({
        offers: [
          {
            clientId: CLIENT_ID,
            nonce: NONCE,
            offerSdp: OFFER_SDP,
            expiresAt: Date.now() + 60_000,
          },
        ],
      });
    }
    if (url.endsWith('/connections/answer')) {
      if (h.answerShouldFail)
        return new Response(JSON.stringify({ accepted: false }), {
          status: 200,
        });
      return jsonResponse({ accepted: true });
    }
    if (url.endsWith('/leases/withdraw')) {
      if (h.withdrawShouldFail)
        return new Response(JSON.stringify({ withdrawn: false }), {
          status: 200,
        });
      return jsonResponse({ withdrawn: true });
    }
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal('fetch', fetchStub);

  type FakeAdapter = {
    answer: { type: 'answer'; sdp: string };
    close: () => Promise<void>;
    cleanupComplete: Promise<void>;
  };
  const adapters: FakeAdapter[] = [];
  const startAdapter = vi.fn(
    async (input: Record<string, unknown>): Promise<FakeAdapter> => {
      h.closeCalls += 0;
      let resolveCleanup!: () => void;
      const cleanupComplete = new Promise<void>((resolve) => {
        resolveCleanup = resolve;
      });
      cleanupComplete.then(undefined, () => {});
      const adapter = {
        answer: { type: 'answer' as const, sdp: ANSWER_SDP },
        close: vi.fn(async () => {
          h.closeCalls += 1;
          resolveCleanup();
        }),
        cleanupComplete,
      };
      adapters.push(adapter);
      h.acceptCallback = input.accept as Harness['acceptCallback'];
      return adapter;
    },
  );

  const scope = {
    stationId: trust.stationId,
    enrollmentId: trust.enrollmentId,
    routingGeneration: 1,
    browserOrigin: 'https://browser.example',
  };
  const trustOwner = {
    // Fresh clones each call: reference identity must not be required.
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
        signingKey: h.privateKey,
        now: Math.floor(Date.now() / 1000),
      }),
  };
  const application = {
    signal: new AbortController().signal,
    fetch: async (_request: Request) => new Response('app'),
  };
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
      maxPeers: options.maxPeers ?? 4,
    },
    application as never,
    { startAdapter: startAdapter as never },
  );
  // Capture published proofs through the answer endpoint body.
  const origImpl = fetchStub.getMockImplementation()!;
  fetchStub.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/connections/answer') && typeof init?.body === 'string') {
      try {
        h.capturedProof = (
          JSON.parse(init.body) as { connection: { stationProof: string } }
        ).connection.stationProof;
      } catch {
        // Ignore parse failure; endpoint stub below reports it.
      }
    }
    return origImpl(url);
  });
  return { h, runtime, startAdapter, fetchStub };
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

describe('self-hosted broker pion factory', () => {
  test('admits with fresh-clone trust and publishes a cryptographically valid proof', async () => {
    const { h, runtime } = await harness();
    await runtime.start();
    try {
      await waitFor(() => h.capturedProof !== undefined);
      const binding = {
        stationId: h.trust.stationId,
        enrollmentId: h.trust.enrollmentId,
        generation: 1,
        connectionId: CLIENT_ID,
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
        verifier.verifyAndConsume(h.capturedProof!),
      ).resolves.toEqual(expect.objectContaining({ connectionId: CLIENT_ID }));
    } finally {
      await runtime.shutdown();
    }
    expect(h.closeCalls).toBe(1);
  });

  test('wrong-issuer proof fails publication and releases capacity', async () => {
    const { h, runtime, startAdapter } = await harness({
      maxPeers: 1,
      wrongIssuer: true,
    });
    await runtime.start();
    try {
      // Proof issuance succeeds (wrong key) but verification must refuse;
      // the failed publish cleans the adapter without leaking capacity.
      await waitFor(() => startAdapter.mock.calls.length >= 1);
      await waitFor(() => h.closeCalls >= 1);
      expect(h.capturedProof).toBeUndefined();
      expect(h.closeCalls).toBeGreaterThanOrEqual(1);
    } finally {
      h.live = false;
      await runtime.shutdown().catch(() => undefined);
    }
  });

  test('retired trust gates application frames in both directions', async () => {
    const { h, runtime } = await harness();
    await runtime.start();
    try {
      await waitFor(() => h.acceptCallback !== undefined);
      const received: unknown[] = [];
      let rawInbound: ((value: unknown) => void) | undefined;
      const raw = {
        send: vi.fn(),
        close: vi.fn(),
        subscribe: (message: (value: unknown) => void, _closed: () => void) => {
          rawInbound = message;
          return () => undefined;
        },
      };
      h.acceptCallback!(raw as never);
      const mod = (await import(
        '@kontourai/station-connect/application-channel'
      )) as unknown as {
        __captured: Array<{
          channel: { send(m: string): void };
          inbound: Array<(v: unknown) => void>;
          delivered?: unknown[];
        }>;
      };
      await waitFor(() => mod.__captured.length >= 1);
      const gated = mod.__captured[0]!.channel;
      // Outgoing before retirement passes through to the raw channel.
      gated.send('hello');
      expect(raw.send).toHaveBeenCalledWith('hello');
      // Retire trust: outgoing must throw and incoming must drop.
      h.current = null;
      expect(() => gated.send('late')).toThrow('broker_runtime_trust_retired');
      expect(raw.send).toHaveBeenCalledTimes(1);
      // Inbound path: deliver through the raw channel's subscriber; the gate
      // must drop it instead of forwarding to the app handler.
      const deliveredBefore =
        (mod.__captured[0] as { delivered?: unknown[] }).delivered ?? [];
      const countBefore = deliveredBefore.length;
      rawInbound!({ late: true });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const deliveredAfter =
        (mod.__captured[0] as { delivered?: unknown[] }).delivered ?? [];
      expect(deliveredAfter.length).toBe(countBefore);
      void received;
    } finally {
      h.live = false;
      await runtime.shutdown().catch(() => undefined);
    }
  });

  test('lost withdraw reply still closes peers and reports failure', async () => {
    const { h, runtime } = await harness();
    await runtime.start();
    try {
      await waitFor(() => h.capturedProof !== undefined);
      h.withdrawShouldFail = true;
      await expect(runtime.shutdown()).rejects.toThrow();
      expect(h.closeCalls).toBe(1);
    } finally {
      h.withdrawShouldFail = false;
    }
  });

  test('adapter operational close failure joins cleanup receipt (settlement fault)', async () => {
    const { h, runtime, startAdapter } = await harness();
    startAdapter.mockImplementationOnce(
      async (input: Record<string, unknown>) => {
        let rejectCleanup!: (error: unknown) => void;
        const cleanupComplete = new Promise<void>((_resolve, reject) => {
          rejectCleanup = reject;
        });
        cleanupComplete.then(undefined, () => {});
        const adapter = {
          answer: { type: 'answer' as const, sdp: ANSWER_SDP },
          close: vi.fn(async () => {
            h.closeCalls += 1;
            rejectCleanup(new Error('pion_temp_cleanup_incomplete'));
            throw new Error('pion_operational_abort');
          }),
          cleanupComplete,
        };
        h.acceptCallback = input.accept as Harness['acceptCallback'];
        return adapter as never;
      },
    );
    await runtime.start();
    try {
      await waitFor(() => h.capturedProof !== undefined);
      await expect(runtime.shutdown()).rejects.toThrow(
        'pion_temp_cleanup_incomplete',
      );
      expect(h.closeCalls).toBe(1);
    } finally {
      h.live = false;
      await runtime.shutdown().catch(() => undefined);
    }
  });
});
