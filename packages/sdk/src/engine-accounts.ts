import { useMutation, useQuery } from '@tanstack/react-query';
import { z } from 'zod';

const authState = z.enum(['authenticated', 'unauthenticated', 'unknown']);
const engineAccountsSchema = z
  .object({
    engine: z.enum(['claude', 'codex']),
    activeProfileRef: z.string().nullable(),
    accounts: z.array(
      z
        .object({
          ref: z.string().nullable(),
          label: z.string(),
          authState,
          login: z.enum(['device-code', 'browser-code', 'unavailable']),
        })
        .strict(),
    ),
  })
  .strict();
const providerMoneySchema = z
  .object({
    amountMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[A-Z]{3}$/),
    exponent: z.number().int().min(0).max(6),
  })
  .strict();
const usageMetadataSchema = z
  .object({
    identity: z
      .object({
        email: z.string().optional(),
        accountId: z.string().optional(),
        userId: z.string().optional(),
      })
      .strict()
      .optional(),
    credits: z
      .object({
        available: z.boolean().optional(),
        unlimited: z.boolean().optional(),
        balance: z.number().nonnegative().optional(),
        overageLimitReached: z.boolean().optional(),
        approximateLocalMessages: z
          .array(z.number().nonnegative())
          .length(2)
          .optional(),
        approximateCloudMessages: z
          .array(z.number().nonnegative())
          .length(2)
          .optional(),
      })
      .strict()
      .optional(),
    extraUsage: z
      .object({
        enabled: z.boolean().optional(),
        used: z.number().nonnegative().optional(),
        monthlyLimit: z.number().nonnegative().optional(),
        usedPercent: z.number().nonnegative().optional(),
        limitReached: z.boolean().optional(),
        userDisabled: z.boolean().optional(),
        everEnabled: z.boolean().optional(),
        currency: z.string().optional(),
        decimalPlaces: z.number().int().min(0).max(6).optional(),
        disabledReason: z.string().optional(),
      })
      .strict()
      .optional(),
    spending: z
      .object({
        used: providerMoneySchema.optional(),
        limit: providerMoneySchema.optional(),
        balance: providerMoneySchema.optional(),
        cap: providerMoneySchema.optional(),
        usedPercent: z.number().nonnegative().optional(),
        severity: z.string().optional(),
        enabled: z.boolean().optional(),
        disabledReason: z.string().optional(),
        disclaimer: z.string().optional(),
        canPurchaseCredits: z.boolean().optional(),
        canToggle: z.boolean().optional(),
      })
      .strict()
      .optional(),
    limitDetails: z
      .array(
        z
          .object({
            kind: z.string().optional(),
            group: z.string().optional(),
            usedPercent: z.number().nonnegative().optional(),
            severity: z.string().optional(),
            resetsAt: z.string().optional(),
            active: z.boolean().optional(),
            model: z.string().optional(),
            modelId: z.string().optional(),
            surface: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    weeklyBreakdown: z
      .object({
        asOf: z.string().optional(),
        windowStartedAt: z.string().optional(),
        rows: z.array(
          z
            .object({
              key: z.string(),
              label: z.string(),
              usedPercent: z.number().nonnegative().optional(),
            })
            .strict(),
        ),
      })
      .strict()
      .optional(),
    memberDashboardAvailable: z.boolean().optional(),
    resetCredits: z
      .object({
        available: z.number().nonnegative().optional(),
        applicable: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
    models: z
      .array(
        z
          .object({
            id: z.string(),
            available: z.boolean().optional(),
            availableAt: z.string().optional(),
            creditsWouldEnable: z.boolean().optional(),
          })
          .strict(),
      )
      .optional(),
    capture: z
      .object({
        source: z.enum(['claude-oauth-usage', 'codex-wham-usage']),
        credentialStorage: z.enum(['secure-store', 'file']).optional(),
        unhandledFields: z.array(z.string()),
        excludedFields: z.array(z.string()),
        truncated: z.boolean(),
      })
      .strict(),
  })
  .strict();
const usageHistorySchema = z
  .object({
    status: z.enum(['ok', 'unavailable']),
    retentionDays: z.number().int().positive(),
    observations: z
      .array(
        z
          .object({
            fetchedAt: z.string().datetime({ offset: true }),
            status: z.enum(['ok', 'unknown']),
            windows: z
              .array(
                z
                  .object({
                    id: z.string(),
                    label: z.string(),
                    usedPercent: z.number().min(0).max(100),
                    resetsAt: z.string().optional(),
                    durationSeconds: z.number().positive().optional(),
                  })
                  .strict(),
              )
              .max(32),
          })
          .strict(),
      )
      .max(720),
  })
  .strict();
const engineAccountUsageSchema = z.union([
  z
    .object({
      status: z.literal('ok'),
      fetchedAt: z.string(),
      planLabel: z.string().optional(),
      windows: z.array(
        z
          .object({
            id: z.string(),
            label: z.string(),
            usedPercent: z.number().min(0).max(100),
            resetsAt: z.string().optional(),
            durationSeconds: z.number().positive().optional(),
            resetAfterSeconds: z.number().nonnegative().optional(),
            meteredFeature: z.string().optional(),
            allowed: z.boolean().optional(),
            limitReached: z.boolean().optional(),
            model: z.string().optional(),
          })
          .strict(),
      ),
      exhausted: z.boolean(),
      metadata: usageMetadataSchema.optional(),
      history: usageHistorySchema.optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal('unknown'),
      fetchedAt: z.string(),
      planLabel: z.string().optional(),
      reason: z.string(),
      metadata: usageMetadataSchema.optional(),
      history: usageHistorySchema.optional(),
    })
    .strict(),
]);
const engineAccountLoginSchema = z
  .object({
    engine: z.enum(['claude', 'codex']),
    mechanism: z.enum(['browser-code', 'device-code']),
    phase: z.enum([
      'starting',
      'awaiting-approval',
      'awaiting-code',
      'verifying',
      'completed',
      'failed',
      'cancelled',
    ]),
    startedAt: z.string(),
    expiresAt: z.string(),
    verificationUri: z.string().optional(),
    userCode: z.string().optional(),
    reason: z.string().optional(),
  })
  .strict();

import { fetchUsageRollup } from './client/analytics';
import { type ApiRequestScope, getJson, mutateJson } from './client/http';

export type {
  EngineAccount,
  EngineAccountLogin,
  EngineAccounts,
  EngineAccountUsage,
} from '@kontourai/station-contracts/engine-accounts';

function path(id: string, leaf: string, ref: string | null) {
  return `/api/connections/agent/${encodeURIComponent(id)}/${leaf}${ref === null ? '' : `?profileRef=${encodeURIComponent(ref)}`}`;
}
async function readData(
  scope: ApiRequestScope,
  route: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await getJson(`${scope.apiBase}${route}`, {
    requestScope: scope,
    signal,
  });
  const body: unknown = await response.json();
  if (
    !response.ok ||
    !body ||
    typeof body !== 'object' ||
    !('success' in body) ||
    body.success !== true ||
    !('data' in body)
  )
    throw new Error('This Station could not complete the account request.');
  return body.data;
}
function key(
  scope: ApiRequestScope,
  id: string,
  kind: string,
  ref: string | null,
) {
  return ['engine-accounts', scope.apiBase, scope.authorityKey, id, kind, ref];
}
const queryPolicy = {
  staleTime: 30000,
  gcTime: 0,
  retry: false,
  refetchOnWindowFocus: false,
} as const;
export function useEngineAccountsQuery(
  id: string,
  scope: ApiRequestScope,
  enabled: boolean,
) {
  return useQuery({
    queryKey: key(scope, id, 'accounts', null),
    queryFn: async ({ signal }) =>
      engineAccountsSchema.parse(
        await readData(scope, path(id, 'accounts', null), signal),
      ),
    enabled,
    ...queryPolicy,
  });
}
export function useEngineAccountUsageQuery(
  id: string,
  ref: string | null,
  scope: ApiRequestScope,
  enabled: boolean,
) {
  return useQuery({
    queryKey: key(scope, id, 'limits', ref),
    queryFn: async ({ signal }) =>
      engineAccountUsageSchema.parse(
        await readData(scope, path(id, 'account-usage', ref), signal),
      ),
    enabled,
    ...queryPolicy,
    refetchInterval: 60000,
  });
}
export function useEngineAccountLoginQuery(
  id: string,
  ref: string | null,
  scope: ApiRequestScope,
  enabled: boolean,
) {
  return useQuery({
    queryKey: key(scope, id, 'login', ref),
    queryFn: async ({ signal }) => {
      const data = await readData(
        scope,
        path(id, 'account-login', ref),
        signal,
      );
      if (!data || typeof data !== 'object' || !('login' in data))
        throw new Error('Sign-in status is unavailable.');
      return data.login === null
        ? null
        : engineAccountLoginSchema.parse(data.login);
    },
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: (query) =>
      query.state.data &&
      ['starting', 'awaiting-code', 'awaiting-approval', 'verifying'].includes(
        query.state.data.phase,
      )
        ? 2000
        : false,
  });
}
export function useEngineAccountLoginMutation(
  id: string,
  ref: string | null,
  scope: ApiRequestScope,
) {
  return useMutation({
    mutationFn: async (
      action:
        | { kind: 'start' }
        | { kind: 'code'; code: string }
        | { kind: 'cancel' },
    ) => {
      const response = await mutateJson(
        `${scope.apiBase}${path(id, 'account-login', ref)}`,
        action.kind === 'cancel' ? 'DELETE' : 'POST',
        { requestScope: scope },
        action.kind === 'code' ? { code: action.code } : {},
      );
      const body: unknown = await response.json();
      if (
        !response.ok ||
        !body ||
        typeof body !== 'object' ||
        !('success' in body) ||
        body.success !== true
      )
        throw new Error(
          body &&
            typeof body === 'object' &&
            'error' in body &&
            typeof body.error === 'string'
            ? body.error
            : 'Sign-in could not complete. Check its status before trying again.',
        );
      return response;
    },
    retry: false,
    gcTime: 0,
  });
}
export function useCreateEngineAccountMutation(
  id: string,
  scope: ApiRequestScope,
) {
  return useMutation({
    mutationFn: async (profile: { ref: string; label: string }) => {
      const result = await mutateJson(
        `${scope.apiBase}/api/connections/agent/${encodeURIComponent(id)}/credential-recovery/profiles`,
        'POST',
        { requestScope: scope },
        profile,
      );
      if (!result.ok) throw new Error('The account could not be added.');
      return profile;
    },
    retry: false,
  });
}
export function useEngineActivityQuery(
  engine: 'claude' | 'codex',
  days: 7 | 30,
  scope: ApiRequestScope,
  enabled: boolean,
  credentialProfileRef?: string | null,
) {
  return useQuery({
    queryKey: [
      'engine-activity',
      scope.apiBase,
      scope.authorityKey,
      engine,
      days,
      credentialProfileRef,
    ],
    queryFn: async ({ signal }) => {
      const response = await fetchUsageRollup(
        scope.apiBase,
        {
          days,
          provider: engine,
          credentialProfileRef,
          localOnly: true,
          groupBy: 'day',
          pageSize: 100,
        },
        { requestScope: scope, signal },
      );
      if (!response.success || !response.data)
        throw new Error('Engine activity could not be loaded.');
      return response.data;
    },
    enabled,
    ...queryPolicy,
  });
}
