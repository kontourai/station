import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jwkThumbprint, verifyStationRequest } from '../src/station-auth.ts';
import { AUDIENCE, NOW, sendBody, signRequest, stationKey } from './helpers.ts';

async function verify(authorization: string | null, body = sendBody()) {
  return verifyStationRequest({
    authorization,
    body,
    audiences: [AUDIENCE],
    nowSeconds: NOW,
  });
}

test('accepts a well-formed request and identifies the key by thumbprint', async () => {
  const key = await stationKey();
  const body = sendBody();
  const result = await verify(await signRequest(body, key), body);
  assert.deepEqual(result, {
    ok: true,
    keyThumbprint: await jwkThumbprint(key.publicJwk),
  });
});

test('rejects a body other than the one the token signed', async () => {
  const key = await stationKey();
  const authorization = await signRequest(sendBody(), key);
  const result = await verify(
    authorization,
    sendBody({ token: 'g'.repeat(142) }),
  );
  assert.deepEqual(result, { ok: false, reason: 'body does not match token' });
});

test('rejects a signature made by a different key than the header names', async () => {
  const signer = await stationKey();
  const claimed = await stationKey();
  const body = sendBody();
  const result = await verify(
    await signRequest(body, signer, { header: { jwk: claimed.publicJwk } }),
    body,
  );
  assert.deepEqual(result, { ok: false, reason: 'signature does not verify' });
});

test('rejects wrong audience, expiry, future issue and over-long lifetime', async () => {
  const key = await stationKey();
  const body = sendBody();
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ aud: 'https://elsewhere.test' }, 'wrong audience'],
    [{ iat: NOW - 300, exp: NOW - 200 }, 'token expired'],
    [{ iat: NOW + 120, exp: NOW + 180 }, 'token issued in the future'],
    [{ iat: NOW, exp: NOW + 121 }, 'token lifetime out of range'],
    [{ iat: NOW, exp: NOW }, 'token lifetime out of range'],
    [{ iat: undefined }, 'iat and exp are required'],
  ];
  for (const [claims, reason] of cases) {
    assert.deepEqual(
      await verify(await signRequest(body, key, { claims }), body),
      { ok: false, reason },
      reason,
    );
  }
});

test('rejects other token types, algorithms and private keys in the header', async () => {
  const key = await stationKey();
  const body = sendBody();
  assert.deepEqual(
    await verify(
      await signRequest(body, key, { header: { typ: 'JWT' } }),
      body,
    ),
    {
      ok: false,
      reason: 'unsupported token header',
    },
  );
  assert.deepEqual(
    await verify(
      await signRequest(body, key, { header: { alg: 'none' } }),
      body,
    ),
    {
      ok: false,
      reason: 'unsupported token header',
    },
  );
  const leaked = { ...key.publicJwk, d: 'A'.repeat(43) };
  assert.deepEqual(
    await verify(
      await signRequest(body, key, { header: { jwk: leaked } }),
      body,
    ),
    {
      ok: false,
      reason: 'header must carry a public P-256 jwk',
    },
  );
});

test('rejects missing and malformed authorization', async () => {
  for (const value of [
    null,
    '',
    'Bearer a.b.c',
    'Station a.b',
    'Station a.b.c.d',
  ]) {
    assert.equal((await verify(value)).ok, false, String(value));
  }
});

test('accepts only the canonical encoding of a key, so it has one thumbprint', async () => {
  const key = await stationKey();
  const body = sendBody();
  // Base64url of 32 bytes ends in a character carrying 2 unused bits; flipping
  // them decodes to the same bytes but would be a different thumbprint input.
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = key.publicJwk.x.at(-1) ?? 'A';
  const variant = alphabet[alphabet.indexOf(last) ^ 1];
  const x = key.publicJwk.x.slice(0, -1) + variant;
  const result = await verify(
    await signRequest(body, key, { header: { jwk: { ...key.publicJwk, x } } }),
    body,
  );
  assert.deepEqual(result, {
    ok: false,
    reason: 'header must carry a public P-256 jwk',
  });
});

test('rejects critical header extensions', async () => {
  const key = await stationKey();
  const body = sendBody();
  assert.deepEqual(
    await verify(
      await signRequest(body, key, { header: { crit: ['b64'] } }),
      body,
    ),
    { ok: false, reason: 'unsupported token header' },
  );
});

test('answers a coordinate pair that is not a curve point without throwing', async () => {
  const key = await stationKey();
  const body = sendBody();
  const offCurve = { ...key.publicJwk, y: key.publicJwk.x };
  assert.deepEqual(
    await verify(
      await signRequest(body, key, { header: { jwk: offCurve } }),
      body,
    ),
    { ok: false, reason: 'header must carry a public P-256 jwk' },
  );
});
