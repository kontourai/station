import { NotificationPreferencesRequestError } from '@kontourai/station-sdk';
import { describe, expect, test, vi } from 'vitest';
import { createNotificationPreferencesClient } from '../lib/notification-preferences-client';

const refused = (status: number, code?: string) =>
  new NotificationPreferencesRequestError('refused', status, code);

function transport(overrides: {
  fetch?: () => Promise<unknown>;
  patch?: () => Promise<unknown>;
}) {
  return {
    fetch: vi.fn(overrides.fetch ?? (async () => ({ schemaVersion: 1 }))),
    patch: vi.fn(overrides.patch ?? (async () => ({ schemaVersion: 1 }))),
  } as unknown as {
    fetch: ReturnType<typeof vi.fn>;
    patch: ReturnType<typeof vi.fn>;
  };
}

function client(t: ReturnType<typeof transport>) {
  return createNotificationPreferencesClient({
    apiBase: 'http://s',
    transport: t as never,
  });
}

describe('notification preferences client (#2587 against #2586)', () => {
  test('a Station without the route is unavailable', async () => {
    const t = transport({
      fetch: async () => {
        throw refused(404);
      },
      patch: async () => {
        throw refused(404);
      },
    });
    expect(await client(t).read()).toBe('unavailable');
    expect(await client(t).mute({ kind: 'agent', agent: 'builder' })).toBe(
      'unavailable',
    );
  });

  test('an unreadable document, a 5xx or a network error is failed', async () => {
    for (const error of [
      refused(409, 'preferences_unreadable'),
      refused(503),
      new TypeError('network'),
      new SyntaxError('not JSON'),
    ]) {
      const t = transport({
        fetch: async () => {
          throw error;
        },
      });
      expect(await client(t).read()).toBe('failed');
    }
  });

  test('mute is one PATCH of the one key through the SDK', async () => {
    const t = transport({});
    expect(await client(t).mute({ kind: 'project', projectId: 'proj-1' })).toBe(
      'muted',
    );
    expect(t.patch).toHaveBeenCalledTimes(1);
    expect(t.patch).toHaveBeenCalledWith(
      { perProject: { 'proj-1': 'off' } },
      'http://s',
    );
  });

  test('a refused PATCH is failed and not retried (the server merges it)', async () => {
    const t = transport({
      patch: async () => {
        throw refused(500);
      },
    });
    expect(await client(t).mute({ kind: 'agent', agent: 'builder' })).toBe(
      'failed',
    );
    expect(t.patch).toHaveBeenCalledTimes(1);
    expect(t.fetch).not.toHaveBeenCalled();
  });
});
