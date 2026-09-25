import type { NotificationUrgency } from './notification.js';
/**
 * Delivery preferences (#2586), persisted as `notification-preferences.json`
 * in the Station home and served at {@link NOTIFICATION_PREFERENCES_PATH}.
 * Shapes and defaults only; the strict parser lives on the server.
 */
export const NOTIFICATION_PREFERENCES_PATH = '/api/notifications/preferences';

/**
 * How much an agent may interrupt. `attention-only` lets `attention`
 * notifications through and keeps every other agent urgency in the inbox.
 */
export type AgentNotificationLevel = 'all' | 'attention-only' | 'off';

export const AGENT_NOTIFICATION_LEVELS: readonly AgentNotificationLevel[] = [
  'all',
  'attention-only',
  'off',
];

/** Local wall-clock window in the Station's time zone, `HH:MM` 24-hour. */
export interface NotificationQuietHours {
  start: string;
  end: string;
  /** Let `attention` notifications interrupt during the window. */
  allowAttention: boolean;
}

/** Per delivery surface (`device:<id>` / `local:<clientSessionId>`). */
export interface NotificationSurfacePreference {
  /** Nothing below this urgency interrupts the surface (the inbox keeps it). */
  minUrgency: NotificationUrgency;
  /** Show a generic title and no body on this surface's lock screen. */
  hideContent: boolean;
}

export interface NotificationPreferencesV1 {
  schemaVersion: 1;
  agentNotifications: AgentNotificationLevel;
  /** Overrides by project slug; a per-agent override wins over these. */
  perProject: Record<string, AgentNotificationLevel>;
  /** Overrides by agent name. */
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
