import { APPLICATION_SESSION_VERSION } from '@kontourai/station-contracts/application-session';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import {
  RELAY_ENROLLMENT_ACTIVATE_PATH,
  RELAY_ENROLLMENT_FINALIZE_PATH,
  RELAY_ENROLLMENT_LOGIN_PATH,
  RELAY_ENROLLMENT_PROOF_AUDIENCE,
  RELAY_ENROLLMENT_PROOF_TYPE,
  RELAY_ENROLLMENT_VERSION,
  type RelayEnrollmentChallenge,
  type RelayEnrollmentDeliveredResponse,
} from '@kontourai/station-contracts/relay-enrollment';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createRelayEnrollmentActivationProof,
  createRelayEnrollmentFinalizeProof,
  createRelayEnrollmentKey,
  createRelayEnrollmentLoginProof,
  digestRelayEnrollmentBundle,
  RELAY_ENROLLMENT_CLIENT_PATHS,
  restoreRelayEnrollmentKey,
} from '../client/relay-enrollment.js';

const requestOrigin = 'https://station.example.test';
const clientOrigin = 'https://browser.example.test';
const challenge = (
  key: Awaited<ReturnType<typeof createRelayEnrollmentKey>>,
): RelayEnrollmentChallenge => ({
  version: RELAY_ENROLLMENT_VERSION,
  stationId: '11111111-1111-4111-8111-111111111111',
  requestOrigin,
  clientOrigin,
  enrollmentId: 'E'.repeat(43),
  publicKey: key.publicKey,
  keyThumbprint: 'replace-with-jwk-thumbprint',
  nonce: 'N'.repeat(43),
  purpose: 'login',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

function decode(value: string): Record<string, unknown> {
  return JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/')));
}

async function thumbprint(
  key: Awaited<ReturnType<typeof createRelayEnrollmentKey>>,
) {
  const canonical = JSON.stringify({
    crv: key.publicKey.crv,
    kty: key.publicKey.kty,
    x: key.publicKey.x,
    y: key.publicKey.y,
  });
  return btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(canonical),
        ),
      ),
    ),
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

afterEach(() => vi.useRealTimers());

