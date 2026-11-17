/**
 * The routes' person-only rule with the production check (no injected
 * `isPersonRequest`): the runtime auth boundary's principal binding and the
 * real agent-origin signals decide. An agent-origin header, Station's internal
 * principal and an unauthenticated request are refused on every route before
 * anything is read or sent; the operator in person is admitted.
 */

import { remoteTaskAcknowledgementStatement } from '@kontourai/station-contracts/remote-task-engine';
import { Hono } from 'hono';
import { afterEach, describe, expect, test } from 'vitest';
import {
  type RuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { harness } from '../../../services/remote-task-engines/__tests__/harness.js';
import { devinFake } from '../../../services/remote-task-engines/__tests__/vendor-fakes.js';
import { RemoteTaskTracker } from '../../../services/remote-task-engines/tracker.js';
import {
  STATION_CONTROL_ORIGIN_AGENT_TOOL,
  STATION_CONTROL_ORIGIN_HEADER,
} from '../../../tools/station-control-shared.js';
import { createLogger } from '../../../utils/logger.js';
import { createRemoteTaskEngineRoutes } from '../remote-task-engine-routes.js';

const ORG = 'org-aaaaaaaaaaaa';
const OPERATOR: RuntimeAuthenticatedRequestPrincipal = {
  credential: 'operator-credential',
  authority: 'operator-credential',
  source: 'bearer',
};
const INTERNAL: RuntimeAuthenticatedRequestPrincipal = {
  kind: 'internal',
  credential: 'station-internal',
  authority: 'operator-credential',
  source: 'bearer',
};

const trackers: RemoteTaskTracker[] = [];
afterEach(() => {
  while (trackers.length > 0) trackers.pop()?.stop();
});

function setup() {
  const devin = devinFake(ORG);
  const h = harness(devin.fake.fetch);
  const tracker = new RemoteTaskTracker({
    service: h.service,
    logger: createLogger({ name: 'remote-task-authority-test' }),
    setTimer: () => 0,
    clearTimer: () => {},
  });
  trackers.push(tracker);
  // The production check: no `isPersonRequest` override.
  const routes = createRemoteTaskEngineRoutes({
    service: h.service,
    tracker,
    logger: createLogger({ name: 'remote-task-authority-test' }),
  });
  const as = {
    principal: OPERATOR as RuntimeAuthenticatedRequestPrincipal | null,
  };
  const app = new Hono();
  // Stands in for the runtime auth boundary, which binds the principal.
  app.use('*', async (c, next) => {
    if (as.principal)
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, as.principal);
    await next();
  });
  app.route('/', routes);
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  return { h, devin, as, call };
}

function everyRoute(id: string, taskId: string) {
  return [
    ['GET', '/connections'],
    ['POST', '/connections', { vendor: 'devin', settings: { orgId: ORG } }],
    ['GET', `/connections/${id}`],
    ['PATCH', `/connections/${id}`, { label: 'x' }],
    ['DELETE', `/connections/${id}`],
    [
      'POST',
      `/connections/${id}/acknowledgement`,
      { statement: remoteTaskAcknowledgementStatement('devin') },
    ],
    ['DELETE', `/connections/${id}/acknowledgement`],
    [
      'PUT',
      `/connections/${id}/credential`,
      { token: 'cog_token_value_0000001' },
    ],
    ['DELETE', `/connections/${id}/credential`],
    ['GET', `/connections/${id}/tasks`],
    ['POST', `/connections/${id}/tasks`, { prompt: 'Go' }],
    ['GET', `/connections/${id}/tasks/${taskId}`],
    ['POST', `/connections/${id}/tasks/${taskId}/messages`, { text: 'More' }],
    ['POST', `/connections/${id}/tasks/${taskId}/cancel`],
    ['POST', `/connections/${id}/tasks/${taskId}/sync`],
    ['GET', `/connections/${id}/tasks/${taskId}/events?after=0`],
  ] as Array<[string, string, unknown?]>;
}

describe('remote task routes: who may call, with the production check', () => {
  test.each([
    ['an agent-origin header on the operator credential', OPERATOR, true],
    ["Station's internal principal", INTERNAL, false],
    ['an unauthenticated request', null, false],
  ] as const)(
    '%s is refused on every route and nothing is sent',
    async (_label, principal, agentHeader) => {
      const s = setup();
      // A ready connection, set up by the operator in person.
      const created = await s.call('POST', '/connections', {
        vendor: 'devin',
        settings: { orgId: ORG },
      });
      expect(created.status).toBe(201);
      const id = (created.body.data as { id: string }).id;
      await s.call('POST', `/connections/${id}/acknowledgement`, {
        statement: remoteTaskAcknowledgementStatement('devin'),
      });
      await s.call('PUT', `/connections/${id}/credential`, {
        token: 'cog_token_value_0000001',
      });
      s.as.principal = principal;
      const headers: Record<string, string> = agentHeader
        ? { [STATION_CONTROL_ORIGIN_HEADER]: STATION_CONTROL_ORIGIN_AGENT_TOOL }
        : {};
      for (const [method, path, body] of everyRoute(id, 'devin-000000000001')) {
        const answer = await s.call(method, path, body, headers);
        expect(answer.status, `${method} ${path}`).toBe(403);
        expect(answer.body.code, `${method} ${path}`).toBe(
          'remote-task-not-granted',
        );
      }
      expect(s.devin.fake.requests).toHaveLength(0);
      s.as.principal = OPERATOR;
      expect((await s.call('GET', `/connections/${id}`)).status).toBe(200);
    },
  );

  test('the operator in person is admitted', async () => {
    const s = setup();
    const created = await s.call('POST', '/connections', {
      vendor: 'devin',
      settings: { orgId: ORG },
    });
    expect(created.status).toBe(201);
    expect((await s.call('GET', '/connections')).status).toBe(200);
  });
});
