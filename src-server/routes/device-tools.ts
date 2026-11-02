import {
  DEVICE_PERMISSIONS,
  type DeviceToolAction,
  type DeviceToolsFailure,
} from '@kontourai/station-contracts/device-tools';
import {
  isMobileDeviceHostId,
  LOCAL_MOBILE_DEVICE_HOST_ID as LOCAL_DEVICE_HOST_ID,
  type MobileDevicePlatform,
} from '@kontourai/station-contracts/mobile-device';
import { type Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { readBoundedRequestBody } from '../security/bounded-request-body.js';
import type { DeviceAccess } from '../services/devices/device-access.js';
import {
  DeviceArtifactError,
  type DeviceArtifactStaging,
} from '../services/devices/device-app-artifacts.js';
import type {
  DeviceHistoryAction,
  DeviceHistoryEntry,
  DeviceInstallation,
} from '../services/devices/device-session-service.js';
import { DeviceHostBusyError } from '../services/devices/device-shares.js';
import {
  type DeviceControlConflict,
  DeviceToolsAdmissionError,
  DeviceToolsError,
  type DeviceToolsService,
  isDeviceAppId,
  isDeviceToolsTarget,
  parseDeviceAppAction,
} from '../services/devices/device-tools.js';
import type {
  DeviceInstallFile,
  DeviceInstallOutcome,
} from '../services/devices/hosts/device-app-install.js';

/**
 * The Device pane's Tools drawer (#1971, D10), under `/api/mobile-devices`:
 *
 * - `GET  /hosts/:hostId/devices/:platform/:deviceId/tools` — the values the
 *   drawer shows, read back from the device (foreground app, appearance,
 *   location) and what this platform supports.
 * - `GET  …/tools/permissions?appId=` — one app's permissions, read back.
 * - `GET  …/tools/accessibility` — the accessibility tree for the overlay.
 * - `POST …/tools/actions` — one typed action (`DeviceToolAction`), then
 *   the device read back.
 *
 * Authorization, per request and per DEVICE (D12), before the host is
 * touched: reads need `view` access and actions need `drive` (the operator,
 * or an admin of a Project the operator shared the device with; a future
 * view-only role reads but never changes anything). An action is also
 * refused (`device-controlled-by-other`) while ANOTHER controller — a
 * person or an agent — holds the device's live-surface lease: settings are
 * a separate control plane from taps, but not a way around someone who is
 * actively driving. The pairing scope for every leaf is the terminal
 * authority (`pairing-route-scopes.ts`): the tree and the foreground app
 * disclose what is on the screen, like a frame.
 *
 * Device hosts (#1973, #2442): the path names the host like every device
 * route, and each host has its OWN service — `local` runs this machine's
 * `xcrun`/`adb` and reads the local hub; an SSH device host runs the same
 * allowlisted vectors ON THAT HOST (its device-host program's `tool` mode)
 * and reads that host's forwarded hub. The access check (D12, keyed by
 * host, platform and device) and the lease check are the same code for
 * every host. A host this Station does not have is `unknown-host` (404),
 * after the access check, like the device routes. A busy SSH device host is
 * `device-host-busy` (503), never a refusal. Without `toolsFor` wired, a
 * non-local host stays refused `unsupported` (422) before any access check.
 */

export interface DeviceToolsRouteOptions {
  isRequestPrincipalCurrent: (request: Request) => boolean;
  actionHistory?: {
    read(target: {
      hostId: string;
      platform: MobileDevicePlatform;
      deviceId: string;
    }): { sessionId: string; entries: DeviceHistoryEntry[] } | undefined;
    installed?(target: {
      hostId: string;
      platform: MobileDevicePlatform;
      deviceId: string;
    }): DeviceInstallation | undefined;
    installation(
      target: {
        hostId: string;
        platform: MobileDevicePlatform;
        deviceId: string;
      },
      value: DeviceInstallation,
    ): void;
    note(
      target: {
        hostId: string;
        platform: MobileDevicePlatform;
        deviceId: string;
      },
      action: DeviceHistoryAction,
      outcome: DeviceHistoryEntry['outcome'],
    ): void;
  };
  appInstall?: {
    staging: DeviceArtifactStaging;
    projectId(slug: string): string | undefined;
    authorize(request: Request, projectId: string): Promise<boolean>;
    run(input: {
      hostId: string;
      platform: 'ios' | 'android';
      deviceId: string;
      digest: string;
      files: DeviceInstallFile[];
      beforeInstall: () => Promise<boolean>;
      signal: AbortSignal;
    }): Promise<DeviceInstallOutcome>;
  };
  deviceLoopEnabled?: () => boolean;
  access?: DeviceAccess;
  /** The local device host's service. */
  tools?: DeviceToolsService;
  /**
   * An SSH device host's own service (#2442), or undefined for a host this
   * Station does not have. Absent → such hosts are refused `unsupported`.
   */
  toolsFor?: (hostId: string) => DeviceToolsService | undefined;
  /**
   * The HUMAN caller and the client it acts from — the SAME resolver the
   * live-surface routes use, so "you hold control" means the same thing in
   * both. Null (the station-control token, a delegation device, anything
   * unattributable) is refused as `principal-unresolved` on every route,
   * reads included, like the live-surface view rule: the drawer is a
   * person's tool, and an agent drives a device through the lease or not at
   * all. Absent → every route answers `unavailable`.
   */
  resolveHumanCaller?: (c: Context) => HumanCaller | null;
  /**
   * Who, relative to this caller, holds the device's live-surface lease
   * (`deviceControlConflict`). Absent → every action is refused as
   * `unavailable`: without it the route cannot tell whether someone is
   * driving.
   */
  controlConflict?: (
    caller: HumanCaller,
    platform: MobileDevicePlatform,
    deviceId: string,
    /** The device host (#1973): its own sessions and surfaces. */
    hostId: string,
  ) => DeviceControlConflict;
}

export interface HumanCaller {
  principal: string;
  device: string;
}

/** The whole action body, push payload included, is bounded. */
export const DEVICE_TOOLS_ACTION_MAX_BODY_BYTES = 8 * 1024;

const FAILURE_STATUS: Partial<
  Record<DeviceToolsFailure, ContentfulStatusCode>
> = {
  'invalid-request': 400,
  'invalid-target': 400,
  'access-denied': 403,
  'principal-unresolved': 403,
  'unknown-host': 404,
  'device-controlled-by-other': 409,
  'device-host-not-enabled': 409,
  'payload-too-large': 413,
  unsupported: 422,
  'tool-failed': 502,
  'app-not-running': 409,
  'postcondition-failed': 409,
  'tool-timeout': 504,
};

function failure(c: Context, code: DeviceToolsFailure) {
  // Everything else (unavailable, tool-unavailable, hub-unavailable, the
  // device host busy or unreachable) is 503.
  const status = FAILURE_STATUS[code] ?? 503;
  return c.json({ success: false, code }, status);
}

function targetOf(
  c: Context,
): { hostId: string; platform: MobileDevicePlatform; deviceId: string } | null {
  const hostId = c.req.param('hostId') ?? '';
  const platform = c.req.param('platform');
  const deviceId = c.req.param('deviceId') ?? '';
  if (!isMobileDeviceHostId(hostId)) return null;
  if (platform !== 'ios' && platform !== 'android') return null;
  return isDeviceToolsTarget(platform, deviceId)
    ? { hostId, platform, deviceId }
    : null;
}

/** Only `allowed` query keys, each at most once. */
function queryIsClean(c: Context, allowed: readonly string[]): boolean {
  const queries = c.req.queries();
  return Object.entries(queries).every(
    ([key, values]) => allowed.includes(key) && values.length === 1,
  );
}

const PERMISSIONS: readonly string[] = DEVICE_PERMISSIONS;
const DECISIONS = ['grant', 'revoke', 'reset'];

function exactKeys(record: Record<string, unknown>, keys: readonly string[]) {
  const present = Object.keys(record);
  return (
    present.length === keys.length && present.every((k) => keys.includes(k))
  );
}

function finiteIn(value: unknown, limit: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= limit
  );
}

