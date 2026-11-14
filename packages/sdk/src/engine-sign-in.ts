import type {
  HostAuthLoginRequest,
  HostAuthLoginStart,
} from '@kontourai/station-contracts/engine-credential-provider';
import type {
  EngineSignInView,
  ManagedInstallStateView,
} from '@kontourai/station-contracts/engine-sign-in';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { type ApiRequestScope, getJson, mutateJson } from './client/http';
import { unlessDeadline } from './client/request-deadline';

export type {
  EngineHostAuthStatus,
  HostAuthLoginRequest,
  HostAuthLoginStart,
} from '@kontourai/station-contracts/engine-credential-provider';
export type {
  EngineHostAuthView,
  EngineSignInAttempt,
  EngineSignInMethod,
  EngineSignInStatus,
  EngineSignInView,
  ManagedInstallStateView,
} from '@kontourai/station-contracts/engine-sign-in';

const termsNotice = z
  .object({ provider: z.string(), termsUrl: z.string().url() })
  .strict();
const kind = z.enum(['terminal', 'agent']);
const installStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('not-installed') }).strict(),
  z
    .object({
      kind: z.literal('installing'),
      startedAt: z.string(),
      receivedBytes: z.number().optional(),
      totalBytes: z.number().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('installed'), version: z.string() }).strict(),
  z
    .object({
      kind: z.literal('failed'),
      reason: z.enum([
        'manifest-digest-mismatch',
        'artifact-digest-mismatch',
        'artifact-size-mismatch',
        'unsafe-entry-name',
        'tree-verification-failed',
        'runtime-refused',
        'download-failed',
        'consent-required',
      ]),
      detail: z.string().optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal('unsupported-platform'), platform: z.string() })
    .strict(),
]);
const hostAuthSchema = z
  .object({
    status: z
      .object({
        owner: z.enum(['station', 'engine']),
        state: z.enum([
          'signed-in',
          'signed-out',
          'refresh-rejected',
          'unknown',
        ]),
        identity: z
          .object({
            kind: z.enum([
              'builder-id',
              'identity-center',
              'external-idp',
              'social',
            ]),
            provider: z.string().optional(),
            startUrl: z.string().optional(),
            region: z.string().optional(),
          })
          .strict()
          .optional(),
        accessExpiresAt: z.string().optional(),
        lastIssuedAt: z.string().optional(),
        issueCount24h: z.number().optional(),
      })
      .strict()
      .optional(),
    identities: z.array(z.enum(['builder-id', 'identity-center', 'social'])),
    socialSignIn: z.literal('needs-browser-on-host').optional(),
    policy: z.enum(['allowed', 'off']),
    install: z
      .object({
        installId: z.string(),
        version: z.string(),
        state: installStateSchema,
      })
      .strict()
      .optional(),
    allowed: z.object({ install: z.boolean() }).strict(),
  })
  .strict();
const hostAuthLoginSchema = z
  .object({
    kind: z.enum(['kiro.oidc-access-token', 'openai.chatgpt-auth-tokens']),
    phase: z.enum([
      'starting',
      'awaiting-approval',
      'verifying',
      'completed',
      'failed',
      'cancelled',
    ]),
    startedAt: z.string(),
    expiresAt: z.string(),
    verificationUri: z.string().url().optional(),
    userCode: z.string().optional(),
    authorizationUrl: z.string().url().optional(),
    reason: z.string().optional(),
    failure: z.enum(['refused', 'expired', 'unavailable']).optional(),
  })
  .strict();
const signInViewSchema = z
  .object({
    connectionId: z.string(),
    engineName: z.string(),
    status: z
      .object({
        state: z.enum(['authenticated', 'unauthenticated', 'unknown']),
        source: z.enum([
          'status-command',
          'refusal',
          'sign-in',
          'station-vault',
          'none',
        ]),
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
    hostAuth: hostAuthSchema.optional(),
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
      .object({
        projectSlug: z.string(),
        terminalId: z.string(),
        // Hosts with the terminal socket name the scope to attach under.
        projectId: z.string().optional(),
        bindingKey: z.string().optional(),
      })
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
    // A managed install reports its progress through the view.
    refetchInterval: (query) =>
      query.state.data?.hostAuth?.install?.state.kind === 'installing'
        ? 1500
        : false,
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

function hostAuthLoginKey(scope: ApiRequestScope, connectionId: string) {
  return [
    'engine-sign-in',
    scope.apiBase,
    scope.authorityKey,
    connectionId,
    'host-auth-login',
  ];
}

const HOST_AUTH_LOGIN_RUNNING = new Set([
  'starting',
  'awaiting-approval',
  'verifying',
]);

/** A Station-run sign-in for an engine Station signs in itself. Carries the device code. */
export function useEngineHostAuthLoginQuery(
  connectionId: string,
  scope: ApiRequestScope,
  enabled: boolean,
) {
  return useQuery({
    queryKey: hostAuthLoginKey(scope, connectionId),
    queryFn: async ({ signal }) => {
      const data = await readBody(
        await getJson(`${base(scope, connectionId)}/host-auth/login`, {
          requestScope: scope,
          signal,
        }),
      );
      return data === null
        ? null
        : (hostAuthLoginSchema.parse(data) as HostAuthLoginStart);
    },
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: (query) =>
      query.state.data && HOST_AUTH_LOGIN_RUNNING.has(query.state.data.phase)
        ? 2000
        : false,
  });
}

export function useEngineHostAuthLoginMutation(
  connectionId: string,
  scope: ApiRequestScope,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      action:
        | { kind: 'start'; request: HostAuthLoginRequest }
        | { kind: 'cancel' },
    ) => {
      const data = await readBody(
        await mutateJson(
          `${base(scope, connectionId)}/host-auth/login`,
          action.kind === 'start' ? 'POST' : 'DELETE',
          { requestScope: scope },
          action.kind === 'start' ? action.request : undefined,
        ),
      );
      return data === null
        ? null
        : (hostAuthLoginSchema.parse(data) as HostAuthLoginStart);
    },
    onSuccess: (login) =>
      client.setQueryData(hostAuthLoginKey(scope, connectionId), login),
    retry: false,
    gcTime: 0,
  });
}

/** Removes Station's own sign-in for this engine. */
export function useEngineHostAuthSignOutMutation(
  connectionId: string,
  scope: ApiRequestScope,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      signInViewSchema.parse(
        await readBody(
          await mutateJson(
            `${base(scope, connectionId)}/host-auth/sign-out`,
            'POST',
            { requestScope: scope },
            {},
          ),
        ),
      ) as EngineSignInView,
    onSuccess: (view) =>
      client.setQueryData(viewKey(scope, connectionId), view),
    retry: false,
    gcTime: 0,
  });
}

/** Installs a managed engine. `consent` is the literal `true` a person gave. */
export function useManagedEngineInstallMutation(
  connectionId: string,
  scope: ApiRequestScope,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { consent: true }) =>
      installStateSchema.parse(
        await readBody(
          await mutateJson(
            `${base(scope, connectionId)}/managed-install`,
            'POST',
            { requestScope: scope },
            { consent: input.consent },
          ),
        ),
      ) as ManagedInstallStateView,
    onSuccess: () =>
      void client.invalidateQueries({
        queryKey: viewKey(scope, connectionId),
      }),
    retry: false,
    gcTime: 0,
  });
}
