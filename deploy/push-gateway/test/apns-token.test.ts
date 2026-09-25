import assert from 'node:assert/strict';
import { beforeEach, test } from 'vitest';
import {
  APNS_TOKEN_WINDOW_SECONDS,
  parseApnsCredentials,
  providerToken,
  providerTokenIssuedAt,
  resetProviderTokenCacheForTest,
} from '../src/apns-token.ts';
import { fakeApnsKey, KEY_ID, NOW, TEAM_ID } from './helpers.ts';

const decode = (segment: string) =>
  Uint8Array.from(
    atob(segment.replaceAll('-', '+').replaceAll('_', '/')),
    (c) => c.charCodeAt(0),
  );
const decodeJson = (segment: string) =>
  JSON.parse(new TextDecoder().decode(decode(segment)));

beforeEach(() => resetProviderTokenCacheForTest());

test('two isolates derive the byte-identical token for one window', async () => {
  const { credentials } = await fakeApnsKey();
  const first = await providerToken(credentials, NOW);
  // A fresh isolate: nothing cached, a different moment in the same window.
  resetProviderTokenCacheForTest();
  const windowStart = providerTokenIssuedAt(NOW);
  const second = await providerToken(
    { ...credentials },
    windowStart + APNS_TOKEN_WINDOW_SECONDS - 1,
  );
  assert.equal(second, first);
});

test('rolls to a new token, with a floored iat, at the window boundary', async () => {
  const { credentials } = await fakeApnsKey();
  const windowStart = providerTokenIssuedAt(NOW);
  assert.equal(windowStart % APNS_TOKEN_WINDOW_SECONDS, 0);
  assert.ok(
    windowStart <= NOW && NOW - windowStart < APNS_TOKEN_WINDOW_SECONDS,
  );

  const current = await providerToken(credentials, NOW);
  const next = await providerToken(
    credentials,
    windowStart + APNS_TOKEN_WINDOW_SECONDS,
  );
  assert.notEqual(next, current);
  assert.equal(decodeJson(current.split('.')[1]).iat, windowStart);
  assert.equal(
    decodeJson(next.split('.')[1]).iat,
    windowStart + APNS_TOKEN_WINDOW_SECONDS,
  );
});

test('the token is an ES256 JWT that verifies with the key', async () => {
  const { credentials, publicKey } = await fakeApnsKey();
  const jwt = await providerToken(credentials, NOW);
  const [header, claims, signature] = jwt.split('.');
  assert.deepEqual(decodeJson(header), { alg: 'ES256', kid: KEY_ID });
  assert.deepEqual(decodeJson(claims), {
    iss: TEAM_ID,
    iat: providerTokenIssuedAt(NOW),
  });
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    decode(signature),
    new TextEncoder().encode(`${header}.${claims}`),
  );
  assert.equal(valid, true);
});

test('a rotated key never reuses the previous key token', async () => {
  const before = (await fakeApnsKey()).credentials;
  const after = (await fakeApnsKey()).credentials;
  const first = await providerToken(before, NOW);
  const rotated = await providerToken(after, NOW);
  assert.notEqual(rotated, first);
});

test('a key that is not P-256 fails at first use', async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-384' },
    true,
    ['sign'],
  )) as CryptoKeyPair;
  const der = new Uint8Array(
    await crypto.subtle.exportKey('pkcs8', pair.privateKey),
  );
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
  await assert.rejects(
    providerToken({ teamId: TEAM_ID, keyId: KEY_ID, privateKeyPem: pem }, NOW),
  );
});

test('APNs configuration is off unless every value is present and plausible', async () => {
  const { credentials } = await fakeApnsKey();
  const good = {
    teamId: TEAM_ID,
    keyId: KEY_ID,
    authKey: credentials.privateKeyPem,
  };
  assert.deepEqual(parseApnsCredentials(good), credentials);
  assert.equal(parseApnsCredentials({ ...good, authKey: undefined }), null);
  assert.equal(parseApnsCredentials({ ...good, authKey: 'nope' }), null);
  assert.equal(parseApnsCredentials({ ...good, teamId: undefined }), null);
  assert.equal(parseApnsCredentials({ ...good, teamId: 'short' }), null);
  assert.equal(parseApnsCredentials({ ...good, keyId: 'lowercase12' }), null);
  // A secret pasted on one line keeps literal "\n" sequences.
  const oneLine = parseApnsCredentials({
    ...good,
    authKey: credentials.privateKeyPem.replaceAll('\n', '\\n'),
  });
  assert.equal(oneLine?.privateKeyPem, credentials.privateKeyPem);
});

test('the gateway pins the same signing library the repository installs', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = async (path: string) =>
    JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
  const gateway = await read('../package.json');
  const root = await read('../../../package.json');
  for (const name of ['@noble/curves', '@noble/hashes']) {
    assert.match(gateway.dependencies[name], /^\d+\.\d+\.\d+$/, name);
    assert.equal(gateway.dependencies[name], root.devDependencies[name], name);
  }
});
