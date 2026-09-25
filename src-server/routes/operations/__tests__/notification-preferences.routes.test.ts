import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PAIRING_SCOPE_ORCHESTRATION_OPERATE } from '@kontourai/station-contracts';
import {
  defaultNotificationPreferences,
  desktopHostSurfaceId,
  NOTIFICATION_DELIVERIES_PATH,
  NOTIFICATION_PREFERENCES_PATH,
} from '@kontourai/station-contracts/notification-preferences';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  matchPairingScopeRule,
  requiredPairingScope,
} from '../../../security/pairing-route-scopes.js';
import {
  bindRuntimeLocalOperator,
  type RuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { DesktopHostChannel } from '../../../services/notifications/delivery/desktop-host-channel.js';
import {
  NOTIFICATION_PREFERENCES_FILE,
  NotificationPreferencesStore,
} from '../../../services/notifications/notification-preferences.js';
import { createNotificationPreferencesRoutes } from '../notification-preferences.js';

const PERSON: RuntimeAuthenticatedRequestPrincipal = {
  kind: 'credential',
  credential: 'person-credential',
  authority: undefined,
  source: 'bearer',
};

let home: string;
let app: Hono;
let desktopHost: DesktopHostChannel;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'notification-preferences-routes-'));
  desktopHost = new DesktopHostChannel();
  app = new Hono();
  app.route(
    '/api/notifications',
    createNotificationPreferencesRoutes(
      new NotificationPreferencesStore(home),
      {
        desktopHost,
        // Only the family phone may hold a feed.
        isFeedDevice: (deviceId) => deviceId === 'phone',
      },
    ),
  );
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function call(
  method: 'GET' | 'PUT' | 'PATCH',
  body?: unknown,
  principal: RuntimeAuthenticatedRequestPrincipal = PERSON,
  options: { path?: string; headers?: Record<string, string> } = {},
) {
  const request = new Request(
    `http://station.test${options.path ?? NOTIFICATION_PREFERENCES_PATH}`,
    {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    },
  );
  setRuntimeAuthenticatedRequestPrincipal(request, principal);
  bindRuntimeLocalOperator(request, principal);
  const response = await app.fetch(request);
  return {
    status: response.status,
    etag: response.headers.get('etag'),
    json: (await response.json()) as Record<string, unknown>,
  };
}

describe('GET/PUT /api/notifications/preferences', () => {
  test('both verbs sit on the operate tier by an explicit rule', () => {
    for (const method of ['GET', 'PUT', 'PATCH']) {
      expect(requiredPairingScope(method, NOTIFICATION_PREFERENCES_PATH)).toBe(
        PAIRING_SCOPE_ORCHESTRATION_OPERATE,
      );
      expect(
        matchPairingScopeRule(method, NOTIFICATION_PREFERENCES_PATH)?.origin,
      ).toBe('explicit');
    }
  });

  test('GET before anything is saved returns the defaults', async () => {
    const { status, json } = await call('GET');
    expect(status).toBe(200);
    expect(json).toEqual({
      success: true,
      data: defaultNotificationPreferences(),
      stored: false,
    });
  });

  test('PUT stores a valid document and GET returns it', async () => {
    const next = {
      ...defaultNotificationPreferences(),
      agentNotifications: 'attention-only',
      quietHours: { start: '22:00', end: '07:00', allowAttention: true },
      perSurface: {
        'device:phone': { minUrgency: 'failed', hideContent: true },
      },
    };
    const put = await call('PUT', next);
    expect(put).toMatchObject({
      status: 200,
      json: { success: true, data: next },
    });
    const get = await call('GET');
    expect(get.json).toEqual({ success: true, data: next, stored: true });
  });

  test.each([
    ['an unknown key', { ...defaultNotificationPreferences(), extra: 1 }],
    ['a partial document', { agentNotifications: 'off' }],
    ['malformed JSON', '{not json'],
  ])('PUT refuses %s with 400 and stores nothing', async (_label, body) => {
    const put = await call('PUT', body);
    expect(put).toMatchObject({
      status: 400,
      json: { success: false, error: 'invalid_preferences' },
    });
    expect((await call('GET')).json.stored).toBe(false);
  });

  test('an unreadable saved file is reported, not replaced by defaults', async () => {
    writeFileSync(
      join(home, NOTIFICATION_PREFERENCES_FILE),
      '{"schemaVersion":9}',
      {
        mode: 0o600,
      },
    );
    const get = await call('GET');
    expect(get.status).toBe(409);
    expect(get.json.error).toBe('preferences_unreadable');
  });

  test.each<[string, RuntimeAuthenticatedRequestPrincipal]>([
    [
      "Station's internal agent caller",
      { ...PERSON, kind: 'internal', credential: 'internal-token' },
    ],
    [
      "another Station's delegation grant",
      { ...PERSON, deviceId: 'grant-1', deviceKind: 'delegation' },
    ],
  ])('%s can neither read nor write them', async (_label, principal) => {
    expect((await call('GET', undefined, principal)).status).toBe(403);
    const put = await call(
      'PUT',
      { ...defaultNotificationPreferences(), agentNotifications: 'all' },
      principal,
    );
    expect(put.status).toBe(403);
    expect(put.json.error).toBe('person_required');
    expect((await call('GET')).json.stored).toBe(false);
  });

  test("a person's own paired device may", async () => {
    const device = {
      ...PERSON,
      deviceId: 'phone',
      deviceKind: 'device' as const,
    };
    expect((await call('GET', undefined, device)).status).toBe(200);
  });
});

