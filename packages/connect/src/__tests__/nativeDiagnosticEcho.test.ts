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
import type { NativeDiagnosticSignalAnswer } from '../core/nativeDiagnosticEcho.js';
import {
  createNativeDiagnosticEchoClient,
  type NativeDiagnosticSignaling,
} from '../core/nativeDiagnosticEcho.js';

const CLIENT_FP = Array(32).fill('AA').join(':');
const STATION_FP = Array(32).fill('BB').join(':');
const OFFER_SDP = `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 ${CLIENT_FP}\r\n`;
const ANSWER_SDP = `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 ${STATION_FP}\r\n`;
const EXPIRES_AT = Date.now() + 30_000;

class FakeChannel extends EventTarget {
  readyState = 'open';
  bufferedAmount = 0;
  closed = false;
  constructor(readonly label: string) {
    super();
  }
  send(value: string) {
    setTimeout(
      () => this.dispatchEvent(new MessageEvent('message', { data: value })),
      0,
    );
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
  channel = new FakeChannel('station-lab-v1');
  createOffer = vi.fn(async () => ({ type: 'offer' as const, sdp: OFFER_SDP }));
  setLocalDescription = vi.fn(async (value: RTCSessionDescriptionInit) => {
    this.localDescription = value;
  });
  setRemoteDescription = vi.fn(async (_value: RTCSessionDescriptionInit) => {
    this.remoteCalls++;
    const event = new Event('datachannel');
    Object.defineProperty(event, 'channel', { value: this.channel });
    this.ondatachannel?.(event as unknown as RTCDataChannelEvent);
  });
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
  let answerOverride: NativeDiagnosticSignalAnswer | undefined;
  let responseSdp: string | undefined;
  let bindingOverride: Partial<StationConnectionProofBinding> = {};
  let revokeOnRead = false;
  let pendingRead = false;
  const signaling: NativeDiagnosticSignaling = {
    scope,
    surface,
    open: vi.fn(async (value) => {
      opened = value;
      return EXPIRES_AT;
    }),
    read: vi.fn(async (): Promise<NativeDiagnosticSignalAnswer> => {
      if (pendingRead)
        return await new Promise<NativeDiagnosticSignalAnswer>(() => {});
      if (revokeOnRead) current = null;
      if (answerOverride) return answerOverride;
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
        answerSdp: responseSdp ?? ANSWER_SDP,
        stationProof: await signStationConnectionProof({
          trust,
          binding,
          signingKey: pair.privateKey,
          now: Math.floor(Date.now() / 1000),
        }),
      };
    }),
  };
  const client = createNativeDiagnosticEchoClient({
    signaling,
    trust: {
      current: () => current,
      isCurrent: (expected) => current === expected,
    },
    createPeer: () => peer as unknown as RTCPeerConnection,
  });
  return {
    client,
    peer,
    signaling,
    surface,
    trust,
    setAnswer(value: NativeDiagnosticSignalAnswer) {
      answerOverride = value;
    },
    substituteSdp(value: string) {
      responseSdp = value;
    },
    overrideBinding(value: Partial<StationConnectionProofBinding>) {
      bindingOverride = value;
    },
    revokeOnRead() {
      revokeOnRead = true;
    },
    pendingRead() {
      pendingRead = true;
    },
    setChannelLabel(label: string) {
      peer.channel = new FakeChannel(label);
    },
  };
}

describe('native diagnostic echo client', () => {
  test('verifies the exact Station proof before applying SDP and uses only the diagnostic echo channel', async () => {
    const f = await fixture();
    await expect(f.client.run(new AbortController().signal)).resolves.toEqual({
      stationId: f.trust.stationId,
      echoed: true,
    });
    expect(f.signaling.open).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 'station-broker-native-connection-open/v2',
        surface: f.surface,
        offerSdp: OFFER_SDP,
        nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      }),
      expect.any(AbortSignal),
    );
    expect(f.peer.setRemoteDescription).toHaveBeenCalledOnce();
    expect(f.peer.channel.label).toBe('station-lab-v1');
    expect(f.peer.channel.closed).toBe(true);
    expect(f.peer.closed).toBe(true);
  });

  test('rejects a substituted answer SDP against the valid proof for the original SDP', async () => {
    const f = await fixture();
    f.substituteSdp(ANSWER_SDP.replace(STATION_FP, CLIENT_FP));
    await expect(f.client.run(new AbortController().signal)).rejects.toThrow();
    expect(f.peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(f.peer.closed).toBe(true);
  });

  test('rejects a correctly signed proof for a substituted client identity', async () => {
    const f = await fixture();
    f.overrideBinding({ connectionId: 'substituted-client' });
    await expect(f.client.run(new AbortController().signal)).rejects.toThrow();
    expect(f.peer.setRemoteDescription).not.toHaveBeenCalled();
  });

  test('rejects substituted nonce and station fingerprint proof bindings', async () => {
    const nonceCase = await fixture();
    nonceCase.overrideBinding({ clientNonce: 'X'.repeat(43) });
    await expect(
      nonceCase.client.run(new AbortController().signal),
    ).rejects.toThrow();
    expect(nonceCase.peer.setRemoteDescription).not.toHaveBeenCalled();

    const fingerprintCase = await fixture();
    fingerprintCase.overrideBinding({ stationFingerprint: CLIENT_FP });
    await expect(
      fingerprintCase.client.run(new AbortController().signal),
    ).rejects.toThrow();
    expect(fingerprintCase.peer.setRemoteDescription).not.toHaveBeenCalled();
  });

  test('refuses an application channel and closes the peer', async () => {
    const f = await fixture();
    f.setChannelLabel('station-application-v1');
    await expect(f.client.run(new AbortController().signal)).rejects.toThrow();
    expect(f.peer.remoteCalls).toBe(1);
    expect(f.peer.channel.closed).toBe(true);
    expect(f.peer.closed).toBe(true);
  });

  test('rejects a trust change during signaling before applying remote SDP', async () => {
    const f = await fixture();
    f.revokeOnRead();
    await expect(f.client.run(new AbortController().signal)).rejects.toThrow(
      'native_diagnostic_trust_retired',
    );
    expect(f.peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(f.peer.closed).toBe(true);
  });

  test('cancellation during a pending answer read closes the owned peer', async () => {
    const f = await fixture();
    f.pendingRead();
    const controller = new AbortController();
    const running = f.client.run(controller.signal);
    await vi.waitFor(() => expect(f.signaling.read).toHaveBeenCalledOnce());
    controller.abort(new Error('test_cancelled'));
    await expect(running).rejects.toThrow('test_cancelled');
    expect(f.peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(f.peer.closed).toBe(true);
  });
});
