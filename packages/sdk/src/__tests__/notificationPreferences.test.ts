/**
 * #2586: preference writes carry the last read's ETag as If-Match, so a
 * write from a stale copy is refused (412) instead of overwriting someone
 * else's change, and the refusal is a coded error.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: async () => 'http://localhost:9999',
}));

const authenticatedFetch = vi.fn();
vi.mock('../client/http', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

const {
  fetchNotificationPreferences,
  NotificationPreferencesRequestError,
  patchNotificationPreferences,
  updateNotificationPreferences,
} = await import('../query-domains/notificationPreferences');

const DOC = {
  schemaVersion: 1,
  agentNotifications: 'all',
  perProject: {},
  perAgent: {},
  perSurface: {},
  escalateAfterMs: 180_000,
};

function respond(status: number, body: unknown, etag?: string) {
  authenticatedFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(etag ? { etag } : {}),
    json: async () => body,
  });
}

function ifMatchOf(call: number): string | undefined {
  const init = authenticatedFetch.mock.calls[call]?.[1] as
    | { headers?: Record<string, string> }
    | undefined;
  return init?.headers?.['If-Match'];
}

describe('notification preferences writes are compare-and-swap', () => {
  beforeEach(() => authenticatedFetch.mockReset());

  test("a PUT sends the last response's ETag; a PATCH (the server-side merge) never does", async () => {
    respond(200, { success: true, data: DOC }, '"rev-1"');
    await fetchNotificationPreferences();
    respond(200, { success: true, data: DOC }, '"rev-2"');
    await patchNotificationPreferences({ perAgent: { builder: 'off' } });
    respond(200, { success: true, data: DOC }, '"rev-3"');
    await updateNotificationPreferences(DOC as never);
    expect(ifMatchOf(1)).toBeUndefined();
    // The PATCH's response revision is what the PUT carries.
    expect(ifMatchOf(2)).toBe('"rev-2"');
  });

  test('a 412 is a coded error and forgets the stale revision', async () => {
    respond(200, { success: true, data: DOC }, '"rev-1"');
    await fetchNotificationPreferences();
    respond(412, { success: false, error: 'preferences_changed' });
    const error = await updateNotificationPreferences(DOC as never).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(NotificationPreferencesRequestError);
    expect(error).toMatchObject({ status: 412, code: 'preferences_changed' });
    respond(200, { success: true, data: DOC });
    await updateNotificationPreferences(DOC as never);
    expect(ifMatchOf(2)).toBeUndefined();
  });

  test('an unreadable file is a coded 409 whose ETag a reset sends back', async () => {
    respond(
      409,
      {
        success: false,
        error: 'preferences_unreadable',
        message: 'unreadable',
      },
      '"unreadable"',
    );
    await expect(fetchNotificationPreferences()).rejects.toMatchObject({
      code: 'preferences_unreadable',
    });
    respond(200, { success: true, data: DOC }, '"rev-9"');
    await updateNotificationPreferences(DOC as never);
    expect(ifMatchOf(1)).toBe('"unreadable"');
  });
});