describe('compare-and-swap and PATCH', () => {
  test('PUT with a stale If-Match is refused 412 and changes nothing', async () => {
    const { etag } = await call('GET');
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    // Another writer (the inbox's mute) lands first.
    expect((await call('PATCH', { perAgent: { builder: 'off' } })).status).toBe(
      200,
    );
    const stale = await call(
      'PUT',
      { ...defaultNotificationPreferences(), agentNotifications: 'off' },
      PERSON,
      { headers: { 'if-match': etag! } },
    );
    expect(stale.status).toBe(412);
    expect(stale.json.error).toBe('preferences_changed');
    const after = await call('GET');
    expect(after.json.data).toMatchObject({
      agentNotifications: 'all',
      perAgent: { builder: 'off' },
    });
    // With the fresh tag it goes through.
    const fresh = await call(
      'PUT',
      { ...(after.json.data as object), agentNotifications: 'off' },
      PERSON,
      { headers: { 'if-match': after.etag! } },
    );
    expect(fresh.status).toBe(200);
  });

  test('PATCH changes only the fields it names', async () => {
    await call('PATCH', { perProject: { alpha: 'attention-only' } });
    const patched = await call('PATCH', { perAgent: { builder: 'off' } });
    expect(patched.status).toBe(200);
    expect(patched.json.data).toMatchObject({
      perProject: { alpha: 'attention-only' },
      perAgent: { builder: 'off' },
    });
  });

  test('PATCH with a stale If-Match is refused 412', async () => {
    const { etag } = await call('GET');
    await call('PATCH', { perAgent: { builder: 'off' } });
    const stale = await call('PATCH', { agentNotifications: 'off' }, PERSON, {
      headers: { 'if-match': etag! },
    });
    expect(stale.status).toBe(412);
    expect((await call('GET')).json.data).toMatchObject({
      agentNotifications: 'all',
    });
  });

  test('an unreadable file serves an ETag that makes the reset a CAS', async () => {
    writeFileSync(join(home, NOTIFICATION_PREFERENCES_FILE), '{', {
      mode: 0o600,
    });
    const unreadable = await call('GET');
    expect(unreadable.status).toBe(409);
    expect(unreadable.etag).toBe('"unreadable"');
    const reset = await call('PUT', defaultNotificationPreferences(), PERSON, {
      headers: { 'if-match': unreadable.etag! },
    });
    expect(reset.status).toBe(200);
    // A second reset from the same stale read now loses.
    const again = await call('PUT', defaultNotificationPreferences(), PERSON, {
      headers: { 'if-match': unreadable.etag! },
    });
    expect(again.status).toBe(412);
  });

  test('an invalid PATCH is 400', async () => {
    expect(
      (await call('PATCH', { perAgent: { builder: 'loud' } })).status,
    ).toBe(400);
  });
});