/**
 * The route seam: exactly one well-formed `DeviceToolAction`, no extra
 * keys. The push payload's own bound and shape are checked again where it
 * is encoded (`encodeDevicePushPayload`).
 */
function parseDeviceToolAction(value: unknown): DeviceToolAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case 'set-appearance':
      return exactKeys(record, ['type', 'appearance']) &&
        (record.appearance === 'light' || record.appearance === 'dark')
        ? { type: 'set-appearance', appearance: record.appearance }
        : null;
    case 'set-location':
      return exactKeys(record, ['type', 'latitude', 'longitude']) &&
        finiteIn(record.latitude, 90) &&
        finiteIn(record.longitude, 180)
        ? {
            type: 'set-location',
            latitude: record.latitude,
            longitude: record.longitude,
          }
        : null;
    case 'clear-location':
      return exactKeys(record, ['type']) ? { type: 'clear-location' } : null;
    case 'set-permission':
      return exactKeys(record, ['type', 'appId', 'permission', 'decision']) &&
        isDeviceAppId(record.appId) &&
        typeof record.permission === 'string' &&
        PERMISSIONS.includes(record.permission) &&
        typeof record.decision === 'string' &&
        DECISIONS.includes(record.decision)
        ? {
            type: 'set-permission',
            appId: record.appId,
            permission:
              record.permission as (typeof DEVICE_PERMISSIONS)[number],
            decision: record.decision as 'grant' | 'revoke' | 'reset',
          }
        : null;
    case 'send-push': {
      const payload = record.payload;
      return exactKeys(record, ['type', 'appId', 'payload']) &&
        isDeviceAppId(record.appId) &&
        payload !== null &&
        typeof payload === 'object' &&
        !Array.isArray(payload)
        ? {
            type: 'send-push',
            appId: record.appId,
            payload: payload as Record<string, unknown>,
          }
        : null;
    }
    default:
      return null;
  }
}

