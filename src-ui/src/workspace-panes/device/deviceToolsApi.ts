import {
  DEVICE_AX_CLIENT_MAX_BYTES,
  type DeviceAccessibilityTree,
  type DeviceControlHeldBy,
  type DevicePermissionsReadBack,
  type DeviceToolAction,
  type DeviceToolActionResult,
  type DeviceToolsFailure,
  type DeviceToolsSnapshot,
} from '@kontourai/station-contracts/device-tools';
import type { MobileDevicePlatform } from '@kontourai/station-contracts/mobile-device';
import { getJson, mutateJson } from '@kontourai/station-sdk';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/**
 * React Query bindings for the Device pane's Tools drawer (#1971).
 *
 * Keys are partitioned by the request scope (API base AND authority), the
 * Project the pane is in (device shares are per Project, D12) and the
 * device. Every value shown is what the SERVER read back from the device;
 * an action's answer replaces the cached snapshot, so the drawer never
 * shows a value the device did not confirm.
 */

export interface DeviceToolsTarget {
  /**
   * The device host (#1973). The tools run THIS Station's `xcrun`/`adb`, so
   * only `local` is served; an SSH device host's device is refused
   * (`unsupported`) by the server, and the drawer never asks.
   */
  hostId: string;
  platform: MobileDevicePlatform;
  deviceId: string;
}

/** Whether the Tools drawer can act on this device's host (#1973). */
export function deviceToolsSupported(target: DeviceToolsTarget): boolean {
  return target.hostId === 'local';
}

const KNOWN_FAILURES: readonly DeviceToolsFailure[] = [
  'invalid-request',
  'invalid-target',
  'access-denied',
  'principal-unresolved',
  'unavailable',
  'payload-too-large',
  'device-controlled-by-other',
  'unsupported',
  'tool-unavailable',
  'tool-failed',
  'tool-timeout',
  'hub-unavailable',
];

class DeviceToolsRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: DeviceToolsFailure | undefined,
    /** With `device-controlled-by-other`: who holds control. */
    readonly heldBy?: DeviceControlHeldBy,
  ) {
    super('The device tools request did not succeed.');
    this.name = 'DeviceToolsRequestError';
  }
}

async function data(response: Response): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      body = parsed as Record<string, unknown>;
  } catch {
    // A non-JSON answer is reported by status alone.
  }
  const code = KNOWN_FAILURES.find((known) => known === body?.code);
  const value = body?.data;
  const heldBy =
    body?.heldBy === 'same-person-elsewhere' || body?.heldBy === 'other'
      ? body.heldBy
      : undefined;
  if (
    !response.ok ||
    body?.success !== true ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  )
    throw new DeviceToolsRequestError(response.status, code, heldBy);
  return value as Record<string, unknown>;
}

const PROJECT_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function toolsPath(
  target: DeviceToolsTarget,
  leaf: string,
  query: Record<string, string> = {},
  projectSlug?: string | null,
): string {
  const params = new URLSearchParams(query);
  if (projectSlug && PROJECT_SLUG.test(projectSlug))
    params.set('projectSlug', projectSlug);
  const search = params.toString();
  return `/api/mobile-devices/hosts/${encodeURIComponent(target.hostId)}/devices/${target.platform}/${encodeURIComponent(target.deviceId)}/tools${leaf}${search ? `?${search}` : ''}`;
}

const READ_STATES = ['read', 'unreadable', 'last-set'];

function isReadBack(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    READ_STATES.includes(String((value as { state?: unknown }).state))
  );
}

function asSnapshot(
  value: Record<string, unknown>,
  target: DeviceToolsTarget,
): DeviceToolsSnapshot {
  if (
    value.hostId !== target.hostId ||
    value.platform !== target.platform ||
    value.deviceId !== target.deviceId ||
    !isReadBack(value.foregroundApp) ||
    !isReadBack(value.appearance) ||
    !isReadBack(value.location) ||
    !value.capabilities ||
    typeof value.capabilities !== 'object'
  )
    throw new DeviceToolsRequestError(200, undefined);
  return value as unknown as DeviceToolsSnapshot;
}

