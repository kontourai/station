import {
  APPLICATION_TRANSPORT_CHANNEL,
  createNativeApplicationTransport,
  createNativeVerifiedPeerTransport,
} from '@kontourai/station-connect/native-application';
import type {
  ApprovedStationConnectionTrust,
  StationConnectionProofBinding,
} from '@kontourai/station-contracts/connection-proof';
import { NATIVE_DEVICE_PROOF_HEADER } from '@kontourai/station-contracts/native-device-proof';
import {
  connectionDescriptionDigest,
  signStationConnectionProof,
} from '@kontourai/station-shared/connection-proof';
import { exportJWK, generateKeyPair } from 'jose';
import { describe, expect, test, vi } from 'vitest';
import { writeApplicationFrame } from '../core/applicationChannelFrames.js';
import type {
  NativeApplicationPeerAnswer,
  NativeApplicationTransportInput,
} from '../core/nativeApplicationTransport.js';

const CLIENT_FP = Array(32).fill('AA').join(':');
const STATION_FP = Array(32).fill('BB').join(':');
const OFFER_SDP = `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 ${CLIENT_FP}\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=sctp-port:5000\r\n`;
const ANSWER_SDP = `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 ${STATION_FP}\r\n`;
const EXPIRES_AT = Date.now() + 30_000;
const PEER_HANDLE = 'A'.repeat(43);
const PEER_NONCE = 'B'.repeat(43);
const PEER_EXPIRES_AT = Date.now() + 120_000;
const ORIGIN = 'https://station.example';

function peerDescriptor(connectionId = '33333333-3333-4333-8333-333333333333') {
  return {
    version: 'station-native-application-peer/v1',
    peerHandle: PEER_HANDLE,
    nonce: PEER_NONCE,
    connectionId,
    expiresAt: PEER_EXPIRES_AT,
  };
}

class FakeChannel extends EventTarget {
  readonly label: string;
  readyState = 'connecting';
  constructor(label: string) {
    super();
    this.label = label;
  }
  bufferedAmount = 0;
  readonly ordered = true;
  readonly maxRetransmits: number | null = null;
  readonly maxPacketLifeTime: number | null = null;
  closed = false;
  sent: string[] = [];
  peerListeners = new Set<(value: string) => void>();
  /** Deliver a remote-side frame to the client. */
  emit(value: string) {
    this.dispatchEvent(new MessageEvent('message', { data: value }));
  }
  send(value: string) {
    this.sent.push(value);
    for (const listener of this.peerListeners)
      setTimeout(() => listener(value), 0);
  }
  open() {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }
  close() {
    this.closed = true;
    this.readyState = 'closed';
  }
}

class FakePeer extends EventTarget {
  iceGatheringState = 'complete';
  iceConnectionState = 'new';
  connectionState = 'connected';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteCalls = 0;
  closed = false;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  createdChannels: FakeChannel[] = [];
  unexpectedRemoteChannel: FakeChannel | undefined;
  setRemoteDescription = vi.fn(async (_value: RTCSessionDescriptionInit) => {
    this.remoteCalls++;
    for (const created of this.createdChannels) created.open();
    if (this.unexpectedRemoteChannel) {
      const event = new Event('datachannel');
      Object.defineProperty(event, 'channel', {
        value: this.unexpectedRemoteChannel,
      });
      this.ondatachannel?.(event as unknown as RTCDataChannelEvent);
    }
  });
  createDataChannel = vi.fn((label: string, _options?: RTCDataChannelInit) => {
    const created = new FakeChannel(label);
    this.createdChannels.push(created);
    return created;
  });
  createOffer = async () => ({ type: 'offer' as const, sdp: OFFER_SDP });
  setLocalDescription = async (value: RTCSessionDescriptionInit) => {
    this.localDescription = value;
  };
  close() {
    this.closed = true;
  }
}

