import { isWellFormedContributionProjection } from '@kontourai/station-contracts/contribution';
import { describe, expect, test, vi } from 'vitest';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import {
  createProjectContributionRoutes,
  delegationContributionQueryAuthorized,
} from '../project-contribution-routes.js';

const QUERY_BODY = { portableProjectId: 'prj_shared', resourceId: 'repo' };

function postQuery(body: unknown = QUERY_BODY) {
  return {
    method: 'POST' as const,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('project contribution routes', () => {
  const body = QUERY_BODY;
  test('query and mutation use separate receiver and local-operator authorities', async () => {
    const service = {
      query: vi.fn(async () => ({ ok: true })),
      setExecutionOffer: vi.fn(async () => ({ enabled: true })),
    };
    const denied = createProjectContributionRoutes(service as never, {
      canManage: () => false,
      canQuery: () => false,
    });
    expect(
      (
        await denied.request('/query', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await denied.request('/offer', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...body,
            localProjectId: 'local',
            expected: null,
            enabled: true,
          }),
        })
      ).status,
    ).toBe(403);
    expect(service.query).not.toHaveBeenCalled();
    const allowed = createProjectContributionRoutes(service as never, {
      canManage: () => true,
      canQuery: () => true,
    });
    expect(
      (
        await allowed.request('/query', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(200);
  });

  test.each([
    ['delegation', true, true],
    ['device', true, false],
    ['delegation', false, false],
  ] as const)(
    'query authority requires current delegation transport (%s, current=%s)',
    (kind, current, expected) => {
      const request = new Request(
        'https://station.example/api/project-contributions/query',
        { method: 'POST' },
      );
      setRuntimeAuthenticatedRequestPrincipal(request, {
        credential: 'receiver-bearer',
        authority: 'device-credential',
        deviceId: 'device-1',
        source: 'bearer',
      });
      expect(
        delegationContributionQueryAuthorized(request, {
          current: () => current,
          identify: () => ({ id: 'device-1', kind }),
        }),
      ).toBe(expected);
    },
  );
});

describe('project contribution query release boundary', () => {
  const PROJECTION = {
    schemaVersion: 'station.contribution/v1' as const,
    scope: { kind: 'project' as const, projectId: 'prj_shared' },
    projectedAt: '2026-09-20T12:00:00.000Z',
    sourceObservedAt: null,
    participation: 'contributed-unavailable' as const,
    execution: [{ repoId: 'repo', bound: false, verifiedAt: null }],
    agents: [],
    inference: [],
    diagnostics: [
      {
        axis: 'execution' as const,
        resourceId: 'repo',
        code: 'contribution-unavailable-resource' as const,
        message: 'The offered Project resource is unavailable.',
      },
    ],
  };

  test('the projection body is the contract shape (validator, not invention)', () => {
    expect(isWellFormedContributionProjection(PROJECTION)).toBe(true);
  });

  test('a credential revoked while the ready projection is queued is refused BEFORE body release', async () => {
    let release!: (value: unknown) => void;
    const service = {
      query: vi.fn(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      ),
      setExecutionOffer: vi.fn(),
    };
    let current = true;
    const app = createProjectContributionRoutes(service as never, {
      canManage: () => false,
      canQuery: () => current,
    });
    const pending = app.request('/query', postQuery());
    await vi.waitFor(() => expect(service.query).toHaveBeenCalledTimes(1));
    current = false;
    release(PROJECTION);
    const response = await pending;
    // The release guard re-checked the CURRENT credential after the service
    // resolved and refused the whole response — the 200 the service built
    // never becomes observable.
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toMatchObject({
      success: false,
    });
  });

  test('a credential revoked after the guard admits but before body consumption fails the stream', async () => {
    const service = {
      query: vi.fn(async () => PROJECTION),
      setExecutionOffer: vi.fn(),
    };
    let current = true;
    const app = createProjectContributionRoutes(service as never, {
      canManage: () => false,
      canQuery: () => current,
    });
    const response = await app.request('/query', postQuery());
    // Admitted at release entry — the projection is on its way out.
    expect(response.status).toBe(200);
    // Revoked before the body is CONSUMED: the guard's per-chunk recheck
    // fails the stream instead of delivering a projection to a credential
    // that no longer exists.
    current = false;
    await expect(response.text()).rejects.toThrow(
      'Project authorization ended before response delivery.',
    );
  });
});
