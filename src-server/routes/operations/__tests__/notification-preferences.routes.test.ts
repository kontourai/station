import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAIRING_SCOPE_ORCHESTRATION_OPERATE } from '@kontourai/station-contracts';
import {
  DESKTOP_INSTALLATION_HEADER,
  defaultNotificationPreferences,
  desktopHostSurfaceId,
  NOTIFICATION_DELIVERIES_PATH,
  NOTIFICATION_PREFERENCES_PATH,
} from '@kontourai/station-contracts/notification-preferences';
import { Hono } from 'hono';
import { beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
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
import {
  createNotificationDeliveryFeedRoutes,
  createNotificationPreferencesRoutes,
} from '../notification-preferences.js';

const makeTempDir = trackTempDirs();

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
  home = makeTempDir('notification-preferences-routes-');
  desktopHost = new DesktopHostChannel();
  app = new Hono();
  const store = new NotificationPreferencesStore(home);
  app.route(
    '/api/notifications/preferences',
    createNotificationPreferencesRoutes(store),
  );
  app.route(
    '/api/notifications/deliveries',
    createNotificationDeliveryFeedRoutes({
      desktopHost,
      // Only the family phone may hold a feed.
      isFeedDevice: (deviceId) => deviceId === 'phone',
    }),
  );
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

  test('/api/notifications is not a route family: only the two leaves are mapped', () => {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE'])
      for (const path of [
        '/api/notifications',
        '/api/notifications/other',
        '/api/notifications/preferences/extra',
      ])
        expect(requiredPairingScope(method, path)).toBeUndefined();
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
    // Each handler carries its own guard, so each method is pinned.
    const patch = await call('PATCH', { agentNotifications: 'all' }, principal);
    expect(patch.status).toBe(403);
    expect(patch.json.error).toBe('person_required');
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

describe("GET /api/notifications/deliveries (the caller's own feed)", () => {
  const INSTALLATION = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const desktop = desktopHostSurfaceId(INSTALLATION);
  const LOCAL: RuntimeAuthenticatedRequestPrincipal = {
    ...PERSON,
    locality: 'home-possession',
  };
  const PHONE: RuntimeAuthenticatedRequestPrincipal = {
    ...PERSON,
    deviceId: 'phone',
    deviceKind: 'device',
  };
  const feed = (
    query: string,
    principal: RuntimeAuthenticatedRequestPrincipal,
    installation?: string,
  ) =>
    call('GET', undefined, principal, {
      path: `${NOTIFICATION_DELIVERIES_PATH}?${query}`,
      headers:
        installation === undefined
          ? {}
          : { [DESKTOP_INSTALLATION_HEADER]: installation },
    });

  test('operate tier by an explicit rule', () => {
    expect(requiredPairingScope('GET', NOTIFICATION_DELIVERIES_PATH)).toBe(
      PAIRING_SCOPE_ORCHESTRATION_OPERATE,
    );
  });

  test('the local operator: surface derived from the installation header, and echoed', async () => {
    const result = await feed('after=0', LOCAL, INSTALLATION);
    expect(result.status).toBe(200);
    expect(result.json.data).toEqual({
      surface: desktop,
      entries: [],
      cursor: 0,
      epoch: expect.any(String),
      leaseMs: 90_000,
    });
    expect(desktopHost.registrations()).toEqual([
      { surface: desktop, ref: desktop },
    ]);
  });

  test.each([
    ['missing', undefined],
    ['malformed', 'not an id!'],
    ['too short', 'abc'],
  ])(
    'the local operator with the installation header %s → 400 installation_required',
    async (_label, installation) => {
      const result = await feed('after=0', LOCAL, installation);
      expect(result.status).toBe(400);
      expect(result.json.error).toBe('installation_required');
      expect(desktopHost.registrations()).toEqual([]);
    },
  );

  test('a paired device: surface from its credential, the installation header ignored', async () => {
    const result = await feed('after=0', PHONE, INSTALLATION);
    expect(result.status).toBe(200);
    expect((result.json.data as { surface: string }).surface).toBe(
      'device:phone',
    );
    expect(desktopHost.registrations()).toEqual([
      { surface: 'device:phone', ref: 'device:phone' },
    ]);
  });

  test('an explicit surface equal to the derived one is accepted (older clients)', async () => {
    expect(
      (await feed(`surface=${desktop}&after=0`, LOCAL, INSTALLATION)).status,
    ).toBe(200);
    expect((await feed('surface=device:phone&after=0', PHONE)).status).toBe(
      200,
    );
  });

  test.each<[string, RuntimeAuthenticatedRequestPrincipal, string | undefined]>(
    [
      ['a device naming another device', PHONE, 'device:tablet'],
      ['a device naming a desktop surface', PHONE, undefined],
      ['the operator naming a device', LOCAL, 'device:phone'],
      [
        'the operator naming another installation',
        LOCAL,
        desktopHostSurfaceId('11111111-2222-4333-8444-555555555555'),
      ],
    ],
  )('%s → 403 surface_not_yours', async (_label, principal, named) => {
    const result = await feed(
      `surface=${named ?? desktop}&after=0`,
      principal,
      INSTALLATION,
    );
    expect(result.status).toBe(403);
    expect(result.json.error).toBe('surface_not_yours');
    expect(desktopHost.registrations()).toEqual([]);
  });

  test('a paired device outside the family (e.g. a delegated Station) gets no feed', async () => {
    const outsider = {
      ...PERSON,
      deviceId: 'no-read-scope',
      deviceKind: 'device' as const,
    };
    const refused = await feed('after=0', outsider);
    expect(refused.status).toBe(403);
    expect(refused.json.error).toBe('device_not_eligible');
    // It never occupies a feed slot.
    expect(desktopHost.registrations()).toEqual([]);
  });

  test('a remote person (not this machine, not a device) is refused', async () => {
    const result = await feed('after=0', PERSON, INSTALLATION);
    expect(result.status).toBe(403);
    expect(desktopHost.registrations()).toEqual([]);
  });

  test('an internal agent caller is refused', async () => {
    const result = await feed(
      'after=0',
      { ...LOCAL, kind: 'internal' },
      INSTALLATION,
    );
    expect(result.status).toBe(403);
    // Refused by the person-only guard, not by the feed's own eligibility.
    expect(result.json.error).toBe('person_required');
  });

  test.each(['after=-1', 'after=abc', 'after=0&epoch=not%20an%20id'])(
    'a malformed query is 400 (%s)',
    async (query) => {
      expect((await feed(query, LOCAL, INSTALLATION)).status).toBe(400);
    },
  );
});
