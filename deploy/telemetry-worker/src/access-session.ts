import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface AccessConfiguration {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUDIENCE?: string;
}

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function insightsAccess(
  request: Request,
  env: AccessConfiguration,
): Promise<'ok' | 'unconfigured' | 'unauthorized'> {
  const team = env.ACCESS_TEAM_DOMAIN;
  const audience = env.ACCESS_AUDIENCE;
  if (!team || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team) || !audience)
    return 'unconfigured';
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return 'unauthorized';
  const issuer = `https://${team}`;
  let keys = keySets.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    keySets.set(issuer, keys);
  }
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'sub', 'aud', 'iss'],
    });
    return typeof payload.sub === 'string' &&
      payload.sub.length > 0 &&
      typeof payload.email === 'string' &&
      payload.email.length > 0
      ? 'ok'
      : 'unauthorized';
  } catch {
    return 'unauthorized';
  }
}
