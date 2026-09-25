import type {
  NotificationSource,
  NotificationUrgency,
} from '@kontourai/station-contracts/notification';
import { authenticatedFetch } from '@kontourai/station-sdk';

/**
 * Client seam for agent-notification preferences (#2587 reads, #2586 owns).
 *
 * The preferences document and its routes belong to the router slice
 * (#2586, design §1d), built in parallel. Everything here reads through this
 * one interface so the desktop OS channel and the inbox never depend on that
 * route existing: an absent route (404/405), a failed read, or a malformed
 * document all resolve to the SAFE defaults — no quiet hours, content shown,
 * nothing muted — which is exactly today's behaviour. Mute is reported as
 * `unavailable` rather than pretending to have worked.
 *
 * Integration points for #2586 (see the PR notes):
 * - path: {@link NOTIFICATION_PREFERENCES_PATH} (design §1d);
 * - GET returns the document either bare or as `{ success, data }`;
 * - PUT accepts the whole document back (unknown fields are preserved);
 * - `hideContent` is read from `perSurface[<surface id>]`; the local desktop
 *   surface is `local:<client session>`, which rotates on every reload.
 */
export const NOTIFICATION_PREFERENCES_PATH = '/api/notifications/preferences';

export type AgentNotificationLevel = 'all' | 'attention-only' | 'off';

export interface QuietHours {
  /** `HH:MM`, 24-hour, evaluated against this client's clock. */
  start: string;
  end: string;
  allowAttention: boolean;
}

export interface ClientNotificationPreferences {
  agentNotifications: AgentNotificationLevel;
  perAgent: Readonly<Record<string, AgentNotificationLevel>>;
  perProject: Readonly<Record<string, AgentNotificationLevel>>;
  quietHours?: QuietHours;
  hideContent: boolean;
}

export const DEFAULT_CLIENT_NOTIFICATION_PREFERENCES: ClientNotificationPreferences =
  Object.freeze({
    agentNotifications: 'all',
    perAgent: Object.freeze({}),
    perProject: Object.freeze({}),
    hideContent: false,
  });

export type NotificationPreferencesRead =
  | { available: true; preferences: ClientNotificationPreferences }
  | { available: false; preferences: ClientNotificationPreferences };

export type NotificationMuteTarget =
  | { kind: 'agent'; agent: string }
  | { kind: 'project'; projectId: string };

export type NotificationMuteResult = 'muted' | 'unavailable' | 'failed';

export interface NotificationPreferencesClient {
  /** Never throws; defaults when the route is absent or unreadable. */
  read(): Promise<NotificationPreferencesRead>;
  mute(target: NotificationMuteTarget): Promise<NotificationMuteResult>;
}

type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

export function createNotificationPreferencesClient(input: {
  apiBase: string;
  surfaceId?: string;
  fetch?: FetchLike;
}): NotificationPreferencesClient {
  const request: FetchLike = input.fetch ?? authenticatedFetch;
  const url = `${input.apiBase}${NOTIFICATION_PREFERENCES_PATH}`;

  async function readDocument(): Promise<
    | { status: 'ok'; document: Record<string, unknown> }
    | { status: 'unavailable' | 'failed' }
  > {
    try {
      const response = await request(url);
      if (response.status === 404 || response.status === 405)
        return { status: 'unavailable' };
      if (!response.ok) return { status: 'failed' };
      const body: unknown = await response.json();
      const document = isRecord(body) && isRecord(body.data) ? body.data : body;
      return isRecord(document)
        ? { status: 'ok', document }
        : { status: 'failed' };
    } catch {
      return { status: 'failed' };
    }
  }

  return {
    async read() {
      const result = await readDocument();
      if (result.status !== 'ok') {
        return {
          available: false,
          preferences: DEFAULT_CLIENT_NOTIFICATION_PREFERENCES,
        };
      }
      return {
        available: true,
        preferences: parsePreferences(result.document, input.surfaceId),
      };
    },

    async mute(target) {
      const current = await readDocument();
      if (current.status !== 'ok') return current.status;
      const key = target.kind === 'agent' ? 'perAgent' : 'perProject';
      const id = target.kind === 'agent' ? target.agent : target.projectId;
      const existing = isRecord(current.document[key])
        ? current.document[key]
        : {};
      try {
        const response = await request(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...current.document,
            [key]: { ...existing, [id]: 'off' },
          }),
        });
        if (response.status === 404 || response.status === 405)
          return 'unavailable';
        return response.ok ? 'muted' : 'failed';
      } catch {
        return 'failed';
      }
    },
  };
}

/**
 * Whether this agent/project/level setting lets an OS alert through. The
 * in-app record is never affected — muting only stops interruptions.
 */
export function agentAlertAllowed(
  preferences: ClientNotificationPreferences,
  source: NotificationSource,
  urgency: NotificationUrgency,
): boolean {
  if (source.kind !== 'agent') return true;
  const levels = [
    preferences.agentNotifications,
    source.agent ? preferences.perAgent[source.agent] : undefined,
    source.projectId ? preferences.perProject[source.projectId] : undefined,
  ];
  return levels.every(
    (level) =>
      level === undefined ||
      level === 'all' ||
      (level === 'attention-only' && urgency === 'attention'),
  );
}

/** True when `now` falls inside the window; an overnight window wraps. */
export function isWithinQuietHours(quietHours: QuietHours, now: Date): boolean {
  const start = minutesOfDay(quietHours.start);
  const end = minutesOfDay(quietHours.end);
  if (start === undefined || end === undefined || start === end) return false;
  const minute = now.getHours() * 60 + now.getMinutes();
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
}

function minutesOfDay(value: string): number | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

function parsePreferences(
  document: Record<string, unknown>,
  surfaceId: string | undefined,
): ClientNotificationPreferences {
  const quiet = document.quietHours;
  const surfaces = isRecord(document.perSurface) ? document.perSurface : {};
  const surface =
    surfaceId && isRecord(surfaces[surfaceId]) ? surfaces[surfaceId] : {};
  return {
    agentNotifications: isLevel(document.agentNotifications)
      ? document.agentNotifications
      : 'all',
    perAgent: levelMap(document.perAgent),
    perProject: levelMap(document.perProject),
    ...(isRecord(quiet) &&
    typeof quiet.start === 'string' &&
    typeof quiet.end === 'string'
      ? {
          quietHours: {
            start: quiet.start,
            end: quiet.end,
            allowAttention: quiet.allowAttention === true,
          },
        }
      : {}),
    hideContent: surface.hideContent === true,
  };
}

function levelMap(value: unknown): Record<string, AgentNotificationLevel> {
  if (!isRecord(value)) return {};
  const levels: Record<string, AgentNotificationLevel> = {};
  for (const [key, level] of Object.entries(value)) {
    if (isLevel(level)) levels[key] = level;
  }
  return levels;
}

function isLevel(value: unknown): value is AgentNotificationLevel {
  return value === 'all' || value === 'attention-only' || value === 'off';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
