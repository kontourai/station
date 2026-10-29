/**
 * Member passkeys for Station local accounts (#4303).
 *
 * Better Auth's maintained passkey plugin owns the WebAuthn ceremony, the
 * challenge record and the `passkey` table inside `local-accounts.sqlite`.
 * Station owns who may register, which account a credential lands on, and
 * whether the account may sign in. This store is unrelated to the operator
 * passkey registry: a member passkey only ever creates an ordinary member
 * session, which carries no operator authority.
 *
 * The plugin's own routes never reach the network. `handle` exposes six
 * Station endpoints, each with exactly one authority source:
 *
 *  - sign-in: none (the credential itself), usernameless.
 *  - sign-up: a real pending invitation (`mayRegister`), checked at both steps.
 *  - add: a Station-verified, recently authenticated account session.
 *  - recover: an operator-issued recovery token, consumed once at verify.
 *  - list / remove: a Station-verified account session.
 *
 * Every registration resolves its account through a server-held ceremony
 * rather than Better Auth's session view, which does not know Station's
 * disabled or signed-out-everywhere policy.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { passkey } from '@better-auth/passkey';
import type { DeploymentAuthenticationEndpoint } from '@kontourai/station-contracts/deployment-authentication';
import type { BetterAuthPlugin, GenericEndpointContext } from 'better-auth';
import { APIError } from 'better-auth/api';
import { z } from 'zod/v3';
import type { LocalAccountAdministration } from './local-account-administration.js';

/** The Station-wide Feature Preview that offers member passkeys (#4303). */
export const MEMBER_PASSKEYS_PREVIEW_ID = 'member-passkeys';

export const MEMBER_PASSKEY_ENDPOINTS = [
  { path: '/passkey/sign-in', methods: ['POST'], operation: 'passkey-sign-in' },
  {
    path: '/passkey/sign-up',
    methods: ['POST'],
    operation: 'passkey-register',
  },
  { path: '/passkey/add', methods: ['POST'], operation: 'passkey-add' },
  { path: '/passkey/recover', methods: ['POST'], operation: 'passkey-recover' },
  { path: '/passkey/list', methods: ['POST'], operation: 'passkey-list' },
  { path: '/passkey/remove', methods: ['POST'], operation: 'passkey-remove' },
] as const satisfies readonly DeploymentAuthenticationEndpoint[];

/** Matches the plugin's challenge lifetime (300 s). */
const CEREMONY_TTL_MS = 5 * 60_000;
/** Live registration ceremonies at once; refuse rather than evict. */
const MAX_LIVE_CEREMONIES = 256;
/** Adding a credential needs a sign-in at most this old. */
export const PASSKEY_ADD_FRESHNESS_MS = 15 * 60_000;
const USERNAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}$/;
const RECOVERY_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const label = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    (value) =>
      !Array.from(value).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || (code >= 127 && code <= 159);
      }),
  );
const credential = z.record(z.unknown());

type RegistrationKind = 'sign-up' | 'add' | 'recover';
interface Ceremony {
  readonly kind: RegistrationKind;
  readonly expiresAt: number;
  readonly username: string;
  readonly displayName: string;
  /** add / recover: the account the credential must land on. */
  readonly userId?: string;
  /** sign-up: the invitation that authorized this ceremony. */
  readonly invitation?: string;
  /** recover: SHA-256 of the recovery token that authorized it. */
  readonly tokenDigest?: Buffer;
}

type Scope =
  | { kind: 'sign-in' }
  | {
      kind: RegistrationKind;
      /** Present on the options step: what the new ceremony will bind. */
      draft?: Omit<Ceremony, 'kind' | 'expiresAt'>;
      /** Present on the verify step: binds a ceremony to its account. */
      complete?: (
        ceremony: Ceremony,
        ctx: GenericEndpointContext,
      ) => Promise<string>;
    };

export interface MemberPasskeyAccount {
  userId: string;
  authenticatedAt: string;
}

interface MemberPasskeyHost {
  publicOrigin: string;
  basePath: string;
  database: DatabaseSync;
  administration: LocalAccountAdministration;
  mayRegister(invitation: string): Promise<boolean>;
  now?: () => number;
}

