import {
  NATIVE_DEVICE_PROOF_LIFETIME_SECONDS,
  NATIVE_DEVICE_PROOF_REQUEST_PURPOSE,
  NATIVE_DEVICE_PROOF_TYPE,
  NATIVE_DEVICE_PROOF_VERSION,
  type NativeDeviceProofPublicKey,
} from '@kontourai/station-contracts/native-device-proof';
import type { SelfHostedBrokerNativeClientSurfaceV2 } from '@kontourai/station-contracts/self-hosted-broker';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createNativeDeviceRequestProof,
  type NativeDeviceProofSigner,
} from '../client/native-device-proof.js';

const audience = 'https://station.example.test';
const path = '/api/v1/sessions?turn=7';

test('refuses a combined proof-size overflow before invoking the host signer', async () => {
  const key = await makeSigner();
  const snapshot = await binding(key);
  const sign = vi.spyOn(key.signer, 'sign');
  await expect(
    createNativeDeviceRequestProof(
      key.signer,
      {
        ...snapshot,
        surface: { ...snapshot.surface, appIdentifier: 'a'.repeat(255) },
      },
      { method: 'GET', path: `/${'a'.repeat(2047)}`, body: new Uint8Array() },
    ),
  ).rejects.toThrow('proof exceeds');
  expect(sign).not.toHaveBeenCalled();
});

function decode(value: string): Record<string, unknown> {
  return JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/')));
}
function decodeBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function makeSigner(): Promise<{
  signer: NativeDeviceProofSigner;
  publicKey: NativeDeviceProofPublicKey;
  thumbprint: string;
}> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const publicKey = {
    kty: 'EC' as const,
    crv: 'P-256' as const,
    x: jwk.x!,
    y: jwk.y!,
  };
  const thumbprint = btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(
            JSON.stringify({
              crv: publicKey.crv,
              kty: publicKey.kty,
              x: publicKey.x,
              y: publicKey.y,
            }),
          ),
        ),
      ),
    ),
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return {
    publicKey,
    thumbprint,
    signer: {
      publicKey,
      async sign(input: Uint8Array) {
        return new Uint8Array(
          await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            pair.privateKey,
            new Uint8Array(input),
          ),
        );
      },
    },
  };
}

async function binding(
  key: Awaited<ReturnType<typeof makeSigner>>,
  overrides: Partial<Parameters<typeof createNativeDeviceRequestProof>[1]> = {},
) {
  const surface: SelfHostedBrokerNativeClientSurfaceV2 = {
    kind: 'station-native',
    appIdentifier: 'dev.kontourai.station',
    channel: 'stable',
    clientInstanceId: '33333333-3333-4333-8333-333333333333',
    keyThumbprint: 'R'.repeat(43),
  };
  return {
    stationId: '11111111-1111-4111-8111-111111111111',
    stationAudience: audience,
    deviceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    bindingId: '22222222-2222-4222-8222-222222222222',
    deviceProofKeyThumbprint: key.thumbprint,
    surface,
    peerNonce: 'N'.repeat(43),
    ...overrides,
  };
}

afterEach(() => vi.useRealTimers());

