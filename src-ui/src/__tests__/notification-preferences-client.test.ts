import { describe, expect, test, vi } from 'vitest';
import { createNotificationPreferencesClient } from '../lib/notification-preferences-client';

function response(status: number, body: unknown = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('notification preferences client (#2587 against #2586)', () => {
  test('a Station without the route is unavailable', async () => {
    const client = createNotificationPreferencesClient({
      apiBase: 'http://s',
      fetch: async () => response(404),
    });
    expect(await client.read()).toBe('unavailable');
    expect(await client.mute({ kind: 'agent', agent: 'builder' })).toBe(
      'unavailable',
    );
  });

  test('an unreadable document, a 5xx or a network error is failed, not unavailable', async () => {
    for (const fetch of [
      async () =>
        response(409, { success: false, error: 'preferences_unreadable' }),
      async () => response(503),
      async () => {
        throw new TypeError('network');
      },
    ]) {
      const client = createNotificationPreferencesClient({
        apiBase: 'http://s',
        fetch,
      });
      expect(await client.read()).toBe('failed');
    }
  });

  test('a readable document is ok', async () => {
    const client = createNotificationPreferencesClient({
      apiBase: 'http://s',
      fetch: async () =>
        response(200, {
          success: true,
          data: { schemaVersion: 1 },
          stored: true,
        }),
    });
    expect(await client.read()).toBe('ok');
  });

  test('mute is one server-side PATCH naming only the muted key', async () => {
    const fetch = vi.fn(async () => response(200, { success: true }));
    const client = createNotificationPreferencesClient({
      apiBase: 'http://s',
      fetch,
    });
    expect(await client.mute({ kind: 'project', projectId: 'proj-1' })).toBe(
      'muted',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'http://s/api/notifications/preferences',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ perProject: { 'proj-1': 'off' } }),
      },
    );
    fetch.mockResolvedValueOnce(response(500));
    expect(await client.mute({ kind: 'agent', agent: 'builder' })).toBe(
      'failed',
    );
  });
});
