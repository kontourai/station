import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  type EnrollmentActor,
  SourceEnrollmentStore,
} from '../../../analytics/source-enrollment-store.js';
import { requiredPairingScope } from '../../../security/pairing-route-scopes.js';
import { AuthorityObservationRejected } from '../../../services/identity/authority-observation.js';
import { createSourceEnrollmentRoutes } from '../source-enrollments.js';

const temporary = trackTempDirs();
const base = '/api/analytics/source-enrollments';
const operationId = '01234567-89ab-4cde-8fab-0123456789ab';
const now = Date.parse('2026-10-24T00:00:00.000Z');
const input = {
  operationId,
  proposedDestination: {
    stationId: 'destination-station',
    origin: 'https://destination.example.test',
  },
  scope: 'individual',
  expiresAt: '2026-10-25T00:00:00.000Z',
  retention: { mode: 'live-mirror' },
};
function fixture(home = temporary('source-enrollment-')) {
  let current = {
    userId: 'human:tailscale:alice',
    mode: 'hosted' as const,
    tenantId: 'tenant-a',
  };
  let permitted = true;
  const store = new SourceEnrollmentStore(home, () => now);
  const app = new Hono().route(
    '/api/analytics/source-enrollments',
    createSourceEnrollmentRoutes({
      store,
      // Trusted ingress is supplied by this fixture. These cases exercise the
      // real proposal store, owner isolation and release guard, not runtime login.
      capture: async () => {
        if (!permitted)
          throw new AuthorityObservationRejected(403, 'authority_changed');
        const captured = { ...current };
        const actor: EnrollmentActor = {
          ...captured,
          sourceStationId: 'source-station',
          ownerIds: [captured.userId],
          async assertCurrent() {
            if (
              !permitted ||
              JSON.stringify(current) !== JSON.stringify(captured)
            )
              throw new AuthorityObservationRejected(403, 'authority_changed');
          },
        };
        return actor;
      },
    }),
  );
  return {
    home,
    app,
    setUser(userId: string) {
      current = { ...current, userId };
    },
    setTenant(tenantId: string) {
      current = { ...current, tenantId };
    },
    deny() {
      permitted = false;
    },
    post(body: unknown = input) {
      return app.request(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    },
  };
}

test('enrollment proposals persist without export authority, recover the same intent and remain scoped to the verified person and tenant', async () => {
  const h = fixture();
  expect(requiredPairingScope('POST', base)).toBe('orchestration:read');
  expect(requiredPairingScope('DELETE', `${base}/${operationId}`)).toBe(
    'orchestration:read',
  );
  for (const extra of [
    { userId: 'foreign' },
    { tenantId: 'foreign' },
    { exportAuthority: true },
    { destinationVerified: true },
  ])
    expect((await h.post({ ...input, ...extra })).status).toBe(400);
  const created = await h.post();
  expect(created.status).toBe(200);
  expect(created.headers.get('cache-control')).toBe('no-store');
  const receipt = await created.json();
  expect(receipt).toMatchObject({
    data: {
      protocol: 'station-analytics-source-enrollment-intent/v1',
      sourceStationId: 'source-station',
      phase: 'prepared',
      exportAuthority: false,
      destinationVerified: false,
    },
  });
  expect(receipt).not.toHaveProperty('data.credential');
  expect(
    (
      await h.post({
        ...input,
        proposedDestination: {
          stationId: 'different',
          origin: input.proposedDestination.origin,
        },
      })
    ).status,
  ).toBe(409);
  const second = fixture(h.home);
  expect(await (await second.post()).json()).toEqual(receipt);
  expect(await (await second.app.request(base)).json()).toEqual({
    data: [expect.objectContaining({ operationId })],
  });
  h.setUser('human:tailscale:bob');
  expect((await h.app.request(`${base}/${operationId}`)).status).toBe(404);
  expect(await (await h.app.request(base)).json()).toEqual({ data: [] });
  h.setUser('human:tailscale:alice');
  h.setTenant('tenant-b');
  expect((await h.app.request(`${base}/${operationId}`)).status).toBe(404);
  expect(
    (await h.app.request(`${base}/${operationId}`, { method: 'DELETE' }))
      .status,
  ).toBe(404);
  h.setTenant('tenant-a');
  expect((await h.app.request(`${base}/${operationId}`)).status).toBe(200);
  const cancelled = await second.app.request(`${base}/${operationId}`, {
    method: 'DELETE',
  });
  expect(await cancelled.json()).toMatchObject({
    data: { phase: 'cancelled', exportAuthority: false },
  });
  expect(
    await (await h.app.request(`${base}/${operationId}`)).json(),
  ).toMatchObject({ data: { phase: 'cancelled' } });
  expect(await (await h.post()).json()).toMatchObject({
    data: { phase: 'cancelled' },
  });
});

test('queued proposal reads stop after authority loss and corrupt private records are retained instead of reset', async () => {
  const h = fixture();
  expect((await h.post()).status).toBe(200);
  const held = await h.app.request(`${base}/${operationId}`);
  h.deny();
  await expect(held.text()).rejects.toThrow('Authority observation ended');
  expect((await h.app.request(base)).status).toBe(403);
  const current = fixture(h.home);
  const file = join(h.home, 'security/analytics-source-enrollments.json');
  await writeFile(file, 'null', { mode: 0o600 });
  const corrupt = await current.app.request(base);
  expect(corrupt.status).toBe(503);
  expect(await corrupt.json()).toEqual({
    error: { code: 'source_enrollment_unavailable' },
  });
  expect((await current.post()).status).toBe(503);
  expect(await readFile(file, 'utf8')).toBe('null');
});
