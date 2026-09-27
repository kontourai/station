import type {
  ApprovedStationConnectionTrust,
  StationConnectionProofBinding,
} from '@kontourai/station-contracts/connection-proof';
import {
  connectionDescriptionDigest,
  signStationConnectionProof,
} from '@kontourai/station-shared/connection-proof';
import { exportJWK, generateKeyPair } from 'jose';
import { describe, expect, test, vi } from 'vitest';
import { writeApplicationFrame } from '../core/applicationChannelFrames.js';
import {
  APPLICATION_TRANSPORT_CHANNEL,
  createNativeApplicationTransport,
} from '../core/nativeApplicationTransport.js';
import type { NativeDiagnosticSignalAnswer } from '../core/nativeDiagnosticEcho.js';

const CLIENT_FP = Array(32).fill('AA').join(':');
const STATION_FP = Array(32).fill('BB').join(':');
const OFFER_SDP = `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 ${CLIENT_FP}\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=sctp-port:5000\r\n`;
const ANSWER_SDP = `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 ${STATION_FP}\r\n`;
const EXPIRES_AT = Date.now() + 30_000;
const ORIGIN = 'https://station.example';

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

async function fixture() {
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
  let opened: { nonce: string; offerSdp: string } | undefined;
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
    open: vi.fn(async (value: { nonce: string; offerSdp: string }) => {
      opened = value;
      return EXPIRES_AT;
    }),
    read: vi.fn(async (): Promise<NativeDiagnosticSignalAnswer> => {
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
        expiresAt: EXPIRES_AT,
        answerSdp: ANSWER_SDP,
        stationProof: await signStationConnectionProof({
          trust,
          binding,
          signingKey: pair.privateKey,
          now: Math.floor(Date.now() / 1000),
        }),
      };
    }),
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
  const controller = new AbortController();
  const transport = createNativeApplicationTransport({
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
  });
  return {
    transport,
    controller,
    peer,
    trust,
    requests,
    surface,
    signaling,
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
    expect(f.requests[0]).toMatchObject({
      type: 'request',
      method: 'GET',
      path: '/api/health',
    });
    expect(f.peer.closed).toBe(true);
    expect(f.peer.createdChannels[0]?.closed).toBe(true);
  });

  test('rejects a request outside the pinned origin without any signaling', async () => {
    const f = await fixture();
    await expect(
      f.transport.fetch('https://evil.example/api/health'),
    ).rejects.toThrow();
    expect(f.signaling.open).not.toHaveBeenCalled();
    expect(f.fetchSpy).not.toHaveBeenCalled();
    expect(f.peer.closed).toBe(false);
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
});
