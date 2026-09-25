import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import {
  type RuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { FocusPresence } from '../../../services/presence/focus-presence.js';
import { createFocusPresenceRoutes } from '../focus-presence-routes.js';

const TAB = '0f0e0d0c-0b0a-4908-8706-050403020100';
const DEVICES: Record<string, { id: string; kind?: string }> = {
  'phone-credential': { id: 'phone', kind: 'device' },
  'peer-station-credential': { id: 'peer', kind: 'delegation' },
};

const operator: RuntimeAuthenticatedRequestPrincipal = {
  kind: 'credential',
  credential: 'operator-credential-value',
  authority: 'operator-credential',
  source: 'bearer',
};
const phone: RuntimeAuthenticatedRequestPrincipal = {
  kind: 'credential',
  credential: 'phone-credential',
  authority: 'device-credential',
  deviceId: 'phone',
  source: 'session',
};

function harness(principal: RuntimeAuthenticatedRequestPrincipal | undefined) {
  const presence = new FocusPresence({ now: () => 5_000 });
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (principal)
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, principal);
    await next();
  });
  app.route(
    '/api/presence',
    createFocusPresenceRoutes({
      presence,
      identifyDevice: (credential) => DEVICES[credential] ?? null,
    }),
  );
  const post = (body: unknown) =>
    app.request('/api/presence/focus', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { presence, post };
}

describe('POST /api/presence/focus', () => {
  test('a paired device reports on its device surface', async () => {
    const { presence, post } = harness(phone);
    const response = await post({ clientSessionId: TAB, state: 'focused' });
    expect(response.status).toBe(204);
    expect([...presence.snapshot().keys()]).toEqual(['device:phone']);
  });

  test('the operator credential reports on the local surface of its document', async () => {
    const { presence, post } = harness(operator);
    expect(
      (await post({ clientSessionId: TAB, state: 'visible' })).status,
    ).toBe(204);
    expect(presence.snapshot().get(`local:${TAB}`)?.state).toBe('visible');
  });

  test('a device credential cannot land on a local surface, nor the operator on a device', async () => {
    const device = harness(phone);
    await device.post({ clientSessionId: TAB, state: 'focused' });
    expect(device.presence.snapshot([`local:${TAB}`]).size).toBe(0);

    const local = harness(operator);
    await local.post({ clientSessionId: TAB, state: 'focused' });
    expect(
      [...local.presence.snapshot().keys()].some((id) =>
        id.startsWith('device:'),
      ),
    ).toBe(false);
  });

  test('the body cannot choose the surface', async () => {
    const { presence, post } = harness(phone);
    for (const extra of [
      { surfaceId: `local:${TAB}` },
      { surfaceId: 'device:laptop' },
      { deviceId: 'laptop' },
    ]) {
      const response = await post({
        clientSessionId: TAB,
        state: 'focused',
        ...extra,
      });
      expect(response.status).toBe(400);
    }
    expect(presence.snapshot().size).toBe(0);
  });

  test('a revoked device, a delegation grant, the internal token and an unauthenticated request are refused', async () => {
    for (const principal of [
      { ...phone, credential: 'revoked-credential' },
      { ...phone, credential: 'peer-station-credential', deviceId: 'peer' },
      {
        kind: 'internal',
        credential: 'internal-token',
        authority: undefined,
        source: 'bearer',
      } satisfies RuntimeAuthenticatedRequestPrincipal,
      undefined,
    ]) {
      const { presence, post } = harness(principal);
      const response = await post({ clientSessionId: TAB, state: 'focused' });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'focus_surface_unavailable',
      });
      expect(presence.snapshot().size).toBe(0);
    }
  });

  test('malformed reports are rejected before they reach presence', async () => {
    const { presence, post } = harness(phone);
    for (const body of [
      'not json',
      '[]',
      'null',
      { state: 'focused' },
      { clientSessionId: 'not-a-uuid', state: 'focused' },
      { clientSessionId: TAB, state: 'asleep' },
      { clientSessionId: TAB },
      JSON.stringify({
        clientSessionId: TAB,
        state: 'focused',
        pad: 'x'.repeat(600),
      }),
    ]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(presence.snapshot().size).toBe(0);
  });

  test('a surface over its report rate gets 429 with Retry-After', async () => {
    const { post } = harness(phone);
    let last: Response | undefined;
    for (let index = 0; index < 31; index += 1) {
      last = await post({ clientSessionId: TAB, state: 'focused' });
    }
    expect(last?.status).toBe(429);
    expect(last?.headers.get('retry-after')).toBe('60');
  });
});
