import type { webcrypto as nodeWebcrypto } from 'node:crypto';
import {
  NATIVE_DEVICE_PROOF_LIFETIME_SECONDS,
  NATIVE_DEVICE_PROOF_TYPE,
  type NativeDeviceBindingSnapshot,
} from '@kontourai/station-contracts/native-device-proof';
import type { SelfHostedBrokerNativeClientSurfaceV2 } from '@kontourai/station-contracts/self-hosted-broker';
import { createNativeDeviceRequestProof } from '@kontourai/station-sdk/native-device-proof';
import { describe, expect, test } from 'vitest';
import {
  type NativeDeviceProofBindingView,
  type NativeDeviceProofPeerView,
  type NativeDeviceProofPublicKeyJwk,
  NativeDeviceProofReplayedError,
  verifyNativeDeviceRequestProof,
} from '../native-device-proof-verifier.js';

const opaque = (label: string) => label.padEnd(43, 'a');
const STATION_UUID = '7e5a8c1e-1f2b-4c3d-9a4e-5f6a7b8c9d0e';
const DEVICE_UUID = '2b9d4f6a-8c1e-4b3f-a5d7-6e8f9a0b1c2d';
const BINDING_UUID = '9c3e5f7a-1b2d-4e6f-8a9b-0c1d2e3f4a5b';
const STATION_ID = STATION_UUID;
const DEVICE_ID = DEVICE_UUID;
const BINDING_ID = BINDING_UUID;
const ROUTE_KEY_THUMBPRINT = opaque('routekey');
const PEER_NONCE = opaque('peernonce');
const AUDIENCE = 'https://station.example.test';
const PATH = '/v1/things?limit=2';

const surface = (
  keyThumbprint = ROUTE_KEY_THUMBPRINT,
): SelfHostedBrokerNativeClientSurfaceV2 => ({
  kind: 'station-native',
  appIdentifier: 'dev.kontourai.station',
  channel: 'stable',
  clientInstanceId: '3f2c9b1e-5a44-4c1d-9a7b-2b6e8f0a1c2d',
  keyThumbprint,
});

const bindingSnapshot = (
  overrides: Partial<NativeDeviceBindingSnapshot> = {},
): NativeDeviceBindingSnapshot => ({
  stationId: STATION_ID,
  stationAudience: AUDIENCE,
  deviceId: DEVICE_ID,
  bindingId: BINDING_ID,
  deviceProofKeyThumbprint: opaque('proofkey'),
  surface: surface(),
  peerNonce: PEER_NONCE,
  ...overrides,
});

const peerSnapshot = (
  overrides: Partial<NonNullable<NativeDeviceProofPeerView['snapshot']>> = {},
): NonNullable<NativeDeviceProofPeerView['snapshot']> => ({
  stationId: STATION_ID,
  stationAudience: AUDIENCE,
  surface: surface(),
  peerNonce: PEER_NONCE,
  ...overrides,
});

interface KeyPair {
  readonly publicKey: NativeDeviceProofPublicKeyJwk;
  sign(input: Uint8Array): Promise<Uint8Array>;
}

async function generateKeyPair(): Promise<KeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const publicJwk = (await crypto.subtle.exportKey(
    'jwk',
    pair.publicKey,
  )) as nodeWebcrypto.JsonWebKey;
  return {
    publicKey: {
      kty: 'EC',
      crv: 'P-256',
      x: publicJwk.x as string,
      y: publicJwk.y as string,
    },
    sign: (input) => signP1363(pair.privateKey, input),
  };
}

/** Node WebCrypto yields the IEEE-P1363 64-byte form the signer contract wants. */
async function signP1363(
  privateKey: CryptoKey,
  input: Uint8Array,
): Promise<Uint8Array> {
  const inputCopy = new Uint8Array(input.byteLength);
  inputCopy.set(input);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      inputCopy,
    ),
  );
  expect(signature.byteLength).toBe(64);
  return signature;
}

