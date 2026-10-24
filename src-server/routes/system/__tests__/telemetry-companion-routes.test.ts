import type { TelemetryCompanionPrerequisites } from '@kontourai/station-contracts/telemetry-delivery';
import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import { requiredPairingScope } from '../../../security/pairing-route-scopes.js';
import { createTelemetryCompanionRoutes } from '../telemetry-companion-routes.js';

const unavailable: TelemetryCompanionPrerequisites = {
  kind: 'unavailable',
  checkedAt: '2026-10-23T00:00:00.000Z',
  reason: 'container-daemon-unavailable',
};

function fixture(prerequisites = vi.fn(async () => unavailable)) {
  let operator = false;
  const app = new Hono().route(
    '/api/operator/telemetry-companion',
    createTelemetryCompanionRoutes({
      requireOperator: async () => {
        if (!operator) throw new Error('Operator authority required');
      },
      prerequisites,
    }),
  );
  return {
    prerequisites,
    setOperator(value: boolean) {
      operator = value;
    },
    request: () =>
      app.request('/api/operator/telemetry-companion/prerequisites'),
  };
}

test('a mounted unauthorized prerequisite request cannot launch the host probe', async () => {
  const h = fixture();
  const response = await h.request();
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    error: { code: 'operator_required' },
  });
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(h.prerequisites).not.toHaveBeenCalled();
});

test('an operator sees the explicit unavailable prerequisite result', async () => {
  const h = fixture();
  h.setOperator(true);
  const response = await h.request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: unavailable });
  expect(
    requiredPairingScope(
      'GET',
      '/api/operator/telemetry-companion/prerequisites',
    ),
  ).toBe('orchestration:read');
});

test('authority withdrawn during a host probe cannot disclose the result', async () => {
  const h = fixture(
    vi.fn(async () => {
      h.setOperator(false);
      return unavailable;
    }),
  );
  h.setOperator(true);
  const response = await h.request();
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    error: { code: 'operator_required' },
  });
});

test('an unexpected host probe failure is unavailable and contains no host output', async () => {
  const h = fixture(
    vi.fn(async () => {
      throw new Error('private daemon path');
    }),
  );
  h.setOperator(true);
  const response = await h.request();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: { code: 'companion_probe_unavailable' },
  });
});