export function createDeviceToolsRoutes(options: DeviceToolsRouteOptions) {
  const app = new Hono();
  const { access, tools } = options;

  const stillCurrent = (c: Context) =>
    options.isRequestPrincipalCurrent(c.req.raw);

  const publish = (c: Context, data: unknown) =>
    stillCurrent(c)
      ? c.json({ success: true, data })
      : failure(c, 'access-denied');

  const conflictResponse = (c: Context, heldBy: DeviceControlConflict) =>
    c.json({ success: false, code: 'device-controlled-by-other', heldBy }, 409);

  const run = async (c: Context, work: () => Promise<Response>) => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof DeviceToolsError) return failure(c, error.code);
      // Re-admission after a wait for the host refused (#2442 review M2):
      // answered exactly as the first admission would have been.
      if (error instanceof DeviceToolsAdmissionError)
        return error.refusal.code === 'access-denied'
          ? failure(c, 'access-denied')
          : conflictResponse(c, error.refusal.heldBy);
      // Transient (#1973 D2, #2442): 503, never a refusal.
      if (error instanceof DeviceHostBusyError)
        return failure(c, 'device-host-busy');
      throw error;
    }
  };

  /** Validated target + per-device access, before the host is touched. */
  const admit = async (
    c: Context,
    purpose: 'view' | 'drive',
  ): Promise<
    | {
        ok: true;
        target: {
          hostId: string;
          platform: MobileDevicePlatform;
          deviceId: string;
        };
        caller: HumanCaller;
        service: DeviceToolsService;
      }
    | { ok: false; response: Response }
  > => {
    c.header('Cache-Control', 'no-store');
    if (!stillCurrent(c))
      return { ok: false, response: failure(c, 'access-denied') };
    if (!tools || !access || !options.resolveHumanCaller)
      return { ok: false, response: failure(c, 'unavailable') };
    const target = targetOf(c);
    if (!target) return { ok: false, response: failure(c, 'invalid-target') };
    // Before any access check or host call: only a person uses the drawer.
    const caller = options.resolveHumanCaller(c);
    if (!caller)
      return { ok: false, response: failure(c, 'principal-unresolved') };
    const local = target.hostId === LOCAL_DEVICE_HOST_ID;
    // Without SSH device host services wired, a device on another host is
    // refused, typed, before any access check (which could itself reach
    // that host): a tool aimed at a remote device must never run against a
    // local device that shares its id.
    if (!local && !options.toolsFor)
      return { ok: false, response: failure(c, 'unsupported') };
    // D12, per request and per device ON ITS HOST. For an Android emulator
    // on an SSH device host this resolves the AVD there, which may find the
    // host busy: that propagates as 503, never as a refusal.
    let allowed: boolean;
    try {
      allowed = await access.mayAccessDevice(
        c.req.raw,
        target.platform,
        target.deviceId,
        purpose,
        target.hostId,
      );
    } catch (error) {
      if (error instanceof DeviceHostBusyError)
        return { ok: false, response: failure(c, 'device-host-busy') };
      throw error;
    }
    if (!allowed) return { ok: false, response: failure(c, 'access-denied') };
    if (!stillCurrent(c))
      return { ok: false, response: failure(c, 'access-denied') };
    // Each host has its own service: its own runner and its own hub.
    const service = local ? tools : options.toolsFor?.(target.hostId);
    if (!service) return { ok: false, response: failure(c, 'unknown-host') };
    return { ok: true, target, caller, service };
  };

  app.get('/hosts/:hostId/devices/:platform/:deviceId/tools', async (c) => {
    if (!queryIsClean(c, ['projectSlug'])) return failure(c, 'invalid-request');
    const admitted = await admit(c, 'view');
    if (!admitted.ok) return admitted.response;
    return run(c, async () =>
      publish(c, await admitted.service.snapshot(admitted.target)),
    );
  });

  app.get(
    '/hosts/:hostId/devices/:platform/:deviceId/tools/permissions',
    async (c) => {
      if (!queryIsClean(c, ['projectSlug', 'appId']))
        return failure(c, 'invalid-request');
      const appId = c.req.query('appId');
      if (!isDeviceAppId(appId)) return failure(c, 'invalid-request');
      const admitted = await admit(c, 'view');
      if (!admitted.ok) return admitted.response;
      return run(c, async () =>
        publish(c, await admitted.service.permissions(admitted.target, appId)),
      );
    },
  );

  app.get(
    '/hosts/:hostId/devices/:platform/:deviceId/tools/logs',
    async (c) => {
      if (!options.deviceLoopEnabled?.())
        return c.json(
          {
            success: false,
            code: 'feature_preview_disabled',
            previewId: 'device-developer-loop',
            settingsPath:
              '/settings?view=feature-previews&highlight=feature-previews',
          },
          404,
        );
      if (!queryIsClean(c, ['projectSlug', 'appId']))
        return failure(c, 'invalid-request');
      const appId = c.req.query('appId');
      if (!isDeviceAppId(appId)) return failure(c, 'invalid-request');
      const admitted = await admit(c, 'view');
      if (!admitted.ok) return admitted.response;
      const recheck = async () => {
        if (
          !options.deviceLoopEnabled?.() ||
          !stillCurrent(c) ||
          !(await access!.mayAccessDevice(
            c.req.raw,
            admitted.target.platform,
            admitted.target.deviceId,
            'view',
            admitted.target.hostId,
          )) ||
          (admitted.target.hostId === LOCAL_DEVICE_HOST_ID
            ? tools
            : options.toolsFor?.(admitted.target.hostId)) !==
            admitted.service ||
          !stillCurrent(c) ||
          !options.deviceLoopEnabled?.()
        )
          throw new DeviceToolsAdmissionError({ code: 'access-denied' });
      };
      return run(c, async () => {
        const logs = await admitted.service.logs(
          admitted.target,
          appId,
          recheck,
          c.req.raw.signal,
        );
        await recheck();
        return publish(c, logs);
      });
    },
  );

  app.get(
    '/hosts/:hostId/devices/:platform/:deviceId/tools/accessibility',
    async (c) => {
      if (!queryIsClean(c, ['projectSlug']))
        return failure(c, 'invalid-request');
      const admitted = await admit(c, 'view');
      if (!admitted.ok) return admitted.response;
      return run(c, async () =>
        publish(c, await admitted.service.accessibility(admitted.target)),
      );
    },
  );

  app.get(
    '/hosts/:hostId/devices/:platform/:deviceId/tools/history',
    async (c) => {
      if (!options.deviceLoopEnabled?.())
        return c.json(
          { success: false, code: 'feature_preview_disabled' },
          404,
        );
      if (!queryIsClean(c, ['projectSlug']))
        return failure(c, 'invalid-request');
      const admitted = await admit(c, 'view');
      if (!admitted.ok) return admitted.response;
      const history = options.actionHistory?.read(admitted.target);
      if (!history) return failure(c, 'unavailable');
      if (!stillCurrent(c) || !options.deviceLoopEnabled?.())
        return failure(c, 'access-denied');
      return publish(c, history);
    },
  );

  app.post(
    '/hosts/:hostId/devices/:platform/:deviceId/tools/install',
    async (c) => {
      if (!options.deviceLoopEnabled?.())
        return c.json(
          { success: false, code: 'feature_preview_disabled' },
          404,
        );
      const config = options.appInstall;
      const slug = c.req.query('projectSlug');
      if (!config || !options.controlConflict) return failure(c, 'unavailable');
      if (
        !queryIsClean(c, ['projectSlug']) ||
        !slug ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(slug)
      )
        return failure(c, 'invalid-request');
      const projectId = config.projectId(slug);
      if (!projectId) return failure(c, 'access-denied');
      const body = await readBoundedRequestBody(c.req.raw, 4096);
      let value: unknown;
      try {
        value = body.status === 'ok' ? JSON.parse(body.body) : null;
      } catch {
        value = null;
      }
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length !== 1 ||
        typeof (value as { artifactHandle?: unknown }).artifactHandle !==
          'string' ||
        !/^[0-9a-f-]{36}$/.test(
          (value as { artifactHandle: string }).artifactHandle,
        )
      )
        return failure(c, 'invalid-request');
      const handle = (value as { artifactHandle: string }).artifactHandle;
      const admitted = await admit(c, 'drive');
      if (!admitted.ok) return admitted.response;
      const { target, caller, service } = admitted;
      const current = async () => {
        if (
          !options.deviceLoopEnabled?.() ||
          !stillCurrent(c) ||
          c.req.raw.signal.aborted ||
          config.projectId(slug) !== projectId ||
          !(await config.authorize(c.req.raw, projectId))
        )
          return false;
        const fresh = await admit(c, 'drive');
        return (
          fresh.ok &&
          fresh.service === service &&
          fresh.caller.principal === caller.principal &&
          fresh.caller.device === caller.device &&
          options.controlConflict!(
            caller,
            target.platform,
            target.deviceId,
            target.hostId,
          ) === 'none' &&
          config.projectId(slug) === projectId &&
          options.deviceLoopEnabled?.() === true &&
          stillCurrent(c)
        );
      };
      let started = false;
      let outcome: DeviceInstallOutcome | undefined;
      try {
        const result = await config.staging.withArtifact(
          projectId,
          handle,
          current,
          async (receipt, payload, artifactCurrent, signal) => {
            if (receipt.platform !== target.platform)
              return {
                ok: false as const,
                code: 'incompatible-artifact',
                effect: 'none' as const,
              };
            const files =
              payload.platform === 'ios'
                ? payload.files
                : [
                    {
                      path: 'Application.apk',
                      executable: false,
                      bytes: payload.apk,
                    },
                  ];
            started = true;
            outcome = await config.run({
              ...target,
              digest: receipt.digest,
              files,
              signal,
              beforeInstall: async () =>
                (await current()) &&
                (await artifactCurrent()) &&
                (await current()),
            });
            if (!(await current()))
              return {
                ok: false as const,
                code: 'interrupted',
                effect:
                  outcome.ok || outcome.effect === 'unknown'
                    ? ('unknown' as const)
                    : ('none' as const),
              };
            if (outcome.ok)
              options.actionHistory?.installation(target, {
                ...outcome,
                source: receipt.source,
              });
            return outcome.ok
              ? {
                  ...outcome,
                  source: receipt.source,
                  hostId: target.hostId,
                  deviceId: target.deviceId,
                }
              : outcome;
          },
          c.req.raw.signal,
        );
        options.actionHistory?.note(
          target,
          'install-app',
          result.ok
            ? 'success'
            : result.effect === 'unknown'
              ? 'unknown'
              : 'failed',
        );
        return result.ok
          ? publish(c, result)
          : c.json({ success: false, ...result }, 409);
      } catch (error) {
        options.actionHistory?.note(
          target,
          'install-app',
          started ? 'unknown' : 'failed',
        );
        return c.json(
          {
            success: false,
            code:
              !started && error instanceof DeviceArtifactError
                ? error.code
                : 'interrupted',
            effect:
              started &&
              (!outcome || outcome.ok || outcome.effect === 'unknown')
                ? 'unknown'
                : 'none',
          },
          409,
        );
      }
    },
  );

  app.post(
    '/hosts/:hostId/devices/:platform/:deviceId/tools/app-actions',
    async (c) => {
      if (!options.deviceLoopEnabled?.())
        return c.json(
          {
            success: false,
            code: 'feature_preview_disabled',
            previewId: 'device-developer-loop',
          },
          404,
        );
      if (!queryIsClean(c, ['projectSlug']))
        return failure(c, 'invalid-request');
      const body = await readBoundedRequestBody(c.req.raw, 4096);
      let value: unknown;
      try {
        value = body.status === 'ok' ? JSON.parse(body.body) : null;
      } catch {
        value = null;
      }
      const action = parseDeviceAppAction(value);
      if (!action) return failure(c, 'invalid-request');
      const admitted = await admit(c, 'drive');
      if (!admitted.ok) return admitted.response;
      const { target, caller, service } = admitted;
      if (!options.controlConflict) return failure(c, 'unavailable');
      const readmit = async () => {
        if (
          !options.deviceLoopEnabled?.() ||
          !stillCurrent(c) ||
          !(await access!.mayAccessDevice(
            c.req.raw,
            target.platform,
            target.deviceId,
            'drive',
            target.hostId,
          )) ||
          (target.hostId === LOCAL_DEVICE_HOST_ID
            ? tools
            : options.toolsFor?.(target.hostId)) !== service ||
          !stillCurrent(c) ||
          !options.deviceLoopEnabled?.()
        )
          throw new DeviceToolsAdmissionError({ code: 'access-denied' });
        const heldBy = options.controlConflict!(
          caller,
          target.platform,
          target.deviceId,
          target.hostId,
        );
        if (heldBy !== 'none')
          throw new DeviceToolsAdmissionError({
            code: 'device-controlled-by-other',
            heldBy,
          });
      };
      return run(c, async () => {
        try {
          await readmit();
          const result = await service.appAction(target, action, {
            beforeRun: readmit,
            declaredSchemes: (() => {
              const receipt = options.actionHistory?.installed?.(target);
              return receipt?.metadata.appId === action.appId
                ? receipt.metadata.urlSchemes
                : undefined;
            })(),
            signal: c.req.raw.signal,
          });
          await readmit();
          options.actionHistory?.note(target, action.type, 'success');
          return publish(c, result);
        } catch (error) {
          options.actionHistory?.note(
            target,
            action.type,
            error instanceof DeviceToolsAdmissionError ||
              error instanceof DeviceHostBusyError ||
              (error instanceof DeviceToolsError &&
                error.code === 'invalid-request')
              ? 'failed'
              : 'unknown',
          );
          throw error;
        }
      });
    },
  );

  app.post(
    '/hosts/:hostId/devices/:platform/:deviceId/tools/actions',
    async (c) => {
      if (!queryIsClean(c, ['projectSlug']))
        return failure(c, 'invalid-request');
      if (!targetOf(c)) return failure(c, 'invalid-target');
      const body = await readBoundedRequestBody(
        c.req.raw,
        DEVICE_TOOLS_ACTION_MAX_BODY_BYTES,
      );
      if (body.status === 'too-large') return failure(c, 'payload-too-large');
      if (body.status !== 'ok') return failure(c, 'invalid-request');
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.body);
      } catch {
        return failure(c, 'invalid-request');
      }
      const action = parseDeviceToolAction(parsed);
      if (!action) return failure(c, 'invalid-request');
      const admitted = await admit(c, 'drive');
      if (!admitted.ok) return admitted.response;
      const { platform, deviceId } = admitted.target;
      if (!options.controlConflict) return failure(c, 'unavailable');
      // Once, before the first command: an action is one decision and runs
      // to the end (see DeviceToolsService.act on why it is atomic).
      const conflict = options.controlConflict(
        admitted.caller,
        platform,
        deviceId,
        admitted.target.hostId,
      );
      if (conflict !== 'none') return conflictResponse(c, conflict);
      const controlConflict = options.controlConflict;
      // An SSH device host may make the action wait for a slot (up to
      // ~20 s). Once it can run, and before its first command, the same
      // two decisions are made again for the same caller and device: D12
      // drive access, then the lease (#2442 review M2). Once per action —
      // a permission group is still one decision.
      const readmit = async () => {
        if (!stillCurrent(c))
          throw new DeviceToolsAdmissionError({ code: 'access-denied' });
        const allowed = await access!.mayAccessDevice(
          c.req.raw,
          platform,
          deviceId,
          'drive',
          admitted.target.hostId,
        );
        if (!allowed)
          throw new DeviceToolsAdmissionError({ code: 'access-denied' });
        const now = controlConflict(
          admitted.caller,
          platform,
          deviceId,
          admitted.target.hostId,
        );
        if (now !== 'none')
          throw new DeviceToolsAdmissionError({
            code: 'device-controlled-by-other',
            heldBy: now,
          });
      };
      return run(c, async () => {
        try {
          const result = await admitted.service.act(admitted.target, action, {
            beforeRun: readmit,
          });
          options.actionHistory?.note(
            admitted.target,
            'tool-action',
            'success',
          );
          return publish(c, result);
        } catch (error) {
          options.actionHistory?.note(
            admitted.target,
            'tool-action',
            error instanceof DeviceToolsAdmissionError ||
              error instanceof DeviceHostBusyError ||
              (error instanceof DeviceToolsError &&
                error.code === 'invalid-request')
              ? 'failed'
              : 'unknown',
          );
          throw error;
        }
      });
    },
  );

  return app;
}