const thumbprint = async (jwk: NativeDeviceProofPublicKeyJwk) => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }),
    ),
  );
  return Buffer.from(new Uint8Array(digest))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
};

class MemoryReplayStore {
  readonly consumed: string[] = [];
  private readonly seen = new Set<string>();
  failNext = false;

  async consume(jti: string): Promise<void> {
    if (this.failNext) throw new Error('replay store backend unavailable');
    if (this.seen.has(jti)) throw new NativeDeviceProofReplayedError();
    this.seen.add(jti);
    this.consumed.push(jti);
  }
}

interface Harness {
  key: KeyPair;
  otherKey: KeyPair;
  store: MemoryReplayStore;
  authority: {
    binding: () => Promise<NativeDeviceProofBindingView>;
    peer: () => Promise<NativeDeviceProofPeerView>;
  };
  nowSeconds: () => number;
  snapshot: NativeDeviceBindingSnapshot;
  makeBinding: () => Promise<NativeDeviceProofBindingView>;
  makePeer: () => NativeDeviceProofPeerView;
  buildProof: (options?: {
    snapshot?: NativeDeviceBindingSnapshot;
    method?: string;
    path?: string;
    body?: Uint8Array;
  }) => Promise<string>;
}

async function harness(): Promise<Harness> {
  const key = await generateKeyPair();
  const otherKey = await generateKeyPair();
  const store = new MemoryReplayStore();
  const now = Math.floor(Date.now() / 1000);
  const snapshot: NativeDeviceBindingSnapshot = bindingSnapshot({
    deviceProofKeyThumbprint: await thumbprint(key.publicKey),
  });
  const binding: NativeDeviceProofBindingView = {
    status: 'approved',
    snapshot,
    deviceProofKey: key.publicKey,
  };
  const peer: NativeDeviceProofPeerView = {
    status: 'current',
    snapshot: peerSnapshot(),
  };
  return {
    key,
    otherKey,
    store,
    nowSeconds: () => now,
    get authority() {
      return {
        binding: async () => binding,
        peer: async () => peer,
      };
    },
    snapshot,
    makeBinding: async () => binding,
    makePeer: () => peer,
    buildProof: async (options) => {
      const used = options?.snapshot ?? snapshot;
      return createNativeDeviceRequestProof(key, used, {
        method: options?.method ?? 'POST',
        path: options?.path ?? PATH,
        body: options?.body ?? new TextEncoder().encode('{"n":1}'),
      });
    },
  };
}

const request = (overrides?: {
  method?: string;
  path?: string;
  body?: Uint8Array;
}) => ({
  method: overrides?.method ?? 'POST',
  path: overrides?.path ?? PATH,
  body: overrides?.body ?? new TextEncoder().encode('{"n":1}'),
});

const encodeSegment = (value: unknown) =>
  Buffer.from(JSON.stringify(value), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const sha256Base64Url = async (bytes: Uint8Array) => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return Buffer.from(await crypto.subtle.digest('SHA-256', copy)).toString(
    'base64url',
  );
};

const baseClaims = async (
  h: Harness,
  overrides: Record<string, unknown> = {},
) => ({
  version: 'station-native-device-proof/v1',
  aud: AUDIENCE,
  purpose: 'request',
  stationId: STATION_ID,
  deviceId: DEVICE_ID,
  bindingId: BINDING_ID,
  deviceProofKeyThumbprint: await thumbprint(h.key.publicKey),
  surface: surface(),
  peerNonce: PEER_NONCE,
  htm: 'POST',
  htu: PATH,
  bodySha256: await sha256Base64Url(new TextEncoder().encode('{"n":1}')),
  jti: opaque('jtivalue'),
  iat: h.nowSeconds(),
  exp: h.nowSeconds() + NATIVE_DEVICE_PROOF_LIFETIME_SECONDS,
  ...overrides,
});

