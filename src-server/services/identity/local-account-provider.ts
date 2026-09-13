import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  DEPLOYMENT_AUTHENTICATION_VERSION,
  type DeploymentAuthenticationHost,
  type DeploymentAuthenticationProvider,
} from '@kontourai/station-contracts/deployment-authentication';
import { type BetterAuthOptions, betterAuth } from 'better-auth';
import { getCookies } from 'better-auth/cookies';
import { getMigrations } from 'better-auth/db/migration';
import { username } from 'better-auth/plugins';
import { z } from 'zod/v3';
import { openPrivateSqlite } from '../../utils/private-sqlite.js';
import { LocalAccountAdministration } from './local-account-administration.js';

export interface LocalAccountEmail {
  kind: 'verify-email' | 'reset-password';
  recipient: string;
  url: string;
}

export interface LocalAccountEnrollment {
  /** Checks the real pending invitation. This is eligibility to register, never membership. */
  mayRegister(input: { invitation: string; email?: string }): Promise<boolean>;
  /** Server-owned mail transport; callers must not supply a delivery destination. */
  deliver(message: LocalAccountEmail): Promise<void>;
}

export interface LocalAccountProvider extends DeploymentAuthenticationProvider {
  /** Private operator route composition only; never forwarded through provider.handle. */
  administration: LocalAccountAdministration;
  issueRecovery(accountId: string): Promise<string>;
}

