import type {
  EngineLoginProfile,
  EngineLoginProfiles,
} from '@kontourai/station-contracts/connection-recovery';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ApiRequestScope, getJson, mutateJson } from './client/http';
import type { DeviceCodeLogin } from './query-domains/workspaceConnections';

export type { DeviceCodeLogin, EngineLoginProfiles };

export interface DeviceCodeLoginTarget {
  connectionId: string;
  profileRef: string;
  requestScope: ApiRequestScope;
}

export class DeviceCodeLoginRefusal extends Error {
  constructor(
    message: string,
    readonly outcome: string | undefined,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DeviceCodeLoginRefusal';
  }
}

function loginKey(target: DeviceCodeLoginTarget) {
  return [
    'device-code-login',
    target.requestScope.apiBase,
    target.requestScope.authorityKey,
    target.connectionId,
    target.profileRef,
  ];
}

function loginUrl(target: DeviceCodeLoginTarget) {
  return `${target.requestScope.apiBase}/api/connections/agent/${encodeURIComponent(target.connectionId)}/enrolment/${encodeURIComponent(target.profileRef)}/device-code`;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseLogin(value: unknown): DeviceCodeLogin {
  if (
    !record(value) ||
    (value.engine !== 'codex' && value.engine !== 'claude') ||
    (value.phase !== 'starting' &&
      value.phase !== 'awaiting-approval' &&
      value.phase !== 'verifying' &&
      value.phase !== 'completed' &&
      value.phase !== 'failed' &&
      value.phase !== 'cancelled') ||
    typeof value.startedAt !== 'string' ||
    typeof value.expiresAt !== 'string'
  )
    throw new Error('This Station returned an incompatible sign-in response.');
  for (const key of ['verificationUri', 'userCode', 'detail', 'reason']) {
    if (value[key] !== undefined && typeof value[key] !== 'string')
      throw new Error(
        'This Station returned an incompatible sign-in response.',
      );
  }
  const { verificationUri, userCode, detail, reason } = value;
  if (typeof verificationUri === 'string') {
    const url = new URL(verificationUri);
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('This Station returned an unsafe sign-in link.');
  }
  return {
    engine: value.engine,
    phase: value.phase,
    startedAt: value.startedAt,
    expiresAt: value.expiresAt,
    ...(typeof verificationUri === 'string' ? { verificationUri } : {}),
    ...(typeof userCode === 'string' ? { userCode } : {}),
    ...(typeof detail === 'string' ? { detail } : {}),
    ...(typeof reason === 'string' ? { reason } : {}),
  };
}

async function readLogin(
  response: Response,
  absentAllowed = false,
): Promise<DeviceCodeLogin | null> {
  if (response.status === 404 && absentAllowed) return null;
  const body: unknown = await response.json();
  if (!record(body))
    throw new Error('This Station returned an incompatible sign-in response.');
  const data = record(body.data) ? body.data : undefined;
  if (!response.ok || body.success !== true) {
    throw new DeviceCodeLoginRefusal(
      typeof body.error === 'string'
        ? body.error
        : 'The sign-in request was refused.',
      typeof data?.outcome === 'string' ? data.outcome : undefined,
      response.status,
    );
  }
  return parseLogin(data?.login);
}

export function useDeviceCodeLoginQuery(
  target: DeviceCodeLoginTarget,
  enabled: boolean,
) {
  return useQuery({
    queryKey: loginKey(target),
    queryFn: async ({ signal }) =>
      readLogin(
        await getJson(loginUrl(target), {
          requestScope: target.requestScope,
          signal,
        }),
        true,
      ),
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      const phase = query.state.data?.phase;
      return phase === 'starting' ||
        phase === 'awaiting-approval' ||
        phase === 'verifying'
        ? 2000
        : false;
    },
  });
}

export function useStartDeviceCodeLoginMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (target: DeviceCodeLoginTarget) =>
      readLogin(
        await mutateJson(loginUrl(target), 'POST', {
          requestScope: target.requestScope,
        }),
      ),
    retry: false,
    onSuccess: (login, target) => client.setQueryData(loginKey(target), login),
    onSettled: (_login, _error, target) =>
      client.invalidateQueries({ queryKey: loginKey(target) }),
  });
}

export function useCancelDeviceCodeLoginMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (target: DeviceCodeLoginTarget) =>
      readLogin(
        await mutateJson(loginUrl(target), 'DELETE', {
          requestScope: target.requestScope,
        }),
      ),
    retry: false,
    onSuccess: (login, target) => client.setQueryData(loginKey(target), login),
    onSettled: (_login, _error, target) =>
      client.invalidateQueries({ queryKey: loginKey(target) }),
  });
}

export function useEngineLoginProfilesQuery(
  connectionId: string,
  requestScope: ApiRequestScope,
) {
  return useQuery({
    queryKey: [
      'engine-login-profiles',
      requestScope.apiBase,
      requestScope.authorityKey,
      connectionId,
    ],
    queryFn: async ({ signal }): Promise<EngineLoginProfiles> => {
      const response = await getJson(
        `${requestScope.apiBase}/api/connections/agent/${encodeURIComponent(connectionId)}/device-code-profiles`,
        { requestScope, signal },
      );
      const body: unknown = await response.json();
      if (
        !response.ok ||
        !record(body) ||
        body.success !== true ||
        !record(body.data) ||
        !Array.isArray(body.data.profiles)
      )
        throw new Error('Sign-in profiles could not be loaded.');
      const profiles = body.data.profiles.map((profile): EngineLoginProfile => {
        if (
          !record(profile) ||
          typeof profile.ref !== 'string' ||
          (profile.label !== undefined && typeof profile.label !== 'string') ||
          !Array.isArray(profile.mechanisms) ||
          profile.mechanisms.some((value) => value !== 'device-code')
        )
          throw new Error(
            'This Station returned incompatible sign-in profiles.',
          );
        const authState = profile.authState;
        if (
          authState !== 'authenticated' &&
          authState !== 'unauthenticated' &&
          authState !== 'unknown'
        )
          throw new Error(
            'This Station returned an incompatible sign-in state.',
          );
        return {
          ref: profile.ref,
          ...(typeof profile.label === 'string'
            ? { label: profile.label }
            : {}),
          authState,
          mechanisms: profile.mechanisms.map(() => 'device-code' as const),
        };
      });
      return { profiles };
    },
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });
}
