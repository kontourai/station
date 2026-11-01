import type {
  AccountSharingApplyResult,
  AccountSharingChoice,
  AccountSharingSettingView,
  LocalAccountAction,
  LocalAccountActionResult,
  LocalAccountAdministrationView,
} from '@kontourai/station-contracts/local-accounts';
import { z } from 'zod/v3';
import { type ClientRequestOptions, getJson, mutateJson } from './http';
import { unwrapProjectResponse } from './project-response';

const view = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z
    .object({ kind: z.literal('external'), provider: z.string().min(1) })
    .strict(),
  z
    .object({
      kind: z.literal('local'),
      accounts: z
        .array(
          z
            .object({
              accountId: z.string().min(1),
              name: z.string(),
              username: z.string().optional(),
              email: z.string().email().optional(),
              emailVerified: z.boolean(),
              disabled: z.boolean(),
            })
            .strict(),
        )
        .max(1000),
    })
    .strict(),
]);
export async function getLocalAccounts(
  apiBase: string,
  options: ClientRequestOptions,
): Promise<LocalAccountAdministrationView> {
  return view.parse(
    await unwrapProjectResponse<unknown>(
      await getJson(`${apiBase}/api/operator/accounts`, options),
    ),
  );
}
export async function changeLocalAccount(
  apiBase: string,
  accountId: string,
  action: LocalAccountAction,
  options: ClientRequestOptions,
): Promise<LocalAccountActionResult> {
  const result = await unwrapProjectResponse<unknown>(
    await mutateJson(
      `${apiBase}/api/operator/accounts/${encodeURIComponent(accountId)}/actions`,
      'POST',
      { ...options, readOnly: false },
      { action },
    ),
  );
  if (action !== 'create-recovery')
    return z
      .object({ changed: z.literal(true) })
      .strict()
      .parse(result);
  return z
    .object({
      recoveryUrl: z
        .string()
        .url()
        .refine((value) => {
          const url = new URL(value);
          return (
            ['https:', 'http:'].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            url.pathname === '/account/reset' &&
            !url.search &&
            /^[A-Za-z0-9_-]{16,256}$/.test(
              new URLSearchParams(url.hash.slice(1)).get('token') ?? '',
            )
          );
        }),
    })
    .strict()
    .parse(result);
}

const sharingChoice = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({ enabled: z.literal(true), publicOrigin: z.string().url() })
    .strict(),
]);
const sharingView = z
  .object({
    source: z.enum(['deployment', 'setting']),
    lockedBy: z.array(z.string().min(1)).max(16),
    active: z
      .object({
        projectSharing: z.boolean(),
        localAccounts: z.boolean(),
        externalProvider: z.boolean(),
        publicOrigin: z.string().url().optional(),
      })
      .strict(),
    stored: sharingChoice.optional(),
    storedUnreadable: z.boolean().optional(),
    pending: z
      .object({ choice: sharingChoice, ready: z.boolean() })
      .strict()
      .optional(),
    startupFailure: z.string().max(1024).optional(),
    lastApply: z
      .object({
        outcome: z.enum(['applied', 'rolled-back', 'withdrawn']),
        choice: sharingChoice,
        at: z.string(),
        reason: z.string().optional(),
      })
      .strict()
      .optional(),
    origins: z
      .array(
        z
          .object({
            origin: z.string().url(),
            sources: z
              .array(
                z.enum([
                  'allowed-origin',
                  'station-loopback',
                  'bound-host',
                  'tailscale-serve',
                ]),
              )
              .min(1),
            unavailable: z
              .enum(['requires-https', 'not-a-browser-origin'])
              .optional(),
          })
          .strict(),
      )
      .max(64),
    restart: z.enum(['supervised', 'unavailable']),
  })
  .strict();

/** #4305: the operator-only Project sharing with local accounts setting. */
export async function getAccountSharingSetting(
  apiBase: string,
  options: ClientRequestOptions,
): Promise<AccountSharingSettingView> {
  return sharingView.parse(
    await unwrapProjectResponse<unknown>(
      await getJson(`${apiBase}/api/operator/account-sharing`, options),
    ),
  );
}

/**
 * Applies a new choice. A `changed` result means the Station is restarting
 * into it; read the setting again afterwards for the outcome.
 */
export async function applyAccountSharingSetting(
  apiBase: string,
  choice: AccountSharingChoice,
  options: ClientRequestOptions,
): Promise<AccountSharingApplyResult> {
  return z
    .union([
      z.object({ changed: z.literal(false) }).strict(),
      z
        .object({
          changed: z.literal(true),
          confirmation: z
            .object({
              id: z.string().uuid(),
              reviewUrl: z.string().url(),
              expiresAt: z.number(),
            })
            .strict()
            .refine(({ id, reviewUrl }) => {
              try {
                const url = new URL(reviewUrl);
                return (
                  ['http:', 'https:'].includes(url.protocol) &&
                  !url.username &&
                  !url.password &&
                  !url.search &&
                  !url.hash &&
                  url.pathname === `/consent/${encodeURIComponent(id)}`
                );
              } catch {
                return false;
              }
            }),
        })
        .strict(),
      z
        .object({
          changed: z.literal(true),
          restarting: z.literal(true),
          durabilityUncertain: z.boolean().optional(),
        })
        .strict(),
    ])
    .parse(
      await unwrapProjectResponse<unknown>(
        await mutateJson(
          `${apiBase}/api/operator/account-sharing`,
          'PUT',
          { ...options, readOnly: false },
          choice,
        ),
      ),
    );
}
