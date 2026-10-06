import { randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
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
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../identity/principal-resolver.js';
import {
  NativeSurfaceOperatorAuthority,
  NativeSurfaceRegistry,
} from '../native-surface-registry.js';
import {
  createNativeV2PionApplicationAdapter,
  createResolvedNativeV2PionApplicationAdapter,
  readVerifiedNativePionApplicationRequest,
} from '../native-v2-pion-application-adapter.js';
import type { PionApplicationAdapterInput } from '../pion-application-adapter.js';
import {
  readVerifiedNativeVirtualApplicationRequest,
  readVerifiedVirtualApplicationRequest,
  transferVerifiedNativeVirtualApplicationRequest,
  VirtualApplicationIngress,
} from '../virtual-application.js';

const makeTempDir = trackTempDirs();

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
  let lastRequest: Request | undefined;
  const seenPeerNonces: Array<string | undefined> = [];
  const handler = vi.fn((request: Request) => {
    lastRequest = request;
    const native = readVerifiedNativeVirtualApplicationRequest(request);
    seenPeerNonces.push(native?.peerNonce);
    expect(request.headers.get('authorization')).toBe(
      'station-session-continuation opaque-proof',
    );
    expect(native?.surface).toEqual(surface);
    expect(native?.stationId).toBe(trust.stationId);
    expect(native?.connectionEnrollmentId).toBe(trust.enrollmentId);
    expect(native?.routingGeneration).toBe(offer.scope.routingGeneration);
    expect(native?.routingGeneration).not.toBe(trust.generation);
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
  const accepts: Array<(channel: FakeChannel) => void> = [];
  let earlyChannel: FakeChannel | undefined;
  let resolveCleanup!: () => void;
  let rejectCleanup!: (reason: unknown) => void;
  const cleanupComplete = new Promise<void>((resolve, reject) => {
    resolveCleanup = resolve;
    rejectCleanup = reject;
  });
  const startAdapter = vi.fn(async (input: PionApplicationAdapterInput) => {
    expect(input.profile).toBe('application');
    expect(input.applicationChannelLabel).toBe('station-application-v1');
    accept = input.accept as (channel: FakeChannel) => void;
    accepts.push(accept);
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
  const dependencies = {
    startAdapter:
      startAdapter as unknown as typeof import('../pion-application-adapter.js').startPionApplicationAdapter,
    serve: (await import('@kontourai/station-connect/application-channel'))
      .serveApplicationChannel,
  };
  const adapter = createNativeV2PionApplicationAdapter(input, dependencies);
  return {
    input,
    dependencies,
    stopApplication: () => ingress.stop(),
    adapter,
    offer,
    surface,
    trust,
    trustOwner,
    handler,
    startAdapter,
    application,
    accept: () => accept,
    accepts: () => accepts,
    earlyChannel: () => earlyChannel,
    lastRequest: () => lastRequest,
    seenPeerNonces,
    resolveCleanup,
    rejectCleanup,
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
  test('native per-offer ICE uses fresh credentials and shortens its 90-second peer ceiling', async () => {
    const f = await fixture();
    const capture = vi.fn(async () => ({
      version: 'station-relay-ice-configuration/v1' as const,
      scope: f.offer.scope,
      iceTransportPolicy: 'relay' as const,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 50_000,
      iceServers: [
        {
          urls: ['turns:turn.example:443?transport=tcp'],
          username: 'native-issued-user',
          credential: 'native-issued-secret',
        },
      ],
    }));
    const adapter = createNativeV2PionApplicationAdapter(
      { ...f.input, turn: { source: 'broker', capture } },
      f.dependencies,
    );
    try {
      await adapter.adapter.answer(
        f.offer,
        f.trust,
        new AbortController().signal,
      );
      expect(capture).toHaveBeenCalledOnce();
      expect(f.startAdapter.mock.calls[0]![0].turn.username).toBe(
        'native-issued-user',
      );
      expect(
        f.startAdapter.mock.calls[0]![0].maxLifetimeMs,
      ).toBeLessThanOrEqual(45_000);
    } finally {
      await adapter.close();
      await f.adapter.close();
      f.stopApplication();
    }
  });
  test('native owner retirement during ICE capture refuses before Pion startup', async () => {
    const f = await fixture();
    const adapter = createNativeV2PionApplicationAdapter(
      {
        ...f.input,
        turn: {
          source: 'broker',
          capture: async () => {
            f.trustOwner.retire();
            return {
              version: 'station-relay-ice-configuration/v1',
              scope: f.offer.scope,
              iceTransportPolicy: 'relay',
              issuedAt: Date.now(),
              expiresAt: Date.now() + 600_000,
              iceServers: [
                {
                  urls: ['turns:turn.example:443?transport=tcp'],
                  username: 'issued-user',
                  credential: 'issued-secret',
                },
              ],
            };
          },
        },
      },
      f.dependencies,
    );
    try {
      await expect(
        adapter.adapter.answer(f.offer, f.trust, new AbortController().signal),
      ).rejects.toThrow('native_pion_application_trust_retired');
      expect(f.startAdapter).not.toHaveBeenCalled();
    } finally {
      await adapter.close();
      await f.adapter.close();
      f.stopApplication();
    }
  });

  test('resolved approved surface reaches application bytes and revocation fences the captured peer', async () => {
    const h = await fixture();
    const home = makeTempDir('native-resolved-peer-');
    const registry = new NativeSurfaceRegistry(home, h.trust.stationId);
    const authority = new NativeSurfaceOperatorAuthority();
    const tuple = { scope: h.offer.scope, surface: h.surface };
    registry.approve(
      authority.approve(LOCAL_OPERATOR_PRINCIPAL_ID, 'approve', tuple),
    );
    const resolved = createResolvedNativeV2PionApplicationAdapter(
      { ...h.input, registry },
      h.dependencies,
    );
    try {
      const admission = resolved.adapter.approvedSurfaces()[0]!;
      await expect(
        resolved.adapter.answer(
          {
            ...h.offer,
            surface: { ...h.surface, keyThumbprint: 'X'.repeat(43) },
          },
          h.trust,
          new AbortController().signal,
          admission,
        ),
      ).rejects.toThrow('surface_unapproved');
      expect(h.startAdapter).not.toHaveBeenCalled();
      await resolved.adapter.answer(
        h.offer,
        h.trust,
        new AbortController().signal,
        admission,
      );
      const channel = new FakeChannel();
      h.accept()!(channel);
      channel.receive(APPLICATION_REQUEST);
      await vi.waitFor(() => expect(h.handler).toHaveBeenCalledTimes(1));
      expect(applicationFrame(channel.sent[0]!)).toMatchObject({ status: 200 });
      const observed = h.lastRequest()!;
      registry.revoke(
        authority.approve(LOCAL_OPERATOR_PRINCIPAL_ID, 'revoke', tuple),
      );
      expect(
        readVerifiedNativeVirtualApplicationRequest(observed),
      ).toBeUndefined();
      channel.receive(APPLICATION_REQUEST);
      await vi.waitFor(() => expect(channel.closeCalls).toBeGreaterThan(0));
      expect(h.handler).toHaveBeenCalledTimes(1);
      await expect(
        resolved.adapter.answer(
          h.offer,
          h.trust,
          new AbortController().signal,
          admission,
        ),
      ).rejects.toThrow('surface_unapproved');
    } finally {
      await resolved.close();
      await h.adapter.close();
      registry.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
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

  test('natural peer cleanup invalidates retained request facts and closes channels', async () => {
    const h = await fixture();
    await h.adapter.adapter.answer(
      h.offer,
      h.trustOwner.current()!,
      new AbortController().signal,
    );
    const channel = new FakeChannel();
    h.accept()!(channel);
    channel.receive(APPLICATION_REQUEST);
    await vi.waitFor(() => expect(h.lastRequest()).toBeDefined());
    const observed = h.lastRequest()!;
    expect(readVerifiedNativeVirtualApplicationRequest(observed)).toBeDefined();
    h.resolveCleanup();
    await vi.waitFor(() => expect(h.adapter.activePeerCount).toBe(0));
    expect(channel.closeCalls).toBeGreaterThan(0);
    expect(
      readVerifiedNativeVirtualApplicationRequest(observed),
    ).toBeUndefined();
    await h.adapter.close();
  });

  test('failed natural cleanup invalidates facts and remains reportable', async () => {
    const h = await fixture();
    await h.adapter.adapter.answer(
      h.offer,
      h.trustOwner.current()!,
      new AbortController().signal,
    );
    const channel = new FakeChannel();
    h.accept()!(channel);
    channel.receive(APPLICATION_REQUEST);
    await vi.waitFor(() => expect(h.lastRequest()).toBeDefined());
    const observed = h.lastRequest()!;
    h.rejectCleanup(new Error('native_cleanup_failed'));
    await vi.waitFor(() => expect(channel.closeCalls).toBeGreaterThan(0));
    expect(
      readVerifiedNativeVirtualApplicationRequest(observed),
    ).toBeUndefined();
    await expect(h.adapter.close()).rejects.toThrow(
      'native_pion_application_close_failed',
    );
  });

  test('carries the exact broker offer nonce through fresh Request and bounded-body replacement and refuses forged substitutes', async () => {
    const h = await fixture();
    const requestNonce = randomBytes(32).toString('base64url');
    await h.adapter.adapter.answer(
      h.offer,
      h.trustOwner.current()!,
      new AbortController().signal,
    );
    const channel = new FakeChannel();
    h.accept()!(channel);
    const requestFrame = JSON.stringify({
      version: 'station.application-channel/v1',
      type: 'request',
      method: 'POST',
      path: '/api/projects',
      headers: [
        ['authorization', 'station-session-continuation opaque-proof'],
        ['x-station-peer-nonce', requestNonce],
      ],
      body: Buffer.from(JSON.stringify({ peerNonce: requestNonce })).toString(
        'base64',
      ),
    });
    channel.receive(requestFrame);
    await vi.waitFor(() => expect(h.lastRequest()).toBeDefined());
    const observed = h.lastRequest()!;
    const admitted = readVerifiedNativeVirtualApplicationRequest(observed);
    expect(admitted?.peerNonce).toBe(h.offer.nonce);
    expect(admitted?.peerNonce).not.toBe(requestNonce);

    const replacement = new Request(observed.url, {
      method: observed.method,
      headers: observed.headers,
      body: new Blob([JSON.stringify({ peerNonce: requestNonce })]),
    });
    expect(
      transferVerifiedNativeVirtualApplicationRequest(observed, replacement),
    ).toBe(true);
    const carried = readVerifiedNativeVirtualApplicationRequest(replacement);
    expect(carried?.peerNonce).toBe(h.offer.nonce);
    expect(carried?.peerNonce).not.toBe(requestNonce);

    const forgedNonce = randomBytes(32).toString('base64url');
    expect(forgedNonce).not.toBe(requestNonce);
    const forgedHeaders = new Headers(observed.headers);
    forgedHeaders.set('x-station-peer-nonce', forgedNonce);
    const forged = new Request(observed.url, {
      method: observed.method,
      headers: forgedHeaders,
      body: new Blob([JSON.stringify({ peerNonce: requestNonce })]),
      duplex: 'half',
    });
    const withoutReportedNonce = (headers: Headers) =>
      [...headers].filter(([name]) => name !== 'x-station-peer-nonce');
    expect(withoutReportedNonce(forged.headers)).toEqual(
      withoutReportedNonce(observed.headers),
    );
    expect(
      transferVerifiedNativeVirtualApplicationRequest(observed, forged),
    ).toBe(false);
    expect(readVerifiedNativeVirtualApplicationRequest(forged)).toBeUndefined();
    expect(
      readVerifiedNativeVirtualApplicationRequest(
        new Request(observed.url, { method: observed.method }),
      ),
    ).toBeUndefined();
    await h.adapter.close();
  });

  test('two offers for the same client instance with distinct nonces remain distinguishable', async () => {
    const h = await fixture();
    const firstOffer = h.offer;
    const secondNonce = randomBytes(32).toString('base64url');
    expect(secondNonce).not.toBe(firstOffer.nonce);
    const secondOffer = { ...firstOffer, nonce: secondNonce };
    await h.adapter.adapter.answer(
      firstOffer,
      h.trustOwner.current()!,
      new AbortController().signal,
    );
    await h.adapter.adapter.answer(
      secondOffer,
      h.trustOwner.current()!,
      new AbortController().signal,
    );
    expect(h.adapter.activePeerCount).toBe(2);
    const firstChannel = new FakeChannel();
    const secondChannel = new FakeChannel();
    const [firstAccept, secondAccept] = h.accepts();
    firstAccept!(firstChannel);
    secondAccept!(secondChannel);
    firstChannel.receive(APPLICATION_REQUEST);
    secondChannel.receive(APPLICATION_REQUEST);
    await vi.waitFor(() => expect(h.handler).toHaveBeenCalledTimes(2));
    expect(h.seenPeerNonces).toEqual([firstOffer.nonce, secondNonce]);
    await h.adapter.close();
  });

  test('retiring a peer makes its nonce-bearing facts refuse', async () => {
    const h = await fixture();
    await h.adapter.adapter.answer(
      h.offer,
      h.trustOwner.current()!,
      new AbortController().signal,
    );
    const channel = new FakeChannel();
    h.accept()!(channel);
    channel.receive(APPLICATION_REQUEST);
    await vi.waitFor(() => expect(h.lastRequest()).toBeDefined());
    const observed = h.lastRequest()!;
    expect(
      readVerifiedNativeVirtualApplicationRequest(observed)?.peerNonce,
    ).toBe(h.offer.nonce);
    h.resolveCleanup();
    await vi.waitFor(() => expect(h.adapter.activePeerCount).toBe(0));
    expect(channel.closeCalls).toBeGreaterThan(0);
    expect(
      readVerifiedNativeVirtualApplicationRequest(observed),
    ).toBeUndefined();
    await h.adapter.close();
  });
});
