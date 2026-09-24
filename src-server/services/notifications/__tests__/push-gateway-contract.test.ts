/**
 * The Station signer against the REAL gateway verifier
 * (deploy/push-gateway/src/station-auth.ts), not a re-implementation of it:
 * if the header type, audience, body hash or key encoding the Station
 * produces ever diverges from what the deployed gateway accepts, this fails.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  PUSH_JWT_TYPE as GATEWAY_JWT_TYPE,
  jwkThumbprint,
  verifyStationRequest,
} from '../../../../deploy/push-gateway/src/station-auth.js';
import {
  PUSH_JWT_TYPE,
  PushSigningKeyStore,
  pushJwkThumbprint,
} from '../push-signing-key-store.js';

const AUDIENCE = 'https://push.kontourai.io';
const NOW_MS = 1_800_000_000_000;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function key() {
  const home = mkdtempSync(join(tmpdir(), 'station-push-contract-'));
  roots.push(home);
  mkdirSync(join(home, 'security'), { mode: 0o700 });
  return new PushSigningKeyStore(
    home,
    () => 'station-under-test',
  ).loadOrCreate();
}

const bytes = (value: string) =>
  new TextEncoder().encode(value) as Uint8Array<ArrayBuffer>;

function decodeSegment(jws: string, index: number): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(jws.split('.')[index] ?? '', 'base64url').toString('utf8'),
  );
}

describe('Station push signer against the gateway verifier', () => {
  test('a signed request verifies, and the gateway derives the same thumbprint the Station hands the phone', async () => {
    const signing = await key();
    const body = bytes(JSON.stringify({ token: 't'.repeat(40), data: {} }));
    const jws = signing.signRequest(body, {
      audience: AUDIENCE,
      nowMs: NOW_MS,
    });

    const result = await verifyStationRequest({
      authorization: `Station ${jws}`,
      body,
      audiences: [AUDIENCE],
      nowSeconds: NOW_MS / 1000,
    });
    expect(result).toEqual({ ok: true, keyThumbprint: signing.thumbprint });
    expect(await jwkThumbprint(signing.publicJwk)).toBe(signing.thumbprint);
    expect(pushJwkThumbprint(signing.publicJwk)).toBe(signing.thumbprint);
  });

  test('the envelope is exactly the documented shape', async () => {
    const signing = await key();
    const jws = signing.signRequest(bytes('{}'), {
      audience: AUDIENCE,
      nowMs: NOW_MS,
    });
    expect(PUSH_JWT_TYPE).toBe(GATEWAY_JWT_TYPE);
    expect(decodeSegment(jws, 0)).toEqual({
      alg: 'ES256',
      typ: GATEWAY_JWT_TYPE,
      jwk: { ...signing.publicJwk },
    });
    const claims = decodeSegment(jws, 1);
    expect(Object.keys(claims).sort()).toEqual([
      'aud',
      'bsh',
      'exp',
      'iat',
      'jti',
    ]);
    expect(claims.aud).toBe(AUDIENCE);
    expect(claims.iat).toBe(NOW_MS / 1000);
    expect(claims.exp).toBe(NOW_MS / 1000 + 60);
  });

  test('the token is bound to the exact body bytes', async () => {
    const signing = await key();
    const signed = bytes('{"data":{"a":"1"}}');
    const jws = signing.signRequest(signed, {
      audience: AUDIENCE,
      nowMs: NOW_MS,
    });
    expect(
      await verifyStationRequest({
        authorization: `Station ${jws}`,
        body: bytes('{"data":{"a":"2"}}'),
        audiences: [AUDIENCE],
        nowSeconds: NOW_MS / 1000,
      }),
    ).toEqual({ ok: false, reason: 'body does not match token' });
  });

  test('the token names only the audience it was signed for', async () => {
    const signing = await key();
    const body = bytes('{}');
    const jws = signing.signRequest(body, {
      audience: 'https://gateway.example.test',
      nowMs: NOW_MS,
    });
    expect(
      await verifyStationRequest({
        authorization: `Station ${jws}`,
        body,
        audiences: [AUDIENCE],
        nowSeconds: NOW_MS / 1000,
      }),
    ).toEqual({ ok: false, reason: 'wrong audience' });
  });

  test('coordinates stay canonical across many keys (no leading-zero truncation)', async () => {
    for (let index = 0; index < 32; index += 1) {
      const signing = await key();
      for (const coordinate of [signing.publicJwk.x, signing.publicJwk.y])
        expect(Buffer.from(coordinate, 'base64url')).toHaveLength(32);
      const body = bytes(String(index));
      const result = await verifyStationRequest({
        authorization: `Station ${signing.signRequest(body, { audience: AUDIENCE, nowMs: NOW_MS })}`,
        body,
        audiences: [AUDIENCE],
        nowSeconds: NOW_MS / 1000,
      });
      expect(result.ok).toBe(true);
    }
  });
});
