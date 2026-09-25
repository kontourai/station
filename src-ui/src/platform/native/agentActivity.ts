/**
 * Agent activity on this phone: registering the Android or iOS app with the
 * active Station so it pushes Live Update cards (Android) or Live Activities
 * (iOS) (docs/design/notification-delivery.md, "Station contract" and "iOS:
 * Live Activities over broadcast channels").
 *
 * The flow is plugin identity → Station registration → plugin configuration,
 * and every step's input is the previous step's output, never a guess:
 *
 * - enable: `status` (package name or bundle id) → `push_token` (FCM token,
 *   or the ActivityKit push-to-start token and its APNs environment) →
 *   `registerNativePush` → `configure` with exactly what the Station
 *   returned (on iOS the plugin keeps it in the keychain group it shares
 *   with the widget extension).
 * - disable: `unregisterNativePush` → `clear` of that one registration.
 * - refresh (app start, return to foreground): tokens rotate while the app
 *   is closed (FCM with no `onNewToken` hook; push-to-start tokens are only
 *   read when the app asks), so a stored registration re-registers when the
 *   token (or, on iOS, its APNs environment) changed or the last
 *   registration is more than a day old. Nothing is registered that the
 *   person has not turned on.
 *
 * Registrations are kept per Station (environment id), so a phone paired with
 * several Stations keeps one each.
 */

import {
  isNativePushSessionReference,
  NATIVE_PUSH_ANDROID_PACKAGES,
  NATIVE_PUSH_IOS_BUNDLES,
  type NativePushAndroidPackage,
  type NativePushIosBundle,
  type NativePushRegistrationRequest,
  type NativePushRegistrationResponse,
} from '@kontourai/station-contracts/native-push';
import type {
  NativeAgentActivityPhoneStatus,
  NativeApnsEnvironment,
  NativeCommandResult,
  NativePlatformAdapter,
} from './types';

export const AGENT_ACTIVITY_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
const STORAGE_KEY = 'station-agent-activity-registrations-v1';

interface AgentActivityRegistrationFields {
  registrationId: string;
  stationId: string;
  stationKey: string;
  /** The push token the Station last accepted for this registration. */
  token: string;
  /** Epoch ms of the last successful registration with the Station. */
  registeredAt: number;
}

/** An Android registration; records from before iOS support carry no `platform`. */
export interface AgentActivityAndroidRegistrationRecord
  extends AgentActivityRegistrationFields {
  platform?: undefined;
  packageName: NativePushAndroidPackage;
}

export interface AgentActivityIosRegistrationRecord
  extends AgentActivityRegistrationFields {
  platform: 'ios';
  packageName: NativePushIosBundle;
  /** The APNs environment the Station last accepted `token` for. */
  apnsEnvironment: NativeApnsEnvironment;
}

export type AgentActivityRegistrationRecord =
  | AgentActivityAndroidRegistrationRecord
  | AgentActivityIosRegistrationRecord;

/**
 * What the phone registers as, from the plugin's own answers. The Station
 * request is built from this and a token in one place,
 * {@link registrationRequest}.
 */
type AgentActivityIdentity =
  | { platform: 'android'; packageName: NativePushAndroidPackage }
  | {
      platform: 'ios';
      packageName: NativePushIosBundle;
      apnsEnvironment: NativeApnsEnvironment;
    };

export interface AgentActivityRegistrationStore {
  get(environmentId: string): AgentActivityRegistrationRecord | null;
  set(environmentId: string, record: AgentActivityRegistrationRecord): void;
  remove(environmentId: string): void;
}

export interface AgentActivityTarget {
  /** The active Station's environment id; the registration is kept under it. */
  environmentId: string;
  apiBase: string;
}

export type AgentActivityAdapter = Pick<
  NativePlatformAdapter,
  | 'agentActivityStatus'
  | 'agentActivityPushToken'
  | 'configureAgentActivity'
  | 'clearAgentActivity'
  | 'openLiveUpdateSettings'
