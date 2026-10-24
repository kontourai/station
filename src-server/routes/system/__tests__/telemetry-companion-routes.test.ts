import type {
  TelemetryCompanionAction,
  TelemetryCompanionArchivePreparation,
  TelemetryCompanionInstallation,
  TelemetryCompanionManagedState,
  TelemetryCompanionPrerequisites,
} from '@kontourai/station-contracts/telemetry-delivery';
import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import { requiredPairingScope } from '../../../security/pairing-route-scopes.js';
import { CompanionArchivePreparationUnsupportedError } from '../../../services/telemetry-companion-archive.js';
import { CompanionControlRefusal } from '../../../services/telemetry-companion-control.js';
import { CompanionInstallationRefusal } from '../../../services/telemetry-companion-install.js';
import { createTelemetryCompanionRoutes } from '../telemetry-companion-routes.js';

const unavailable: TelemetryCompanionPrerequisites = {
  kind: 'unavailable',
  checkedAt: '2026-10-23T00:00:00.000Z',
  reason: 'container-daemon-unavailable',
};

function fixture(prerequisites = vi.fn(async () => unavailable)) {
  let operator = false;
  const managedState = vi.fn(
    async (): Promise<TelemetryCompanionManagedState> => ({
      supported: true,
      hasOperationLock: false,
      installation: null,
      latestAction: null,
      runtime: 'not-installed',
      storage: 'not-checked',
      observedAt: '2026-10-24T00:00:00.000Z',
    }),
  );
  const control = vi.fn(
    async (
      _request: Request,
      _installationId: string,
      _operationId: string,
      _action: 'start' | 'stop',
    ): Promise<TelemetryCompanionAction> => {
      throw new CompanionControlRefusal('custody-mismatch');
    },
  );
  const action = vi.fn(
    async (
      _installationId: string,
      _operationId: string,
    ): Promise<TelemetryCompanionAction | null> => null,
  );
  const install = vi.fn(
    async (
      _request: Request,
      _installationId: string,
      _preparationId: string,
    ): Promise<TelemetryCompanionInstallation> => {
      throw new CompanionInstallationRefusal('qualification-required');
    },
  );
  const installation = vi.fn(
    async (_id: string): Promise<TelemetryCompanionInstallation | null> => null,
  );
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
      managedState,
      control,
      action,
      install,
      installation,
      prepareArchive,
      archivePreparation,
    }),
  );
  return {
    prerequisites,
    managedState,
    control,
    action,
    install,
    installation,
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

test('managed actions accept only start/stop intent and refuse stale authority across reads or mutation results', async () => {
  const h = fixture();
  const installationId = '01234567-89ab-4cde-8fab-0123456789ab';
  const operationId = '11234567-89ab-4cde-8fab-0123456789ab';
  const path = `/api/operator/telemetry-companion/installations/${installationId}/actions`;
  const statePath = '/api/operator/telemetry-companion/installations';
  const post = (body: unknown) =>
    h.app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  expect((await post({ operationId, action: 'start' })).status).toBe(403);
  expect((await h.app.request(statePath)).status).toBe(403);
  expect(h.control).not.toHaveBeenCalled();
  expect(h.managedState).not.toHaveBeenCalled();
  expect(requiredPairingScope('POST', path)).toBe('telemetry:manage');
  h.setOperator(true);
  for (const input of [
    { operationId, action: 'delete' },
    { operationId, action: 'start', command: 'docker' },
    { operationId, action: 'stop', url: 'http://caller.test' },
    { operationId: '../escape', action: 'start' },
  ])
    expect((await post(input)).status).toBe(400);
  expect(h.control).not.toHaveBeenCalled();
  const refused = await post({ operationId, action: 'start' });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({
    error: { code: 'companion_control_refused', reason: 'custody-mismatch' },
  });
  const receipt: TelemetryCompanionAction = {
    protocol: 'station-companion-action/v1',
    installationId,
    operationId,
    action: 'start',
    phase: 'completed',
    createdAt: '2026-10-24T00:00:00.000Z',
    configuresSending: false,
  };
  h.control.mockImplementationOnce(async () => {
    h.setOperator(false);
    return receipt;
  });
  expect((await post({ operationId, action: 'start' })).status).toBe(403);
  h.setOperator(true);
  h.control.mockResolvedValueOnce(receipt);
  expect(await (await post({ operationId, action: 'start' })).json()).toEqual({
    data: receipt,
  });
  expect((await h.app.request(`${path}/${operationId}`)).status).toBe(404);
  h.action.mockImplementationOnce(async () => {
    h.setOperator(false);
    return receipt;
  });
  expect((await h.app.request(`${path}/${operationId}`)).status).toBe(403);
  h.setOperator(true);
  h.managedState.mockImplementationOnce(async () => {
    h.setOperator(false);
    return {
      supported: true,
      hasOperationLock: false,
      installation: null,
      latestAction: null,
      runtime: 'not-installed',
      storage: 'not-checked',
      observedAt: '2026-10-24T00:00:00.000Z',
    };
  });
  expect((await h.app.request(statePath)).status).toBe(403);
});

test('installation routes require explicit host/storage intent and current human operator authority across async results', async () => {
  const h = fixture();
  const path = '/api/operator/telemetry-companion/installations';
  const installationId = '01234567-89ab-4cde-8fab-0123456789ab';
  const preparationId = '11234567-89ab-4cde-8fab-0123456789ab';
  const input = {
    installationId,
    preparationId,
    host: 'selected-station',
    storage: 'managed-docker-volumes',
  };
  const post = (body: unknown) =>
    h.app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  expect((await post(input)).status).toBe(403);
  expect((await h.app.request(`${path}/${installationId}`)).status).toBe(403);
  expect(h.install).not.toHaveBeenCalled();
  expect(requiredPairingScope('POST', path)).toBe('telemetry:manage');
  h.setOperator(true);
  for (const extra of [
    { url: 'https://caller.test' },
    { command: 'docker' },
    { keys: {} },
    { host: 'another-host' },
    { storage: '/caller/path' },
  ])
    expect((await post({ ...input, ...extra })).status).toBe(400);
  expect((await post({ installationId, preparationId })).status).toBe(400);
  expect(h.install).not.toHaveBeenCalled();
  const refused = await post(input);
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({
    error: {
      code: 'companion_installation_refused',
      reason: 'qualification-required',
    },
  });
  h.install.mockRejectedValueOnce(
    new CompanionInstallationRefusal('unsupported'),
  );
  expect((await post(input)).status).toBe(501);
  const receipt: TelemetryCompanionInstallation = {
    ...input,
    host: 'selected-station',
    storage: 'managed-docker-volumes',
    protocol: 'station-companion-installation/v1',
    phase: 'installed',
    source: 'a'.repeat(40),
    version: '0.7.0',
    architecture: 'arm64',
    createdAt: '2026-10-24T00:00:00.000Z',
    configuresSending: false,
  };
  h.install.mockImplementationOnce(async () => {
    h.setOperator(false);
    return receipt;
  });
  expect((await post(input)).status).toBe(403);
  h.setOperator(true);
  h.install.mockResolvedValueOnce(receipt);
  const created = await post(input);
  expect(created.status).toBe(200);
  expect(created.headers.get('cache-control')).toBe('no-store');
  expect(await created.json()).toEqual({ data: receipt });
  expect((await h.app.request(`${path}/${installationId}`)).status).toBe(404);
  h.installation.mockImplementationOnce(async () => {
    h.setOperator(false);
    return receipt;
  });
  expect((await h.app.request(`${path}/${installationId}`)).status).toBe(403);
});

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
