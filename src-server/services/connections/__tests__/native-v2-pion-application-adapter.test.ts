import { randomBytes, randomUUID } from 'node:crypto';
import type {
  ApprovedStationConnectionTrust,
  StationConnectionProofBinding,
  StationConnectionSigningKey,
} from '@kontourai/station-contracts/connection-proof';
import type {
  SelfHostedBrokerNativeClientSurfaceV2,
  SelfHostedBrokerNativeConnectionOfferV2,
} from '@kontourai/station-contracts/self-hosted-broker';
import {
  signStationConnectionProof,
  stationConnectionSigningKeyId,
} from '@kontourai/station-shared/connection-proof';
import { exportJWK, generateKeyPair } from 'jose';
import { describe, expect, test, vi } from 'vitest';
import {
  createNativeV2PionApplicationAdapter,
  readVerifiedNativePionApplicationRequest,
} from '../native-v2-pion-application-adapter.js';
import type { PionApplicationAdapterInput } from '../pion-application-adapter.js';
import {
  readVerifiedNativeVirtualApplicationRequest,
  readVerifiedVirtualApplicationRequest,
  VirtualApplicationIngress,
} from '../virtual-application.js';

const ORIGIN = 'https://station.example';
const CLIENT_FINGERPRINT = Array(32).fill('AA').join(':');
const STATION_FINGERPRINT = Array(32).fill('BB').join(':');
const OFFER_SDP = `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 ${CLIENT_FINGERPRINT}\r\n`;
const ANSWER_SDP = `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 ${STATION_FINGERPRINT}\r\n`;
const APPLICATION_REQUEST = JSON.stringify({
  version: 'station.application-channel/v1',
  type: 'request',
  method: 'GET',
  path: '/api/projects',
  headers: [['authorization', 'station-session-continuation opaque-proof']],
  body: null,
});

function applicationFrame(value: string) {
  return JSON.parse(value) as Record<string, unknown>;
}