>;

export interface AgentActivityDependencies {
  adapter: AgentActivityAdapter;
  register(
    request: NativePushRegistrationRequest,
    apiBase: string,
  ): Promise<NativePushRegistrationResponse>;
  unregister(apiBase: string): Promise<void>;
  store: AgentActivityRegistrationStore;
  /** Ask the OS for notification permission; resolves whether it is granted. */
  requestNotificationPermission(): Promise<boolean>;
  now(): number;
}

export type AgentActivityEnableOutcome =
  | { status: 'enabled'; record: AgentActivityRegistrationRecord }
  /** This build carries no push configuration; nothing was registered. */
  | { status: 'unconfigured' }
  /** This OS is below the feature floor (iOS 18); nothing was registered. */
  | { status: 'unsupported' }
  /** The OS will not show Station's notifications; nothing was registered. */
  | { status: 'notifications-disabled' }
  /** iOS: the person turned Live Activities off for Station; nothing was registered. */
  | { status: 'live-activities-disabled' };

export type AgentActivityRefreshOutcome =
  | 'off'
  | 'current'
  | 'refreshed'
  | 'unconfigured'
  | 'unsupported';

/** A step failed; `message` is safe to show. */
class AgentActivityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentActivityError';
  }
}

/** A short, plain sentence for any failure from the steps above. */
export function describeAgentActivityError(error: unknown): string {
  if (error instanceof Error && error.name === 'DevicePairingRequiredError') {
    return 'Pair this phone with the Station first.';
  }
  const message = error instanceof Error ? error.message : String(error);
  return message || 'Something went wrong.';
}

function unwrap<T>(result: NativeCommandResult<T>): T {
  if (result.status === 'ok') return result.value;
  throw new AgentActivityError(
    result.status === 'unsupported' ? result.reason : result.message,
  );
}

