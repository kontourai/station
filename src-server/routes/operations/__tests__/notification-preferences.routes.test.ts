import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PAIRING_SCOPE_ORCHESTRATION_OPERATE } from '@kontourai/station-contracts';
import {
  defaultNotificationPreferences,
  NOTIFICATION_PREFERENCES_PATH,
} from '@kontourai/station-contracts/notification-preferences';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  matchPairingScopeRule,
  requiredPairingScope,
} from '../../../security/pairing-route-scopes.js';
import {
  type RuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
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

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'notification-preferences-routes-'));
  app = new Hono();
  app.route(
    '/api/notifications',
    createNotificationPreferencesRoutes(new NotificationPreferencesStore(home)),
  );
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function call(
  method: 'GET' | 'PUT',
  body?: unknown,
  principal: RuntimeAuthenticatedRequestPrincipal = PERSON,
) {
  const request = new Request(
    `http://station.test${NOTIFICATION_PREFERENCES_PATH}`,
    {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: typeof body === 'string' ? body : JSON.stringify(body),
          }),
    },
  );
  setRuntimeAuthenticatedRequestPrincipal(request, principal);
  const response = await app.fetch(request);
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

describe('GET/PUT /api/notifications/preferences', () => {
  test('both verbs sit on the operate tier by an explicit rule', () => {
    for (const method of ['GET', 'PUT']) {
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
    expect(put).toEqual({ status: 200, json: { success: true, data: next } });
    const get = await call('GET');
    expect(get.json).toEqual({ success: true, data: next, stored: true });
  });

  test.each([
    ['an unknown key', { ...defaultNotificationPreferences(), extra: 1 }],
    ['a partial document', { agentNotifications: 'off' }],
    ['malformed JSON', '{not json'],
  ])('PUT refuses %s with 400 and stores nothing', async (_label, body) => {
    const put = await call('PUT', body);
    expect(put).toEqual({
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
