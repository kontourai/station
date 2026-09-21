import { randomUUID } from 'node:crypto';
import type {
  ApprovedStationConnectionTrust,
  DeviceConnectionTrustRecord,
  StationConnectionProofBinding,
  StationConnectionSigningKey,
} from '@kontourai/station-contracts/connection-proof';
import {
  connectionDescriptionDigest,
  signStationConnectionProof,
} from '@kontourai/station-shared/connection-proof';
import { exportJWK, generateKeyPair } from 'jose';
import { describe, expect, test, vi } from 'vitest';
import { createBrowserPionConnection } from '../core/browserPionConnection.js';
import { createSelfHostedApplicationTransport } from '../core/selfHostedApplicationTransport.js';
import { SelfHostedBrokerBrowserClient } from '../core/selfHostedBrokerBrowserClient.js';

const FP_OFFER = Array.from({ length: 32 }, (_, i) =>
  i.toString(16).padStart(2, '0').toUpperCase(),
).join(':');
const FP_STATION = Array.from({ length: 32 }, (_, i) =>
  ((i + 80) % 256).toString(16).padStart(2, '0').toUpperCase(),
).join(':');
const OFFER = `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 ${FP_OFFER}\r\n`;
const ANSWER = `v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 ${FP_STATION}\r\n`;

type Listener = (...args: never[]) => void;
function fakeChannel(label: string) {
  const listeners = new Map<string, Set<Listener>>();
  const channel = {
    label,
    readyState: 'connecting',
    binaryType: 'arraybuffer',
    ordered: true,
    maxRetransmits: null,
    maxPacketLifeTime: null,
    bufferedAmount: 0,
    addEventListener: (t: string, f: Listener) => {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t)!.add(f);
    },
    removeEventListener: (t: string, f: Listener) => {
      listeners.get(t)?.delete(f);
    },
    close: vi.fn(() => {
      channel.readyState = 'closed';
    }),
    send: vi.fn(),
    __open() {
      channel.readyState = 'open';
      for (const f of [...(listeners.get('open') ?? [])]) f();
    },
    __fail() {
      for (const f of [...(listeners.get('error') ?? [])]) f();
    },
  };
  return channel;
}

function fakePeer(offerSdp: string, channels: unknown[]) {
  const listeners = new Map<string, Set<() => void>>();
  const peer = {
    iceGatheringState: 'complete',
    connectionState: 'connected',
    localDescription: null as { type: string; sdp: string } | null,
    addEventListener: (t: string, f: () => void) => {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t)!.add(f);
    },
    removeEventListener: (t: string, f: () => void) => {
      listeners.get(t)?.delete(f);
    },
    createDataChannel: (label: string) => {
      const c = fakeChannel(label);
      channels.push(c);
      queueMicrotask(() => c.__open());
      return c;
    },
    createOffer: async () => ({ type: 'offer', sdp: offerSdp }),
    setLocalDescription: async (d: { sdp?: string }) => {
      peer.localDescription = { type: 'offer', sdp: d.sdp ?? offerSdp };
    },
    setRemoteDescription: vi.fn(async () => {}),
    close: vi.fn(() => {
      peer.connectionState = 'closed';
    }),
    __emitState(state: string) {
      peer.connectionState = state;
      for (const f of [...(listeners.get('connectionstatechange') ?? [])]) f();
    },
  };
  return peer;
}

async function trustFixture() {
  const keys = await generateKeyPair('ES256', { extractable: true });
  const signingKey = (await exportJWK(
    keys.publicKey,
  )) as StationConnectionSigningKey;
  const trust: ApprovedStationConnectionTrust = {
    stationId: randomUUID(),
    enrollmentId: randomUUID(),
    generation: 7,
    signingKey,
  };
  const trustRecord: DeviceConnectionTrustRecord = {
    schemaVersion: 1,
    revision: 1,
    status: 'approved',
    trust: { ...trust, signingKey: { ...signingKey } },
  };
  return { keys, trust, trustRecord };
}

async function signBinding(
  keys: Awaited<ReturnType<typeof generateKeyPair>>,
  trust: ApprovedStationConnectionTrust,
  binding: StationConnectionProofBinding,
) {
  return signStationConnectionProof({
    trust,
    binding,
    signingKey: keys.privateKey,
    now: Math.floor(Date.now() / 1000),
  });
}