describe('GET /api/notifications/deliveries (desktop host feed)', () => {
  const surface = desktopHostSurfaceId('7c9e6679-7425-40de-944b-e07fc1f90ae7');
  const LOCAL: RuntimeAuthenticatedRequestPrincipal = {
    ...PERSON,
    locality: 'home-possession',
  };
  const feed = (query: string, principal = LOCAL) =>
    call('GET', undefined, principal, {
      path: `${NOTIFICATION_DELIVERIES_PATH}?${query}`,
    });

  test('operate tier by an explicit rule', () => {
    expect(requiredPairingScope('GET', NOTIFICATION_DELIVERIES_PATH)).toBe(
      PAIRING_SCOPE_ORCHESTRATION_OPERATE,
    );
  });

  test('the local operator reads its feed and registers the host', async () => {
    const result = await feed(`surface=${surface}&after=0`);
    expect(result.status).toBe(200);
    expect(result.json.data).toEqual({
      entries: [],
      cursor: 0,
      epoch: expect.any(String),
      leaseMs: 90_000,
    });
    expect(desktopHost.registrations()).toEqual([{ surface, ref: surface }]);
  });

  test('a paired device reads its OWN feed, derived from its credential', async () => {
    const phone = {
      ...PERSON,
      deviceId: 'phone',
      deviceKind: 'device' as const,
    };
    const own = await call('GET', undefined, phone, {
      path: `${NOTIFICATION_DELIVERIES_PATH}?after=0`,
    });
    expect(own.status).toBe(200);
    // Naming its own surface explicitly is fine too.
    expect(
      (
        await call('GET', undefined, phone, {
          path: `${NOTIFICATION_DELIVERIES_PATH}?surface=device:phone&after=0`,
        })
      ).status,
    ).toBe(200);
    expect(desktopHost.registrations()).toEqual([
      { surface: 'device:phone', ref: 'device:phone' },
    ]);
  });

  test.each([
    'surface=device:tablet',
    `surface=${desktopHostSurfaceId('7c9e6679-7425-40de-944b-e07fc1f90ae7')}`,
  ])(
    'a paired device naming another surface is refused 403 (%s)',
    async (query) => {
      const phone = {
        ...PERSON,
        deviceId: 'phone',
        deviceKind: 'device' as const,
      };
      const other = await call('GET', undefined, phone, {
        path: `${NOTIFICATION_DELIVERIES_PATH}?${query}&after=0`,
      });
      expect(other.status).toBe(403);
      expect(other.json.error).toBe('surface_not_yours');
      expect(desktopHost.registrations()).toEqual([]);
    },
  );

  test('a paired device outside the family (e.g. a delegated Station) gets no feed', async () => {
    const outsider = {
      ...PERSON,
      deviceId: 'no-read-scope',
      deviceKind: 'device' as const,
    };
    const refused = await call('GET', undefined, outsider, {
      path: `${NOTIFICATION_DELIVERIES_PATH}?after=0`,
    });
    expect(refused.status).toBe(403);
    expect(refused.json.error).toBe('device_not_eligible');
    // It never occupies a feed slot.
    expect(desktopHost.registrations()).toEqual([]);
  });

  test('a remote person (not this machine) is refused', async () => {
    const result = await feed(`surface=${surface}&after=0`, PERSON);
    expect(result.status).toBe(403);
    expect(desktopHost.registrations()).toEqual([]);
  });

  test('an internal agent caller is refused', async () => {
    const result = await feed(`surface=${surface}&after=0`, {
      ...LOCAL,
      kind: 'internal',
    });
    expect(result.status).toBe(403);
  });

  test.each([
    'surface=device:phone&after=0',
    'surface=local:0b1d2c3e-session&after=0',
    `surface=${surface}&after=-1`,
    `surface=${surface}&after=abc`,
    `surface=${surface}&after=0&epoch=not%20an%20id`,
  ])('a malformed query is 400 (%s)', async (query) => {
    expect((await feed(query)).status).toBe(400);
  });
});