const handBuiltProof = async (
  key: KeyPair,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {
    alg: 'ES256',
    typ: NATIVE_DEVICE_PROOF_TYPE,
  },
) => {
  const headerSegment = encodeSegment(header);
  const payloadSegment = encodeSegment(claims);
  const signature = await key.sign(
    new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
  );
  return `${headerSegment}.${payloadSegment}.${Buffer.from(signature).toString('base64url')}`;
};

describe('verifyNativeDeviceRequestProof', () => {
  test('accepts an exact proof from the real SDK signer with a generated P-256 key and consumes its JTI once', async () => {
    const h = await harness();
    const proof = await h.buildProof();
    const result = await verifyNativeDeviceRequestProof(
      proof,
      request(),
      h.authority,
      { replayStore: h.store, nowSeconds: h.nowSeconds },
    );
    expect(result).toEqual({ deviceId: DEVICE_ID, bindingId: BINDING_ID });
    expect(h.store.consumed).toHaveLength(1);
  });

  test('rejects a proof signed by a different key (signature verification is reached)', async () => {
    const h = await harness();
    const proof = await createNativeDeviceRequestProof(
      h.otherKey,
      {
        ...h.snapshot,
        deviceProofKeyThumbprint: await thumbprint(h.otherKey.publicKey),
      },
      request(),
    );
    // Honest binding, but claims name the other key's thumbprint: mismatch first.
    await expect(
      verifyNativeDeviceRequestProof(proof, request(), h.authority, {
        replayStore: h.store,
        nowSeconds: h.nowSeconds,
      }),
    ).rejects.toMatchObject({ reason: 'binding_mismatch' });

    const forged = await h.buildProof();
    const parts = forged.split('.');
    const signatureBytes = Buffer.from(parts[2]!, 'base64url');
    signatureBytes[0] ^= 1;
    parts[2] = signatureBytes.toString('base64url');
    const tampered = parts.join('.');
    await expect(
      verifyNativeDeviceRequestProof(tampered, request(), h.authority, {
        replayStore: h.store,
        nowSeconds: h.nowSeconds,
      }),
    ).rejects.toMatchObject({ reason: 'signature_invalid' });
    expect(h.store.consumed).toHaveLength(0);
  });

  test('rejects an approved-key substitution under an unchanged Device thumbprint', async () => {
    const h = await harness();
    const forged = await handBuiltProof(h.otherKey, await baseClaims(h));
    await expect(
      verifyNativeDeviceRequestProof(
        forged,
        request(),
        {
          binding: async () => ({
            status: 'approved',
            snapshot: h.snapshot,
            deviceProofKey: h.otherKey.publicKey,
          }),
          peer: h.authority.peer,
        },
        { replayStore: h.store, nowSeconds: h.nowSeconds },
      ),
    ).rejects.toMatchObject({ reason: 'binding_mismatch' });
    expect(h.store.consumed).toHaveLength(0);
  });

  test('rejects when the binding reuses the route key thumbprint', async () => {
    const h = await harness();
    const claims = await baseClaims(h, {
      deviceProofKeyThumbprint: ROUTE_KEY_THUMBPRINT,
      surface: surface(ROUTE_KEY_THUMBPRINT),
    });
    const proof = await handBuiltProof(h.key, claims);
    const binding: NativeDeviceProofBindingView = {
      status: 'approved',
      snapshot: bindingSnapshot({
        deviceProofKeyThumbprint: ROUTE_KEY_THUMBPRINT,
        surface: surface(ROUTE_KEY_THUMBPRINT),
      }),
      deviceProofKey: h.key.publicKey,
    };
    await expect(
      verifyNativeDeviceRequestProof(
        proof,
        request(),
        { binding: async () => binding, peer: h.authority.peer },
        { replayStore: h.store, nowSeconds: h.nowSeconds },
      ),
    ).rejects.toMatchObject({ reason: 'binding_mismatch' });
    expect(h.store.consumed).toHaveLength(0);
  });

  test('rejects a wrong Station audience, surface or peer nonce', async () => {
    const h = await harness();
    const proof = await h.buildProof();

    await expect(
      verifyNativeDeviceRequestProof(
        proof,
        request(),
        {
          binding: h.authority.binding,
          peer: async () => ({
            status: 'current',
            snapshot: peerSnapshot({ stationId: opaque('other') }),
          }),
        },
        { replayStore: h.store, nowSeconds: h.nowSeconds },
      ),
    ).rejects.toMatchObject({ reason: 'peer_mismatch' });

    await expect(
      verifyNativeDeviceRequestProof(
        proof,
        request(),
        {
          binding: h.authority.binding,
          peer: async () => ({
            status: 'current',
            snapshot: peerSnapshot({ peerNonce: opaque('othernonce') }),
          }),
        },
        { replayStore: h.store, nowSeconds: h.nowSeconds },
      ),
    ).rejects.toMatchObject({ reason: 'peer_mismatch' });

    await expect(
      verifyNativeDeviceRequestProof(
        proof,
        request(),
        {
          binding: h.authority.binding,
          peer: async () => ({
            status: 'current',
            snapshot: peerSnapshot({
              surface: surface(opaque('routetwo')),
            }),
          }),
        },
        { replayStore: h.store, nowSeconds: h.nowSeconds },
      ),
    ).rejects.toMatchObject({ reason: 'peer_mismatch' });
    expect(h.store.consumed).toHaveLength(0);
  });

  test('rejects changed path, query, method or body', async () => {
    const h = await harness();
    const proof = await h.buildProof();
    await expect(
      verifyNativeDeviceRequestProof(
        proof,
        request({ path: '/v1/things?limit=3' }),
        h.authority,
        { replayStore: h.store, nowSeconds: h.nowSeconds },
      ),
    ).rejects.toMatchObject({ reason: 'route_mismatch' });
    await expect(
      verifyNativeDeviceRequestProof(
        proof,
        request({ path: '/v1/other?limit=2' }),
        h.authority,
        { replayStore: h.store, nowSeconds: h.nowSeconds },
      ),
    ).rejects.toMatchObject({ reason: 'route_mismatch' });
    await expect(
      verifyNativeDeviceRequestProof(
        proof,
        request({ method: 'PUT' }),
        h.authority,
        {
          replayStore: h.store,
          nowSeconds: h.nowSeconds,
        },
      ),
    ).rejects.toMatchObject({ reason: 'route_mismatch' });
    await expect(
      verifyNativeDeviceRequestProof(
        proof,
        request({ body: new TextEncoder().encode('{"n":2}') }),
        h.authority,
        { replayStore: h.store, nowSeconds: h.nowSeconds },
      ),
    ).rejects.toMatchObject({ reason: 'body_mismatch' });
    expect(h.store.consumed).toHaveLength(0);
  });

  test('rejects a replayed JTI after the first acceptance', async () => {
    const h = await harness();
    const proof = await h.buildProof();
    await verifyNativeDeviceRequestProof(proof, request(), h.authority, {
      replayStore: h.store,
      nowSeconds: h.nowSeconds,
    });
    await expect(
      verifyNativeDeviceRequestProof(proof, request(), h.authority, {
        replayStore: h.store,
        nowSeconds: h.nowSeconds,
      }),
    ).rejects.toBeInstanceOf(NativeDeviceProofReplayedError);
    expect(h.store.consumed).toHaveLength(1);
  });

  test('rejects an expired proof and a proof dated in the future', async () => {
    const h = await harness();
    await expect(
      verifyNativeDeviceRequestProof(
        await h.buildProof(),
        request(),
        h.authority,
        {
          replayStore: h.store,
          nowSeconds: () =>
            h.nowSeconds() + NATIVE_DEVICE_PROOF_LIFETIME_SECONDS,
        },
      ),
    ).rejects.toMatchObject({ reason: 'expired' });
    const proof = await h.buildProof();
    const future = h.nowSeconds() + NATIVE_DEVICE_PROOF_LIFETIME_SECONDS + 1;
    await expect(
      verifyNativeDeviceRequestProof(proof, request(), h.authority, {
        replayStore: h.store,
        nowSeconds: () => future,
      }),
    ).rejects.toMatchObject({ reason: 'expired' });

    const futureProof = await h.buildProof();
    const pastViewer = h.nowSeconds() - 100;
    await expect(
      verifyNativeDeviceRequestProof(futureProof, request(), h.authority, {
        replayStore: h.store,
        nowSeconds: () => pastViewer,
      }),
    ).rejects.toMatchObject({ reason: 'not_yet_valid' });
    expect(h.store.consumed).toHaveLength(0);
  });

  test('rejects when the binding is rotated or revoked after asynchronous work', async () => {
    const h = await harness();
    const proof = await h.buildProof();
    let binding = await h.makeBinding();
    let calls = 0;
    await expect(
      verifyNativeDeviceRequestProof(
        proof,
        request(),
        {
          binding: async () => {
            calls += 1;
            if (calls >= 2) binding = { status: 'rotated' };
            return binding;
          },
          peer: h.authority.peer,
        },
        { replayStore: h.store, nowSeconds: h.nowSeconds },
      ),
    ).rejects.toMatchObject({ reason: 'binding_not_approved' });
    expect(calls).toBe(2);
    expect(h.store.consumed).toHaveLength(0);

    let peerCalls = 0;
    const peerView = h.makePeer();
    await expect(
      verifyNativeDeviceRequestProof(
        await h.buildProof(),
        request(),
        {
          binding: h.authority.binding,
          peer: async () => {
            peerCalls += 1;
            return peerCalls >= 2 ? { status: 'aborted' } : peerView;
          },
        },
        { replayStore: h.store, nowSeconds: h.nowSeconds },
      ),
    ).rejects.toMatchObject({ reason: 'peer_not_current' });
    expect(peerCalls).toBe(2);
    expect(h.store.consumed).toHaveLength(0);
  });

  test('rechecks every binding and peer field after signature verification', async () => {
    const h = await harness();
    const proof = await h.buildProof();
    let bindingReads = 0;
    await expect(
      verifyNativeDeviceRequestProof(
        proof,
        request(),
        {
          binding: async () => {
            bindingReads += 1;
            return {
              status: 'approved',
              snapshot:
                bindingReads === 1
                  ? h.snapshot
                  : {
                      ...h.snapshot,
                      surface: {
                        ...h.snapshot.surface,
                        clientInstanceId:
                          '44444444-4444-4444-8444-444444444444',
                      },
                    },
              deviceProofKey: h.key.publicKey,
            };
          },
          peer: h.authority.peer,
        },
        { replayStore: h.store, nowSeconds: h.nowSeconds },
      ),
    ).rejects.toMatchObject({ reason: 'binding_not_approved' });
    expect(h.store.consumed).toHaveLength(0);

    let peerReads = 0;
    await expect(
      verifyNativeDeviceRequestProof(
        await h.buildProof(),
        request(),
        {
          binding: h.authority.binding,
          peer: async () => {
            peerReads += 1;
            return {
              status: 'current',
              snapshot:
                peerReads === 1
                  ? peerSnapshot()
                  : peerSnapshot({ peerNonce: opaque('newnonce') }),
            };
          },
        },
        { replayStore: h.store, nowSeconds: h.nowSeconds },
      ),
    ).rejects.toMatchObject({ reason: 'peer_not_current' });
    expect(h.store.consumed).toHaveLength(0);
  });

  test('refuses authority retired during replay consumption before returning a Device', async () => {
    const h = await harness();
    let bindingRevoked = false;
    await expect(
      verifyNativeDeviceRequestProof(
        await h.buildProof(),
        request(),
        {
          binding: async () =>
            bindingRevoked ? { status: 'revoked' } : h.makeBinding(),
          peer: h.authority.peer,
        },
        {
          nowSeconds: h.nowSeconds,
          replayStore: {
            async consume() {
              bindingRevoked = true;
            },
          },
        },
      ),
    ).rejects.toMatchObject({ reason: 'binding_not_approved' });

    let peerRetired = false;
    await expect(
      verifyNativeDeviceRequestProof(
        await h.buildProof(),
        request(),
        {
          binding: h.authority.binding,
          peer: async () =>
            peerRetired ? { status: 'aborted' } : h.makePeer(),
        },
        {
          nowSeconds: h.nowSeconds,
          replayStore: {
            async consume() {
              peerRetired = true;
            },
          },
        },
      ),
    ).rejects.toMatchObject({ reason: 'peer_not_current' });
  });

  test('rejects an invalid verification clock before consuming a proof', async () => {
    const h = await harness();
    await expect(
      verifyNativeDeviceRequestProof(
        await h.buildProof(),
        request(),
        h.authority,
        {
          replayStore: h.store,
          nowSeconds: () => Number.NaN,
        },
      ),
    ).rejects.toMatchObject({ reason: 'invalid_claims' });
    expect(h.store.consumed).toHaveLength(0);
  });

  test('requires the approved binding nonce to match the verified peer and signed proof', async () => {
    const h = await harness();
    await expect(
      verifyNativeDeviceRequestProof(
        await h.buildProof(),
        request(),
        {
          ...h.authority,
          binding: async () => ({
            ...(await h.makeBinding()),
            snapshot: { ...h.snapshot, peerNonce: 'b'.repeat(43) },
          }),
        },
        { replayStore: h.store, nowSeconds: h.nowSeconds },
      ),
    ).rejects.toMatchObject({ reason: 'binding_mismatch' });
    expect(h.store.consumed).toHaveLength(0);
  });

  test('accepts the SDK path contract beyond 512 characters', async () => {
    const h = await harness();
    const path = `/${'a'.repeat(600)}`;
    await expect(
      verifyNativeDeviceRequestProof(
        await h.buildProof({ path }),
        request({ path }),
        h.authority,
        { replayStore: h.store, nowSeconds: h.nowSeconds },
      ),
    ).resolves.toEqual({
      deviceId: h.snapshot.deviceId,
      bindingId: h.snapshot.bindingId,
    });
  });

  test('refuses authority that mutates a previously returned snapshot in place', async () => {
    const h = await harness();
    const proof = await h.buildProof();
    const mutable = structuredClone(await h.makeBinding());
    let reads = 0;
    await expect(
      verifyNativeDeviceRequestProof(
        proof,
        request(),
        {
          ...h.authority,
          binding: async () => {
            if (++reads === 3 && mutable.snapshot) {
              Object.assign(mutable.snapshot, {
                deviceId: '11111111-1111-4111-8111-111111111111',
              });
            }
            return mutable;
          },
        },
        { replayStore: h.store, nowSeconds: h.nowSeconds },
      ),
    ).rejects.toMatchObject({ reason: 'binding_not_approved' });
  });

  test.each([
    { advance: 31, reason: 'expired' },
    { advance: Number.NaN, reason: 'invalid_claims' },
  ])(
    'rechecks the proof clock after replay consumption ($reason)',
    async ({ advance, reason }) => {
      const h = await harness();
      let clock = h.nowSeconds();
      const proof = await h.buildProof();
      await expect(
        verifyNativeDeviceRequestProof(proof, request(), h.authority, {
          nowSeconds: () => clock,
          replayStore: {
            async consume(jti) {
              await h.store.consume(jti);
              clock += advance;
            },
          },
        }),
      ).rejects.toMatchObject({ reason });
      expect(h.store.consumed).toHaveLength(1);
    },
  );

  test('rejects an extra claim and an extra header parameter', async () => {
    const h = await harness();
    const claims = await baseClaims(h);

    const extraClaimProof = await handBuiltProof(h.key, {
      ...claims,
      scope: 'everything',
    });
    await expect(
      verifyNativeDeviceRequestProof(extraClaimProof, request(), h.authority, {
        replayStore: h.store,
        nowSeconds: h.nowSeconds,
      }),
    ).rejects.toMatchObject({ reason: 'invalid_claims' });

    const extraHeaderProof = await handBuiltProof(h.key, claims, {
      alg: 'ES256',
      typ: NATIVE_DEVICE_PROOF_TYPE,
      kid: 'extra',
    });
    await expect(
      verifyNativeDeviceRequestProof(extraHeaderProof, request(), h.authority, {
        replayStore: h.store,
        nowSeconds: h.nowSeconds,
      }),
    ).rejects.toMatchObject({ reason: 'invalid_header' });
    expect(h.store.consumed).toHaveLength(0);
  });

  test('rejects a signed but non-canonical base64url JWS segment', async () => {
    const h = await harness();
    const headerBytes = Buffer.from(
      `${JSON.stringify({ alg: 'ES256', typ: NATIVE_DEVICE_PROOF_TYPE })} `,
    );
    const canonical = headerBytes.toString('base64url');
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const replacement = [...alphabet]
      .map((last) => `${canonical.slice(0, -1)}${last}`)
      .find(
        (candidate) =>
          candidate !== canonical &&
          Buffer.from(candidate, 'base64url').equals(headerBytes),
      );
    expect(replacement).toBeDefined();
    const payload = encodeSegment(await baseClaims(h));
    const input = `${replacement}.${payload}`;
    const signature = await h.key.sign(new TextEncoder().encode(input));
    await expect(
      verifyNativeDeviceRequestProof(
        `${input}.${Buffer.from(signature).toString('base64url')}`,
        request(),
        h.authority,
        { replayStore: h.store, nowSeconds: h.nowSeconds },
      ),
    ).rejects.toMatchObject({ reason: 'malformed_proof' });
    expect(h.store.consumed).toHaveLength(0);
  });

  test('rejects an oversized body and an oversized proof', async () => {
    const h = await harness();
    const bigBody = new Uint8Array(16 * 1024 + 1);
    await expect(
      verifyNativeDeviceRequestProof(
        'a.b.c',
        request({ body: bigBody }),
        h.authority,
        {
          replayStore: h.store,
          nowSeconds: h.nowSeconds,
        },
      ),
    ).rejects.toMatchObject({ reason: 'oversized_body' });

    const oversizedProof = `${'a'.repeat(4097)}.b.c`;
    await expect(
      verifyNativeDeviceRequestProof(oversizedProof, request(), h.authority, {
        replayStore: h.store,
        nowSeconds: h.nowSeconds,
      }),
    ).rejects.toMatchObject({ reason: 'oversized_proof' });
    expect(h.store.consumed).toHaveLength(0);
  });

  test('rejects a missing or aborted peer and fails closed on a replay-store error', async () => {
    const h = await harness();
    const proof = await h.buildProof();

    await expect(
      verifyNativeDeviceRequestProof(
        proof,
        request(),
        {
          binding: h.authority.binding,
          peer: async () => ({ status: 'aborted' }),
        },
        { replayStore: h.store, nowSeconds: h.nowSeconds },
      ),
    ).rejects.toMatchObject({ reason: 'peer_not_current' });

    h.store.failNext = true;
    await expect(
      verifyNativeDeviceRequestProof(proof, request(), h.authority, {
        replayStore: h.store,
        nowSeconds: h.nowSeconds,
      }),
    ).rejects.toMatchObject({ reason: 'replay_store_unavailable' });
    expect(h.store.consumed).toHaveLength(0);
  });
});
