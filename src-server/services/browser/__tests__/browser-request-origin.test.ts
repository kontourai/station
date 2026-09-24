/**
 * The browser routes' request-origin predicates (#90 review S4, S7), against
 * the REAL runtime principal stamps the security middleware writes:
 *  - the Browser pane's human routes refuse Station's internal principal
 *    (an agent holding the internal token stood as the operator there);
 *  - the browser tools' REST side answers ONLY the internal principal;
 *  - a request that may be an agent's cannot change the D4 permission.
 */
import { describe, expect, test, vi } from 'vitest';
import { createBrowserRoutes } from '../../../routes/browser.js';
import { createBrowserAgentRoutes } from '../../../routes/browser-agent.js';
import {
  type RuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import {
  STATION_CONTROL_ORIGIN_AGENT_TOOL,
  STATION_CONTROL_ORIGIN_HEADER,
} from '../../../tools/station-control-shared.js';
import {
  isStationInternalRequest,
  mayBeAgentRequest,
} from '../browser-request-origin.js';

/** The exact stamp the runtime writes for the per-boot internal token. */
const INTERNAL: RuntimeAuthenticatedRequestPrincipal = {
  kind: 'internal',
  credential: 'internal-token',
  authority: undefined,
  source: 'bearer',
  locality: 'home-possession',
};
const OPERATOR: RuntimeAuthenticatedRequestPrincipal = {
  kind: 'credential',
  credential: 'operator-secret',
  authority: 'operator-credential',
  source: 'bearer',
};
const DEVICE: RuntimeAuthenticatedRequestPrincipal = {
  kind: 'credential',
  credential: 'device-secret',
  authority: 'device-credential',
  deviceId: 'dev-1',
  source: 'bearer',
};

function stamped(
  principal: RuntimeAuthenticatedRequestPrincipal | undefined,
  init: RequestInit & { path?: string } = {},
): Request {
  const request = new Request(`http://station.test${init.path ?? '/'}`, init);
  if (principal) setRuntimeAuthenticatedRequestPrincipal(request, principal);
  return request;
}

const identify =
  (kind: string | undefined) =>
  (_credential: string): { kind?: string } | undefined =>
    kind ? { kind } : undefined;

describe('isStationInternalRequest', () => {
  test('is true only for the internal principal stamp', () => {
    expect(isStationInternalRequest(stamped(INTERNAL))).toBe(true);
    expect(isStationInternalRequest(stamped(OPERATOR))).toBe(false);
    expect(isStationInternalRequest(stamped(DEVICE))).toBe(false);
    expect(isStationInternalRequest(stamped(undefined))).toBe(false);
  });
});

describe('mayBeAgentRequest', () => {
  test('the internal principal, an agent-tool marker, or a delegation device may be an agent', () => {
    expect(mayBeAgentRequest(stamped(INTERNAL), identify(undefined))).toBe(
      true,
    );
    expect(
      mayBeAgentRequest(
        stamped(OPERATOR, {
          headers: {
            [STATION_CONTROL_ORIGIN_HEADER]: STATION_CONTROL_ORIGIN_AGENT_TOOL,
          },
        }),
        identify(undefined),
      ),
    ).toBe(true);
    expect(mayBeAgentRequest(stamped(DEVICE), identify('delegation'))).toBe(
      true,
    );
  });

  test('an operator credential or a personal device is a person', () => {
    expect(mayBeAgentRequest(stamped(OPERATOR), identify(undefined))).toBe(
      false,
    );
    expect(mayBeAgentRequest(stamped(DEVICE), identify('device'))).toBe(false);
  });
});

describe('the Browser pane routes refuse the internal principal (S4)', () => {
  function paneRoutes() {
    const registry = {
      createSession: vi.fn(),
      getSession: vi.fn(),
      listSessions: vi.fn(() => []),
      navigate: vi.fn(),
      closeSession: vi.fn(),
      reopenSession: vi.fn(),
      navigateHistory: vi.fn(),
      setViewport: vi.fn(),
      getSessionSummary: vi.fn(),
    };
    const acquisition = {
      status: vi.fn(() => ({ state: 'found-system' })),
      startDownload: vi.fn(),
    };
    // The internal token passes the operator check (home possession):
    // exactly why the route must refuse it before authorizing anything.
    const authorizeProject = vi.fn(async () => ({ kind: 'operator' as const }));
    const app = createBrowserRoutes({
      registry: registry as never,
      acquisition: acquisition as never,
      localTargets: { list: vi.fn(() => []) } as never,
      listeners: () => ({ ports: [], hostnames: [] }) as never,
      suggestLocalTargets: async () => ({}) as never,
      authorizeProject,
      authorizeOperator: async () => true,
      resolveProject: () => ({ id: 'p-alpha', slug: 'alpha' }),
      isRequestPrincipalCurrent: () => true,
      isStationInternalRequest,
    });
    return { app, registry, acquisition, authorizeProject };
  }

  test.each([
    ['POST', '/sessions', { projectSlug: 'alpha', url: 'https://x.test/' }],
    [
      'POST',
      '/sessions/bs_00000000-0000-4000-8000-000000000001/navigate',
      { url: 'https://x.test/' },
    ],
    ['DELETE', '/sessions/bs_00000000-0000-4000-8000-000000000001', undefined],
    ['POST', '/acquisition/download', { consent: true }],
    ['GET', '/sessions', undefined],
  ])(
    '%s %s with the internal token is refused and does nothing',
    async (method, path, body) => {
      const h = paneRoutes();
      const response = await h.app.fetch(
        stamped(INTERNAL, {
          path,
          method,
          ...(body
            ? {
                body: JSON.stringify(body),
                headers: { 'content-type': 'application/json' },
              }
            : {}),
        }),
      );
      expect(response.status).toBe(403);
      expect(h.authorizeProject).not.toHaveBeenCalled();
      expect(h.registry.createSession).not.toHaveBeenCalled();
      expect(h.registry.navigate).not.toHaveBeenCalled();
      expect(h.registry.closeSession).not.toHaveBeenCalled();
      expect(h.acquisition.startDownload).not.toHaveBeenCalled();
    },
  );

  test('an operator credential still reaches the route', async () => {
    const h = paneRoutes();
    const response = await h.app.fetch(
      stamped(OPERATOR, { path: '/sessions' }),
    );
    expect(response.status).toBe(200);
  });
});

describe('the browser tools route answers only the internal principal', () => {
  function toolRoutes() {
    const resolveCaller = vi.fn(() => null);
    const app = createBrowserAgentRoutes({
      isInternalRequest: isStationInternalRequest,
      resolveCaller,
      authorizePrincipal: async () => undefined,
      automation: {} as never,
      settings: { evaluateAllowed: () => false },
      browserReady: () => true,
      projectSlug: () => undefined,
      surfaceIdFor: () => undefined,
    });
    return { app, resolveCaller };
  }

  test('an operator credential gets a bare 404 before any caller lookup', async () => {
    const h = toolRoutes();
    const response = await h.app.fetch(
      stamped(OPERATOR, { path: '/status', method: 'POST', body: '{}' }),
    );
    expect(response.status).toBe(404);
    expect(h.resolveCaller).not.toHaveBeenCalled();
  });

  test('the internal principal reaches the caller check', async () => {
    const h = toolRoutes();
    const response = await h.app.fetch(
      stamped(INTERNAL, { path: '/status', method: 'POST', body: '{}' }),
    );
    expect(await response.json()).toMatchObject({
      ok: false,
      code: 'caller-required',
    });
    expect(h.resolveCaller).toHaveBeenCalledTimes(1);
  });
});
