import type {
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
