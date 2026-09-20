import { describe, expect, test, vi } from 'vitest';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import {
  createProjectContributionRoutes,
  delegationContributionQueryAuthorized,
} from '../project-contribution-routes.js';

describe('project contribution routes', () => {
  const body = { portableProjectId: 'prj_shared', resourceId: 'repo' };
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
