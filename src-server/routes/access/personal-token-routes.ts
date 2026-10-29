/**
 * #3557: a person's own personal access tokens. The caller must be a paired
 * device tied to a person (never a token, the operator credential, or a
 * device tied to no one): the token acts as that person, so it may carry no
 * more than the calling device may use right now, and it stays capped by the
 * person's Station group for as long as it lives. The operator manages
 * anyone's tokens from the People routes instead.
 */

import {
  isPairingScopeSubset,
  type PairedDevice,
} from '@kontourai/station-contracts/environment-security';
import {
  isPersonalTokenScope,
  MAX_PERSONAL_TOKEN_LIFETIME_MS,
} from '@kontourai/station-contracts/personal-tokens';
import { type Context, Hono } from 'hono';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import { principalForDeviceBinding } from '../../services/access/device-binding-principal.js';
import { PersonalTokenUnavailableError } from '../../services/access/personal-token-store.js';
import {
  DevicePairingError,
  type DevicePairingService,
} from '../../services/ssh/device-pairing-service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

type TokenPairing = Pick<
  DevicePairingService,
  | 'identifyDevice'
  | 'effectiveScope'
  | 'mintPersonalToken'
  | 'listPersonalTokens'
  | 'revokePersonalToken'
>;

/** `expiresInDays` from a request body: none, or 1..365 whole days. */
export function parseTokenExpiry(
  value: unknown,
  now: number,
): number | null | 'invalid' {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value * DAY_MS > MAX_PERSONAL_TOKEN_LIFETIME_MS
  )
    return 'invalid';
  return now + value * DAY_MS;
}

export function createPersonalTokenRoutes(
  pairing: TokenPairing,
  now: () => number = Date.now,
) {
  const app = new Hono();

  /** The calling device and its person, or why it may not manage tokens. */
  const caller = (
    c: Context,
  ):
    | {
        credential: string;
        device: PairedDevice & {
          principalBinding: NonNullable<PairedDevice['principalBinding']>;
        };
        ownerPrincipalId: string;
      }
    | Response => {
    const principal = getRuntimeAuthenticatedRequestPrincipal(c.req.raw);
    if (principal?.authority !== 'device-credential')
      return c.json({ error: { code: 'person_device_required' } }, 403);
    const device = pairing.identifyDevice(principal.credential);
    if (
      !device?.principalBinding ||
      device.kind !== 'device' ||
      device.credentialKind === 'personal-token'
    )
      return c.json({ error: { code: 'person_device_required' } }, 403);
    return {
      credential: principal.credential,
      device: device as PairedDevice & {
        principalBinding: NonNullable<PairedDevice['principalBinding']>;
      },
      ownerPrincipalId: principalForDeviceBinding(device.principalBinding).id,
    };
  };

  app.get('/', (c) => {
    c.header('Cache-Control', 'no-store');
    const self = caller(c);
    if (self instanceof Response) return self;
    return c.json({
      tokens: pairing.listPersonalTokens(self.ownerPrincipalId),
    });
  });

  app.post('/', async (c) => {
    c.header('Cache-Control', 'no-store');
    const self = caller(c);
    if (self instanceof Response) return self;
    const body = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      scope?: unknown;
      expiresInDays?: unknown;
    } | null;
    const expiresAt = parseTokenExpiry(body?.expiresInDays, now());
    if (
      typeof body?.name !== 'string' ||
      typeof body.scope !== 'string' ||
      !isPersonalTokenScope(body.scope) ||
      expiresAt === 'invalid'
    )
      return c.json({ error: { code: 'invalid_request' } }, 400);
    // Never more than this device may use now (its group's cap included).
    const usable = pairing.effectiveScope(self.credential);
    if (usable === undefined || !isPairingScopeSubset(body.scope, usable))
      return c.json({ error: { code: 'scope_exceeds_access' } }, 400);
    try {
      return c.json(
        await pairing.mintPersonalToken({
          name: body.name,
          binding: self.device.principalBinding,
          ownerPrincipalId: self.ownerPrincipalId,
          scope: body.scope,
          expiresAt,
        }),
        201,
      );
    } catch (error) {
      if (
        error instanceof DevicePairingError &&
        error.code === 'identity_credential_quota_reached'
      )
        return c.json({ error: { code: 'token_limit_reached' } }, 409);
      if (
        error instanceof DevicePairingError &&
        error.code === 'account_bound_person'
      )
        return c.json({ error: { code: 'account_bound_person' } }, 400);
      if (error instanceof PersonalTokenUnavailableError)
        return c.json({ error: { code: 'tokens_unavailable' } }, 503);
      if (error instanceof DevicePairingError)
        return c.json({ error: { code: 'invalid_request' } }, 400);
      throw error;
    }
  });

  app.delete('/:tokenId', async (c) => {
    const self = caller(c);
    if (self instanceof Response) return self;
    try {
      return (await pairing.revokePersonalToken(
        c.req.param('tokenId'),
        self.ownerPrincipalId,
      ))
        ? c.json({ revoked: true })
        : c.json({ error: { code: 'not_found' } }, 404);
    } catch (error) {
      if (error instanceof PersonalTokenUnavailableError)
        return c.json({ error: { code: 'tokens_unavailable' } }, 503);
      throw error;
    }
  });

  return app;
}
