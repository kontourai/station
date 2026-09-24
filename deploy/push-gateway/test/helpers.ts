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
