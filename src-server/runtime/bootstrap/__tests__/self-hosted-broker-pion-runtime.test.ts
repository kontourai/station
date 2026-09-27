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
import { Hono } from 'hono';
import { exportJWK, generateKeyPair } from 'jose';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  readVerifiedVirtualApplicationRequest,
  type VirtualApplication,
  VirtualApplicationIngress,
} from '../../../services/connections/virtual-application.js';
import {
  createSelfHostedBrokerPionRuntime,
  readVerifiedPionApplicationRequest,
} from '../self-hosted-broker-pion-runtime.js';

vi.mock('@kontourai/station-connect/application-channel', () => {
  const captured: Array<{
    channel: {
      send(m: string): void;
      close(): void;
      subscribe(a: (v: unknown) => void, b: () => void): () => void;
    };
    inbound: Array<(v: unknown) => void>;
    closeCalls: number;
    application: {
      signal: AbortSignal;
      fetch(request: Request): Promise<Response>;
    };
  }> = [];
  return {
    serveApplicationChannel: (
      channel: {
        send(m: string): void;
        close(): void;
        subscribe(a: (v: unknown) => void, b: () => void): () => void;
      },
      _origin: string,
      application: {
        signal: AbortSignal;
        fetch(request: Request): Promise<Response>;
      },
    ) => {
      const entry = {
        channel,
        inbound: [] as Array<(v: unknown) => void>,
        closeCalls: 0,
        application,
      };
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
  /**
   * Settles when the runtime publishes its answer to the broker. The runtime
   * publishes only after the peer entry exists, so a channel accepted after
   * this is served; one accepted before it is refused and closed. Rejects if
   * the adapter is closed first, which is how a failed admission ends.
   */
  admitted: Promise<void>;
}

async function harness(
  options: {
    maxPeers?: number;
    wrongIssuer?: boolean;
    application?: VirtualApplication;
    offerBrowserOrigin?: string;
    observeStatus?: (status: {
      state: string;
      phase: string;
      reason?: string;
    }) => void;
  } = {},
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
  let markAdmitted!: () => void;
  let failAdmission!: (error: Error) => void;
  const admitted = new Promise<void>((resolve, reject) => {
    markAdmitted = resolve;
    failAdmission = reject;
  });
  // Tests that expect admission to fail never await this.
  admitted.catch(() => undefined);
  const h: Harness = {
    admitted,
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
            browserOrigin: options.offerBrowserOrigin ?? scope.browserOrigin,
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
          failAdmission(new Error('test_adapter_closed_before_admission'));
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
  const application = options.application ?? {
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
      observeStatus: options.observeStatus,
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
        markAdmitted();
      } catch {
        // Ignore parse failure; endpoint stub below reports it. A test awaiting
        // admission gets a named failure instead of vitest's generic timeout.
        failAdmission(new Error('test_answer_body_unparseable'));
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
  test('forwards lifecycle status through Pion composition without implying application readiness', async () => {
    const statuses: Array<{ state: string; phase: string }> = [];
    const { runtime } = await harness({
      observeStatus: ({ state, phase }) => statuses.push({ state, phase }),
    });
    await runtime.start();
    expect(statuses.slice(0, 2)).toEqual([
      { state: 'starting', phase: 'registration' },
      { state: 'registered', phase: 'registration' },
    ]);
    await runtime.shutdown();
    expect(statuses.at(-1)).toEqual({
      state: 'withdrawn',
      phase: 'withdrawal',
    });
  });
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

  test.each(['https://browser.example', 'https://zach.example'])(
    'copies only an admitted Pion peer fact for %s and aborts it on retirement',
    async (clientOrigin) => {
      const app = new Hono();
      let sawFacts: ReturnType<typeof readVerifiedVirtualApplicationRequest>;
      let requestSignal: AbortSignal | undefined;
      let unblock!: () => void;
      const blocked = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      app.post('/relay-enrollment-test', async (c) => {
        sawFacts = readVerifiedVirtualApplicationRequest(c.req.raw);
        if (sawFacts) {
          requestSignal = c.req.raw.signal;
          await blocked;
        }
        return c.json({ admitted: !!sawFacts });
      });
      const owner = new VirtualApplicationIngress(
        'https://station.example',
        readVerifiedPionApplicationRequest,
      );
      owner.bind({ fetch: (request) => app.fetch(request) });
      const application = owner.activate();
      const { h, runtime } = await harness({
        application,
        offerBrowserOrigin: clientOrigin,
      });
      await runtime.start();
      try {
        await waitFor(() => h.capturedProof !== undefined);
        const rawChannel = {
          send: vi.fn(),
          close: vi.fn(),
          subscribe: () => () => undefined,
        };
        h.acceptCallback!(rawChannel as never);
        const mod = (await import(
          '@kontourai/station-connect/application-channel'
        )) as unknown as {
          __captured: Array<{
            application: {
              fetch(request: Request): Promise<Response>;
            };
          }>;
        };
        await waitFor(() => mod.__captured.length > 0);
        const dispatch = mod.__captured.at(-1)!.application.fetch;
        const request = new Request(
          'https://station.example/relay-enrollment-test',
          {
            method: 'POST',
            headers: { Origin: clientOrigin },
            body: '{}',
          },
        );
        const pending = dispatch(request);
        await waitFor(() => requestSignal !== undefined);
        expect(readVerifiedPionApplicationRequest(request)).toMatchObject({
          stationId: h.trust.stationId,
          connectionEnrollmentId: h.trust.enrollmentId,
          routingGeneration: h.trust.generation,
          connectionId: CLIENT_ID,
          browserOrigin: clientOrigin,
        });
        expect(readVerifiedVirtualApplicationRequest(request)).toBeUndefined();
        expect(sawFacts).toMatchObject({
          stationId: h.trust.stationId,
          connectionEnrollmentId: h.trust.enrollmentId,
          routingGeneration: h.trust.generation,
          connectionId: CLIENT_ID,
          clientOrigin,
          requestOrigin: 'https://station.example',
        });

        const direct = await app.fetch(
          new Request('https://station.example/relay-enrollment-test', {
            method: 'POST',
            headers: {
              Origin: clientOrigin,
              'X-Pion-Verified': 'true',
            },
            body: '{}',
          }),
        );
        expect(direct.status).toBe(200);
        expect(((await direct.json()) as { admitted: boolean }).admitted).toBe(
          false,
        );
        const genericVirtual = await application.fetch(
          new Request('https://station.example/relay-enrollment-test', {
            method: 'POST',
            headers: { Origin: clientOrigin },
            body: '{}',
          }),
        );
        expect(genericVirtual.status).toBe(200);
        expect(
          ((await genericVirtual.json()) as { admitted: boolean }).admitted,
        ).toBe(false);

        const wrongOrigin = await dispatch(
          new Request('https://station.example/relay-enrollment-test', {
            method: 'POST',
            headers: { Origin: 'https://attacker.example' },
            body: '{}',
          }),
        );
        expect(wrongOrigin.status).toBe(403);

        h.current = null;
        const stale = await dispatch(
          new Request('https://station.example/relay-enrollment-test', {
            method: 'POST',
            headers: { Origin: clientOrigin },
            body: '{}',
          }),
        );
        expect(stale.status).toBe(503);
        await expect(pending).rejects.toThrow();
        expect(requestSignal?.aborted).toBe(true);
        unblock();
      } finally {
        unblock();
        h.live = false;
        await runtime.shutdown().catch(() => undefined);
        owner.stop();
      }
    },
  );

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
      // Admission completes in the background after start(): a channel
      // accepted before the peer entry exists is refused, not queued (#2557).
      await h.admitted;
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
      const mod = (await import(
        '@kontourai/station-connect/application-channel'
      )) as unknown as {
        __captured: Array<{
          channel: { send(m: string): void };
          inbound: Array<(v: unknown) => void>;
          delivered?: unknown[];
        }>;
      };
      const base = mod.__captured.length;
      h.acceptCallback!(raw as never);
      // accept serves the channel synchronously.
      expect(raw.close).not.toHaveBeenCalled();
      expect(mod.__captured.length).toBe(base + 1);
      const entry = mod.__captured[base]!;
      const gated = entry.channel;
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
        (entry as { delivered?: unknown[] }).delivered ?? [];
      const countBefore = deliveredBefore.length;
      rawInbound!({ late: true });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const deliveredAfter =
        (entry as { delivered?: unknown[] }).delivered ?? [];
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

  test('closed channels retire handlers: no re-close, bounded simultaneous handlers', async () => {
    const { h, runtime } = await harness();
    await runtime.start();
    try {
      await waitFor(() => h.acceptCallback !== undefined);
      await waitFor(() => h.capturedProof !== undefined);
      const mod = (await import(
        '@kontourai/station-connect/application-channel'
      )) as unknown as {
        __captured: Array<{
          channel: { send(m: string): void };
          closeCalls: number;
        }>;
      };
      const base = mod.__captured.length;
      const raws: Array<{ close: ReturnType<typeof vi.fn> }> = [];
      const closedCbs: Array<() => void> = [];
      const openRaw = (syncClose = false) => {
        const raw = {
          send: vi.fn(),
          close: vi.fn(),
          subscribe: (
            _message: (value: unknown) => void,
            closed: () => void,
          ) => {
            closedCbs.push(closed);
            if (syncClose) closed();
            return () => undefined;
          },
        };
        raws.push(raw);
        h.acceptCallback!(raw as never);
        return raw;
      };
      // Synchronous close during subscription must be safe, never retained.
      openRaw(true);
      expect(raws[0]!.close).toHaveBeenCalledTimes(1);
      // Many sequential closed channels: each fires its real closed event.
      for (let i = 0; i < 70; i += 1) {
        const raw = openRaw();
        expect(raw.close).not.toHaveBeenCalled();
        closedCbs.at(-1)!();
      }
      // Duplicate closed events must not double-close.
      for (const cb of closedCbs.slice(1)) cb();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const fresh = mod.__captured.slice(base);
      // 1 sync-closed + 70 closed: none retained, so retirement closes none.
      const before = fresh.map((e) => e.closeCalls);
      h.live = false;
      await runtime.shutdown();
      await waitFor(() => h.closeCalls >= 1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const after = mod.__captured.slice(base).map((e) => e.closeCalls);
      for (let i = 0; i < 71; i += 1) {
        expect(after[i]).toBe(before[i]);
      }
      expect(h.closeCalls).toBe(1);
    } finally {
      h.live = false;
      h.current = null;
      await runtime.shutdown().catch(() => undefined);
    }
  });

  test('simultaneous handlers capped at 32: retirement closes at most 32', async () => {
    const { h, runtime } = await harness();
    await runtime.start();
    try {
      await waitFor(() => h.acceptCallback !== undefined);
      await waitFor(() => h.capturedProof !== undefined);
      const mod = (await import(
        '@kontourai/station-connect/application-channel'
      )) as unknown as {
        __captured: Array<{ closeCalls: number }>;
      };
      const base = mod.__captured.length;
      const raws: Array<{ close: ReturnType<typeof vi.fn> }> = [];
      for (let i = 0; i < 40; i += 1) {
        const raw = {
          send: vi.fn(),
          close: vi.fn(),
          subscribe: () => () => undefined,
        };
        raws.push(raw);
        h.acceptCallback!(raw as never);
      }
      await waitFor(() => mod.__captured.length >= base + 40);
      expect(
        raws.slice(0, 32).every((raw) => raw.close.mock.calls.length === 0),
      ).toBe(true);
      expect(
        raws.slice(32).every((raw) => raw.close.mock.calls.length === 1),
      ).toBe(true);
      h.live = false;
      await runtime.shutdown();
      await waitFor(() => h.closeCalls >= 1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const retired = mod.__captured.slice(base, base + 40);
      const totalCloses = retired.reduce((n, e) => n + e.closeCalls, 0);
      expect(totalCloses).toBe(40);
      expect(h.closeCalls).toBe(1);
    } finally {
      h.live = false;
      h.current = null;
      await runtime.shutdown().catch(() => undefined);
    }
  });

  test('duplicate trust retirement runs one adapter close', async () => {
    const { h, runtime } = await harness();
    await runtime.start();
    try {
      await waitFor(() => h.acceptCallback !== undefined);
      await waitFor(() => h.capturedProof !== undefined);
      const raw = {
        send: vi.fn(),
        close: vi.fn(),
        subscribe: () => () => undefined,
      };
      h.acceptCallback!(raw as never);
      const mod = (await import(
        '@kontourai/station-connect/application-channel'
      )) as unknown as { __captured: Array<unknown> };
      await waitFor(() => mod.__captured.length >= 1);
      h.current = null;
      const gated = mod.__captured[mod.__captured.length - 1] as {
        channel: { send(m: string): void };
      };
      // Two duplicate retirement triggers through the same trust gate.
      expect(() => gated.channel.send('one')).toThrow(
        'broker_runtime_trust_retired',
      );
      expect(() => gated.channel.send('two')).toThrow(
        'broker_runtime_trust_retired',
      );
      await waitFor(() => h.closeCalls >= 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(h.closeCalls).toBe(1);
    } finally {
      h.live = false;
      await runtime.shutdown().catch(() => undefined);
    }
  });

  test('failed admission with failed cleanup retains evidence, surfaces cleanup receipt', async () => {
    const { h, runtime, startAdapter } = await harness({
      maxPeers: 1,
      wrongIssuer: true,
    });
    startAdapter.mockImplementationOnce(
      async (input: Record<string, unknown>) => {
        const cleanupComplete = Promise.reject(
          new Error('pion_temp_cleanup_incomplete'),
        );
        cleanupComplete.then(undefined, () => {});
        const adapter = {
          answer: { type: 'answer' as const, sdp: ANSWER_SDP },
          close: vi.fn(async () => {
            h.closeCalls += 1;
          }),
          cleanupComplete,
        };
        h.acceptCallback = input.accept as Harness['acceptCallback'];
        return adapter as never;
      },
    );
    await runtime.start();
    try {
      await waitFor(() => startAdapter.mock.calls.length >= 1);
      await waitFor(() => h.closeCalls >= 1);
      // Admission failed (wrong issuer) and cleanup failed: no proof, the
      // adapter-owned receipt stays authoritative, and the retained entry
      // surfaces its cleanup failure on shutdown instead of vanishing.
      expect(h.capturedProof).toBeUndefined();
      h.live = false;
      let failure: unknown;
      try {
        await runtime.shutdown();
      } catch (error) {
        failure = error;
      }
      const messages = (error: unknown): string[] =>
        error instanceof AggregateError
          ? [error.message, ...error.errors.flatMap(messages)]
          : error instanceof Error
            ? [error.message]
            : [];
      expect(messages(failure)).toContain('Station connection proof refused');
      expect(messages(failure)).toContain('pion_temp_cleanup_incomplete');
      expect(messages(failure)).toContain(
        'broker_runtime_admission_cleanup_failed',
      );
      expect(h.closeCalls).toBe(1);
    } finally {
      h.live = false;
      await runtime.shutdown().catch(() => undefined);
    }
  });
});
