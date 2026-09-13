import {
  DEPLOYMENT_AUTHENTICATION_VERSION,
  type DeploymentAuthenticationDescriptor,
  type DeploymentAuthenticationProvider,
  type DeploymentAuthenticationResult,
} from '@kontourai/station-contracts/deployment-authentication';
import { z } from 'zod/v3';

function nonControlText(value: string): boolean {
  return (
    value.trim() !== '' &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
  );
}
const text = (max: number) => z.string().max(max).refine(nonControlText);
const timestamp = z.string().datetime({ offset: true });
const sessionSchema = z
  .object({
    subject: text(2048),
    displayName: text(256),
    sessionId: text(512),
    authenticatedAt: timestamp,
    expiresAt: timestamp,
    contacts: z
      .array(
        z
          .object({
            kind: z.literal('email'),
            value: text(320).refine((value) => /^[^\s@]+@[^\s@]+$/.test(value)),
            verifiedAt: timestamp,
          })
          .strict(),
      )
      .max(16),
  })
  .strict();
const resultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('absent') }).strict(),
  z.object({ kind: z.literal('unavailable') }).strict(),
  z
    .object({
      kind: z.literal('invalid'),
      reason: z.enum([
        'invalid-credential',
        'expired',
        'revoked',
        'conflicting-identity',
      ]),
    })
    .strict(),
  z
    .object({ kind: z.literal('authenticated'), session: sessionSchema })
    .strict(),
]);
const descriptorSchema = z
  .object({
    version: z.literal(DEPLOYMENT_AUTHENTICATION_VERSION),
    issuer: text(2048),
    displayName: text(256),
    login: z
      .discriminatedUnion('kind', [
        z
          .object({
            kind: z.enum(['email-password', 'username-password']),
            signInPath: z.string(),
            signUpPath: z.string().optional(),
          })
          .strict(),
        z
          .object({ kind: z.literal('redirect'), startPath: z.string() })
          .strict(),
      ])
      .optional(),
    sessionCookies: z
      .array(
        z
          .string()
          .regex(/^[A-Za-z0-9_.-]{1,128}$/)
          .refine(
            (name) =>
              !['station-device', '__Host-station-device'].includes(name),
          ),
      )
      .min(1)
      .max(4),
    endpoints: z
      .array(
        z
          .object({
            path: text(256)
              .refine((value) => /^\/[a-z0-9][a-z0-9/_-]*$/.test(value))
              .refine(
                (path) =>
                  !['/session', '/accept-invitation'].includes(path) &&
                  !path.includes('//'),
              ),
            methods: z
              .array(z.enum(['GET', 'POST']))
              .min(1)
              .max(2),
            operation: z.enum([
              'begin-login',
              'callback',
              'register',
              'verify-contact',
              'request-recovery',
              'complete-recovery',
              'change-password',
              'refresh-session',
              'logout',
              'revoke-session',
            ]),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();

/** Closed data validation at the trusted-module boundary, without reflecting its rejected values. */
export function readDeploymentAuthenticationDescriptor(
  provider: DeploymentAuthenticationProvider,
): DeploymentAuthenticationDescriptor {
  const parsed = descriptorSchema.safeParse({
    version: provider.version,
    issuer: provider.issuer,
    displayName: provider.displayName,
    endpoints: provider.endpoints,
    sessionCookies: provider.sessionCookies,
    login: provider.login,
  });
  if (
    !parsed.success ||
    typeof provider.authenticate !== 'function' ||
    typeof provider.handle !== 'function'
  ) {
    throw new Error('Unsupported deployment authentication provider contract.');
  }
  const descriptor = parsed.data;
  const login = descriptor.login;
  const declared = (path: string, method: 'GET' | 'POST', operation: string) =>
    descriptor.endpoints.some(
      (endpoint) =>
        endpoint.path === path &&
        endpoint.methods.includes(method) &&
        endpoint.operation === operation,
    );
  if (
    login?.kind === 'redirect' &&
    !declared(login.startPath, 'GET', 'begin-login')
  )
    throw new Error('Browser login endpoint is not declared.');
  if (
    (login?.kind === 'email-password' || login?.kind === 'username-password') &&
    (!declared(login.signInPath, 'POST', 'begin-login') ||
      (login.signUpPath && !declared(login.signUpPath, 'POST', 'register')))
  )
    throw new Error('Browser password endpoints are not declared.');
  const issuer = new URL(descriptor.issuer);
  if (
    issuer.username ||
    issuer.password ||
    issuer.hash ||
    issuer.search ||
    descriptor.issuer !== descriptor.issuer.trim()
  ) {
    throw new Error(
      'Deployment authentication issuer must be an exact non-secret authority URI.',
    );
  }
  const methods = descriptor.endpoints.flatMap((endpoint) =>
    endpoint.methods.map((method) => `${method} ${endpoint.path}`),
  );
  if (
    new Set(methods).size !== methods.length ||
    new Set(descriptor.sessionCookies).size !== descriptor.sessionCookies.length
  ) {
    throw new Error(
      'Invalid deployment authentication endpoint method or cookie ambiguity.',
    );
  }
  if (
    !descriptor.endpoints.some(
      (endpoint) =>
        endpoint.operation === 'logout' && endpoint.methods.includes('POST'),
    )
  ) {
    throw new Error(
      'Deployment authentication requires an explicit logout operation.',
    );
  }
  return descriptor;
}

export function readDeploymentAuthenticationResult(
  value: unknown,
  now: number,
): DeploymentAuthenticationResult {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) return { kind: 'unavailable' };
  const result = parsed.data;
  if (result.kind !== 'authenticated') return result;
  const { session } = result;
  const authenticatedAt = Date.parse(session.authenticatedAt);
  const expiresAt = Date.parse(session.expiresAt);
  if (
    authenticatedAt > now ||
    expiresAt <= authenticatedAt ||
    session.contacts.some((contact) => Date.parse(contact.verifiedAt) > now)
  ) {
    return { kind: 'unavailable' };
  }
  return expiresAt <= now ? { kind: 'invalid', reason: 'expired' } : result;
}