describe('fresh relay enrollment proof', () => {
  test('creates a non-extractable P-256 key and a method/path/origin-bound ES256 JWS', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T12:00:00.000Z'));
    const key = await createRelayEnrollmentKey();
    expect(key.privateKey.extractable).toBe(false);
    expect(key.privateKey.algorithm).toMatchObject({
      name: 'ECDSA',
      namedCurve: 'P-256',
    });
    const binding = { ...challenge(key), keyThumbprint: await thumbprint(key) };
    const compact = await createRelayEnrollmentLoginProof(key, binding, {
      method: 'POST',
      url: `${requestOrigin}${RELAY_ENROLLMENT_LOGIN_PATH}`,
      clientOrigin,
    });
    const [header, payload, signature] = compact.split('.');
    expect(decode(header!)).toEqual({
      alg: 'ES256',
      typ: RELAY_ENROLLMENT_PROOF_TYPE,
    });
    expect(decode(payload!)).toEqual({
      v: RELAY_ENROLLMENT_VERSION,
      aud: RELAY_ENROLLMENT_PROOF_AUDIENCE,
      stationId: binding.stationId,
      enrollmentId: binding.enrollmentId,
      clientOrigin,
      keyThumbprint: binding.keyThumbprint,
      nonce: binding.nonce,
      purpose: 'login',
      htm: 'POST',
      htu: `${requestOrigin}${RELAY_ENROLLMENT_LOGIN_PATH}`,
      jti: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 30,
    });
    const verifyingKey = await crypto.subtle.importKey(
      'jwk',
      key.publicKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify'],
    );
    const decodeBytes = (value: string) =>
      Uint8Array.from(
        atob(value.replace(/-/g, '+').replace(/_/g, '/')),
        (char) => char.charCodeAt(0),
      );
    expect(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        verifyingKey,
        decodeBytes(signature!),
        new TextEncoder().encode(`${header}.${payload}`),
      ),
    ).toBe(true);
  });

  test('refuses the wrong signing key, browser Origin, target path and expired challenge', async () => {
    const key = await createRelayEnrollmentKey();
    const other = await createRelayEnrollmentKey();
    const binding = { ...challenge(key), keyThumbprint: await thumbprint(key) };
    const request = {
      method: 'POST',
      url: `${requestOrigin}${RELAY_ENROLLMENT_LOGIN_PATH}`,
      clientOrigin,
    };
    await expect(
      createRelayEnrollmentLoginProof(other, binding, request),
    ).rejects.toThrow('does not match');
    await expect(
      createRelayEnrollmentLoginProof(key, binding, {
        ...request,
        clientOrigin: 'https://attacker.example.test',
      }),
    ).rejects.toThrow('target');
    await expect(
      createRelayEnrollmentLoginProof(key, binding, {
        ...request,
        url: `${requestOrigin}/different`,
      }),
    ).rejects.toThrow('target');
    await expect(
      createRelayEnrollmentLoginProof(
        key,
        { ...binding, expiresAt: new Date(Date.now() - 1).toISOString() },
        request,
      ),
    ).rejects.toThrow('expired');
  });

  test('cannot restore extractable private-key custody', async () => {
    const key = await createRelayEnrollmentKey();
    const extractable = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    expect(() =>
      restoreRelayEnrollmentKey(extractable.privateKey, key.publicKey),
    ).toThrow('non-extractable');
  });

  test('finalize and activation proofs use purpose-specific paths and bind the delivered bundle', async () => {
    const key = await createRelayEnrollmentKey();
    const binding = { ...challenge(key), keyThumbprint: await thumbprint(key) };
    expect(RELAY_ENROLLMENT_CLIENT_PATHS.finalize).toBe(
      RELAY_ENROLLMENT_FINALIZE_PATH,
    );
    expect(RELAY_ENROLLMENT_CLIENT_PATHS.activate).toBe(
      RELAY_ENROLLMENT_ACTIVATE_PATH,
    );
    const finalize = await createRelayEnrollmentFinalizeProof(key, binding, {
      method: 'POST',
      url: `${requestOrigin}${RELAY_ENROLLMENT_FINALIZE_PATH}`,
      clientOrigin,
    });
    expect(decode(finalize.split('.')[1]!)).toMatchObject({
      purpose: 'finalize',
      nonce: binding.nonce,
      htu: `${requestOrigin}${RELAY_ENROLLMENT_FINALIZE_PATH}`,
    });

    const deviceId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const bundle: RelayEnrollmentDeliveredResponse['bundle'] = {
      stationId: binding.stationId,
      deviceId,
      deviceCredential: 'D'.repeat(43),
      continuation: {
        version: APPLICATION_SESSION_VERSION,
        credential: 'C'.repeat(43),
        authorityKey: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
        stationId: binding.stationId,
        deviceId,
        principal: humanPrincipal(
          'deployment',
          'subject-hash',
          'Relay account',
        ),
        requestOrigin,
        clientOrigin,
        keyThumbprint: binding.keyThumbprint,
        nonce: 'Z'.repeat(43),
        expiresAt: binding.expiresAt,
      },
    };
    const bundleDigest = await digestRelayEnrollmentBundle(bundle);
    const delivery: RelayEnrollmentDeliveredResponse = {
      version: RELAY_ENROLLMENT_VERSION,
      state: 'delivered',
      enrollmentId: binding.enrollmentId,
      activationNonce: 'A'.repeat(43),
      bundleDigest,
      bundle,
      expiresAt: binding.expiresAt,
    };
    const activation = await createRelayEnrollmentActivationProof(
      key,
      binding,
      delivery,
      {
        method: 'POST',
        url: `${requestOrigin}${RELAY_ENROLLMENT_ACTIVATE_PATH}`,
        clientOrigin,
      },
    );
    expect(decode(activation.split('.')[1]!)).toMatchObject({
      purpose: 'activate',
      nonce: delivery.activationNonce,
      deviceId,
      authorityKey: bundle.continuation.authorityKey,
      bundleDigest,
      htu: `${requestOrigin}${RELAY_ENROLLMENT_ACTIVATE_PATH}`,
    });
    await expect(
      createRelayEnrollmentActivationProof(
        key,
        binding,
        { ...delivery, bundleDigest: 'X'.repeat(43) },
        {
          method: 'POST',
          url: `${requestOrigin}${RELAY_ENROLLMENT_ACTIVATE_PATH}`,
          clientOrigin,
        },
      ),
    ).rejects.toThrow('does not match');
  });
});
