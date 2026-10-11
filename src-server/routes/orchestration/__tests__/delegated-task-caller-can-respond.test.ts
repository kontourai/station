import {
  PAIRING_SCOPE_ORCHESTRATION_OPERATE,
  PAIRING_SCOPE_ORCHESTRATION_READ,
} from '@kontourai/station-contracts/environment-security';
import { type Context, Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { mayAnswerDelegatedRequest } from '../../../runtime/routes/runtime-attention-route-options.js';
import {
  type RuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { bindStationControlRequestAuthority } from '../../../security/station-control-request-authority.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
} from '../../../utils/internal-api-token.js';
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

/**
 * The serving Station judges the two kinds of request on their own routes'
 * dispatch-scope action: an input answer needs `execute`, a decision needs
 * `approve`. A bound, non-operator station-control caller that owns a task in
 * the global space holds `execute` there but never `approve`.
 */
test('a station-control caller is judged on execute for input and approve for a decision', async () => {
  const scope = {
    target: (_ref: unknown, action = 'execute') => ({
      ownerId: 'agent-owner',
      scope: { kind: 'global' },
      host: false,
      remote: false,
      ...(action === 'approve' ? { ownerHoldsAction: false } : {}),
    }),
    conversationExists: () => true,
  };
  async function readAsCaller(requestType: string) {
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
            {
              security: { authorizeCredential: () => true } as never,
              stationControlDispatchScope: scope as never,
            },
            c,
            taskId,
            type,
            false,
          ),
      } as never,
    );
    const app = new Hono();
    app.use('*', async (c, next) => {
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        kind: 'internal',
        credential: 'internal',
        authority: undefined,
        source: 'bearer',
      });
      bindStationControlRequestAuthority(c.req.raw, {
        kind: 'caller',
        caller: {
          sessionId: 'agent-session',
          assurance: 'bound',
          principal: {
            id: 'agent-owner',
            source: 'session-owner',
            elevationEligible: true,
          } as never,
        },
        boundOperator: false,
      });
      await next();
    });
    app.route('/', routes);
    const response = await app.request('/delegations/task-1', {
      headers: { [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken() },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { pendingRequest?: { callerCanRespond?: boolean } };
    };
    return body.data.pendingRequest?.callerCanRespond;
  }
  expect(await readAsCaller('input')).toBe(true);
  expect(await readAsCaller('approval')).toBe(false);
});

describe('the delegated continue route reports binding refusals as closed codes', () => {
  async function post(error: Error & { code?: string }) {
    const routes = createOrchestrationRoutes(
      {} as never,
      {
        eventBus: { subscribe: () => () => {} } as never,
        logger: { debug: vi.fn() },
        getUserId: () => 'default',
        continueDelegatedTask: async () => {
          throw error;
        },
      } as never,
    );
    const response = await routes.request('/delegations/task-1/continue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'Use staging',
        expectedInputRequest: {
          threadId: 'thread-1',
          requestId: 'request-1',
          requestEventId: 'event-1',
        },
      }),
    });
    return {
      status: response.status,
      body: (await response.json()) as { code?: string },
    };
  }
  const coded = (code: string) =>
    Object.assign(new Error(`refused: ${code}`), { code });

  test.each([
    ['input_request_changed', 'input_request_changed'],
    // The engine-invocation recheck's own code is reported in the route's
    // vocabulary, so a sender sees one code for "the request moved on".
    ['request_event_changed', 'input_request_changed'],
    ['input_binding_unsupported', 'input_binding_unsupported'],
  ])('%s answers 409 with code %s', async (thrown, reported) => {
    const result = await post(coded(thrown));
    expect(result.status).toBe(409);
    expect(result.body.code).toBe(reported);
  });

  test('a model change with a binding answers 400 with its code', async () => {
    const result = await post(coded('input_binding_model_change'));
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('input_binding_model_change');
  });

  test('an unrelated failure keeps the plain 400 and no binding code', async () => {
    const result = await post(new Error('something else'));
    expect(result.status).toBe(400);
    expect(result.body.code).toBeUndefined();
  });
});
