/**
 * #2377 slice C2b: the dispatch routes decide the remote verdict themselves,
 * before they connect or forward anything.
 *
 * The tests bind the same caller authority as the Station Control guard.
 */
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { bindStationControlRequestAuthority } from '../../../security/station-control-request-authority.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { STATION_CONTROL_OPERATOR_PRINCIPAL_ID } from '../../../tools/station-control-policy.js';
import type { StationControlCallerAssurance } from '../../../tools/station-control-shared.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };

function app(assurance: StationControlCallerAssurance | undefined) {
  const discoverDelegationOptions = vi.fn(async () => ({ agents: [] }));
  const listDelegatedTasks = vi.fn(async () => ({ tasks: [] }));
  const routes = createOrchestrationRoutes(
    {} as never,
    {
      eventBus: new EventBus(),
      logger,
      getUserId: () => 'operator',
      discoverDelegationOptions,
      stationControlDispatchScope: {
        ownProjectSlug: () => 'caller-project',
        target: (ref: { projectSlug?: string; ownerId: string }) => ({
          ownerId: ref.ownerId,
          scope: { kind: 'project', id: ref.projectSlug },
          ownerHoldsAction: true,
        }),
      },
      listDelegatedTasks,
    } as never,
  );
  const host = new Hono();
  host.use('*', async (c, next) => {
    if (assurance)
      bindStationControlRequestAuthority(c.req.raw, {
        kind: 'caller',
        caller: {
          sessionId: 'session-1',
          assurance,
          projectIdSource: 'session-record',
          localProjectId: 'caller-project',
          principal: {
            id: STATION_CONTROL_OPERATOR_PRINCIPAL_ID,
            source: 'session-owner',
            elevationEligible: true,
          } as never,
        },
        boundOperator: assurance === 'bound',
      });
    await next();
  });
  host.route('/', routes);
  return { host, discoverDelegationOptions, listDelegatedTasks };
}

test('an ACP caller discovers its own Project targets and cannot inspect another Project', async () => {
  const { host, discoverDelegationOptions } = app('delegated-custody');
  const post = (body: object) =>
    host.request('/delegations/options', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  expect((await post({})).status).toBe(200);
  expect(discoverDelegationOptions).toHaveBeenCalledWith({
    projectSlug: 'caller-project',
  });
  expect((await post({ projectSlug: 'another-project' })).status).toBe(403);
  expect(discoverDelegationOptions).toHaveBeenCalledTimes(1);
});

const requests = [
  [
    'POST /delegations/options',
    (host: Hono, environmentId?: string) =>
      host.request('/delegations/options', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(environmentId ? { environmentId } : {}),
      }),
    'discoverDelegationOptions',
  ],
  [
    'GET /delegations',
    (host: Hono, environmentId?: string) =>
      host.request(
        `/delegations${environmentId ? `?environmentId=${environmentId}` : ''}`,
      ),
    'listDelegatedTasks',
  ],
] as const;

describe('the dispatch routes refuse another Station for a non-operator caller (#2377 C2b)', () => {
  test.each(requests)(
    '%s: a bearer-exposed caller naming a saved Environment is refused before anything runs',
    async (_route, send, dep) => {
      const composed = app('bearer-exposed');
      const response = await send(composed.host, 'env-peer');
      expect(response.status).toBe(403);
      expect(composed[dep]).not.toHaveBeenCalled();
    },
  );

  test.each(requests)(
    '%s: the same caller on this Station, and a bound operator on the saved Environment, pass',
    async (_route, send, dep) => {
      const local = app('bearer-exposed');
      expect((await send(local.host)).status).toBe(200);
      expect(local[dep]).toHaveBeenCalledTimes(1);
      const operator = app('bound');
      expect((await send(operator.host, 'env-peer')).status).toBe(200);
      expect(operator[dep]).toHaveBeenCalledTimes(1);
    },
  );
});
