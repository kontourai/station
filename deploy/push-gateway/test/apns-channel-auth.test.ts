import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  parseChannelAuthSecrets,
  signChannelAuth,
  verifyChannelAuth,
} from '../src/apns-channel-auth.ts';
import { base64UrlEncode } from '../src/station-auth.ts';
import { CHANNEL_AUTH_SECRET, CHANNEL_ID, IOS_BUNDLE } from './helpers.ts';

const binding = {
  bundleId: IOS_BUNDLE,
  environment: 'sandbox',
  channelId: CHANNEL_ID,
  stationKey: 'thumbprint-of-the-signing-key',
};
const secrets = { current: CHANNEL_AUTH_SECRET };

test('is the documented HMAC over the channel routing and the key', async () => {
  const token = await signChannelAuth(secrets, binding);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(CHANNEL_AUTH_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expected = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(
      `station-apns-channel:v1\n${IOS_BUNDLE}\nsandbox\n${CHANNEL_ID}\nthumbprint-of-the-signing-key`,
    ),
  );
  assert.equal(token, `v1.${base64UrlEncode(expected)}`);
  assert.equal(await verifyChannelAuth(secrets, binding, token), 'current');
});

test('binds every field: another key, channel, bundle or environment fails', async () => {
  const token = await signChannelAuth(secrets, binding);
  for (const change of [
    { stationKey: 'another-key' },
    { channelId: 'b3RoZXItY2hhbm5lbA==' },
    { bundleId: 'io.kontourai.station' },
    { environment: 'production' },
  ]) {
    assert.equal(
      await verifyChannelAuth(secrets, { ...binding, ...change }, token),
      null,
      JSON.stringify(change),
    );
  }
  assert.equal(
    await verifyChannelAuth(
      { current: 'a-different-secret-of-sufficient-length!' },
      binding,
      token,
    ),
    null,
  );
});

test('refuses malformed and non-canonical tokens', async () => {
  const token = await signChannelAuth(secrets, binding);
  const mac = token.slice(3);
  // The last character carries two spare bits; flipping them keeps the bytes.
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = alphabet.indexOf(mac.at(-1) ?? 'A');
  const sibling = `v1.${mac.slice(0, -1)}${alphabet[last ^ 1]}`;
  for (const bad of ['', mac, `v2.${mac}`, `v1.${mac}x`, sibling]) {
    assert.equal(await verifyChannelAuth(secrets, binding, bad), null, bad);
  }
});

test('accepts the previous secret during rotation and says so', async () => {
  const old = { current: 'the-old-secret-that-is-being-rotated-out' };
  const oldToken = await signChannelAuth(old, binding);
  const rotated = { current: CHANNEL_AUTH_SECRET, previous: old.current };
  assert.equal(await verifyChannelAuth(rotated, binding, oldToken), 'previous');
  assert.equal(await verifyChannelAuth(secrets, binding, oldToken), null);
});

test('a missing or short secret leaves channel auth unconfigured', () => {
  assert.equal(parseChannelAuthSecrets(undefined, undefined), null);
  assert.equal(parseChannelAuthSecrets('short', undefined), null);
  assert.deepEqual(parseChannelAuthSecrets(CHANNEL_AUTH_SECRET, 'short'), {
    current: CHANNEL_AUTH_SECRET,
  });
  assert.deepEqual(
    parseChannelAuthSecrets(CHANNEL_AUTH_SECRET, CHANNEL_AUTH_SECRET),
    { current: CHANNEL_AUTH_SECRET, previous: CHANNEL_AUTH_SECRET },
  );
});
