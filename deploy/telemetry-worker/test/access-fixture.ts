import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose';

export const ACCESS_TEAM = 'test-telemetry.cloudflareaccess.com';
export const ACCESS_AUDIENCE = 'test-telemetry-insights';
const pair = generateKeyPair('RS256');

export async function accessFixture(claims: JWTPayload = {}) {
  const { privateKey, publicKey } = await pair;
  const jwk = await exportJWK(publicKey);
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    email: 'owner@example.test',
    iss: `https://${ACCESS_TEAM}`,
    aud: ACCESS_AUDIENCE,
    sub: 'test-owner',
    iat: now,
    exp: now + 600,
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .sign(privateKey);
  return {
    token,
    jwks: { keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] },
  };
}
