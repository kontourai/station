import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';
import { createOrchestrationRoutes } from '../orchestration.js';
import { createTaskRoutes } from '../tasks.js';

const occurrenceId = 'occurrence_'.padEnd(32, 'a');
const continuationToken = 'continuation_'.padEnd(32, 'b');
const appResult = {
  status: 'available' as const,
  occurrenceId,
  data: {
    version: 'station.session-inventory-mcp/v1',
    kind: 'projection',
    projection: {},
  },
  continuations: [{ groupId: 'inputs' as const, continuationToken }],
};
const body = (value: unknown) => JSON.stringify(value);

describe('Session inventory App read routes', () => {
  test('direct Session open/page/revoke are opaque no-store and preserve only capability metadata', async () => {
    let principalCurrent = true;
    let aclCurrent = true;
    const module = {
      open: vi.fn(async () => appResult),
      page: vi.fn(async () => appResult),
      revoke: vi.fn(),
    };
    const app = createOrchestrationRoutes(
      { canUserReadSession: () => aclCurrent } as any,
      {
        eventBus: { subscribe: () => () => {} },
        logger: { debug: vi.fn() },
        getUserId: () => 'fixture-user',
        isRequestPrincipalCurrent: () => principalCurrent,
        callerBindingForRequest: () => 'caller_'.padEnd(32, 'c'),
        sessionInventoryAppRead: module as any,
      },
    );
    const request = (value: unknown, method = 'POST') =>
      app.request('/sessions/session-a/inventory/app-read', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body(value),
      });
    const opened = await request({
      operation: 'open',
      scope: { kind: 'whole-session', sessionId: 'session-a' },
    });
    expect(opened.headers.get('cache-control')).toContain('private, no-store');
    expect(await opened.json()).toEqual({
      success: true,
      data: appResult.data,
      meta: {
        'station.session-inventory-app/v1': {
          occurrenceId,
          continuations: appResult.continuations,
        },
      },
    });
    expect(module.open).toHaveBeenCalledWith(
      expect.objectContaining({
        routeFamily: 'orchestration',
        callerBinding: 'caller_'.padEnd(32, 'c'),
      }),
    );
    await request({
      operation: 'page',
      scope: { kind: 'whole-session', sessionId: 'session-a' },
      occurrenceId,
      groupId: 'inputs',
      continuationToken,
    });
    expect(module.page).toHaveBeenCalledWith(
      expect.objectContaining({
        occurrenceId,
        groupId: 'inputs',
        continuationToken,
      }),
    );
    const revoked = await request({ occurrenceId }, 'DELETE');
    expect(revoked.status).toBe(200);
    expect(module.revoke).toHaveBeenCalledWith(
      expect.objectContaining({ routeFamily: 'orchestration', occurrenceId }),
    );

    principalCurrent = false;
    aclCurrent = false;
    const denied = await request({
      operation: 'open',
      scope: { kind: 'whole-session', sessionId: 'session-a' },
    });
    expect(denied.status).toBe(503);
    expect(await denied.json()).toEqual({
      success: false,
      error: 'Session inventory unavailable',
    });
    expect(module.open).toHaveBeenCalledTimes(2);
  });

  test('Task app read rejects mismatched Task/Session scope and rechecks the Task relation before publication', async () => {
    let relation = true;
    let principalCurrent = true;
    const module = {
      open: vi.fn(async () => appResult),
      page: vi.fn(),
      revoke: vi.fn(),
    };
    const graph = {
      readTask: () => ({ id: 'task-a' }),
      readSessionRelations: () => ({
        links: relation
          ? [
              {
                sourceType: 'task',
                sourceId: 'task-a',
                targetType: 'session',
                targetId: 'session-a',
              },
            ]
          : [],
      }),
    };
    const app = createTaskRoutes(graph as any, {
      taskDispatcher: { dispatch: async () => ({}) } as any,
      readAuthorityForRequest: () =>
        sessionReadAuthorityFromRequest('fixture-user', undefined, undefined),
      canReadSession: (sessionId) => sessionId === 'session-a',
      isRequestPrincipalCurrent: () => principalCurrent,
      callerBindingForRequest: () => 'caller_'.padEnd(32, 'c'),
      sessionInventoryAppRead: module as any,
    });
    const post = (scope: unknown) =>
      app.request('/task-a/sessions/session-a/inventory/app-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body({ operation: 'open', scope }),
      });
    const mismatch = await post({
      kind: 'kept-in-task',
      taskId: 'task-b',
      sessionId: 'session-a',
    });
    expect(mismatch.status).toBe(503);
    expect(module.open).not.toHaveBeenCalled();
    relation = false;
    const drift = await post({
      kind: 'kept-in-task',
      taskId: 'task-a',
      sessionId: 'session-a',
    });
    expect(drift.status).toBe(503);
    relation = true;
    principalCurrent = false;
    const denied = await post({
      kind: 'kept-in-task',
      taskId: 'task-a',
      sessionId: 'session-a',
    });
    expect(denied.status).toBe(503);
  });
});
