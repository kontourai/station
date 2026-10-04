import {
  PAIRING_SCOPE_ORCHESTRATION_OPERATE,
  PAIRING_SCOPE_ORCHESTRATION_READ,
} from '@kontourai/station-contracts/environment-security';
import { type Context, Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import { mayAnswerDelegatedRequest } from '../../../runtime/routes/runtime-attention-route-options.js';
import {
  type RuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { createOrchestrationRoutes } from '../orchestration.js';

/**
 * `delegatedInputAnswers`: the serving Station tells the reader of a
 * delegated task whether ITS credential passes the gates of the route that
 * answers the open request — `continue` for an input question, `respond`
 * for a decision — computed from the reader's real granted pairing scope.
 * A forwarded read (`environmentId`) is never decorated here: the serving
 * Station decorates it about this Station's own credential.
 */
const READ_DEVICE = 'read-device';
const OPERATE_DEVICE = 'operate-device';

const security = {
  authorizeCredential: () => true,
  resolveGrantedScope: (credential: string) =>
    credential === READ_DEVICE
      ? PAIRING_SCOPE_ORCHESTRATION_READ
      : `${PAIRING_SCOPE_ORCHESTRATION_READ} ${PAIRING_SCOPE_ORCHESTRATION_OPERATE}`,
};

function principal(credential: string): RuntimeAuthenticatedRequestPrincipal {
  return {
    kind: 'credential',
    credential,
    authority: 'device-credential',
    deviceId: `device-${credential}`,
    deviceKind: 'device',
    source: 'bearer',
  };
}

async function read(
  credential: string,
  requestType: string,
  query = '',
): Promise<Record<string, unknown> | undefined> {
  const routes = createOrchestrationRoutes(
    {} as never,
    {
      eventBus: { subscribe: () => () => {} } as never,
      logger: { debug: vi.fn() },
      getUserId: () => 'default',
      observeDelegatedTask: async () => ({
        taskId: 'task-1',
        status: 'needs_input',
        pendingRequest: { id: 'request-1', type: requestType },
      }),
      callerMayAnswerDelegatedRequest: (
        c: Context,
        taskId: string,
        type: string | undefined,
      ) =>
        mayAnswerDelegatedRequest(
          { security, stationControlDispatchScope: undefined },
          c,
          taskId,
          type,
          false,
        ),
    } as never,
  );
  const app = new Hono();
  app.use('*', async (c, next) => {
    setRuntimeAuthenticatedRequestPrincipal(c.req.raw, principal(credential));
    await next();
  });
  app.route('/', routes);
  const response = await app.request(`/delegations/task-1${query}`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: { pendingRequest?: Record<string, unknown> };
  };
  return body.data.pendingRequest;
}

test('a device granted orchestration operate may answer an input question', async () => {
  expect((await read(OPERATE_DEVICE, 'input'))?.callerCanRespond).toBe(true);
});

test('a read-scoped device may not answer or decide', async () => {
  expect((await read(READ_DEVICE, 'input'))?.callerCanRespond).toBe(false);
  expect((await read(READ_DEVICE, 'approval'))?.callerCanRespond).toBe(false);
});

test('a forwarded read is left for the serving Station to decorate', async () => {
  expect(
    await read(OPERATE_DEVICE, 'input', '?environmentId=environment-remote'),
  ).not.toHaveProperty('callerCanRespond');
});
