import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import {
  getRuntimeAuthenticatedRequestPrincipal,
  type RuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { FocusPresence } from '../../../services/presence/focus-presence.js';
import { createFocusPresenceRoutes } from '../focus-presence-routes.js';

const TAB = '0f0e0d0c-0b0a-4908-8706-050403020100';
const DEVICES: Record<string, { id: string; kind?: string }> = {
  'phone-credential': { id: 'phone', kind: 'device' },
  'peer-station-credential': { id: 'peer', kind: 'delegation' },
  'unbound-credential': { id: 'unbound', kind: 'device' },
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
      resolvePrincipalId: (c) => {
        // Stands in for the runtime's request-principal resolver: whatever
        // it resolves for this credential is what the surface records.
        const found = getRuntimeAuthenticatedRequestPrincipal(c.req.raw);
        if (found?.credential === 'unbound-credential') {
          throw new Error('PrincipalUnresolvedError');
        }
        return `person-of:${found?.credential}`;
      },
    }),
  );
  const post = (body: unknown, header: string | null = TAB) =>
    app.request('/api/presence/focus', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(header === null ? {} : { 'x-station-client-session': header }),
      },
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

  test('the surface carries the principal Station resolved for the caller', async () => {
    const device = harness(phone);
    await device.post({ clientSessionId: TAB, state: 'focused' });
    expect(device.presence.snapshot().get('device:phone')?.principalId).toBe(
      'person-of:phone-credential',
    );
    const local = harness(operator);
    await local.post({ clientSessionId: TAB, state: 'focused' });
    expect(local.presence.snapshot().get(`local:${TAB}`)?.principalId).toBe(
      'person-of:operator-credential-value',
    );
  });

  test('the body must name the same document as the X-Station-Client-Session header', async () => {
    const { presence, post } = harness(phone);
    const other = '99999999-9999-4999-8999-999999999999';
    expect(
      (await post({ clientSessionId: TAB, state: 'focused' }, other)).status,
    ).toBe(400);
    expect(
      (await post({ clientSessionId: TAB, state: 'focused' }, null)).status,
    ).toBe(400);
    expect(presence.snapshot().size).toBe(0);
    expect(
      (
        await post(
          { clientSessionId: TAB, state: 'focused' },
          TAB.toUpperCase(),
        )
      ).status,
    ).toBe(204);
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
      { ...phone, credential: 'unbound-credential', deviceId: 'unbound' },
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

  test('a surface over its report rate gets 429 for a raise, but a hidden still lands', async () => {
    const { presence, post } = harness(phone);
    for (let index = 0; index < 30; index += 1) {
      await post({ clientSessionId: TAB, state: 'visible' });
    }
    const raise = await post({ clientSessionId: TAB, state: 'focused' });
    expect(raise.status).toBe(429);
    expect(raise.headers.get('retry-after')).toBe('60');
    expect((await post({ clientSessionId: TAB, state: 'hidden' })).status).toBe(
      204,
    );
    expect(presence.snapshot().get('device:phone')?.state).toBe('hidden');
  });
});
