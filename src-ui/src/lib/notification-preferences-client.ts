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
 * route existing. Two non-answers are kept apart, because only one of them
 * says anything about the user's wishes:
 * - `unavailable` — the route is absent (404/405): this Station has no
 *   preferences, so the defaults (no quiet hours, content shown, nothing
 *   muted) ARE its preferences, exactly today's behaviour.
 * - `failed` — a Station that has preferences could not be read (5xx,
 *   network, malformed). Its wishes are unknown, so callers must not treat
 *   the defaults as consent: the OS channel falls back to content-free copy
 *   and the inbox offers no Mute.
 *
 * Per-surface `hideContent` is NOT read yet. The design keys it by surface
 * id, and the local desktop surface today is `local:<client session>` — a
 * per-document random id no stored preference can name. Reading it would
 * be a label nothing could set. TODO(#2586): read `perSurface[<stable
 * desktop surface id>].hideContent` once S4 defines that id.
 *
 * Integration points for #2586 (see the PR notes):
 * - path: {@link NOTIFICATION_PREFERENCES_PATH} (design §1d);
 * - GET returns the document either bare or as `{ success, data }`;
 * - mute writes through {@link writeMute} (whole-document PUT today; swap
 *   for S4's PATCH/compare-and-set there — it is the one write site).
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
  /**
   * Replace alert text with content-free copy. From stored preferences this
   * is always false until #2586 defines a stable desktop surface id; it is
   * true when the preferences could not be read (see `failed`).
   */
  hideContent: boolean;
}

export const DEFAULT_CLIENT_NOTIFICATION_PREFERENCES: ClientNotificationPreferences =
  Object.freeze({
    agentNotifications: 'all',
    perAgent: Object.freeze({}),
    perProject: Object.freeze({}),
    hideContent: false,
  });

export type NotificationPreferencesReadStatus = 'ok' | 'unavailable' | 'failed';

export interface NotificationPreferencesRead {
  status: NotificationPreferencesReadStatus;
  preferences: ClientNotificationPreferences;
}

/**
 * What an OS alert may assume when the read did not answer: the defaults
 * for a Station without preferences, content-free copy for one whose
 * preferences exist but could not be read.
 */
export const FAILED_READ_CLIENT_NOTIFICATION_PREFERENCES: ClientNotificationPreferences =
  Object.freeze({
    ...DEFAULT_CLIENT_NOTIFICATION_PREFERENCES,
    hideContent: true,
  });

export type NotificationMuteTarget =
  | { kind: 'agent'; agent: string }
  | { kind: 'project'; projectId: string };

export type NotificationMuteResult = 'muted' | 'unavailable' | 'failed';

export interface NotificationPreferencesClient {
  /** Never throws; see the module docblock for `unavailable` vs `failed`. */
  read(): Promise<NotificationPreferencesRead>;
  mute(target: NotificationMuteTarget): Promise<NotificationMuteResult>;
}

type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

export function createNotificationPreferencesClient(input: {
  apiBase: string;
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
      if (result.status === 'ok') {
        return {
          status: 'ok',
          preferences: parsePreferences(result.document),
        };
      }
      return {
        status: result.status,
        preferences:
          result.status === 'unavailable'
            ? DEFAULT_CLIENT_NOTIFICATION_PREFERENCES
            : FAILED_READ_CLIENT_NOTIFICATION_PREFERENCES,
      };
    },

    async mute(target) {
      const current = await readDocument();
      if (current.status !== 'ok') return current.status;
      return writeMute(request, url, current.document, target);
    },
  };
}

/**
 * The single preferences write. Whole-document read-modify-write PUT: a
 * concurrent edit between the read and this write is lost. TODO(#2586):
 * replace with S4's PATCH / compare-and-set when it lands.
 */
async function writeMute(
  request: FetchLike,
  url: string,
  document: Record<string, unknown>,
  target: NotificationMuteTarget,
): Promise<NotificationMuteResult> {
  const key = target.kind === 'agent' ? 'perAgent' : 'perProject';
  const id = target.kind === 'agent' ? target.agent : target.projectId;
  const existing = isRecord(document[key]) ? document[key] : {};
  try {
    const response = await request(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...document,
        [key]: { ...existing, [id]: 'off' },
      }),
    });
    if (response.status === 404 || response.status === 405)
      return 'unavailable';
    return response.ok ? 'muted' : 'failed';
  } catch {
    return 'failed';
  }
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
): ClientNotificationPreferences {
  const quiet = document.quietHours;
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
    // TODO(#2586): per-surface hideContent once a stable desktop surface id
    // exists — see the module docblock.
    hideContent: false,
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