const PAYLOAD_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The Station's per-registration payload key. The contract type does not
 * carry it yet (it lands with the publisher's end-to-end encryption), so read
 * it defensively and refuse to turn anything on without it: a phone
 * configured without the key could not read its cards. The value never
 * appears in an error.
 *
 * TODO: read `response.payloadKey` directly once
 * `NativePushRegistrationResponse` and `registerNativePush` carry it.
 */
function payloadKeyOf(response: NativePushRegistrationResponse): string {
  const value = (response as { payloadKey?: unknown }).payloadKey;
  if (typeof value !== 'string' || !PAYLOAD_KEY_PATTERN.test(value)) {
    throw new AgentActivityError(
      'The Station did not return a usable encryption key for this phone. Update the Station, then try again.',
    );
  }
  return value;
}

function deliverable<T extends string>(
  allowed: readonly T[],
  packageName: string,
): T {
  const match = allowed.find((candidate) => candidate === packageName);
  if (!match) {
    throw new AgentActivityError(
      `This app (${packageName}) is not one the push gateway delivers to.`,
    );
  }
  return match;
}

/**
 * The one place a registration request is built. A future iOS field (the
 * #2589 alert token) is one more property on the `ios` branch, read from
 * the same `push_token` answer as the token.
 */
function registrationRequest(
  identity: AgentActivityIdentity,
  token: string,
): NativePushRegistrationRequest {
  return identity.platform === 'ios'
    ? {
        token,
        packageName: identity.packageName,
        platform: 'ios',
        apnsEnvironment: identity.apnsEnvironment,
      }
    : { token, packageName: identity.packageName, platform: 'android' };
}

/**
 * A record from exactly the known fields, in the order an Android record has
 * always been stored in; an iOS record adds its platform and environment.
 */
function recordFor(
  identity: AgentActivityIdentity,
  fields: AgentActivityRegistrationFields,
): AgentActivityRegistrationRecord {
  const { registrationId, stationId, stationKey, token, registeredAt } = fields;
  if (identity.platform !== 'ios')
    return {
      registrationId,
      stationId,
      stationKey,
      token,
      packageName: identity.packageName,
      registeredAt,
    };
  return {
    registrationId,
    stationId,
    stationKey,
    token,
    packageName: identity.packageName,
    registeredAt,
    platform: 'ios',
    apnsEnvironment: identity.apnsEnvironment,
  };
}

/** An iOS token is only registrable with the APNs environment it belongs to. */
function tokenApnsEnvironment(token: {
  apnsEnvironment?: NativeApnsEnvironment;
}): NativeApnsEnvironment {
  if (!token.apnsEnvironment) {
    throw new AgentActivityError(
      'This phone did not say which APNs environment its push token belongs to.',
    );
  }
  return token.apnsEnvironment;
}

export interface AgentActivityController {
  registration(environmentId: string): AgentActivityRegistrationRecord | null;
  status(): Promise<NativeAgentActivityPhoneStatus>;
  enable(target: AgentActivityTarget): Promise<AgentActivityEnableOutcome>;
  disable(target: AgentActivityTarget): Promise<void>;
  refresh(target: AgentActivityTarget): Promise<AgentActivityRefreshOutcome>;
  /** Resolves whether the OS settings page opened. */
  openLiveUpdateSettings(): Promise<boolean>;
}

export function createAgentActivityController(
  deps: AgentActivityDependencies,
): AgentActivityController {
  // One operation at a time: a foreground refresh racing a settings toggle
  // could otherwise re-register a registration the person just turned off.
  let queue: Promise<unknown> = Promise.resolve();
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = queue.then(operation, operation);
    queue = next.catch(() => undefined);
    return next;
  }

  async function registerAndConfigure(
    target: AgentActivityTarget,
    token: string,
    identity: AgentActivityIdentity,
    previous: AgentActivityRegistrationRecord | null,
  ): Promise<AgentActivityRegistrationRecord> {
    const response = await deps.register(
      registrationRequest(identity, token),
      target.apiBase,
    );
    let payloadKey: string;
    try {
      if (response.stationId !== target.environmentId) {
        throw new AgentActivityError(
          'The Station answered as a different Station than the one connected.',
        );
      }
      payloadKey = payloadKeyOf(response);
      unwrap(
        await deps.adapter.configureAgentActivity({
          registrationId: response.registrationId,
          stationId: response.stationId,
          stationKey: response.stationKey,
          payloadKey,
          ongoingEnabled: true,
        }),
      );
    } catch (error) {
      // A first registration the phone could not take would leave the Station
      // sending cards nobody reads; withdraw it. A refresh keeps the existing
      // one, which the phone still holds.
      if (!previous) await deps.unregister(target.apiBase).catch(() => {});
      throw error;
    }
    const record = recordFor(identity, {
      registrationId: response.registrationId,
      stationId: response.stationId,
      stationKey: response.stationKey,
      token,
      registeredAt: deps.now(),
    });
    deps.store.set(target.environmentId, record);
    // The Station keeps registrationId across token rotation; a new one means
    // it lost the old registration (the device was unpaired and paired
    // again). Drop the stale one from the phone only after the new one is in
    // place, so this clear never deletes the push token in use.
    if (previous && previous.registrationId !== record.registrationId) {
      unwrap(await deps.adapter.clearAgentActivity(previous.registrationId));
    }
    return record;
  }

  return {
    registration: (environmentId) => deps.store.get(environmentId),

    status: async () => unwrap(await deps.adapter.agentActivityStatus()),

    openLiveUpdateSettings: async () =>
      unwrap(await deps.adapter.openLiveUpdateSettings()).opened,

    enable: (target) =>
      serialize(async () => {
        let status = unwrap(await deps.adapter.agentActivityStatus());
        if (!status.pushConfigured) return { status: 'unconfigured' };
        if (status.platform === 'ios') {
          // A Live Activity needs no notification permission; the person's
          // switch for it is the Live Activities one.
          if (!status.liveActivitiesSupported) return { status: 'unsupported' };
          if (!status.liveActivitiesEnabled) {
            return { status: 'live-activities-disabled' };
          }
          const packageName = deliverable(
            NATIVE_PUSH_IOS_BUNDLES,
            status.packageName,
          );
          const token = unwrap(await deps.adapter.agentActivityPushToken());
          if (token.state !== 'available') return { status: token.state };
          const record = await registerAndConfigure(
            target,
            token.token,
            {
              platform: 'ios',
              packageName,
              apnsEnvironment: tokenApnsEnvironment(token),
            },
            deps.store.get(target.environmentId),
          );
          return { status: 'enabled', record };
        }
        if (!status.notificationsEnabled) {
          await deps.requestNotificationPermission();
          status = unwrap(await deps.adapter.agentActivityStatus());
          if (status.platform === 'ios' || !status.notificationsEnabled) {
            return { status: 'notifications-disabled' };
          }
        }
        const packageName = deliverable(
          NATIVE_PUSH_ANDROID_PACKAGES,
          status.packageName,
        );
        const token = unwrap(await deps.adapter.agentActivityPushToken());
        if (token.state !== 'available') return { status: token.state };
        const record = await registerAndConfigure(
          target,
          token.token,
          { platform: 'android', packageName },
          deps.store.get(target.environmentId),
        );
        return { status: 'enabled', record };
      }),

    disable: (target) =>
      serialize(async () => {
        const record = deps.store.get(target.environmentId);
        let stationError: unknown = null;
        try {
          await deps.unregister(target.apiBase);
        } catch (error) {
          stationError = error;
        }
        // Clear the phone side even when the Station could not be told: a
        // cleared phone drops that registration's pushes, so turning this off
        // always takes effect here.
        if (record) {
          unwrap(await deps.adapter.clearAgentActivity(record.registrationId));
          deps.store.remove(target.environmentId);
        }
        if (stationError !== null) {
          const detail = describeAgentActivityError(stationError);
          throw new AgentActivityError(
            `Turned off on this phone, but the Station could not be told: ${detail}`,
          );
        }
      }),

    refresh: (target) =>
      serialize(async () => {
        const record = deps.store.get(target.environmentId);
        if (!record) return 'off';
        const token = unwrap(await deps.adapter.agentActivityPushToken());
        if (token.state !== 'available') return token.state;
        const identity: AgentActivityIdentity =
          record.platform === 'ios'
            ? {
                platform: 'ios',
                packageName: record.packageName,
                apnsEnvironment: tokenApnsEnvironment(token),
              }
            : { platform: 'android', packageName: record.packageName };
        const fresh =
          deps.now() - record.registeredAt < AGENT_ACTIVITY_REFRESH_AFTER_MS;
        const unchanged =
          token.token === record.token &&
          (record.platform !== 'ios' ||
            (identity.platform === 'ios' &&
              identity.apnsEnvironment === record.apnsEnvironment));
        if (unchanged && fresh) return 'current';
        await registerAndConfigure(target, token.token, identity, record);
        return 'refreshed';
      }),
  };
}

