import { createHash } from 'node:crypto';
import { chmod, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  DEPLOYMENT_AUTHENTICATION_VERSION,
  type DeploymentAuthenticationHost,
  type DeploymentAuthenticationProvider,
} from '@kontourai/station-contracts/deployment-authentication';
import { type BetterAuthOptions, betterAuth } from 'better-auth';
import { getCookies } from 'better-auth/cookies';
import { getMigrations } from 'better-auth/db/migration';
import { LocalAccountAdministration } from './local-account-administration.js';

export interface LocalAccountEmail {
  kind: 'verify-email' | 'reset-password';
  recipient: string;
  url: string;
}

export interface LocalAccountEnrollment {
  /** Checks the real pending invitation. This is eligibility to register, never membership. */
  mayRegister(input: { invitation: string; email: string }): Promise<boolean>;
  /** Server-owned mail transport; callers must not supply a delivery destination. */
  deliver(message: LocalAccountEmail): Promise<void>;
}

export interface LocalAccountProvider extends DeploymentAuthenticationProvider {
  /** Private operator route composition only; never forwarded through provider.handle. */
  administration: LocalAccountAdministration;
}

/** Maintained password/session implementation behind Station's common authentication contract. */
export async function createLocalAccountProvider(
  host: Readonly<DeploymentAuthenticationHost>,
  secret: string,
  enrollment: LocalAccountEnrollment,
): Promise<LocalAccountProvider> {
  if (secret.length < 32)
    throw new Error(
      'Local accounts require an operator-owned authentication secret.',
    );
  const databasePath = join(host.stateDirectory, 'local-accounts.sqlite');
  const existing = await lstat(databasePath).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error('Local account database must be a regular owned file.');
  const database = new DatabaseSync(databasePath);
  try {
    if (process.platform !== 'win32') await chmod(databasePath, 0o600);
    database.exec(
      'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;',
    );
    const administration = new LocalAccountAdministration(database);
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
        requireEmailVerification: true,
        autoSignIn: false,
        minPasswordLength: 12,
        maxPasswordLength: 128,
        revokeSessionsOnPasswordReset: true,
        sendResetPassword: async ({ user, token }) =>
          enrollment.deliver({
            kind: 'reset-password',
            recipient: user.email,
            // The account recovery view submits the token explicitly; GET or
            // mail-preview navigation never consumes it. Fragments stay off HTTP logs.
            url: `${host.publicOrigin}/account/reset#token=${encodeURIComponent(token)}`,
          }),
      },
      emailVerification: {
        sendOnSignUp: true,
        sendOnSignIn: true,
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
                  email: user.email,
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
    const endpoints: DeploymentAuthenticationProvider['endpoints'] = [
      { path: '/sign-up/email', methods: ['POST'], operation: 'register' },
      { path: '/sign-in/email', methods: ['POST'], operation: 'begin-login' },
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
    ];
    const cookie = getCookies(options).sessionToken.name;
    let closed = false;
    return {
      administration,
      version: DEPLOYMENT_AUTHENTICATION_VERSION,
      issuer: `urn:station:local-accounts:${host.stationId}`,
      displayName: 'Station account',
      sessionCookies: [cookie],
      endpoints,
      async authenticate(request) {
        const current = await auth.api.getSession({
          headers: request.headers,
          query: { disableCookieCache: true, disableRefresh: true },
        });
        if (!current?.user.emailVerified || !current.user.verifiedAt)
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
            contacts: [
              {
                kind: 'email',
                value: current.user.email,
                verifiedAt: current.user.verifiedAt.toISOString(),
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
        if (path === '/sign-up/email') {
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
            !email ||
            !(await enrollment.mayRegister({ invitation, email }))
          ) {
            return Response.json(
              { error: { code: 'invitation_required' } },
              { status: 403 },
            );
          }
        }
        let operation = request;
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
          [
            '/sign-in/email',
            '/sign-up/email',
            '/get-session',
            '/change-password',
          ].includes(path)
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