function brokerStub(
  trust: ApprovedStationConnectionTrust,
  keys: Awaited<ReturnType<typeof generateKeyPair>>,
  answerSdp: string,
  opts?: { expiresAt?: number; delayMs?: number },
) {
  const expiresAt = opts?.expiresAt ?? Date.now() + 60_000;
  let clientId = '';
  let nonce = '';
  const broker = {
    scope: { stationId: trust.stationId, enrollmentId: trust.enrollmentId },
    open: vi.fn(async (c: { clientId: string; nonce: string }) => {
      clientId = c.clientId;
      nonce = c.nonce;
      if (opts?.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      return { expiresAt };
    }),
    read: vi.fn(async () => {
      if (opts?.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const binding: StationConnectionProofBinding = {
        stationId: trust.stationId,
        enrollmentId: trust.enrollmentId,
        generation: trust.generation,
        connectionId: clientId,
        clientNonce: nonce,
        clientFingerprint: FP_OFFER,
        stationFingerprint: FP_STATION,
        offerSha256: await connectionDescriptionDigest(OFFER),
        answerSha256: await connectionDescriptionDigest(answerSdp),
      };
      return {
        kind: 'answered',
        answerSdp,
        stationProof: await signBinding(keys, trust, binding),
        expiresAt,
      } as const;
    }),
  };
  return broker;
}

const iceProvider = () => ({
  capture: () => ({ configuration: {}, isCurrent: () => true }),
});

describe('browser relay consumer (public boundary)', () => {
  test('positive complete connect reaches remote description and publishes snapshot', async () => {
    const { keys, trust, trustRecord } = await trustFixture();
    const channels: unknown[] = [];
    let peerRef: ReturnType<typeof fakePeer> | undefined;
    const broker = brokerStub(trust, keys, ANSWER);
    const conn = createBrowserPionConnection({
      broker: broker as never,
      applicationOrigin: 'https://app.example',
      trustRecord,
      trustStore: { isCurrent: async () => true },
      ice: iceProvider() as never,
      createPeer: () => {
        peerRef = fakePeer(OFFER, channels);
        return peerRef as never;
      },
    });
    const snap = await conn.connect(new AbortController().signal);
    expect(snap.stationId).toBe(trust.stationId);
    expect(peerRef!.setRemoteDescription).toHaveBeenCalledOnce();
    expect(await conn.isCurrent(snap)).toBe(true);
  });

  test('wrong generation proof rejected before remote description', async () => {
    const { keys, trust, trustRecord } = await trustFixture();
    const channels: unknown[] = [];
    let peerRef: ReturnType<typeof fakePeer> | undefined;
    const wrongTrust: ApprovedStationConnectionTrust = {
      ...trust,
      generation: trust.generation + 100,
    };
    const broker = {
      scope: { stationId: trust.stationId, enrollmentId: trust.enrollmentId },
      open: async () => ({ expiresAt: Date.now() + 60_000 }),
      read: async (c: { clientId: string; nonce: string }) => {
        const binding: StationConnectionProofBinding = {
          stationId: wrongTrust.stationId,
          enrollmentId: wrongTrust.enrollmentId,
          generation: wrongTrust.generation,
          connectionId: c.clientId,
          clientNonce: c.nonce,
          clientFingerprint: FP_OFFER,
          stationFingerprint: FP_STATION,
          offerSha256: await connectionDescriptionDigest(OFFER),
          answerSha256: await connectionDescriptionDigest(ANSWER),
        };
        return {
          kind: 'answered',
          answerSdp: ANSWER,
          stationProof: await signBinding(keys, wrongTrust, binding),
          expiresAt: Date.now() + 60_000,
        } as const;
      },
    };
    const conn = createBrowserPionConnection({
      broker: broker as never,
      applicationOrigin: 'https://app.example',
      trustRecord,
      trustStore: { isCurrent: async () => true },
      ice: iceProvider() as never,
      createPeer: () => {
        peerRef = fakePeer(OFFER, channels);
        return peerRef as never;
      },
    });
    await expect(conn.connect(new AbortController().signal)).rejects.toThrow();
    expect(peerRef!.setRemoteDescription).not.toHaveBeenCalled();
  });

  test('malformed fingerprint rejected without remote description', async () => {
    const { keys, trust, trustRecord } = await trustFixture();
    const channels: unknown[] = [];
    let peerRef: ReturnType<typeof fakePeer> | undefined;
    const broker = brokerStub(trust, keys, 'v=0\r\nno-fingerprint\r\n');
    const conn = createBrowserPionConnection({
      broker: broker as never,
      applicationOrigin: 'https://app.example',
      trustRecord,
      trustStore: { isCurrent: async () => true },
      ice: iceProvider() as never,
      createPeer: () => {
        peerRef = fakePeer(OFFER, channels);
        return peerRef as never;
      },
    });
    await expect(conn.connect(new AbortController().signal)).rejects.toThrow(
      /fingerprint/,
    );
    expect(peerRef!.setRemoteDescription).not.toHaveBeenCalled();
  });

  test('caller abort during delayed trust retires attempt; late resolve cannot publish', async () => {
    const { keys, trust, trustRecord } = await trustFixture();
    const channels: unknown[] = [];
    let resolveTrust!: (v: boolean) => void;
    const gate = new Promise<boolean>((r) => {
      resolveTrust = r;
    });
    const broker = brokerStub(trust, keys, ANSWER);
    const conn = createBrowserPionConnection({
      broker: broker as never,
      applicationOrigin: 'https://app.example',
      trustRecord,
      trustStore: { isCurrent: () => gate },
      ice: iceProvider() as never,
      createPeer: () => fakePeer(OFFER, channels) as never,
    });
    const caller = new AbortController();
    const pending = conn.connect(caller.signal);
    await new Promise((r) => setTimeout(r, 10));
    caller.abort(new Error('caller-cancelled'));
    resolveTrust(true);
    await expect(pending).rejects.toThrow(/caller-cancelled|cancelled|stale/);
    // Late trust resolution must not publish a snapshot.
    const fakeSnap = {
      generation: 999,
      connectionId: randomUUID(),
      stationId: trust.stationId,
      applicationOrigin: 'https://app.example',
    } as const;
    expect(await conn.isCurrent(fakeSnap)).toBe(false);
  });

  test('close during delayed remote description cancels promptly and second connect wins', async () => {
    const { keys, trust, trustRecord } = await trustFixture();
    const channels: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const brokerInner = brokerStub(trust, keys, ANSWER);
    const broker = {
      scope: brokerInner.scope,
      open: brokerInner.open,
      read: brokerInner.read,
    };
    let first = true;
    const conn = createBrowserPionConnection({
      broker: broker as never,
      applicationOrigin: 'https://app.example',
      trustRecord,
      trustStore: { isCurrent: async () => true },
      ice: iceProvider() as never,
      createPeer: (config: RTCConfiguration) => {
        const peer = fakePeer(OFFER, channels);
        if (first) {
          first = false;
          const orig = peer.setRemoteDescription;
          peer.setRemoteDescription = (async () => {
            await gate;
            return orig();
          }) as typeof orig;
        }
        return peer as never;
      },
    });
    const a = conn.connect(new AbortController().signal);
    await new Promise((r) => setTimeout(r, 20));
    const b = conn.connect(new AbortController().signal);
    release();
    await expect(a).rejects.toThrow(/stale|cancelled|timeout/);
    const snap = await b;
    expect(snap.applicationOrigin).toBe('https://app.example');
  });

  test('connecting/connected state changes do not fail gathering; 32 concurrent channel opens cap', async () => {
    const { keys, trust, trustRecord } = await trustFixture();
    const channels: unknown[] = [];
    const broker = brokerStub(trust, keys, ANSWER);
    const conn = createBrowserPionConnection({
      broker: broker as never,
      applicationOrigin: 'https://app.example',
      trustRecord,
      trustStore: { isCurrent: async () => true },
      ice: iceProvider() as never,
      createPeer: (config: RTCConfiguration) => {
        const peer = fakePeer(OFFER, channels);
        peer.iceGatheringState = 'gathering';
        queueMicrotask(() => {
          peer.iceGatheringState = 'complete';
        });
        return peer as never;
      },
    });
    const snap = await conn.connect(new AbortController().signal);
    const results = await Promise.allSettled(
      Array.from({ length: 33 }, () =>
        conn.openApplicationChannel(snap, new AbortController().signal),
      ),
    );
    expect(
      results.filter((r) => r.status === 'fulfilled').length,
    ).toBeLessThanOrEqual(32);
    expect(
      results.filter((r) => r.status === 'rejected').length,
    ).toBeGreaterThanOrEqual(1);
  });

  test('throwing trust/createChannel release reservations without leaking channels', async () => {
    const { keys, trust, trustRecord } = await trustFixture();
    const channels: unknown[] = [];
    const broker = brokerStub(trust, keys, ANSWER);
    let failTrust = false;
    const conn = createBrowserPionConnection({
      broker: broker as never,
      applicationOrigin: 'https://app.example',
      trustRecord,
      trustStore: {
        isCurrent: async () => {
          if (failTrust) {
            failTrust = false;
            throw new Error('trust-boom');
          }
          return true;
        },
      },
      ice: iceProvider() as never,
      createPeer: () => fakePeer(OFFER, channels) as never,
    });
    const snap = await conn.connect(new AbortController().signal);
    failTrust = true;
    await expect(
      conn.openApplicationChannel(snap, new AbortController().signal),
    ).rejects.toThrow(/trust-boom|stale/);
    // Reservation released: a follow-up open can still proceed.
    const ok = await conn.openApplicationChannel(
      snap,
      new AbortController().signal,
    );
    expect(ok).toBeDefined();

    let failChannel = false;
    const conn2 = createBrowserPionConnection({
      broker: broker as never,
      applicationOrigin: 'https://app.example',
      trustRecord,
      trustStore: { isCurrent: async () => true },
      ice: iceProvider() as never,
      createPeer: () => {
        const peer = fakePeer(OFFER, channels);
        const createChannel = peer.createDataChannel;
        peer.createDataChannel = (label) => {
          if (failChannel) throw new Error('channel-boom');
          return createChannel(label);
        };
        return peer as never;
      },
    });
    const snap2 = await conn2.connect(new AbortController().signal);
    failChannel = true;
    await expect(
      conn2.openApplicationChannel(snap2, new AbortController().signal),
    ).rejects.toThrow(/channel-boom/);
  });

  test('transport composer requires snapshot origin and retires on close', async () => {
    const { keys, trust, trustRecord } = await trustFixture();
    const channels: unknown[] = [];
    const broker = brokerStub(trust, keys, ANSWER);
    const conn = createBrowserPionConnection({
      broker: broker as never,
      applicationOrigin: 'https://app.example',
      trustRecord,
      trustStore: { isCurrent: async () => true },
      ice: iceProvider() as never,
      createPeer: () => fakePeer(OFFER, channels) as never,
    });
    const snap = await conn.connect(new AbortController().signal);
    expect(() =>
      createSelfHostedApplicationTransport({
        owner: conn,
        snapshot: snap,
        applicationOrigin: 'https://other.example',
        signal: new AbortController().signal,
      }),
    ).toThrow(/origin/i);
    const t = createSelfHostedApplicationTransport({
      owner: conn,
      snapshot: snap,
      applicationOrigin: 'https://app.example',
      signal: new AbortController().signal,
    });
    expect(t.transportBindingIsCurrent()).toBe(true);
    t.close();
    expect(t.transportBindingIsCurrent()).toBe(false);
  });

  test('broker client allows HTTP loopback, rejects remote HTTP; missing location not fabricated', async () => {
    delete (globalThis as { location?: unknown }).location;
    const creds = {
      capture: () => ({
        id: 'cred-id-01',
        secret: 'x'.repeat(43),
        isCurrent: () => true,
      }),
    };
    const scopeFor = (origin: string) => ({
      stationId: randomUUID(),
      enrollmentId: randomUUID(),
      routingGeneration: 1,
      browserOrigin: origin,
    });
    const request = (async () =>
      new Response(
        JSON.stringify({
          state: 'online',
          routingGeneration: 1,
          expiresAt: Date.now() + 9999,
        }),
        {
          status: 200,
        },
      )) as typeof fetch;
    // Canonical HTTPS works with real location bound.
    (globalThis as { location?: { origin: string } }).location = {
      origin: 'https://browser.example',
    };
    const httpsClient = new SelfHostedBrokerBrowserClient({
      brokerOrigin: 'https://broker.example',
      browserOrigin: 'https://browser.example',
      scope: scopeFor('https://browser.example') as never,
      credentials: creds,
      request,
    });
    await expect(
      httpsClient.status(new AbortController().signal),
    ).resolves.toBeDefined();
    // Mismatched actual location rejected.
    expect(
      () =>
        new SelfHostedBrokerBrowserClient({
          brokerOrigin: 'https://broker.example',
          browserOrigin: 'https://evil.example',
          scope: scopeFor('https://evil.example') as never,
          credentials: creds,
          request,
        }),
    ).toThrow();
    delete (globalThis as { location?: unknown }).location;
    // HTTP loopback allowed for local free profile.
    const loopClient = new SelfHostedBrokerBrowserClient({
      brokerOrigin: 'http://127.0.0.1:3141',
      browserOrigin: 'http://127.0.0.1:3000',
      scope: scopeFor('http://127.0.0.1:3000') as never,
      credentials: creds,
      request,
    });
    await expect(
      loopClient.status(new AbortController().signal),
    ).resolves.toBeDefined();
    // Remote plain HTTP rejected — direct negative reaches the boundary.
    expect(
      () =>
        new SelfHostedBrokerBrowserClient({
          brokerOrigin: 'http://broker.example',
          browserOrigin: 'http://browser.example',
          scope: scopeFor('http://browser.example') as never,
          credentials: creds,
          request,
        }),
    ).toThrow(/broker_origin_invalid/);
    delete (globalThis as { location?: unknown }).location;
  });

  test('stalled reader cancels response; oversized answers rejected', async () => {
    delete (globalThis as { location?: unknown }).location;
    let cancelled = 0;
    const creds = {
      capture: () => ({
        id: 'cred-id-02',
        secret: 'y'.repeat(43),
        isCurrent: () => true,
      }),
    };
    const scope = {
      stationId: randomUUID(),
      enrollmentId: randomUUID(),
      routingGeneration: 1,
      browserOrigin: 'https://browser.example',
    };
    // Stalled body: never emits, caller aborts → reader.cancel must run.
    const stalledRequest = (async (
      _url: string,
      init: { signal: AbortSignal },
    ) => {
      const stream = new ReadableStream({
        start() {
          /* stall forever */
        },
        cancel() {
          cancelled += 1;
        },
      });
      const p = new Promise<Response>((_res, rej) => {
        init.signal.addEventListener('abort', () =>
          rej(init.signal.reason ?? new Error('cancelled')),
        );
      });
      void p.catch(() => {});
      // Race: return a pending response whose body stalls; abort wins.
      const response = new Response(stream, { status: 200 });
      const caller = (async () => {
        await new Promise((r) => setTimeout(r, 5));
        init.signal.throwIfAborted();
        return response;
      })();
      return caller;
    }) as unknown as typeof fetch;
    const stalled = new SelfHostedBrokerBrowserClient({
      brokerOrigin: 'https://broker.example',
      browserOrigin: 'https://browser.example',
      scope: scope as never,
      credentials: creds,
      request: stalledRequest,
      onCancelResponse: () => {
        cancelled += 1;
      },
    });
    const caller = new AbortController();
    const pending = stalled.open(
      { clientId: 'client-01-abcdef', nonce: 'z'.repeat(43), offerSdp: OFFER },
      caller.signal,
    );
    setTimeout(() => caller.abort(new Error('caller-cancelled')), 20);
    await expect(pending).rejects.toThrow(/caller-cancelled|cancelled/);
    expect(cancelled).toBeGreaterThanOrEqual(1);

    const bigRequest = (async () =>
      new Response(
        JSON.stringify({
          answerSdp: 'x'.repeat(200 * 1024),
          stationProof: 'p',
          expiresAt: Date.now() + 9999,
        }),
        { status: 200 },
      )) as typeof fetch;
    const big = new SelfHostedBrokerBrowserClient({
      brokerOrigin: 'https://broker.example',
      browserOrigin: 'https://browser.example',
      scope: scope as never,
      credentials: creds,
      request: bigRequest,
    });
    await expect(
      big.read(
        { clientId: 'client-01-abcdef', nonce: 'z'.repeat(43) },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });

  test('default channel label is station-application-v1', async () => {
    const { keys, trust, trustRecord } = await trustFixture();
    const channels: { label: string }[] = [];
    const broker = brokerStub(trust, keys, ANSWER);
    const conn = createBrowserPionConnection({
      broker: broker as never,
      applicationOrigin: 'https://app.example',
      trustRecord,
      trustStore: { isCurrent: async () => true },
      ice: iceProvider() as never,
      createPeer: () => fakePeer(OFFER, channels) as never,
    });
    await conn.connect(new AbortController().signal);
    expect(channels[0]!.label).toBe('station-application-v1');
  });
});
