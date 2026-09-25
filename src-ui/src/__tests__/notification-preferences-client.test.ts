import { describe, expect, test, vi } from 'vitest';
import {
  agentAlertAllowed,
  createNotificationPreferencesClient,
  DEFAULT_CLIENT_NOTIFICATION_PREFERENCES,
  FAILED_READ_CLIENT_NOTIFICATION_PREFERENCES,
  isWithinQuietHours,
} from '../lib/notification-preferences-client';

function response(status: number, body: unknown = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const agent = {
  kind: 'agent' as const,
  sessionId: 's-1',
  agent: 'builder',
  projectId: 'proj-1',
  assurance: 'bound' as const,
};

describe('notification preferences client (#2587 seam for #2586)', () => {
  test('an absent route is unavailable and yields the safe defaults', async () => {
    const fetch = vi.fn(async () => response(404));
    const client = createNotificationPreferencesClient({
      apiBase: 'http://s',
      fetch,
    });
    expect(await client.read()).toEqual({
      status: 'unavailable',
      preferences: DEFAULT_CLIENT_NOTIFICATION_PREFERENCES,
    });
    expect(await client.mute({ kind: 'agent', agent: 'builder' })).toBe(
      'unavailable',
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('a failed read is not consent: content-free copy, and mute reports failed', async () => {
    for (const fetch of [
      async () => response(503),
      async () => {
        throw new TypeError('network');
      },
      async () => response(200, 'not a document'),
    ]) {
      const client = createNotificationPreferencesClient({
        apiBase: 'http://s',
        fetch,
      });
      expect(await client.read()).toEqual({
        status: 'failed',
        preferences: FAILED_READ_CLIENT_NOTIFICATION_PREFERENCES,
      });
      expect(await client.mute({ kind: 'agent', agent: 'builder' })).toBe(
        'failed',
      );
    }
    expect(FAILED_READ_CLIENT_NOTIFICATION_PREFERENCES.hideContent).toBe(true);
  });

  test('reads quiet hours and mutes; per-surface hideContent waits for #2586', async () => {
    const client = createNotificationPreferencesClient({
      apiBase: 'http://s',
      fetch: async () =>
        response(200, {
          success: true,
          data: {
            agentNotifications: 'attention-only',
            perAgent: { builder: 'off', bogus: 'loud' },
            quietHours: { start: '22:00', end: '07:00', allowAttention: true },
            perSurface: {
              'local:abc': { hideContent: true },
              'device:other': { hideContent: false },
            },
          },
        }),
    });
    // A stored hideContent is not honoured yet: no stable desktop surface id
    // exists for a preference to name (TODO #2586).
    expect(await client.read()).toEqual({
      status: 'ok',
      preferences: {
        agentNotifications: 'attention-only',
        perAgent: { builder: 'off' },
        perProject: {},
        quietHours: { start: '22:00', end: '07:00', allowAttention: true },
        hideContent: false,
      },
    });
  });

  test('mute writes the whole document back with the agent switched off', async () => {
    const fetch = vi.fn(async (_url: string, init?: { method?: string }) =>
      init?.method === 'PUT'
        ? response(200)
        : response(200, { schemaVersion: 1, perAgent: { other: 'all' } }),
    );
    const client = createNotificationPreferencesClient({
      apiBase: 'http://s',
      fetch,
    });
    expect(await client.mute({ kind: 'project', projectId: 'proj-1' })).toBe(
      'muted',
    );
    const put = fetch.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(put?.[0]).toBe('http://s/api/notifications/preferences');
    expect(JSON.parse(String((put?.[1] as { body?: string })?.body))).toEqual({
      schemaVersion: 1,
      perAgent: { other: 'all' },
      perProject: { 'proj-1': 'off' },
    });
  });

  test('agentAlertAllowed applies global, agent and project levels', () => {
    const prefs = DEFAULT_CLIENT_NOTIFICATION_PREFERENCES;
    expect(agentAlertAllowed(prefs, agent, 'info')).toBe(true);
    expect(
      agentAlertAllowed(
        { ...prefs, perProject: { 'proj-1': 'attention-only' } },
        agent,
        'done',
      ),
    ).toBe(false);
    expect(
      agentAlertAllowed(
        { ...prefs, perProject: { 'proj-1': 'attention-only' } },
        agent,
        'attention',
      ),
    ).toBe(true);
    expect(
      agentAlertAllowed(
        { ...prefs, agentNotifications: 'off' },
        agent,
        'attention',
      ),
    ).toBe(false);
  });

  test('quiet hours wrap midnight and reject malformed times', () => {
    const at = (h: number, m = 0) => new Date(2026, 8, 24, h, m);
    const overnight = { start: '22:00', end: '07:00', allowAttention: false };
    expect(isWithinQuietHours(overnight, at(23))).toBe(true);
    expect(isWithinQuietHours(overnight, at(6, 59))).toBe(true);
    expect(isWithinQuietHours(overnight, at(7))).toBe(false);
    expect(isWithinQuietHours(overnight, at(12))).toBe(false);
    const day = { start: '09:00', end: '17:00', allowAttention: false };
    expect(isWithinQuietHours(day, at(9))).toBe(true);
    expect(isWithinQuietHours(day, at(17))).toBe(false);
    expect(isWithinQuietHours({ ...day, start: '9am' }, at(10))).toBe(false);
  });
});
