import type {
  DeviceToolchainStatus,
  DeviceToolchainVersions,
  DeviceToolId,
} from '@kontourai/station-contracts/device-toolchain';
import { getJson, mutateJson } from '@kontourai/station-sdk';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/**
 * React Query bindings for the managed device toolchain (#1970).
 *
 * Keys are partitioned by the caller's `ApiRequestScope` (API base AND
 * authority), like the device inventory: one Station's toolchain must never
 * be served from another's cache.
 */

/** A refused or failed toolchain request, with the server's typed code. */
export class DeviceToolchainRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super('The device toolchain request did not succeed.');
    this.name = 'DeviceToolchainRequestError';
  }
}

async function data<T>(response: Response): Promise<T> {
  let body: { success?: unknown; data?: unknown; code?: unknown } | undefined;
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // A non-JSON answer is reported by status alone.
  }
  if (!response.ok || body?.success !== true || body.data === undefined)
    throw new DeviceToolchainRequestError(
      response.status,
      typeof body?.code === 'string' ? body.code : undefined,
    );
  return body.data as T;
}

const deviceToolchainStatusKey = (scope: ApiRequestScope) => [
  'device-toolchain-status',
  scope.apiBase,
  scope.authorityKey,
];

/** True while the server is doing something the status will change under. */
function statusIsMoving(status: DeviceToolchainStatus | undefined): boolean {
  if (!status) return false;
  return (
    status.hub.state === 'installing' ||
    status.agentDevice.state === 'installing' ||
    status.hubProcess.state === 'starting' ||
    status.hubProcess.state === 'restarting'
  );
}

export function useDeviceToolchainStatus(scope: ApiRequestScope) {
  return useQuery({
    queryKey: deviceToolchainStatusKey(scope),
    queryFn: async ({ signal }) =>
      data<DeviceToolchainStatus>(
        await getJson(`${scope.apiBase}/api/mobile-devices/toolchain`, {
          signal,
          requestScope: scope,
        }),
      ),
    // Poll only while an install or start is in flight; otherwise the
    // person asks with "Check again".
    refetchInterval: (query) =>
      statusIsMoving(query.state.data) ? 1_000 : false,
    retry: false,
    staleTime: 5_000,
  });
}

/** The read-only version check. Starts and installs nothing. */
export function useDeviceToolVersions(
  scope: ApiRequestScope,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['device-toolchain-versions', scope.apiBase, scope.authorityKey],
    queryFn: async ({ signal }) =>
      data<DeviceToolchainVersions>(
        await getJson(
          `${scope.apiBase}/api/mobile-devices/toolchain/versions`,
          { signal, requestScope: scope },
        ),
      ),
    enabled,
    retry: false,
    staleTime: 0,
  });
}

export type DeviceToolchainAction =
  | { kind: 'hub'; enabled: true; consent: true }
  | { kind: 'hub'; enabled: false }
  | { kind: 'agent-access'; enabled: true; consent: true }
  | { kind: 'agent-access'; enabled: false }
  | { kind: 'update'; tool: DeviceToolId }
  | { kind: 'start-hub' };

function actionRequest(action: DeviceToolchainAction): {
  path: string;
  body: Record<string, unknown>;
} {
  switch (action.kind) {
    case 'hub':
      return {
        path: 'toolchain/hub',
        body: action.enabled
          ? { enabled: true, consent: true }
          : { enabled: false },
      };
    case 'agent-access':
      return {
        path: 'toolchain/agent-access',
        body: action.enabled
          ? { enabled: true, consent: true }
          : { enabled: false },
      };
    case 'update':
      return { path: 'toolchain/update', body: { tool: action.tool } };
    case 'start-hub':
      return { path: 'toolchain/hub/start', body: {} };
  }
}

/** Every mutation answers with the fresh status, which replaces the cache. */
export function useDeviceToolchainAction(scope: ApiRequestScope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (action: DeviceToolchainAction) => {
      const { path, body } = actionRequest(action);
      return data<DeviceToolchainStatus>(
        await mutateJson(
          `${scope.apiBase}/api/mobile-devices/${path}`,
          'POST',
          { requestScope: scope },
          body,
        ),
      );
    },
    onSuccess: (status) => {
      queryClient.setQueryData(deviceToolchainStatusKey(scope), status);
      void queryClient.invalidateQueries({
        queryKey: deviceToolchainStatusKey(scope),
      });
    },
  });
}

/** One Project's shared devices (D12), as `GET /shares` reports them. */
export interface DeviceShareEntry {
  projectId: string;
  projectSlug: string;
  shares: Array<{
    /** The device host (#1973); absent from an older server means `local`. */
    hostId?: string;
    platform: 'ios' | 'android';
    deviceId: string;
    label: string;
  }>;
}

const deviceSharesKey = (scope: ApiRequestScope) => [
  'device-shares',
  scope.apiBase,
  scope.authorityKey,
];

export function useDeviceShares(scope: ApiRequestScope, enabled: boolean) {
  return useQuery({
    queryKey: deviceSharesKey(scope),
    queryFn: async ({ signal }) =>
      data<DeviceShareEntry[]>(
        await getJson(`${scope.apiBase}/api/mobile-devices/shares`, {
          signal,
          requestScope: scope,
        }),
      ),
    enabled,
    retry: false,
  });
}

export type DeviceShareAction =
  | {
      kind: 'share';
      /** The device host (#1973); `local` when absent. */
      hostId?: string;
      projectSlug: string;
      platform: 'ios' | 'android';
      deviceId: string;
      label: string;
    }
  | {
      kind: 'unshare';
      hostId?: string;
      projectSlug: string;
      platform: 'ios' | 'android';
      deviceId: string;
    };

/** Operator-only: the server refuses anyone else. */
export function useDeviceShareAction(scope: ApiRequestScope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (action: DeviceShareAction) => {
      const response =
        action.kind === 'share'
          ? await mutateJson(
              `${scope.apiBase}/api/mobile-devices/shares`,
              'POST',
              { requestScope: scope },
              {
                projectSlug: action.projectSlug,
                ...(action.hostId && action.hostId !== 'local'
                  ? { hostId: action.hostId }
                  : {}),
                platform: action.platform,
                deviceId: action.deviceId,
                label: action.label,
              },
            )
          : await mutateJson(
              `${scope.apiBase}/api/mobile-devices/shares/${encodeURIComponent(action.projectSlug)}/${action.platform}/${encodeURIComponent(action.deviceId)}${action.hostId && action.hostId !== 'local' ? `?hostId=${encodeURIComponent(action.hostId)}` : ''}`,
              'DELETE',
              { requestScope: scope },
            );
      return data<unknown>(response);
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: deviceSharesKey(scope) }),
  });
}

/**
 * The AVD running on each emulator serial (operator only). Running
 * emulators are listed by serial, but shares are keyed by AVD name.
 */
export function useRunningAvds(
  scope: ApiRequestScope,
  serials: string[],
  /** The device host running the emulators (#1973); `local` when absent. */
  hostId = 'local',
) {
  const sorted = [...new Set(serials)].sort();
  return useQuery({
    queryKey: [
      'device-running-avds',
      scope.apiBase,
      scope.authorityKey,
      sorted,
      hostId,
    ],
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams(
        sorted.map((serial) => ['serial', serial]),
      );
      if (hostId !== 'local') query.set('hostId', hostId);
      return data<Record<string, string | null>>(
        await getJson(
          `${scope.apiBase}/api/mobile-devices/shares/avds?${query.toString()}`,
          { signal, requestScope: scope },
        ),
      );
    },
    enabled: sorted.length > 0,
    retry: false,
  });
}
