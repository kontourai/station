import type { EngineSignInView } from '@kontourai/station-contracts/engine-sign-in';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { type ApiRequestScope, getJson, mutateJson } from './client/http';
import { unlessDeadline } from './client/request-deadline';

export type {
  EngineSignInAttempt,
  EngineSignInMethod,
  EngineSignInStatus,
  EngineSignInView,
} from '@kontourai/station-contracts/engine-sign-in';

const termsNotice = z
  .object({ provider: z.string(), termsUrl: z.string().url() })
  .strict();
const kind = z.enum(['terminal', 'agent']);
const signInViewSchema = z
  .object({
    connectionId: z.string(),
    engineName: z.string(),
    status: z
      .object({
        state: z.enum(['authenticated', 'unauthenticated', 'unknown']),
        source: z.enum(['status-command', 'refusal', 'sign-in', 'none']),
        observedAt: z.string().optional(),
        checkable: z.boolean(),
      })
      .strict(),
    signInHint: z.string().optional(),
    methods: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string(),
            description: z.string().optional(),
            kind,
            termsNotice: termsNotice.optional(),
          })
          .strict(),
      )
      .optional(),
    methodsObservedAt: z.string().optional(),
    methodsError: z.string().optional(),
    credentials: z.array(
      z.object({ name: z.string(), configured: z.boolean() }).strict(),
    ),
    termsNotice: termsNotice.optional(),
    allowed: z.object({ signIn: z.boolean(), terminal: z.boolean() }).strict(),
  })
  .strict();
const attemptSchema = z
  .object({
    id: z.string(),
    methodId: z.string(),
    kind,
    state: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'timed-out']),
    startedAt: z.string(),
    terminal: z
      .object({ projectSlug: z.string(), terminalId: z.string() })
      .strict()
      .optional(),
    links: z.array(z.string().url()).optional(),
    message: z.string().optional(),
  })
  .strict();

function base(scope: ApiRequestScope, connectionId: string): string {
  return `${scope.apiBase}/acp/connections/${encodeURIComponent(connectionId)}`;
}

async function readBody(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch(unlessDeadline(() => null));
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
        : 'This Station could not complete the sign-in request.',
    );
  return 'data' in body ? body.data : null;
}

function viewKey(scope: ApiRequestScope, connectionId: string) {
  return [
    'engine-sign-in',
    scope.apiBase,
    scope.authorityKey,
    connectionId,
    'view',
  ];
}
function attemptKey(scope: ApiRequestScope, connectionId: string) {
  return [
    'engine-sign-in',
    scope.apiBase,
    scope.authorityKey,
    connectionId,
    'attempt',
  ];
}

export function useEngineSignInQuery(
  connectionId: string,
  scope: ApiRequestScope,
  enabled: boolean,
) {
  return useQuery({
    queryKey: viewKey(scope, connectionId),
    queryFn: async ({ signal }) =>
      signInViewSchema.parse(
        await readBody(
          await getJson(`${base(scope, connectionId)}/sign-in`, {
            requestScope: scope,
            signal,
          }),
        ),
      ) as EngineSignInView,
    enabled,
    staleTime: 15000,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/** Re-runs the status command and the sign-in handshake. */
export function useEngineSignInCheckMutation(
  connectionId: string,
  scope: ApiRequestScope,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      signInViewSchema.parse(
        await readBody(
          await mutateJson(
            `${base(scope, connectionId)}/sign-in/check`,
            'POST',
            { requestScope: scope },
            {},
          ),
        ),
      ) as EngineSignInView,
    onSuccess: (view) =>
      client.setQueryData(viewKey(scope, connectionId), view),
    retry: false,
  });
}

export function useEngineSignInAttemptQuery(
  connectionId: string,
  scope: ApiRequestScope,
  enabled: boolean,
) {
  return useQuery({
    queryKey: attemptKey(scope, connectionId),
    queryFn: async ({ signal }) => {
      const data = await readBody(
        await getJson(`${base(scope, connectionId)}/sign-in/attempt`, {
          requestScope: scope,
          signal,
        }),
      );
      return data === null ? null : attemptSchema.parse(data);
    },
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.state === 'running' ? 2000 : false,
  });
}

export function useEngineSignInMutation(
  connectionId: string,
  scope: ApiRequestScope,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      action: { kind: 'start'; methodId: string } | { kind: 'cancel' },
    ) => {
      const data = await readBody(
        await mutateJson(
          `${base(scope, connectionId)}/sign-in/${action.kind === 'start' ? 'start' : 'attempt'}`,
          action.kind === 'start' ? 'POST' : 'DELETE',
          { requestScope: scope },
          action.kind === 'start' ? { methodId: action.methodId } : undefined,
        ),
      );
      return data === null ? null : attemptSchema.parse(data);
    },
    onSuccess: (attempt) =>
      client.setQueryData(attemptKey(scope, connectionId), attempt),
    retry: false,
    gcTime: 0,
  });
}

/** Sets (value) or clears (null) one engine key. The value is never read back. */
export function useEngineCredentialMutation(
  connectionId: string,
  scope: ApiRequestScope,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; value: string | null }) =>
      signInViewSchema.parse(
        await readBody(
          await mutateJson(
            `${base(scope, connectionId)}/credentials/${encodeURIComponent(input.name)}`,
            input.value === null ? 'DELETE' : 'PUT',
            { requestScope: scope },
            input.value === null ? undefined : { value: input.value },
          ),
        ),
      ) as EngineSignInView,
    onSuccess: (view) =>
      client.setQueryData(viewKey(scope, connectionId), view),
    retry: false,
    gcTime: 0,
  });
}