/** Maintained password/session implementation behind Station's common authentication contract. */
export async function createLocalAccountProvider(
  host: Readonly<DeploymentAuthenticationHost>,
  secret: string,
  enrollment: LocalAccountEnrollment,
  mode: 'email-password' | 'username-password' = 'email-password',
): Promise<LocalAccountProvider> {
  if (secret.length < 32)
    throw new Error(
      'Local accounts require an operator-owned authentication secret.',
    );
  const databasePath = join(host.stateDirectory, 'local-accounts.sqlite');
  const localUsername = mode === 'username-password';
  const database = openPrivateSqlite(databasePath, 'Local accounts');
  const recoveries = new Map<string, (url: string) => void>();
  try {
    const administration = new LocalAccountAdministration(
      database,
      localUsername,
    );
    const options = {
      database,
      secret,
      baseURL: host.publicOrigin,
      basePath: host.basePath,
      trustedOrigins: [host.publicOrigin],
      telemetry: { enabled: false },
      logger: { disabled: true },
      emailAndPassword: {
        enabled: true,
        requireEmailVerification: !localUsername,
        autoSignIn: false,
        minPasswordLength: 12,
        maxPasswordLength: 128,
        revokeSessionsOnPasswordReset: true,
        resetPasswordTokenExpiresIn: 20 * 60,
        sendResetPassword: async ({ user, token }) => {
          const url = `${host.publicOrigin}/account/reset#token=${encodeURIComponent(token)}`;
          if (localUsername) {
            const accept = recoveries.get(user.email);
            if (!accept)
              throw new Error(
                'Local account recovery requires operator authorization.',
              );
            accept(url);
            return;
          }
          await enrollment.deliver({
            kind: 'reset-password',
            recipient: user.email,
            // The account recovery view submits the token explicitly; GET or
            // mail-preview navigation never consumes it. Fragments stay off HTTP logs.
            url,
          });
        },
      },
      emailVerification: {
        sendOnSignUp: !localUsername,
        sendOnSignIn: !localUsername,
        autoSignInAfterVerification: false,
        sendVerificationEmail: async ({ user, url }) =>
          enrollment.deliver({
            kind: 'verify-email',
            recipient: user.email,
            url,
          }),
      },
      session: {
        expiresIn: 60 * 60 * 24,
        deferSessionRefresh: true,
        cookieCache: { enabled: false },
      },
      advanced: {
        cookiePrefix: `station-account-${createHash('sha256').update(host.stationId).digest('hex').slice(0, 20)}`,
        useSecureCookies: host.publicOrigin.startsWith('https:'),
      },
      account: { accountLinking: { enabled: false } },
      plugins: localUsername
        ? [
            username({
              minUsernameLength: 3,
              maxUsernameLength: 32,
              usernameValidator: (value) =>
                /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}$/.test(value),
            }),
          ]
        : [],
      rateLimit: { enabled: true, storage: 'database', window: 60, max: 10 },
      user: {
        additionalFields: {
          verifiedAt: { type: 'date', required: false, input: false },
        },
      },
      databaseHooks: {
        session: {
          create: {
            before: async (session) => administration.permits(session.userId),
          },
        },
        user: {
          create: {
            before: async (user, context) => {
              const invitation = context?.request?.headers.get(
                'x-station-invitation',
              );
              return (
                !!invitation &&
                (await enrollment.mayRegister({
                  invitation,
                  ...(localUsername ? {} : { email: user.email }),
                }))
              );
            },
          },
          update: {
            before: async (user) =>
              user.emailVerified === true
                ? { data: { ...user, verifiedAt: new Date() } }
                : undefined,
          },
        },
      },
    } satisfies BetterAuthOptions;
    const migration = await getMigrations(options);
    await migration.runMigrations();
    const auth = betterAuth(options);
    const signUpPath = localUsername ? '/sign-up/username' : '/sign-up/email';
    const signInPath = localUsername ? '/sign-in/username' : '/sign-in/email';
    const endpoints: DeploymentAuthenticationProvider['endpoints'] = [
      { path: signUpPath, methods: ['POST'], operation: 'register' },
      { path: signInPath, methods: ['POST'], operation: 'begin-login' },
      { path: '/sign-out', methods: ['POST'], operation: 'logout' },
      {
        path: '/send-verification-email',
        methods: ['POST'],
        operation: 'verify-contact',
      },
      { path: '/verify-email', methods: ['GET'], operation: 'verify-contact' },
      {
        path: '/request-password-reset',
        methods: ['POST'],
        operation: 'request-recovery',
      },
      {
        path: '/reset-password',
        methods: ['POST'],
        operation: 'complete-recovery',
      },
      {
        path: '/change-password',
        methods: ['POST'],
        operation: 'change-password',
      },
      { path: '/get-session', methods: ['POST'], operation: 'refresh-session' },
      {
        path: '/revoke-sessions',
        methods: ['POST'],
        operation: 'revoke-session',
      },
      {
        path: '/revoke-other-sessions',
        methods: ['POST'],
        operation: 'revoke-session',
      },
    ].filter(
      (endpoint) =>
        !localUsername ||
        !['verify-contact', 'request-recovery'].includes(endpoint.operation),
    ) as DeploymentAuthenticationProvider['endpoints'];
    const cookie = getCookies(options).sessionToken.name;
    let closed = false;
    return {
      administration,
      async issueRecovery(accountId) {
        if (!localUsername || closed || !administration.permits(accountId))
          throw new Error('Local account recovery is unavailable.');
        const row = database
          .prepare('SELECT email FROM user WHERE id = ?')
          .get(accountId);
        if (typeof row?.email !== 'string' || recoveries.has(row.email))
          throw new Error('Local account recovery is unavailable.');
        let url: string | undefined;
        recoveries.set(row.email, (value) => {
          url = value;
        });
        try {
          await auth.api.requestPasswordReset({ body: { email: row.email } });
          if (!url || !administration.permits(accountId))
            throw new Error('Local account recovery was not created.');
          return url;
        } finally {
          recoveries.delete(row.email);
        }
      },
      version: DEPLOYMENT_AUTHENTICATION_VERSION,
      issuer: `urn:station:local-accounts:${host.stationId}`,
      displayName: 'Station account',
      login: {
        kind: mode,
        signInPath,
        signUpPath,
      },
      sessionCookies: [cookie],
      endpoints,
      async authenticate(request) {
        const current = await auth.api.getSession({
          headers: request.headers,
          query: { disableCookieCache: true, disableRefresh: true },
        });
        if (
          !current ||
          (!localUsername &&
            (!current.user.emailVerified || !current.user.verifiedAt))
        )
          return { kind: 'invalid', reason: 'invalid-credential' };
        if (!administration.permits(current.user.id, current.session.createdAt))
          return { kind: 'invalid', reason: 'revoked' };
        return {
          kind: 'authenticated',
          session: {
            subject: current.user.id,
            displayName: current.user.name,
            sessionId: current.session.id,
            authenticatedAt: current.session.createdAt.toISOString(),
            expiresAt: current.session.expiresAt.toISOString(),
            contacts: localUsername
              ? []
              : [
                  {
                    kind: 'email',
                    value: current.user.email,
                    verifiedAt: current.user.verifiedAt!.toISOString(),
                  },
                ],
          },
        };
      },
      async handle(request) {
        const path = new URL(request.url).pathname.slice(host.basePath.length);
        if (
          !endpoints.some(
            (endpoint) =>
              endpoint.path === path &&
              endpoint.methods.some((method) => method === request.method),
          )
        ) {
          return Response.json(
            { error: { code: 'authentication_operation_unsupported' } },
            { status: 404 },
          );
        }
        let operation = request;
        if (path === signUpPath) {
          const input: unknown = await request.clone().json();
          const invitation = request.headers.get('x-station-invitation');
          const email =
            input &&
            typeof input === 'object' &&
            'email' in input &&
            typeof input.email === 'string'
              ? input.email.toLowerCase()
              : undefined;
          if (
            !invitation ||
            (!localUsername && !email) ||
            !(await enrollment.mayRegister({
              invitation,
              ...(localUsername ? {} : { email }),
            }))
          ) {
            return Response.json(
              { error: { code: 'invitation_required' } },
              { status: 403 },
            );
          }
          if (localUsername) {
            const parsed = z
              .object({
                username: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}$/),
                password: z.string().min(12).max(128),
                name: z.string().trim().min(1).max(128).optional(),
              })
              .strict()
              .safeParse(input);
            if (!parsed.success)
              return Response.json(
                { error: { code: 'invalid_request' } },
                { status: 400 },
              );
            const headers = new Headers(request.headers);
            headers.delete('Content-Length');
            operation = new Request(
              `${host.publicOrigin}${host.basePath}/sign-up/email`,
              {
                method: 'POST',
                headers,
                signal: request.signal,
                body: JSON.stringify({
                  ...parsed.data,
                  name: parsed.data.name ?? parsed.data.username,
                  // Better Auth requires a unique internal email column. This
                  // reserved-domain value is never contact or identity evidence.
                  email: `${randomUUID()}@station.invalid`,
                }),
              },
            );
          }
        }
        if (path === '/change-password') {
          const body: unknown = await request.clone().json();
          if (!body || typeof body !== 'object' || Array.isArray(body))
            return Response.json(
              { error: { code: 'invalid_request' } },
              { status: 400 },
            );
          const headers = new Headers(request.headers);
          headers.delete('Content-Length');
          operation = new Request(request.url, {
            method: request.method,
            headers,
            signal: request.signal,
            body: JSON.stringify({ ...body, revokeOtherSessions: true }),
          });
        }
        const response = await auth.handler(operation);
        if (
          response.ok &&
          [signInPath, signUpPath, '/get-session', '/change-password'].includes(
            path,
          )
        ) {
          // Session tokens stay in HttpOnly cookies. The core self endpoint
          // supplies the closed identity view without library token records.
          const headers = new Headers(response.headers);
          headers.delete('Content-Length');
          headers.set('Content-Type', 'application/json');
          return new Response(JSON.stringify({ success: true }), {
            status: response.status,
            headers,
          });
        }
        return response;
      },
      async close() {
        if (closed) return;
        closed = true;
        database.close();
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