function isRecord(value: unknown): value is AgentActivityRegistrationRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.registrationId !== 'string' ||
    typeof candidate.stationId !== 'string' ||
    typeof candidate.stationKey !== 'string' ||
    typeof candidate.token !== 'string' ||
    typeof candidate.packageName !== 'string' ||
    typeof candidate.registeredAt !== 'number'
  )
    return false;
  if (candidate.platform === 'ios')
    return (
      (NATIVE_PUSH_IOS_BUNDLES as readonly string[]).includes(
        candidate.packageName,
      ) &&
      (candidate.apnsEnvironment === 'production' ||
        candidate.apnsEnvironment === 'sandbox')
    );
  return (
    candidate.platform === undefined &&
    (NATIVE_PUSH_ANDROID_PACKAGES as readonly string[]).includes(
      candidate.packageName,
    )
  );
}

/**
 * Device-local registrations, keyed by Station environment id. None of these
 * authenticate the device to its Station, which does that separately. The
 * card-encryption `payloadKey` is deliberately not kept here: WebView storage
 * is readable by any script the WebView runs for this origin, so the key goes
 * from the Station's response straight to the plugin, which keeps it in app
 * storage. Every registration returns it again, so nothing here needs it.
 */
export function localAgentActivityRegistrationStore(
  storage: Pick<Storage, 'getItem' | 'setItem'> = window.localStorage,
): AgentActivityRegistrationStore {
  function read(): Record<string, AgentActivityRegistrationRecord> {
    try {
      const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}');
      if (typeof parsed !== 'object' || parsed === null) return {};
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>)
          .filter((entry): entry is [string, AgentActivityRegistrationRecord] =>
            isRecord(entry[1]),
          )
          // Rebuild from known fields so anything else stored by an earlier
          // version (an old payloadKey) is dropped on the next write.
          .map(([id, record]) => [
            id,
            recordFor(
              record.platform === 'ios'
                ? {
                    platform: 'ios',
                    packageName: record.packageName,
                    apnsEnvironment: record.apnsEnvironment,
                  }
                : { platform: 'android', packageName: record.packageName },
              record,
            ),
          ]),
      );
    } catch {
      return {};
    }
  }
  function write(value: Record<string, AgentActivityRegistrationRecord>) {
    storage.setItem(STORAGE_KEY, JSON.stringify(value));
  }
  return {
    get: (environmentId) => read()[environmentId] ?? null,
    set(environmentId, record) {
      write({ ...read(), [environmentId]: record });
    },
    remove(environmentId) {
      const next = read();
      delete next[environmentId];
      write(next);
    },
  };
}