async function fixture(configuration: RTCConfiguration = {}) {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  const trust: ApprovedStationConnectionTrust = {
    stationId: '11111111-1111-4111-8111-111111111111',
    enrollmentId: '22222222-2222-4222-8222-222222222222',
    generation: 3,
    signingKey: { kty: 'EC', crv: 'P-256', x: publicJwk.x!, y: publicJwk.y! },
  };
  const scope = {
    stationId: trust.stationId,
    enrollmentId: trust.enrollmentId,
    routingGeneration: 1,
  };
  const surface = {
    kind: 'station-native' as const,
    appIdentifier: 'io.kontourai.station',
    channel: 'dev' as const,
    clientInstanceId: '33333333-3333-4333-8333-333333333333',
    keyThumbprint: 'K'.repeat(43),
  };
  let current: ApprovedStationConnectionTrust | null = trust;
  const peer = new FakePeer();
  let opened:
    | { peerHandle: string; nonce: string; offerSdp: string }
    | undefined;
  let peerOverride: Record<string, unknown> | undefined;
  let prepareGate: Promise<unknown> | undefined;
  let resolvePrepare!: (value: unknown) => void;
  let unknownOpen = false;
  let readExpiresAt = EXPIRES_AT;
  let readExpirySequence: number[] = [];
  let pendingReadCount = 0;
  let readCount = 0;
  let signGate: Promise<string> | undefined;
  let resolveSign!: (value: string) => void;
  let signalSignStarted!: () => void;
  const signStarted = new Promise<void>((resolve) => {
    signalSignStarted = resolve;
  });
  const lifecycle: string[] = [];
  let bindingOverride: Partial<StationConnectionProofBinding> = {};
  let revokeOnRead = false;
  let deferBeforeRemote = false;
  let releaseBeforeRemote!: () => void;
  let signalBeforeRemote!: () => void;
  const beforeRemoteReached = new Promise<void>((resolve) => {
    signalBeforeRemote = resolve;
  });
  const beforeRemoteRelease = new Promise<void>((resolve) => {
    releaseBeforeRemote = resolve;
  });
  const requests: Record<string, unknown>[] = [];
  const signaling = {
    scope,
    surface,
    prepare: vi.fn(async () => {
      lifecycle.push('prepare');
      if (prepareGate) return prepareGate as never;
      return (peerOverride ??
        peerDescriptor(surface.clientInstanceId)) as never;
    }),
    open: vi.fn(async (peerHandle: string, offerSdp: string) => {
      lifecycle.push('open');
      opened = { peerHandle, nonce: PEER_NONCE, offerSdp };
      if (unknownOpen) throw new Error('native_application_peer_open_unknown');
      return EXPIRES_AT;
    }),
    read: vi.fn(
      async (peerHandle: string): Promise<NativeApplicationPeerAnswer> => {
        lifecycle.push('read');
        expect(peerHandle).toBe(PEER_HANDLE);
        const readIndex = readCount++;
        const responseExpiresAt =
          readExpirySequence[readIndex] ?? readExpiresAt;
        const answerPending = readIndex < pendingReadCount;
        if (revokeOnRead) current = null;
        const binding = {
          stationId: trust.stationId,
          enrollmentId: trust.enrollmentId,
          generation: trust.generation,
          connectionId: surface.clientInstanceId,
          clientNonce: opened!.nonce,
          clientFingerprint: CLIENT_FP,
          stationFingerprint: STATION_FP,
          offerSha256: await connectionDescriptionDigest(opened!.offerSdp),
          answerSha256: await connectionDescriptionDigest(ANSWER_SDP),
          ...bindingOverride,
        };
        return {
          version: 'station-broker-native-connection-answer/v2' as const,
          expiresAt: responseExpiresAt,
          answerSdp: answerPending ? null : ANSWER_SDP,
          stationProof: answerPending
            ? null
            : await signStationConnectionProof({
                trust,
                binding,
                signingKey: pair.privateKey,
                now: Math.floor(Date.now() / 1000),
              }),
        };
      },
    ),
    sign: vi.fn(
      async (
        _peerHandle: string,
        _method: string,
        _path: string,
        _body: Uint8Array,
        _signal: AbortSignal,
      ) => {
        lifecycle.push('sign');
        signalSignStarted();
        return signGate ?? 'a.b.c';
      },
    ),
    close: vi.fn(async () => {}),
  };
  /** Pretend to be the station side of station-application-v1. */
  const respond = (channel: FakeChannel) => {
    channel.peerListeners.add((data) => {
      const frame = JSON.parse(data) as { type: string };
      if (frame.type === 'request') {
        requests.push(JSON.parse(data));
        channel.emit(
          writeApplicationFrame({
            type: 'response',
            status: 200,
            headers: [['content-type', 'application/json']],
          }),
        );
      } else if (frame.type === 'credit') {
        channel.emit(writeApplicationFrame({ type: 'end' }));
      }
    });
  };
  const baseCreateDataChannel = peer.createDataChannel as (
    label: string,
    options?: RTCDataChannelInit,
  ) => FakeChannel;
  peer.createDataChannel = ((label: string, options?: RTCDataChannelInit) => {
    const channel = baseCreateDataChannel(label, options);
    if (label === APPLICATION_TRANSPORT_CHANNEL) respond(channel);
    return channel;
  }) as typeof peer.createDataChannel;
  const createOffer = peer.createOffer;
  peer.createOffer = vi.fn(async () => {
    lifecycle.push('createOffer');
    return createOffer();
  });
  const controller = new AbortController();
  const input: NativeApplicationTransportInput = {
    configuration,
    signaling,
    origin: ORIGIN,
    signal: controller.signal,
    trust: {
      current: () => current,
      isCurrent: (expected) => current === expected,
      recheck: async (expected, stage) => {
        if (stage === 'before-remote-description' && deferBeforeRemote) {
          signalBeforeRemote();
          await beforeRemoteRelease;
        }
        return current === expected;
      },
    },
    createPeer: () => peer as unknown as RTCPeerConnection,
  };
  const transport = createNativeApplicationTransport(input);
  return {
    input,
    transport,
    controller,
    peer,
    trust,
    requests,
    surface,
    signaling,
    lifecycle,
    respond,
    fetchSpy: vi.spyOn(globalThis, 'fetch'),
    substituteScope(value: Record<string, unknown>) {
      Object.assign(signaling.scope, value);
    },
    substituteSurface(value: Record<string, unknown>) {
      Object.assign(signaling.surface, value);
    },
    overrideBinding(value: Partial<StationConnectionProofBinding>) {
      bindingOverride = value;
    },
    substitutePeer(value: Record<string, unknown>) {
      peerOverride = value;
    },
    deferPrepare() {
      prepareGate = new Promise((resolve) => {
        resolvePrepare = resolve;
      });
      return {
        resolve: (value: unknown = peerDescriptor(surface.clientInstanceId)) =>
          resolvePrepare(value),
      };
    },
    deferSign() {
      signGate = new Promise((resolve) => {
        resolveSign = resolve;
      });
      return {
        started: signStarted,
        resolve: (proof = 'a.b.c') => resolveSign(proof),
      };
    },
    makeOpenUnknown() {
      unknownOpen = true;
    },
    setReadExpiresAt(value: number) {
      readExpiresAt = value;
    },
    setReadExpirySequence(values: number[], pendingCount: number) {
      readExpirySequence = values;
      pendingReadCount = pendingCount;
    },
    revokeOnRead() {
      revokeOnRead = true;
    },
    revokeTrust() {
      current = null;
    },
    setUnexpectedChannel(label: string) {
      peer.unexpectedRemoteChannel = new FakeChannel(label);
    },
    deferBeforeRemote() {
      deferBeforeRemote = true;
      return {
        reached: beforeRemoteReached,
        revokeAndRelease() {
          current = null;
          releaseBeforeRemote();
        },
      };
    },
  };
}

