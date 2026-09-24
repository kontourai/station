import {
  base64UrlEncode,
  bodyHash,
  PUSH_JWT_TYPE,
  type PushJwk,
} from '../src/station-auth.ts';

export const AUDIENCE = 'https://gateway.test';
export const PACKAGE = 'io.kontourai.station.debug';
export const NOW = 1_800_000_000;

const encode = (value: object) =>
  base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));

export async function stationKey() {
  const pair = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const { kty, crv, x, y } = await crypto.subtle.exportKey(
    'jwk',
    pair.publicKey,
  );
  const publicJwk = { kty, crv, x, y } as PushJwk;
  return { privateKey: pair.privateKey, publicJwk };
}

export async function signRequest(
  body: Uint8Array<ArrayBuffer>,
  key: Awaited<ReturnType<typeof stationKey>>,
  overrides: {
    header?: Record<string, unknown>;
    claims?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const header = {
    alg: 'ES256',
    typ: PUSH_JWT_TYPE,
    jwk: key.publicJwk,
    ...overrides.header,
  };
  const claims = {
    aud: AUDIENCE,
    iat: NOW,
    exp: NOW + 60,
    jti: crypto.randomUUID(),
    bsh: await bodyHash(body),
    ...overrides.claims,
  };
  const unsigned = `${encode(header)}.${encode(claims)}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key.privateKey,
    new TextEncoder().encode(unsigned),
  );
  return `Station ${unsigned}.${base64UrlEncode(signature)}`;
}

export function sendBody(
  overrides: Record<string, unknown> = {},
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify({
      token: 'f'.repeat(142),
      packageName: PACKAGE,
      data: {
        station_kind: 'agent_activity',
        device_id: 'reg-1',
        updated_at: String(NOW * 1000),
        active: 'true',
      },
      ...overrides,
    }),
  );
}

export async function fakeServiceAccount() {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const der = new Uint8Array(
    await crypto.subtle.exportKey('pkcs8', pair.privateKey),
  );
  let binary = '';
  for (const byte of der) binary += String.fromCharCode(byte);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(binary).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;
  return {
    account: {
      projectId: 'kontour-station',
      clientEmail: 'gw@kontour-station.iam.gserviceaccount.com',
      privateKeyPem: pem,
    },
    publicKey: pair.publicKey,
  };
}

export const allow = { limit: async () => ({ success: true }) };

export const IOS_BUNDLE = 'io.kontourai.station.beta';
export const TEAM_ID = 'TEAM123456';
export const KEY_ID = 'KEY1234567';

/** A throwaway P-256 key shaped like an Apple .p8 file. Never a real key. */
export async function fakeApnsKey() {
  const pair = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const der = new Uint8Array(
    await crypto.subtle.exportKey('pkcs8', pair.privateKey),
  );
  let binary = '';
  for (const byte of der) binary += String.fromCharCode(byte);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(binary).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;
  return {
    credentials: { teamId: TEAM_ID, keyId: KEY_ID, privateKeyPem: pem },
    publicKey: pair.publicKey,
  };
}

export const PUSH_TO_START_TOKEN = 'ab'.repeat(40);
export const CHANNEL_ID = 'dHN0LXNyY2gtY2hubA==';
export const REGISTRATION_ID = 'r'.repeat(22);
export const SEALED = 'S'.repeat(400);

export function liveActivityBody(
  overrides: Record<string, unknown> = {},
  event: 'start' | 'update' | 'end' = 'start',
): Record<string, unknown> {
  return {
    bundleId: IOS_BUNDLE,
    environment: 'sandbox',
    event,
    ...(event === 'start' ? { pushToStartToken: PUSH_TO_START_TOKEN } : {}),
    channelId: CHANNEL_ID,
    registrationId: REGISTRATION_ID,
    sealed: SEALED,
    alert: false,
    timestamp: NOW,
    ...(event === 'end' ? { dismissAt: NOW + 900 } : { staleAt: NOW + 7200 }),
    ...overrides,
  };
}

export const encodeBody = (value: unknown): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(JSON.stringify(value));