async function fixture(
  options: {
    invalidProof?: boolean;
    retireDuringIssue?: boolean;
    acceptChannelDuringStartup?: boolean;
  } = {},
) {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  const trust: ApprovedStationConnectionTrust = {
    stationId: randomUUID(),
    enrollmentId: randomUUID(),
    generation: 3,
    signingKey: {
      kty: 'EC',
      crv: 'P-256',
      x: publicJwk.x!,
      y: publicJwk.y!,
    } as StationConnectionSigningKey,
  };
  const surface: SelfHostedBrokerNativeClientSurfaceV2 = {
    kind: 'station-native',
    appIdentifier: 'io.kontourai.station',
    channel: 'dev',
    clientInstanceId: randomUUID(),
    keyThumbprint: 'T'.repeat(43),
  };
  const signingKeyId = await stationConnectionSigningKeyId(trust);
  const offer: SelfHostedBrokerNativeConnectionOfferV2 = {
    version: 'station-broker-native-connection-offer/v2',
    scope: {
      stationId: trust.stationId,
      enrollmentId: trust.enrollmentId,
      routingGeneration: 1,
    },
    surface,
    stationSigningKeyId: signingKeyId,
    stationSigningGeneration: trust.generation,
    clientId: surface.clientInstanceId,
    nonce: randomBytes(32).toString('base64url'),
    offerSdp: OFFER_SDP,
    expiresAt: Date.now() + 60_000,
  };
  let current: ApprovedStationConnectionTrust | null = trust;
  const trustOwner = {
    current: () => current,
    isCurrent: (value: ApprovedStationConnectionTrust) => current === value,
    retire: () => {
      current = null;
    },
  };
  const handler = vi.fn((request: Request) => {
    const native = readVerifiedNativeVirtualApplicationRequest(request);
    expect(request.headers.get('authorization')).toBe(
      'station-session-continuation opaque-proof',
    );
    expect(native?.surface).toEqual(surface);
    expect(native?.stationId).toBe(trust.stationId);
    expect(native?.connectionEnrollmentId).toBe(trust.enrollmentId);
    expect(native?.routingGeneration).toBe(trust.generation);
    expect(native?.connectionId).toBe(surface.clientInstanceId);
    expect(native?.requestOrigin).toBe(ORIGIN);
    expect(readVerifiedVirtualApplicationRequest(request)).toBeUndefined();
    expect(
      readVerifiedNativeVirtualApplicationRequest(new Request(request)),
    ).toBeUndefined();
    return Response.json({ protected: true });
  });
  const ingress = new VirtualApplicationIngress(
    ORIGIN,
    undefined,
    readVerifiedNativePionApplicationRequest,
  );
  ingress.bind({ fetch: handler });
  const application = ingress.activate();
  let accept: ((channel: FakeChannel) => void) | undefined;
  let earlyChannel: FakeChannel | undefined;
  let resolveCleanup!: () => void;
  const cleanupComplete = new Promise<void>((resolve) => {
    resolveCleanup = resolve;
  });
  const startAdapter = vi.fn(async (input: PionApplicationAdapterInput) => {
    expect(input.profile).toBe('application');
    expect(input.applicationChannelLabel).toBe('station-application-v1');
    accept = input.accept as (channel: FakeChannel) => void;
    if (options.acceptChannelDuringStartup) {
      earlyChannel = new FakeChannel();
      input.accept(earlyChannel);
    }
    return {
      answer: { type: 'answer' as const, sdp: ANSWER_SDP },
      close: async () => resolveCleanup(),
      cleanupComplete,
    };
  });
  const input = {
    surface,
    applicationOrigin: ORIGIN,
    application,
    executable: '/pion-peer',
    certificatePem: 'certificate',
    privateKeyPem: 'private-key',
    turn: { url: 'turn:127.0.0.1:3478', username: 'u', password: 'p' },
    trust: trustOwner,
    issuer: {
      issue: async (binding: StationConnectionProofBinding) => {
        if (options.invalidProof) return 'unverified';
        const proof = await signStationConnectionProof({
          trust,
          binding,
          signingKey: pair.privateKey,
          now: Math.floor(Date.now() / 1000),
        });
        if (options.retireDuringIssue) trustOwner.retire();
        return proof;
      },
    },
  } as const;
  const adapter = createNativeV2PionApplicationAdapter(input, {
    startAdapter:
      startAdapter as unknown as typeof import('../pion-application-adapter.js').startPionApplicationAdapter,
    serve: (await import('@kontourai/station-connect/application-channel'))
      .serveApplicationChannel,
  });
  return {
    adapter,
    offer,
    surface,
    trust,
    trustOwner,
    handler,
    startAdapter,
    application,
    accept: () => accept,
    earlyChannel: () => earlyChannel,
  };
}

class FakeChannel {
  readonly messages: Array<(value: unknown) => void> = [];
  readonly sent: string[] = [];
  closeCalls = 0;
  send(message: string) {
    this.sent.push(message);
  }
  close() {
    this.closeCalls++;
    this.messages.length = 0;
  }
  subscribe(message: (value: unknown) => void, _closed: () => void) {
    this.messages.push(message);
    return () => {
      const index = this.messages.indexOf(message);
      if (index >= 0) this.messages.splice(index, 1);
    };
  }
  receive(message: string) {
    for (const listener of [...this.messages]) listener(message);
  }
}