function finiteUnit(value: unknown): boolean {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

function asTree(value: Record<string, unknown>): DeviceAccessibilityTree {
  const space = value.space as
    | { width?: unknown; height?: unknown }
    | undefined;
  if (
    !space ||
    typeof space.width !== 'number' ||
    typeof space.height !== 'number' ||
    !(space.width > 0) ||
    !(space.height > 0) ||
    !Array.isArray(value.elements) ||
    value.elements.length > 500 ||
    !value.elements.every(
      (element: Record<string, unknown>) =>
        element &&
        typeof element.id === 'string' &&
        typeof element.label === 'string' &&
        typeof element.role === 'string' &&
        finiteUnit(element.x) &&
        finiteUnit(element.y) &&
        finiteUnit(element.width) &&
        finiteUnit(element.height),
    )
  )
    throw new DeviceToolsRequestError(200, undefined);
  return value as unknown as DeviceAccessibilityTree;
}

const deviceToolsKey = (
  scope: ApiRequestScope,
  target: DeviceToolsTarget,
  projectSlug?: string | null,
) => [
  'device-tools',
  scope.apiBase,
  scope.authorityKey,
  projectSlug ?? null,
  target.hostId,
  target.platform,
  target.deviceId,
];

/** The drawer's values, read back once on open and on Refresh. */
export function useDeviceToolsSnapshot(
  scope: ApiRequestScope,
  target: DeviceToolsTarget,
  projectSlug?: string | null,
) {
  return useQuery({
    queryKey: deviceToolsKey(scope, target, projectSlug),
    queryFn: async ({ signal }) =>
      asSnapshot(
        await data(
          await getJson(
            `${scope.apiBase}${toolsPath(target, '', {}, projectSlug)}`,
            { signal, requestScope: scope, maxResponseBytes: 64 * 1024 },
          ),
        ),
        target,
      ),
    retry: false,
    staleTime: 0,
  });
}

/** How often the overlay re-reads the tree while it is on and visible. */
const DEVICE_AX_POLL_MS = 2_000;

/**
 * The accessibility tree, polled every {@link DEVICE_AX_POLL_MS} ONLY while
 * `enabled` (the overlay is on AND the device is visibly streaming). With it
 * off no request is made.
 */
export function useDeviceAccessibilityTree(
  scope: ApiRequestScope,
  target: DeviceToolsTarget,
  projectSlug: string | null | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: [...deviceToolsKey(scope, target, projectSlug), 'accessibility'],
    queryFn: async ({ signal }) =>
      asTree(
        await data(
          await getJson(
            `${scope.apiBase}${toolsPath(target, '/accessibility', {}, projectSlug)}`,
            {
              signal,
              requestScope: scope,
              maxResponseBytes: DEVICE_AX_CLIENT_MAX_BYTES,
            },
          ),
        ),
      ),
    enabled,
    refetchInterval: enabled ? DEVICE_AX_POLL_MS : false,
    refetchIntervalInBackground: false,
    retry: false,
    // Keep the last good tree drawn between polls (and through one failure).
    placeholderData: (previous) => previous,
  });
}

/** One app's permissions, read back (only once an app id is chosen). */
export function useDevicePermissions(
  scope: ApiRequestScope,
  target: DeviceToolsTarget,
  projectSlug: string | null | undefined,
  appId: string | null,
) {
  return useQuery({
    queryKey: [
      ...deviceToolsKey(scope, target, projectSlug),
      'permissions',
      appId,
    ],
    queryFn: async ({ signal }) =>
      (await data(
        await getJson(
          `${scope.apiBase}${toolsPath(target, '/permissions', { appId: appId ?? '' }, projectSlug)}`,
          { signal, requestScope: scope, maxResponseBytes: 64 * 1024 },
        ),
      )) as unknown as DevicePermissionsReadBack,
    enabled: appId !== null && appId !== '',
    retry: false,
    staleTime: 0,
  });
}

/** Run one typed action; the device's read-back replaces the cache. */
export function useDeviceToolAction(
  scope: ApiRequestScope,
  target: DeviceToolsTarget,
  projectSlug?: string | null,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (action: DeviceToolAction) => {
      const value = await data(
        await mutateJson(
          `${scope.apiBase}${toolsPath(target, '/actions', {}, projectSlug)}`,
          'POST',
          { requestScope: scope, maxResponseBytes: 128 * 1024 },
          action,
        ),
      );
      const snapshot = asSnapshot(
        (value.snapshot ?? {}) as Record<string, unknown>,
        target,
      );
      return { ...(value as object), snapshot } as DeviceToolActionResult;
    },
    onSuccess: (result) => {
      queryClient.setQueryData(
        deviceToolsKey(scope, target, projectSlug),
        result.snapshot,
      );
      if (result.permissions)
        queryClient.setQueryData(
          [
            ...deviceToolsKey(scope, target, projectSlug),
            'permissions',
            result.permissions.appId,
          ],
          result.permissions,
        );
    },
  });
}

/** Plain-language copy for a refused or failed request. */
export function describeDeviceToolsFailure(error: unknown): string {
  const code =
    error instanceof DeviceToolsRequestError ? error.code : undefined;
  switch (code) {
    case 'device-controlled-by-other':
      return error instanceof DeviceToolsRequestError &&
        error.heldBy === 'same-person-elsewhere'
        ? 'Control is held on another device or browser. Release it there, or take control here, then try again.'
        : 'Someone else is controlling this device right now. Settings changes wait until they release control.';
    case 'principal-unresolved':
      return 'Device tools are for a person signed in to this Station, not an agent or a delegated device.';
    case 'access-denied':
      return 'You cannot change this device. Only the Station operator, or an admin of a Project it is shared with, can.';
    case 'payload-too-large':
      return 'That notification is larger than the 4 KB a push allows.';
    case 'unsupported':
      return 'This device cannot do that.';
    case 'tool-unavailable':
      return 'The device tools (Xcode’s simctl or Android’s adb) are not installed on the Station host.';
    case 'tool-timeout':
      return 'The device did not answer in time. Try again.';
    case 'hub-unavailable':
      return 'The device helper did not answer. Check that devices are set up, then try again.';
    case 'invalid-request':
    case 'invalid-target':
      return 'That value was not accepted. Check it and try again.';
    case 'unavailable':
      return 'Device tools are not available on this Station.';
    default:
      return 'The device could not do that. Try again.';
  }
}
