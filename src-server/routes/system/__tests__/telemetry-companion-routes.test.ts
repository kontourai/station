import type {
  TelemetryCompanionArchivePreparation,
  TelemetryCompanionPrerequisites,
} from '@kontourai/station-contracts/telemetry-delivery';
import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import { requiredPairingScope } from '../../../security/pairing-route-scopes.js';
import { CompanionArchivePreparationUnsupportedError } from '../../../services/telemetry-companion-archive.js';
import { createTelemetryCompanionRoutes } from '../telemetry-companion-routes.js';

const unavailable: TelemetryCompanionPrerequisites = {
  kind: 'unavailable',
  checkedAt: '2026-10-23T00:00:00.000Z',
  reason: 'container-daemon-unavailable',
};

function fixture(prerequisites = vi.fn(async () => unavailable)) {
  let operator = false;
  const prepareArchive = vi.fn(
    async (
      _request: Request,
      _operationId: string,
    ): Promise<TelemetryCompanionArchivePreparation> => {
      throw new Error('private download details');
    },
  );
  const archivePreparation = vi.fn(
    async (
      _operationId: string,
    ): Promise<TelemetryCompanionArchivePreparation | null> => null,
  );
  const app = new Hono().route(
    '/api/operator/telemetry-companion',
    createTelemetryCompanionRoutes({
      requireOperator: async () => {
        if (!operator) throw new Error('Operator authority required');
      },
      prerequisites,
      prepareArchive,
      archivePreparation,
    }),
  );
  return {
    prerequisites,
    app,
    prepareArchive,
    archivePreparation,
    setOperator(value: boolean) {
      operator = value;
    },
    request: () =>
      app.request('/api/operator/telemetry-companion/prerequisites'),
  };
}

test('archive preparation requires a person operator and accepts no caller URL or key policy', async () => {
  const h = fixture();
  const path = '/api/operator/telemetry-companion/archive-preparations';
  const operationId = '01234567-89ab-4cde-8fab-0123456789ab';
  const post = (body: unknown) =>
    h.app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  expect((await post({ operationId })).status).toBe(403);
  expect((await h.app.request(`${path}/${operationId}`)).status).toBe(403);
  expect(h.prepareArchive).not.toHaveBeenCalled();
  expect(h.archivePreparation).not.toHaveBeenCalled();
  expect(requiredPairingScope('POST', path)).toBe('telemetry:manage');
  h.setOperator(true);
  expect(
    (await post({ operationId, url: 'https://caller.test/archive' })).status,
  ).toBe(400);
  expect((await post({ operationId, keys: {} })).status).toBe(400);
  expect((await post({ operationId: '../escape' })).status).toBe(400);
  expect(
    (
      await h.app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: ' '.repeat(2048) + JSON.stringify({ operationId }),
      })
    ).status,
  ).toBe(400);
  expect(h.prepareArchive).not.toHaveBeenCalled();
  const response = await post({ operationId });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: { code: 'companion_preparation_unavailable' },
  });
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(h.prepareArchive).toHaveBeenCalledTimes(1);
  h.prepareArchive.mockRejectedValueOnce(
    new CompanionArchivePreparationUnsupportedError(),
  );
  const unsupported = await post({ operationId });
  expect(unsupported.status).toBe(501);
  expect(await unsupported.json()).toEqual({
    error: { code: 'companion_preparation_unsupported' },
  });
  expect((await h.app.request(`${path}/${operationId}`)).status).toBe(404);
});

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