describe('native v2 Pion application adapter', () => {
  test('admits only verified native application channels and preserves exact Request provenance', async () => {
    const h = await fixture();
    const answer = await h.adapter.adapter.answer(
      h.offer,
      h.trustOwner.current()!,
      new AbortController().signal,
    );
    const channel = new FakeChannel();
    h.accept()!(channel);
    expect(h.startAdapter).toHaveBeenCalledTimes(1);
    expect(h.adapter.activePeerCount).toBe(1);
    channel.receive(APPLICATION_REQUEST);
    await vi.waitFor(() => expect(h.handler).toHaveBeenCalledTimes(1));
    expect(applicationFrame(channel.sent[0]!)).toMatchObject({
      type: 'response',
      status: 200,
    });
    expect(await answer.stationProof).toEqual(expect.any(String));
    await h.adapter.close();
    expect(channel.closeCalls).toBeGreaterThan(0);
  });

  test('closes channels arriving before Station proof verification', async () => {
    const h = await fixture({ acceptChannelDuringStartup: true });
    await h.adapter.adapter.answer(
      h.offer,
      h.trust,
      new AbortController().signal,
    );
    expect(h.earlyChannel()?.closeCalls).toBe(1);
    expect(h.handler).not.toHaveBeenCalled();

    const admittedChannel = new FakeChannel();
    h.accept()!(admittedChannel);
    admittedChannel.receive(APPLICATION_REQUEST);
    await vi.waitFor(() => expect(h.handler).toHaveBeenCalledTimes(1));
    await h.adapter.close();
  });

  test('rejects mismatched native surface before Pion or application-channel admission', async () => {
    const h = await fixture();
    const wrongSurfaceOffer = {
      ...h.offer,
      surface: { ...h.offer.surface, appIdentifier: 'io.example.other' },
    };
    await expect(
      h.adapter.adapter.answer(
        wrongSurfaceOffer,
        h.trustOwner.current()!,
        new AbortController().signal,
      ),
    ).rejects.toThrow('native_pion_application_offer_invalid');
    expect(h.startAdapter).not.toHaveBeenCalled();
    expect(h.handler).not.toHaveBeenCalled();
  });

  test('rejects stale Station trust before starting a peer', async () => {
    const h = await fixture();
    h.trustOwner.retire();
    await expect(
      h.adapter.adapter.answer(h.offer, h.trust, new AbortController().signal),
    ).rejects.toThrow('native_pion_application_trust_unavailable');
    expect(h.startAdapter).not.toHaveBeenCalled();
  });

  test('refuses application channels when the Station proof cannot be verified', async () => {
    const h = await fixture({ invalidProof: true });
    await expect(
      h.adapter.adapter.answer(
        h.offer,
        h.trustOwner.current()!,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(h.accept()).toBeDefined();
    const channel = new FakeChannel();
    h.accept()!(channel);
    expect(channel.closeCalls).toBe(1);
    expect(h.handler).not.toHaveBeenCalled();
    await h.adapter.close();
  });

  test('refuses an otherwise valid Station proof when trust retires during issuance', async () => {
    const h = await fixture({ retireDuringIssue: true });
    await expect(
      h.adapter.adapter.answer(h.offer, h.trust, new AbortController().signal),
    ).rejects.toThrow('native_pion_application_trust_retired');
    const channel = new FakeChannel();
    h.accept()!(channel);
    expect(channel.closeCalls).toBe(1);
    expect(h.handler).not.toHaveBeenCalled();
    await h.adapter.close();
  });

  test('retires an admitted peer immediately when Station trust is revoked', async () => {
    const h = await fixture();
    await h.adapter.adapter.answer(
      h.offer,
      h.trustOwner.current()!,
      new AbortController().signal,
    );
    const channel = new FakeChannel();
    h.accept()!(channel);
    h.trustOwner.retire();
    channel.receive(APPLICATION_REQUEST);
    await vi.waitFor(() => expect(h.adapter.activePeerCount).toBe(0));
    expect(h.handler).not.toHaveBeenCalled();
  });

  test('does not dispatch application channels after adapter retirement', async () => {
    const h = await fixture();
    await h.adapter.adapter.answer(
      h.offer,
      h.trustOwner.current()!,
      new AbortController().signal,
    );
    const channel = new FakeChannel();
    h.accept()!(channel);
    await h.adapter.close();
    channel.receive(APPLICATION_REQUEST);
    expect(h.handler).not.toHaveBeenCalled();
  });
});
