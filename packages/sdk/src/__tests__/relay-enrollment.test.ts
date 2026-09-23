import {
  RELAY_ENROLLMENT_LOGIN_PATH,
  RELAY_ENROLLMENT_PROOF_AUDIENCE,
  RELAY_ENROLLMENT_PROOF_TYPE,
  RELAY_ENROLLMENT_VERSION,
  type RelayEnrollmentChallenge,
} from '@kontourai/station-contracts/relay-enrollment';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createRelayEnrollmentKey,
  createRelayEnrollmentLoginProof,
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
});
