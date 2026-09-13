import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { GenericOAuthConfig } from 'better-auth/plugins/generic-oauth';
import { decodeJwt } from 'jose';
import { z } from 'zod/v3';

const issuer = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  });
const configuredProviders = z
  .array(
    z
      .object({
        id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
        displayName: z.string().min(1).max(128),
        issuer,
        clientId: z.string().min(1).max(512),
        clientSecretEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
      })
      .strict(),
  )
  .min(1)
  .max(4);

/** Private operator configuration. Secrets are resolved at startup, never published in the descriptor. */
export interface LocalAccountOidcProvider {
  id: string;
  displayName: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
}

export function readLocalAccountOidcConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): LocalAccountOidcProvider[] | undefined {
  const file = environment.STATION_LOCAL_ACCOUNT_OIDC_FILE;
  if (file === undefined) return undefined;
  if (!isAbsolute(file) || statSync(file).size > 32 * 1024)
    throw new Error(
      'Local account OIDC configuration requires a bounded absolute file.',
    );
  const parsed = configuredProviders.safeParse(
    JSON.parse(readFileSync(file, 'utf8')),
  );
  if (
    !parsed.success ||
    new Set(parsed.data.map((entry) => entry.id)).size !== parsed.data.length
  )
    throw new Error('Invalid or duplicate local account OIDC configuration.');
  return parsed.data.map(({ clientSecretEnv, ...provider }) => {
    const clientSecret = environment[clientSecretEnv];
    if (!clientSecret || clientSecret.length > 8192)
      throw new Error(
        'A configured local account OIDC client secret is unavailable.',
      );
    return { ...provider, clientSecret };
  });
}

const oidcIdentityClaims = z.object({
  iss: z.string(),
  sub: z.string().min(1),
  aud: z.union([z.string(), z.array(z.string()).min(1)]),
  exp: z.number().finite(),
  iat: z.number().finite(),
  azp: z.string().optional(),
});

/** Invoked by the maintained OAuth callback AFTER its signature/issuer/audience/nonce verifier succeeds. */
export function createOidcAccountSubject(
  configuration: Pick<LocalAccountOidcProvider, 'issuer' | 'clientId'>,
): NonNullable<GenericOAuthConfig['accountSubject']> {
  return ({ tokens, profile }) => {
    if (!tokens.idToken) throw new Error('OIDC identity token is required.');
    // Decoding here does not establish authenticity: Better Auth owns that
    // preceding step. This callback binds its verified token to UserInfo and
    // derives the immutable account key before any user/session can be created.
    const claims = oidcIdentityClaims.safeParse(decodeJwt(tokens.idToken));
    if (!claims.success)
      throw new Error('OIDC identity claims are incomplete.');
    const identity = claims.data;
    const audiences =
      typeof identity.aud === 'string' ? [identity.aud] : identity.aud;
    if (
      identity.iss !== configuration.issuer ||
      identity.sub !== profile.sub ||
      identity.exp * 1000 <= Date.now() ||
      audiences.some((audience) => audience !== configuration.clientId) ||
      (identity.azp !== undefined && identity.azp !== configuration.clientId)
    )
      throw new Error(
        'OIDC identity does not match its verified profile or client.',
      );
    // Provider labels are operator-editable. Include the verified issuer so
    // a new issuer with an equal subject cannot inherit an existing account.
    return `oidc-v1:${createHash('sha256')
      .update(JSON.stringify([identity.iss, identity.sub]))
      .digest('base64url')}`;
  };
}