export interface MemberPasskeyRuntime {
  handler(request: Request): Promise<Response>;
  challengeCookie: string;
  /** Station's own session verdict, including disabled and revoked accounts. */
  currentAccount(request: Request): Promise<MemberPasskeyAccount | undefined>;
  /** Reads a verification row without consuming it. */
  findVerification(
    identifier: string,
  ): Promise<{ value: string; expiresAt: Date } | null>;
}

const digest = (value: string) => createHash('sha256').update(value).digest();
const refuse = (status: number, code: string) =>
  Response.json({ error: { code } }, { status });

export interface MemberPasskeys {
  plugin: BetterAuthPlugin;
  handle(
    path: string,
    request: Request,
    runtime: MemberPasskeyRuntime,
  ): Promise<Response>;
}

export function createMemberPasskeys(host: MemberPasskeyHost): MemberPasskeys {
  const now = host.now ?? (() => Date.now());
  const scope = new AsyncLocalStorage<Scope>();
  const ceremonies = new Map<string, Ceremony>();
  const rpID = new URL(host.publicOrigin).hostname;

  function openCeremony(
    kind: RegistrationKind,
    draft: Omit<Ceremony, 'kind' | 'expiresAt'>,
  ): string {
    const at = now();
    for (const [id, ceremony] of ceremonies)
      if (ceremony.expiresAt <= at) ceremonies.delete(id);
    if (ceremonies.size >= MAX_LIVE_CEREMONIES)
      throw APIError.from('TOO_MANY_REQUESTS', {
        code: 'PASSKEY_CEREMONIES_EXHAUSTED',
        message: 'Too many passkey registrations are in progress.',
      });
    const id = `ceremony-${randomBytes(24).toString('base64url')}`;
    ceremonies.set(id, { ...draft, kind, expiresAt: at + CEREMONY_TTL_MS });
    return id;
  }

  function takeCeremony(id: string): Ceremony | undefined {
    const ceremony = ceremonies.get(id);
    ceremonies.delete(id);
    return ceremony && ceremony.expiresAt > now() ? ceremony : undefined;
  }

  const rejected = (message = 'Passkey registration was refused.') =>
    APIError.from('FORBIDDEN', { code: 'PASSKEY_REFUSED', message });

  const plugin = passkey({
    rpID,
    rpName: 'Station',
    // Never the request's Origin header: the plugin's default would accept
    // whatever origin the caller claims.
    origin: host.publicOrigin,
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
    registration: {
      // Better Auth's session view ignores Station account policy, so every
      // registration resolves its account through a Station-owned ceremony.
      requireSession: false,
      resolveUser: async () => {
        const current = scope.getStore();
        if (!current || current.kind === 'sign-in' || !current.draft)
          throw rejected();
        return {
          id: openCeremony(current.kind, current.draft),
          name: current.draft.username,
          displayName: current.draft.displayName,
        };
      },
      afterVerification: async ({ ctx, user, verification }) => {
        const current = scope.getStore();
        const ceremony = takeCeremony(user.id);
        if (
          !current ||
          current.kind === 'sign-in' ||
          !current.complete ||
          !ceremony ||
          ceremony.kind !== current.kind ||
          !verification.registrationInfo?.userVerified
        )
          throw rejected();
        return {
          userId: await current.complete(ceremony, ctx),
        };
      },
    },
    authentication: {
      afterVerification: async ({ verification, clientData }) => {
        const owner = host.database
          .prepare('SELECT userId FROM passkey WHERE credentialID = ?')
          .get(String(clientData.id))?.userId;
        if (
          scope.getStore()?.kind !== 'sign-in' ||
          !verification.authenticationInfo.userVerified ||
          typeof owner !== 'string' ||
          !host.administration.permits(owner)
        )
          throw APIError.from('UNAUTHORIZED', {
            code: 'PASSKEY_REJECTED',
            message: 'Passkey sign-in was refused.',
          });
      },
    },
  });

  function usernameTaken(username: string): boolean {
    return (
      host.database
        .prepare('SELECT 1 AS found FROM user WHERE username = ?')
        .get(username.toLowerCase()) !== undefined
    );
  }

  function accountNames(
    userId: string,
  ): { username: string; displayName: string } | undefined {
    const row = host.database
      .prepare('SELECT username, name FROM user WHERE id = ?')
      .get(userId);
    if (typeof row?.username !== 'string' || typeof row.name !== 'string')
      return undefined;
    return { username: row.username, displayName: row.name };
  }

  async function readJson(request: Request): Promise<unknown> {
    try {
      return await request.json();
    } catch {
      return undefined;
    }
  }

  function list(userId: string) {
    return host.database
      .prepare(
        `SELECT id, name, createdAt, deviceType, backedUp FROM passkey
         WHERE userId = ? ORDER BY createdAt, id LIMIT 100`,
      )
      .all(userId)
      .map((row) => ({
        id: String(row.id),
        ...(typeof row.name === 'string' && row.name ? { name: row.name } : {}),
        createdAt:
          typeof row.createdAt === 'string' &&
          Number.isFinite(Date.parse(row.createdAt))
            ? new Date(row.createdAt).toISOString()
            : null,
        synced: row.deviceType === 'multiDevice' && Number(row.backedUp) === 1,
      }));
  }

  /** A passkey-only account must keep one way to sign in. */
  function isLastSignInMethod(userId: string): boolean {
    const passkeys = Number(
      host.database
        .prepare('SELECT COUNT(*) AS count FROM passkey WHERE userId = ?')
        .get(userId)?.count,
    );
    const accounts = Number(
      host.database
        .prepare('SELECT COUNT(*) AS count FROM account WHERE userId = ?')
        .get(userId)?.count,
    );
    return passkeys <= 1 && accounts === 0;
  }

  async function handle(
    path: string,
    request: Request,
    runtime: MemberPasskeyRuntime,
  ): Promise<Response> {
    const body = await readJson(request);
    if (
      path !== '/passkey/list' &&
      path !== '/passkey/remove' &&
      request.headers.get('Origin') !== host.publicOrigin
    )
      // WebAuthn binds the RP ID and origin to STATION_AUTHENTICATION_ORIGIN;
      // another approved browser origin cannot complete a ceremony.
      return refuse(403, 'passkey_origin_unsupported');

    function ceremonyRequest(
      pluginPath: string,
      init: { method: 'GET' } | { method: 'POST'; body: unknown },
      extraHeaders: Record<string, string> = {},
    ): Request {
      const headers = new Headers(request.headers);
      for (const name of [
        'Cookie',
        'Cookie2',
        'Authorization',
        'Content-Length',
        'x-station-invitation',
      ])
        headers.delete(name);
      // Only the plugin's signed challenge cookie crosses: an account session
      // never selects or authorizes a ceremony here.
      const challenge = (request.headers.get('cookie') ?? '')
        .split(';')
        .map((entry) => entry.trim())
        .find((entry) => entry.startsWith(`${runtime.challengeCookie}=`));
      if (challenge) headers.set('Cookie', challenge);
      for (const [name, value] of Object.entries(extraHeaders))
        headers.set(name, value);
      if (init.method === 'POST')
        headers.set('Content-Type', 'application/json');
      return new Request(`${host.publicOrigin}${host.basePath}${pluginPath}`, {
        method: init.method,
        headers,
        signal: request.signal,
        ...(init.method === 'POST' ? { body: JSON.stringify(init.body) } : {}),
      });
    }

    /** Pass the plugin's cookies through; never its session/user records. */
    async function relay(
      response: Response,
      failure: { status: number; code: string },
      data?: (value: unknown) => unknown,
    ): Promise<Response> {
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 429) return refuse(429, 'passkey_rate_limited');
        return response.status >= 500 && response.status !== 503
          ? refuse(503, 'passkey_unavailable')
          : refuse(failure.status, failure.code);
      }
      const headers = new Headers();
      for (const cookie of response.headers.getSetCookie())
        headers.append('Set-Cookie', cookie);
      const value: unknown = await response.json();
      return Response.json(
        { data: data ? data(value) : { success: true } },
        { status: 200, headers },
      );
    }

    const step = z
      .object({ step: z.enum(['options', 'verify']) })
      .passthrough()
      .safeParse(body);
    if (!step.success && path !== '/passkey/list' && path !== '/passkey/remove')
      return refuse(400, 'invalid_request');

    const registrationOptions = (kind: RegistrationKind, draft: Scope) =>
      scope
        .run(draft, () =>
          runtime.handler(
            ceremonyRequest('/passkey/generate-register-options', {
              method: 'GET',
            }),
          ),
        )
        .then((response) =>
          relay(
            response,
            { status: 403, code: `passkey_${kind.replace('-', '_')}_refused` },
            (options) => ({ options }),
          ),
        );
    const registrationVerify = (
      kind: RegistrationKind,
      current: Scope,
      input: { response: Record<string, unknown>; label?: string },
      extraHeaders?: Record<string, string>,
    ) =>
      scope
        .run(current, () =>
          runtime.handler(
            ceremonyRequest(
              '/passkey/verify-registration',
              {
                method: 'POST',
                body: {
                  response: input.response,
                  ...(input.label ? { name: input.label } : {}),
                  // add keeps the existing session; the others sign in.
                  createSession: kind !== 'add',
                },
              },
              extraHeaders,
            ),
          ),
        )
        .then((response) =>
          relay(response, {
            status: 403,
            code: `passkey_${kind.replace('-', '_')}_refused`,
          }),
        );

    switch (path) {
      case '/passkey/sign-in': {
        if (step.data?.step === 'options') {
          const response = await scope.run({ kind: 'sign-in' }, () =>
            runtime.handler(
              ceremonyRequest('/passkey/generate-authenticate-options', {
                method: 'GET',
              }),
            ),
          );
          return relay(
            response,
            { status: 401, code: 'passkey_rejected' },
            (options) => ({ options }),
          );
        }
        const input = z
          .object({ step: z.literal('verify'), response: credential })
          .strict()
          .safeParse(body);
        if (!input.success) return refuse(400, 'invalid_request');
        const response = await scope.run({ kind: 'sign-in' }, () =>
          runtime.handler(
            ceremonyRequest('/passkey/verify-authentication', {
              method: 'POST',
              body: { response: input.data.response },
            }),
          ),
        );
        return relay(response, { status: 401, code: 'passkey_rejected' });
      }
      case '/passkey/sign-up': {
        const invitation = request.headers.get('x-station-invitation');
        if (
          !invitation ||
          !/^[A-Za-z0-9._-]{16,2048}$/.test(invitation) ||
          !(await host.mayRegister(invitation))
        )
          return refuse(403, 'invitation_required');
        if (step.data?.step === 'options') {
          const input = z
            .object({
              step: z.literal('options'),
              username: z.string().regex(USERNAME),
              name: z.string().trim().min(1).max(128).optional(),
            })
            .strict()
            .safeParse(body);
          if (!input.success) return refuse(400, 'invalid_request');
          if (usernameTaken(input.data.username))
            return refuse(409, 'username_unavailable');
          return registrationOptions('sign-up', {
            kind: 'sign-up',
            draft: {
              invitation,
              username: input.data.username,
              displayName: input.data.name ?? input.data.username,
            },
          });
        }
        const input = z
          .object({
            step: z.literal('verify'),
            response: credential,
            label: label.optional(),
          })
          .strict()
          .safeParse(body);
        if (!input.success) return refuse(400, 'invalid_request');
        return registrationVerify(
          'sign-up',
          {
            kind: 'sign-up',
            complete: async (ceremony, ctx) => {
              if (
                ceremony.invitation !== invitation ||
                !(await host.mayRegister(invitation))
              )
                throw rejected();
              // The Station user-create hook re-checks this invitation from
              // the forwarded header before the row is written.
              const user = await ctx.context.internalAdapter.createUser(
                {
                  email: `${randomUUID()}@station.invalid`,
                  name: ceremony.displayName,
                  emailVerified: false,
                },
                { method: 'passkey' },
              );
              if (!user) throw rejected();
              // The plugin runs this inside its registration transaction on
              // the single node:sqlite connection. Better Auth 1.7.11's
              // username hook validates through the non-transactional adapter
              // and would wait on that connection forever, so the username is
              // written here, on the same connection and transaction, with
              // the hook's normalization. The column's UNIQUE constraint still
              // rolls the whole registration back on a race.
              host.database
                .prepare(
                  'UPDATE user SET username = ?, displayUsername = ? WHERE id = ?',
                )
                .run(
                  ceremony.username.toLowerCase(),
                  ceremony.username,
                  user.id,
                );
              return user.id;
            },
          },
          input.data,
          { 'x-station-invitation': invitation },
        );
      }
      case '/passkey/add': {
        const account = await runtime.currentAccount(request);
        if (!account) return refuse(401, 'authentication_required');
        if (
          now() - Date.parse(account.authenticatedAt) >
          PASSKEY_ADD_FRESHNESS_MS
        )
          return refuse(403, 'reauthentication_required');
        if (step.data?.step === 'options') {
          if (
            !z
              .object({ step: z.literal('options') })
              .strict()
              .safeParse(body).success
          )
            return refuse(400, 'invalid_request');
          const names = accountNames(account.userId);
          if (!names) return refuse(401, 'authentication_required');
          return registrationOptions('add', {
            kind: 'add',
            draft: { userId: account.userId, ...names },
          });
        }
        const input = z
          .object({
            step: z.literal('verify'),
            response: credential,
            label: label.optional(),
          })
          .strict()
          .safeParse(body);
        if (!input.success) return refuse(400, 'invalid_request');
        return registrationVerify(
          'add',
          {
            kind: 'add',
            complete: async (ceremony) => {
              if (
                ceremony.userId !== account.userId ||
                !host.administration.permits(account.userId)
              )
                throw rejected();
              return account.userId;
            },
          },
          input.data,
        );
      }
      case '/passkey/recover': {
        const input = z
          .discriminatedUnion('step', [
            z
              .object({
                step: z.literal('options'),
                token: z.string().regex(RECOVERY_TOKEN),
              })
              .strict(),
            z
              .object({
                step: z.literal('verify'),
                token: z.string().regex(RECOVERY_TOKEN),
                response: credential,
                label: label.optional(),
              })
              .strict(),
          ])
          .safeParse(body);
        if (!input.success) return refuse(400, 'invalid_request');
        const token = input.data.token;
        if (input.data.step === 'options') {
          // Read without consuming: the token stays usable for a password
          // reset until one recovery path actually completes.
          const row = await runtime.findVerification(`reset-password:${token}`);
          const userId = row?.value;
          const names = userId ? accountNames(userId) : undefined;
          if (
            !row ||
            !userId ||
            !names ||
            !(row.expiresAt.getTime() > now()) ||
            !host.administration.permits(userId)
          )
            return refuse(403, 'recovery_unavailable');
          return registrationOptions('recover', {
            kind: 'recover',
            draft: { userId, tokenDigest: digest(token), ...names },
          });
        }
        return registrationVerify(
          'recover',
          {
            kind: 'recover',
            complete: async (ceremony, ctx) => {
              if (
                !ceremony.tokenDigest ||
                !timingSafeEqual(ceremony.tokenDigest, digest(token))
              )
                throw rejected();
              // Single use, shared with password reset: whichever completes
              // first consumes the operator's link.
              const consumed =
                await ctx.context.internalAdapter.consumeVerificationValue(
                  `reset-password:${token}`,
                );
              if (
                !consumed ||
                consumed.value !== ceremony.userId ||
                !host.administration.permits(ceremony.userId)
              )
                throw rejected();
              // Mirrors revokeSessionsOnPasswordReset.
              await ctx.context.internalAdapter.deleteUserSessions(
                ceremony.userId,
              );
              return ceremony.userId;
            },
          },
          input.data,
        );
      }
      case '/passkey/list': {
        if (
          !z
            .object({})
            .strict()
            .safeParse(body ?? {}).success
        )
          return refuse(400, 'invalid_request');
        const account = await runtime.currentAccount(request);
        if (!account) return refuse(401, 'authentication_required');
        return Response.json({ data: { passkeys: list(account.userId) } });
      }
      case '/passkey/remove': {
        const input = z
          .object({ id: z.string().min(1).max(256) })
          .strict()
          .safeParse(body);
        if (!input.success) return refuse(400, 'invalid_request');
        const account = await runtime.currentAccount(request);
        if (!account) return refuse(401, 'authentication_required');
        const owned = host.database
          .prepare('SELECT 1 AS found FROM passkey WHERE id = ? AND userId = ?')
          .get(input.data.id, account.userId);
        if (!owned) return refuse(404, 'passkey_not_found');
        if (isLastSignInMethod(account.userId))
          return refuse(409, 'last_sign_in_method');
        host.database
          .prepare('DELETE FROM passkey WHERE id = ? AND userId = ?')
          .run(input.data.id, account.userId);
        return Response.json({ data: { success: true } });
      }
      default:
        return refuse(404, 'authentication_operation_unsupported');
    }
  }

  return { plugin, handle };
}
