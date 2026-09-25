import type { NotificationUrgency, SurfaceId } from './notification.js';
/**
 * Delivery preferences (#2586), persisted as `notification-preferences.json`
 * in the Station home and served at {@link NOTIFICATION_PREFERENCES_PATH}.
 * Shapes and defaults only; the strict parser lives on the server.
 */
export const NOTIFICATION_PREFERENCES_PATH = '/api/notifications/preferences';

/**
 * How much an agent may interrupt. `attention-only` lets `attention` and
 * `failed` through (both are something the person acts on) and keeps `info`
 * and `done` in the inbox.
 */
export type AgentNotificationLevel = 'all' | 'attention-only' | 'off';

export const AGENT_NOTIFICATION_LEVELS: readonly AgentNotificationLevel[] = [
  'all',
  'attention-only',
  'off',
];

/** Wall-clock window, `HH:MM` 24-hour, evaluated by the server. */
export interface NotificationQuietHours {
  start: string;
  end: string;
  /** Let `attention` notifications interrupt during the window. */
  allowAttention: boolean;
  /**
   * The person's IANA time zone (`Europe/Berlin`). The server reads the
   * window in it; absent means the Station host's zone.
   */
  timeZone?: string;
}

/**
 * Per delivery surface. Keys are `SurfaceId`s:
 * - `device:<pairedDeviceId>` — a paired device (stable).
 * - `local:desktop-<installationId>` — the desktop app's native host
 *   ({@link desktopHostSurfaceId}), stable across reloads. Per-surface
 *   preferences for the desktop live here.
 * - `local:<clientSessionId>` — one local browser tab/webview document.
 *   Changes on every reload, so it is used for focus presence only; a
 *   preference stored under it would not stick.
 */
export interface NotificationSurfacePreference {
  /** Nothing below this urgency interrupts the surface (the inbox keeps it). */
  minUrgency: NotificationUrgency;
  /** Show a generic title and no body on this surface's lock screen. */
  hideContent: boolean;
}

export interface NotificationPreferencesV1 {
  schemaVersion: 1;
  agentNotifications: AgentNotificationLevel;
  /**
   * Overrides keyed by the agent notification envelope's
   * `source.projectId` — the exact value the router compares, and the value
   * the inbox's "Mute this project" sends. A per-agent override wins.
   */
  perProject: Record<string, AgentNotificationLevel>;
  /** Overrides keyed by the envelope's `source.agent`. */
  perAgent: Record<string, AgentNotificationLevel>;
  quietHours?: NotificationQuietHours;
  perSurface: Record<string, NotificationSurfacePreference>;
  /**
   * How long an attention/failed notification waits for the person to read
   * it on the surface they are using before interrupting their other ones.
   */
  escalateAfterMs: number;
}

export const DEFAULT_NOTIFICATION_ESCALATE_AFTER_MS = 180_000;
/** Upper bound on {@link NotificationPreferencesV1.escalateAfterMs}: one day. */
export const NOTIFICATION_ESCALATE_AFTER_MS_MAX = 86_400_000;

/**
 * A partial update, applied server-side in one step so two writers cannot
 * lose each other's change (a mute from the inbox racing a settings edit).
 * A map entry of `null` removes that key; `quietHours: null` removes the
 * window. Absent fields are left alone.
 */
export interface NotificationPreferencesPatch {
  agentNotifications?: AgentNotificationLevel;
  perProject?: Record<string, AgentNotificationLevel | null>;
  perAgent?: Record<string, AgentNotificationLevel | null>;
  perSurface?: Record<string, NotificationSurfacePreference | null>;
  quietHours?: NotificationQuietHours | null;
  escalateAfterMs?: number;
}

export const DESKTOP_HOST_SURFACE_PREFIX = 'local:desktop-';

/**
 * The desktop app's stable surface id: `local:desktop-<installationId>`,
 * where the installation id is a UUID the native host generates once and
 * persists. Per-tab `local:<clientSessionId>` ids stay focus-only.
 */
export function desktopHostSurfaceId(installationId: string): SurfaceId {
  return `${DESKTOP_HOST_SURFACE_PREFIX}${installationId}` as SurfaceId;
}

/**
 * The feed a desktop app reads the router's decided OS alerts from:
 * `GET ?after=<cursor>&epoch=<epoch>`, plus the
 * {@link DESKTOP_INSTALLATION_HEADER} header from the desktop app. The
 * server derives the caller's OWN surface — a paired device reads
 * `device:<its id>` from its credential; this computer's desktop app reads
 * `local:desktop-<installation id>` — and echoes it as `surface`. A client
 * never names or guesses the surface (an explicit `surface` param is
 * accepted only if it equals the derived one).
 */
export const NOTIFICATION_DELIVERIES_PATH = '/api/notifications/deliveries';

/**
 * Sent by this computer's desktop app on every feed read: its persisted
 * installation id (UUID). The server derives `local:desktop-<id>` from it
 * for the local operator; a paired device's surface comes from its
 * credential and the header is ignored.
 */
export const DESKTOP_INSTALLATION_HEADER = 'X-Station-Desktop-Installation';

/**
 * One decided delivery. Already policy-applied (focus, quiet hours,
 * minUrgency, mute) and redacted per the surface's `hideContent`: when
 * hidden, `title` is generic and `body` absent. A `retract` entry says
 * "take down notificationId" (read or dismissed elsewhere).
 */
export type SurfaceDeliveryEntry =
  | {
      seq: number;
      kind: 'alert';
      notificationId: string;
      title: string;
      body?: string;
      urgency: NotificationUrgency;
      /** Same-origin relative path to open on click. */
      link?: string;
      at: string;
    }
  | { seq: number; kind: 'retract'; notificationId: string; at: string };

export interface SurfaceDeliveryFeed {
  /** The surface the server derived for this caller; key storage by it. */
  surface: SurfaceId;
  entries: SurfaceDeliveryEntry[];
  /** Pass back as `after` on the next read. */
  cursor: number;
  /**
   * This server run's id; pass back as `epoch`. Sequence numbers restart
   * with the server, so a read whose epoch differs (or whose cursor is past
   * this run's last entry) is answered from the start of the feed.
   */
  epoch: string;
  /** The host's registration lasts this long past each read. */
  leaseMs: number;
}

/** Owner decisions (#2582): everything on, three minute escalation, no quiet hours. */
export function defaultNotificationPreferences(): NotificationPreferencesV1 {
  return {
    schemaVersion: 1,
    agentNotifications: 'all',
    perProject: {},
    perAgent: {},
    perSurface: {},
    escalateAfterMs: DEFAULT_NOTIFICATION_ESCALATE_AFTER_MS,
  };
}