/** Where a card tap lands: a route and query the navigator writes, never a URL. */
export interface AgentActivitySessionTarget {
  pathname: string;
  params: Record<string, string>;
}

/**
 * The navigation a card tap's route asks for (#2515), or null when it must
 * be ignored: a route for another Station than the connected one (the phone
 * may be paired with several), or an id or slug outside the contract
 * grammar. The plugin validated it already; this is the web layer's own
 * check, since the launcher activity is reachable by other apps. The target
 * mirrors the Station's exact-session deep link
 * (`resolveNotificationOpenHref`): the project route when the session has
 * one, else the home route, with the chat dock open on the session.
 */
export function agentActivitySessionTarget(
  route: unknown,
  environmentId: string,
): AgentActivitySessionTarget | null {
  if (typeof route !== 'object' || route === null) return null;
  const { stationId, sessionId, projectSlug } = route as Record<
    string,
    unknown
  >;
  if (stationId !== environmentId || !environmentId) return null;
  if (!isNativePushSessionReference(sessionId)) return null;
  if (projectSlug !== undefined && !isNativePushSessionReference(projectSlug))
    return null;
  return {
    pathname: projectSlug
      ? `/projects/${encodeURIComponent(projectSlug)}`
      : '/',
    params: { chat: sessionId, dock: 'open' },
  };
}

/**
 * Takes the pending card-tap route from the plugin and navigates to it when
 * it passes {@link agentActivitySessionTarget}. Resolves whether it
 * navigated. Taking clears the route either way, so a refused route is
 * not retried.
 */
export async function openAgentActivityLaunchRoute(
  adapter: Pick<NativePlatformAdapter, 'takeAgentActivityLaunchRoute'>,
  environmentId: string,
  navigate: (pathname: string, params?: Record<string, string | null>) => void,
): Promise<boolean> {
  const result = await adapter.takeAgentActivityLaunchRoute();
  if (result.status !== 'ok') return false;
  const target = agentActivitySessionTarget(result.value.route, environmentId);
  if (!target) return false;
  navigate(target.pathname, target.params);
  return true;
}