describe('native device request proof', () => {
  test('signs exact header.payload bytes with ES256 and binds the exact body hash', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T12:00:00.000Z'));
    const key = await makeSigner();
    const body = new TextEncoder().encode('{"turnId":"t-7"}');
    const compact = await createNativeDeviceRequestProof(
      key.signer,
      await binding(key),
      { method: 'post', path, body },
    );
    const [header, payload, signature] = compact.split('.');
    expect(decode(header!)).toEqual({
      alg: 'ES256',
      typ: NATIVE_DEVICE_PROOF_TYPE,
    });
    const bodySha256 = btoa(
      String.fromCharCode(
        ...new Uint8Array(await crypto.subtle.digest('SHA-256', body)),
      ),
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(decode(payload!)).toEqual({
      version: NATIVE_DEVICE_PROOF_VERSION,
      aud: audience,
      purpose: NATIVE_DEVICE_PROOF_REQUEST_PURPOSE,
      stationId: '11111111-1111-4111-8111-111111111111',
      deviceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      bindingId: '22222222-2222-4222-8222-222222222222',
      deviceProofKeyThumbprint: key.thumbprint,
      surface: (await binding(key)).surface,
      peerNonce: 'N'.repeat(43),
      htm: 'POST',
      htu: path,
      bodySha256,
      jti: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + NATIVE_DEVICE_PROOF_LIFETIME_SECONDS,
    });
    const verifyingKey = await crypto.subtle.importKey(
      'jwk',
      key.publicKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify'],
    );
    expect(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        verifyingKey,
        decodeBytes(signature!),
        new TextEncoder().encode(`${header}.${payload}`),
      ),
    ).toBe(true);
    expect(signature!.length).toBeGreaterThan(80);
  });

  test('the body hash changes when a single transmitted byte changes', async () => {
    const key = await makeSigner();
    const snap = await binding(key);
    const before = await createNativeDeviceRequestProof(key.signer, snap, {
      method: 'POST',
      path,
      body: new TextEncoder().encode('{"turnId":"t-7"}'),
    });
    const after = await createNativeDeviceRequestProof(key.signer, snap, {
      method: 'POST',
      path,
      body: new TextEncoder().encode('{"turnId":"t-8"}'),
    });
    expect(decode(before.split('.')[1]!).bodySha256).not.toBe(
      decode(after.split('.')[1]!).bodySha256,
    );
  });

  test('each proof carries a fresh one-use JTI', async () => {
    const key = await makeSigner();
    const snap = await binding(key);
    const request = {
      method: 'POST',
      path,
      body: new Uint8Array(0),
    };
    const jti = decode(
      (await createNativeDeviceRequestProof(key.signer, snap, request)).split(
        '.',
      )[1]!,
    ).jti;
    const again = decode(
      (await createNativeDeviceRequestProof(key.signer, snap, request)).split(
        '.',
      )[1]!,
    ).jti;
    expect(jti).not.toBe(again);
  });

  test('refuses a key that does not match the approved binding thumbprint', async () => {
    const key = await makeSigner();
    const other = await makeSigner();
    await expect(
      createNativeDeviceRequestProof(other.signer, await binding(key), {
        method: 'POST',
        path,
        body: new Uint8Array(0),
      }),
    ).rejects.toThrow('thumbprint');
  });

  test('keeps the routing surface key independent and refuses a non-native surface', async () => {
    const key = await makeSigner();
    const compact = await createNativeDeviceRequestProof(
      key.signer,
      await binding(key),
      { method: 'POST', path, body: new Uint8Array(0) },
    );
    const claims = decode(compact.split('.')[1]!);
    expect((claims.surface as { keyThumbprint: string }).keyThumbprint).toBe(
      'R'.repeat(43),
    );
    expect(claims.deviceProofKeyThumbprint).toBe(key.thumbprint);
    expect(claims.deviceProofKeyThumbprint).not.toBe(
      (claims.surface as { keyThumbprint: string }).keyThumbprint,
    );
    await expect(
      createNativeDeviceRequestProof(
        key.signer,
        await binding(key, {
          surface: {
            kind: 'browser',
            appIdentifier: 'dev.kontourai.station',
            channel: 'stable',
            clientInstanceId: '33333333-3333-4333-8333-333333333333',
            keyThumbprint: 'R'.repeat(43),
          } as unknown as SelfHostedBrokerNativeClientSurfaceV2,
        }),
        { method: 'POST', path, body: new Uint8Array(0) },
      ),
    ).rejects.toThrow();
  });

  test('refuses a non-canonical or plaintext audience and a malformed path', async () => {
    const key = await makeSigner();
    const request = { method: 'POST', path, body: new Uint8Array(0) };
    await expect(
      createNativeDeviceRequestProof(
        key.signer,
        await binding(key, { stationAudience: 'http://station.example.test' }),
        request,
      ),
    ).rejects.toThrow();
    await expect(
      createNativeDeviceRequestProof(
        key.signer,
        await binding(key, {
          stationAudience: 'https://station.example.test/',
        }),
        request,
      ),
    ).rejects.toThrow();
    await expect(
      createNativeDeviceRequestProof(key.signer, await binding(key), {
        ...request,
        path: 'api/v1/sessions',
      }),
    ).rejects.toThrow('path');
    await expect(
      createNativeDeviceRequestProof(key.signer, await binding(key), {
        ...request,
        path: '/api/v1/sessions#frag',
      }),
    ).rejects.toThrow('path');
    await expect(
      createNativeDeviceRequestProof(key.signer, await binding(key), {
        ...request,
        path: '//station.example.test/api/v1/sessions',
      }),
    ).rejects.toThrow('path');
    await expect(
      createNativeDeviceRequestProof(key.signer, await binding(key), {
        ...request,
        path: '/api/%2E%2E/sessions',
      }),
    ).rejects.toThrow('path');
    const local = await createNativeDeviceRequestProof(
      key.signer,
      await binding(key, { stationAudience: 'http://127.0.0.1:4312' }),
      request,
    );
    expect(decode(local.split('.')[1]!).aud).toBe('http://127.0.0.1:4312');
  });

  test('refuses malformed binding identities', async () => {
    const key = await makeSigner();
    const request = { method: 'POST', path, body: new Uint8Array(0) };
    await expect(
      createNativeDeviceRequestProof(
        key.signer,
        await binding(key, { bindingId: 'not-a-uuid' }),
        request,
      ),
    ).rejects.toThrow();
    await expect(
      createNativeDeviceRequestProof(
        key.signer,
        await binding(key, { peerNonce: '' }),
        request,
      ),
    ).rejects.toThrow();
    await expect(
      createNativeDeviceRequestProof(
        key.signer,
        await binding(key, { peerNonce: 'N'.repeat(42) }),
        request,
      ),
    ).rejects.toThrow();
    await expect(
      createNativeDeviceRequestProof(
        key.signer,
        await binding(key, { deviceId: '' }),
        request,
      ),
    ).rejects.toThrow();
    await expect(
      createNativeDeviceRequestProof(
        key.signer,
        await binding(key, {
          deviceProofKeyThumbprint: 'A'.repeat(43),
        }),
        request,
      ),
    ).rejects.toThrow('thumbprint');
  });

  test('the minted window is capped at 30 seconds, so proofs expire', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T12:00:00.000Z'));
    const key = await makeSigner();
    const compact = await createNativeDeviceRequestProof(
      key.signer,
      await binding(key),
      { method: 'POST', path, body: new Uint8Array(0) },
    );
    const claims = decode(compact.split('.')[1]!);
    expect(claims.exp).toBe((claims.iat as number) + 30);
    vi.setSystemTime(new Date('2026-09-27T12:00:31.000Z'));
    expect((claims.exp as number) * 1000).toBeLessThanOrEqual(Date.now());
  });

  test('refuses a body beyond the application channel pilot limit', async () => {
    const key = await makeSigner();
    await expect(
      createNativeDeviceRequestProof(key.signer, await binding(key), {
        method: 'POST',
        path,
        body: new Uint8Array(16 * 1024 + 1),
      }),
    ).rejects.toThrow('body');
  });
});