describe('native application transport client', () => {
  test('uses one exact relay offer snapshot when gathering stalls, including lost-open read recovery', async () => {
    const f = await fixture({ iceTransportPolicy: 'relay' });
    f.peer.iceGatheringState = 'gathering';
    const relayOffer = `${OFFER_SDP}a=candidate:3131234567 1 udp 16777215 192.0.2.10 49152 typ relay raddr 0.0.0.0 rport 0 generation 0 ufrag testOnly network-cost 999\r\n`;
    f.peer.setLocalDescription = async () => {
      f.peer.localDescription = { type: 'offer', sdp: relayOffer };
    };
    f.makeOpenUnknown();
    const baseOpen = f.signaling.open;
    f.signaling.open = vi.fn(async (...args: Parameters<typeof baseOpen>) => {
      // More local candidates arrive after submission. Proof verification must
      // remain bound to the submitted SDP rather than reread localDescription.
      f.peer.localDescription = {
        type: 'offer',
        sdp: `${relayOffer}a=candidate:2 1 udp 16777214 192.0.2.11 49153 typ relay\r\n`,
      };
      return baseOpen(...args);
    });
    vi.useFakeTimers();
    try {
      const transport = createNativeVerifiedPeerTransport({
        ...f.input,
        peerVersion: 'station-native-application-peer/v1',
      });
      const running = transport.openVerifiedPeer(f.controller.signal);
      // Attach rejection observation before advancing the owned timeout.
      const result = running.then(
        (opened) => ({ opened }),
        (error: unknown) => ({ error }),
      );
      await vi.waitFor(() => expect(f.peer.localDescription).not.toBeNull());
      expect(f.signaling.open).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10_000);
      const completed = await result;
      if ('error' in completed) throw completed.error;
      expect(completed).toHaveProperty('opened');
      expect(f.signaling.open).toHaveBeenCalledExactlyOnceWith(
        PEER_HANDLE,
        relayOffer,
        expect.any(AbortSignal),
      );
      expect(f.signaling.read).toHaveBeenCalledOnce();
      expect(f.peer.setRemoteDescription).toHaveBeenCalledOnce();
      if ('opened' in completed) await completed.opened.close();
      expect(f.peer.closed).toBe(true);
      expect(f.signaling.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test.each([
    { name: 'no candidates', candidate: '' },
    {
      name: 'host candidate',
      candidate: 'a=candidate:1 1 udp 16777215 192.0.2.10 49152 typ host\r\n',
    },
    {
      name: 'mixed relay and host candidates under relay-only policy',
      candidate:
        'a=candidate:1 1 udp 16777215 192.0.2.10 49152 typ relay\r\na=candidate:2 1 udp 16777214 192.0.2.11 49153 typ host\r\n',
    },
    {
      name: 'malformed relay address',
      candidate: 'a=candidate:1 1 udp 16777215 999.0.2.10 49152 typ relay\r\n',
    },
    {
      name: 'malformed relay port',
      candidate: 'a=candidate:1 1 udp 16777215 192.0.2.10 0 typ relay\r\n',
    },
    {
      name: 'candidate outside application media',
      candidate:
        'm=audio 9 UDP/TLS/RTP/SAVPF 0\r\na=candidate:1 1 udp 16777215 192.0.2.10 49152 typ relay\r\n',
    },
    {
      name: 'unrestricted ICE policy',
      candidate: 'a=candidate:1 1 udp 16777215 192.0.2.10 49152 typ relay\r\n',
      policy: 'all' as const,
    },
    {
      name: 'aborted attempt',
      candidate: 'a=candidate:1 1 udp 16777215 192.0.2.10 49152 typ relay\r\n',
      retire: 'abort',
    },
    {
      name: 'failed ICE transport',
      candidate: 'a=candidate:1 1 udp 16777215 192.0.2.10 49152 typ relay\r\n',
      retire: 'failed',
    },
    {
      name: 'closed transport',
      candidate: 'a=candidate:1 1 udp 16777215 192.0.2.10 49152 typ relay\r\n',
      retire: 'closed',
    },
    {
      name: 'retired Station trust',
      candidate: 'a=candidate:1 1 udp 16777215 192.0.2.10 49152 typ relay\r\n',
      retire: 'trust',
    },
    {
      name: 'abort during authoritative recheck',
      candidate: 'a=candidate:1 1 udp 16777215 192.0.2.10 49152 typ relay\r\n',
      retire: 'late-abort',
    },
    {
      name: 'failure during authoritative recheck',
      candidate: 'a=candidate:1 1 udp 16777215 192.0.2.10 49152 typ relay\r\n',
      retire: 'late-failed',
    },
    {
      name: 'trust retirement during authoritative recheck',
      candidate: 'a=candidate:1 1 udp 16777215 192.0.2.10 49152 typ relay\r\n',
      retire: 'late-trust',
    },
  ])(
    'does not submit a stalled offer with $name',
    async ({ candidate, policy, retire }) => {
      const f = await fixture({ iceTransportPolicy: policy ?? 'relay' });
      f.peer.iceGatheringState = 'gathering';
      f.peer.setLocalDescription = async () => {
        f.peer.localDescription = { type: 'offer', sdp: OFFER_SDP + candidate };
      };
      let retireAtRecheck = false;
      const recheck = f.input.trust.recheck;
      f.input.trust.recheck = async (...args: Parameters<typeof recheck>) => {
        const current = await recheck(...args);
        if (retireAtRecheck) {
          if (retire === 'late-abort') f.controller.abort();
          if (retire === 'late-failed') f.peer.connectionState = 'failed';
          if (retire === 'late-trust') f.revokeTrust();
        }
        return current;
      };
      vi.useFakeTimers();
      try {
        const transport = createNativeVerifiedPeerTransport({
          ...f.input,
          peerVersion: 'station-native-application-peer/v1',
        });
        const result = transport.openVerifiedPeer(f.controller.signal).then(
          (opened) => ({ opened }),
          (error: unknown) => ({ error }),
        );
        await vi.waitFor(() => expect(f.peer.localDescription).not.toBeNull());
        if (retire === 'abort') f.controller.abort();
        if (retire === 'failed') f.peer.iceConnectionState = 'failed';
        if (retire === 'closed') f.peer.connectionState = 'closed';
        if (retire === 'trust') f.revokeTrust();
        retireAtRecheck = true;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(await result).toHaveProperty('error');
        expect(f.signaling.open).not.toHaveBeenCalled();
        expect(f.peer.setRemoteDescription).not.toHaveBeenCalled();
        expect(f.peer.closed).toBe(true);
        expect(f.peer.createdChannels[0]?.closed).toBe(true);
        expect(f.signaling.close).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test('accepts a valid signed answer with an earlier host read expiry', async () => {
    const f = await fixture();
    f.setReadExpiresAt(EXPIRES_AT - 500);
    const response = await f.transport.fetch(new URL('/api/health', ORIGIN));
    expect(response.status).toBe(200);
    await response.text();
    expect(f.signaling.open).toHaveBeenCalledOnce();
    expect(f.signaling.read).toHaveBeenCalledOnce();
    expect(f.peer.setRemoteDescription).toHaveBeenCalledOnce();
  });

  test('refuses an answer expiry that extends the open deadline', async () => {
    const f = await fixture();
    f.setReadExpiresAt(EXPIRES_AT + 1);
    await expect(
      f.transport.fetch(new URL('/api/health', ORIGIN)),
    ).rejects.toThrow('native_application_signal_invalid');
    expect(f.peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(0);
  });

  test('later polling cannot extend a previously shortened read deadline', async () => {
    const f = await fixture();
    f.setReadExpirySequence([EXPIRES_AT - 500, EXPIRES_AT - 250], 1);
    await expect(
      f.transport.fetch(new URL('/api/health', ORIGIN)),
    ).rejects.toThrow('native_application_signal_invalid');
    expect(f.signaling.read).toHaveBeenCalledTimes(2);
    expect(f.peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(0);
  });

  test('refuses an expired host read deadline before applying its answer', async () => {
    const f = await fixture();
    f.setReadExpiresAt(Date.now() - 1);
    await expect(
      f.transport.fetch(new URL('/api/health', ORIGIN)),
    ).rejects.toThrow('native_application_signal_invalid');
    expect(f.peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(0);
  });

  test('verifies the exact proof, opens only station-application-v1, and dispatches through createApplicationChannelFetch without HTTP', async () => {
    const f = await fixture();
    const running = f.transport.fetch(new URL('/api/health', ORIGIN), {
      headers: { 'x-proof-header': 'sdk' },
    });
    const response = await running;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(f.fetchSpy).not.toHaveBeenCalled();
    expect(f.peer.setRemoteDescription).toHaveBeenCalledOnce();
    expect(f.peer.createdChannels).toHaveLength(1);
    expect(f.peer.createdChannels[0]?.label).toBe(
      APPLICATION_TRANSPORT_CHANNEL,
    );
    expect(f.requests).toHaveLength(1);
    expect(f.lifecycle.indexOf('prepare')).toBeLessThan(
      f.lifecycle.indexOf('createOffer'),
    );
    expect(f.lifecycle).toEqual([
      'prepare',
      'createOffer',
      'open',
      'read',
      'sign',
    ]);
    expect(f.signaling.open).toHaveBeenCalledWith(
      PEER_HANDLE,
      OFFER_SDP,
      expect.any(AbortSignal),
    );
    expect(f.signaling.read).toHaveBeenCalledWith(
      PEER_HANDLE,
      expect.any(AbortSignal),
    );
    expect(f.signaling.sign).toHaveBeenCalledWith(
      PEER_HANDLE,
      'GET',
      '/api/health',
      new Uint8Array(0),
      expect.any(AbortSignal),
    );
    expect(f.requests[0]).toMatchObject({
      type: 'request',
      method: 'GET',
      path: '/api/health',
    });
    expect(f.requests[0]?.headers).toEqual(
      expect.arrayContaining([
        ['x-proof-header', 'sdk'],
        [NATIVE_DEVICE_PROOF_HEADER.toLowerCase(), 'a.b.c'],
      ]),
    );
    expect(f.signaling.close).toHaveBeenCalledWith(PEER_HANDLE);
    expect(f.peer.closed).toBe(true);
    expect(f.peer.createdChannels[0]?.closed).toBe(true);
  });

  test('rejects a request outside the pinned origin without any signaling', async () => {
    const f = await fixture();
    await expect(
      f.transport.fetch('https://evil.example/api/health'),
    ).rejects.toThrow();
    expect(f.signaling.prepare).not.toHaveBeenCalled();
    expect(f.signaling.open).not.toHaveBeenCalled();
    expect(f.fetchSpy).not.toHaveBeenCalled();
    expect(f.peer.closed).toBe(false);
  });

  test('requires the host peer connection id to match the prepared native surface', async () => {
    const f = await fixture();
    f.substitutePeer(peerDescriptor('44444444-4444-4444-8444-444444444444'));
    await expect(
      f.transport.fetch(new URL('/api/health', ORIGIN)),
    ).rejects.toThrow('native_application_peer_invalid');
    expect(f.peer.createOffer).not.toHaveBeenCalled();
    expect(f.signaling.open).not.toHaveBeenCalled();
    expect(f.signaling.close).toHaveBeenCalledWith(PEER_HANDLE);
  });

  test('a lost open reply is recovered by reading the same host peer once', async () => {
    const f = await fixture();
    f.makeOpenUnknown();
    const response = await f.transport.fetch(new URL('/api/health', ORIGIN));
    expect(response.status).toBe(200);
    await response.text();
    expect(f.signaling.prepare).toHaveBeenCalledOnce();
    expect(f.signaling.open).toHaveBeenCalledOnce();
    expect(f.signaling.open).toHaveBeenCalledWith(
      PEER_HANDLE,
      OFFER_SDP,
      expect.any(AbortSignal),
    );
    expect(f.signaling.read).toHaveBeenCalledWith(
      PEER_HANDLE,
      expect.any(AbortSignal),
    );
    expect(f.signaling.close).toHaveBeenCalledWith(PEER_HANDLE);
  });

  test('a late host prepare result is closed after client cancellation', async () => {
    const f = await fixture();
    const prepare = f.deferPrepare();
    const running = f.transport.fetch(new URL('/api/health', ORIGIN));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.signaling.prepare).toHaveBeenCalledOnce();
    f.controller.abort(new Error('test_cancelled'));
    await expect(running).rejects.toThrow();
    prepare.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.peer.createOffer).not.toHaveBeenCalled();
    expect(f.signaling.close).toHaveBeenCalledWith(PEER_HANDLE);
    expect(f.requests).toHaveLength(0);
  });

  test('request signing sees the exact copied body and contributes only the Device proof header', async () => {
    const f = await fixture();
    const body = '{"project":"demo"}';
    const response = await f.transport.fetch(
      new URL('/api/projects?slug=demo', ORIGIN),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      },
    );
    expect(response.status).toBe(200);
    expect(f.signaling.sign).toHaveBeenCalledWith(
      PEER_HANDLE,
      'POST',
      '/api/projects?slug=demo',
      new TextEncoder().encode(body),
      expect.any(AbortSignal),
    );
    expect(f.requests[0]?.headers).toEqual(
      expect.arrayContaining([
        ['content-type', 'application/json'],
        [NATIVE_DEVICE_PROOF_HEADER.toLowerCase(), 'a.b.c'],
      ]),
    );
  });

  test('caller credentials and Device proof headers are refused before signing or dispatch', async () => {
    for (const name of [
      'Authorization',
      'Cookie',
      NATIVE_DEVICE_PROOF_HEADER,
    ]) {
      const f = await fixture();
      await expect(
        f.transport.fetch(new URL('/api/projects', ORIGIN), {
          headers: { [name]: 'caller-supplied' },
        }),
      ).rejects.toThrow('native_application_request_credential_conflict');
      expect(f.signaling.sign).not.toHaveBeenCalled();
      expect(f.requests).toHaveLength(0);
      expect(f.fetchSpy).not.toHaveBeenCalled();
      expect(f.signaling.close).toHaveBeenCalledWith(PEER_HANDLE);
    }
  });

  test('cancelling a post-open sign call closes its host peer before dispatch', async () => {
    const f = await fixture();
    const signing = f.deferSign();
    const running = f.transport.fetch(new URL('/api/projects', ORIGIN));
    await signing.started;
    f.controller.abort(new Error('test_cancelled'));
    await expect(running).rejects.toThrow();
    signing.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.requests).toHaveLength(0);
    expect(f.signaling.close).toHaveBeenCalledWith(PEER_HANDLE);
  });

  test('closing an adopted peer during signing refuses proof with a still-live request signal', async () => {
    const f = await fixture();
    const channel = await f.transport.openChannel(new AbortController().signal);
    const signing = f.deferSign();
    const request = {
      method: 'GET',
      path: '/api/projects',
      body: new Uint8Array(0),
      headers: new Headers(),
      signal: new AbortController().signal,
    };
    const preparing = channel.prepareRequest!(request);
    const rejected = expect(preparing).rejects.toThrow(
      'native_application_trust_retired',
    );
    await signing.started;
    channel.close();
    signing.resolve();
    await rejected;
    expect(request.signal.aborted).toBe(false);
    expect(f.requests).toHaveLength(0);
    await expect(channel.prepareRequest!(request)).rejects.toThrow(
      'native_application_trust_retired',
    );
    expect(f.signaling.sign).toHaveBeenCalledOnce();
  });

  test('a wrong Station proof never reaches setRemoteDescription or dispatch', async () => {
    const f = await fixture();
    f.overrideBinding({ stationFingerprint: CLIENT_FP });
    await expect(
      f.transport.fetch(new URL('/api/health', ORIGIN)),
    ).rejects.toThrow();
    expect(f.peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(0);
    expect(f.fetchSpy).not.toHaveBeenCalled();
    expect(f.peer.closed).toBe(true);
  });

  test('rejects a substituted surface before any signaling', async () => {
    const f = await fixture();
    f.substituteSurface({ kind: 'station-web' });
    await expect(
      f.transport.fetch(new URL('/api/health', ORIGIN)),
    ).rejects.toThrow('native_application_trust_mismatch');
    expect(f.signaling.prepare).not.toHaveBeenCalled();
    expect(f.signaling.open).not.toHaveBeenCalled();
    expect(f.fetchSpy).not.toHaveBeenCalled();
  });

  test('rejects a scope whose Station identity does not match the approved trust', async () => {
    const f = await fixture();
    f.substituteScope({
      stationId: '99999999-9999-4999-8999-999999999999',
    });
    await expect(
      f.transport.fetch(new URL('/api/health', ORIGIN)),
    ).rejects.toThrow('native_application_trust_mismatch');
    expect(f.signaling.prepare).not.toHaveBeenCalled();
    expect(f.signaling.open).not.toHaveBeenCalled();
  });

  test('trust revocation before remote description prevents any application dispatch', async () => {
    const f = await fixture();
    const deferred = f.deferBeforeRemote();
    const running = f.transport.fetch(new URL('/api/health', ORIGIN));
    await deferred.reached;
    deferred.revokeAndRelease();
    await expect(running).rejects.toThrow('native_application_trust_retired');
    expect(f.peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(0);
    expect(f.peer.closed).toBe(true);
  });

  test('revocation between read and proof application aborts the handshake', async () => {
    const f = await fixture();
    f.revokeOnRead();
    await expect(
      f.transport.fetch(new URL('/api/health', ORIGIN)),
    ).rejects.toThrow('native_application_trust_retired');
    expect(f.peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(f.fetchSpy).not.toHaveBeenCalled();
  });

  test('an unexpected remote channel is closed and no frame is dispatched on it', async () => {
    const f = await fixture();
    f.setUnexpectedChannel('station-lab-v1');
    await expect(
      f.transport.fetch(new URL('/api/health', ORIGIN)),
    ).rejects.toThrow();
    expect(f.peer.unexpectedRemoteChannel?.closed).toBe(true);
    expect(f.peer.closed).toBe(true);
  });

  test('cancelling the client lifetime closes the owned peer', async () => {
    const f = await fixture();
    f.controller.abort(new Error('test_cancelled'));
    await expect(
      f.transport.fetch(new URL('/api/health', ORIGIN)),
    ).rejects.toThrow();
    expect(f.signaling.prepare).not.toHaveBeenCalled();
    expect(f.signaling.open).not.toHaveBeenCalled();
    expect(f.fetchSpy).not.toHaveBeenCalled();
  });

  test('an adopted channel refuses application bytes after trust rotation', async () => {
    const f = await fixture();
    const channel = await f.transport.openChannel(new AbortController().signal);
    f.revokeTrust();
    expect(() =>
      channel.send(
        writeApplicationFrame({
          type: 'request',
          method: 'GET',
          path: '/api/health',
          headers: [],
          body: null,
        }),
      ),
    ).toThrow('native_application_trust_retired');
    expect(f.peer.closed).toBe(true);
    expect(f.peer.createdChannels[0]?.closed).toBe(true);
  });

  test('aborting client lifetime closes an already adopted channel', async () => {
    const f = await fixture();
    await f.transport.openChannel(new AbortController().signal);
    expect(f.peer.closed).toBe(false);
    f.controller.abort(new Error('test_cancelled'));
    expect(f.peer.closed).toBe(true);
    expect(f.peer.createdChannels[0]?.closed).toBe(true);
    expect(f.signaling.close).toHaveBeenCalledWith(PEER_HANDLE);
  });

  test('a rotated Station cannot deliver another application frame', async () => {
    const f = await fixture();
    const channel = await f.transport.openChannel(new AbortController().signal);
    const received: unknown[] = [];
    let closed = 0;
    channel.subscribe(
      (value) => received.push(value),
      () => closed++,
    );
    f.revokeTrust();
    f.peer.createdChannels[0]!.emit(writeApplicationFrame({ type: 'end' }));
    expect(received).toHaveLength(0);
    expect(closed).toBe(1);
    expect(f.peer.closed).toBe(true);
  });
  test('enrollment verifies its own peer transcript without Device signing and rechecks trust after EOF', async () => {
    const f = await fixture();
    f.substitutePeer({
      ...peerDescriptor(),
      version: 'station-native-enrollment-peer/v1',
    });
    const transport = createNativeVerifiedPeerTransport({
      ...f.input,
      peerVersion: 'station-native-enrollment-peer/v1',
    });
    const opened = await transport.openVerifiedPeer(f.controller.signal);
    expect(f.peer.remoteCalls).toBe(1);
    expect(opened.peer.version).toBe('station-native-enrollment-peer/v1');
    expect(f.signaling.sign).not.toHaveBeenCalled();
    opened.channel.close();
    await opened.close();
    expect(f.peer.closed).toBe(true);
    await expect(opened.assertCurrent()).resolves.toBeUndefined();
    f.revokeTrust();
    await expect(opened.assertCurrent()).rejects.toThrow(
      'native_application_trust_retired',
    );
  });
});
