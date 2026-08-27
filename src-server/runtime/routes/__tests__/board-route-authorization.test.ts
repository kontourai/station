import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { describe, expect, test } from 'vitest';
import { createBoardRoutes } from '../../../routes/board.js';
import { BoardStore } from '../../../services/board/board-store.js';
import { createOrchestrationBoardAuthorization } from '../board-route-authorization.js';

/**
 * Delta review micro-round, item 2 (gap, authz-load-bearing): every prior
 * `board.routes.test.ts` authorization test used a hand-rolled stub — the
 * REAL `runtime-routes.ts` composition (`context.orchestrationService
 * .canUserReadSession` + `readAuthorityForRequest` -> `canReadSession`,
 * `context.taskGraphService.readTask` -> `taskExists`) was never exercised,
 * so a swapped-args bug in that ~15-line wiring would be invisible. This
 * file imports the EXTRACTED factory (`createOrchestrationBoardAuthorization`,
 * `board-route-authorization.ts`) — the exact function `runtime-routes.ts`
 * now calls — and proves both halves the review asked for.
 */

const REAL_AUTHORITY: SessionReadAuthority = sessionReadAuthorityFromRequest(
  'authority-marker-user',
  undefined,
  undefined,
);

async function boardStoreFixture() {
  const root = await mkdtemp(join(tmpdir(), 'station-board-authz-wiring-'));
  return new BoardStore(root);
}

describe('createOrchestrationBoardAuthorization — real wiring smoke test', () => {
  /**
   * (b) Argument-order discrimination: the fake `canUserReadSession` only
   * returns `true` when its FIRST argument is the exact sessionId string and
   * its SECOND argument is the exact authority object identity. A
   * swapped-args mutation in `createOrchestrationBoardAuthorization`
   * (`canUserReadSession(authority, sessionId)` instead of `(sessionId,
   * authority)`) makes `args[0] === sessionId` false, so `canUserReadSession`
   * returns `false`, and this test fails — this is a REAL discriminating
   * test, not a shape check that would pass either order.
   */
  test('args reach canUserReadSession in the order (sessionId, authority)', () => {
    const capturedCalls: unknown[][] = [];
    const authorization = createOrchestrationBoardAuthorization({
      orchestrationService: {
        canUserReadSession: (...args: unknown[]) => {
          capturedCalls.push(args);
          return args[0] === 'session-under-test' && args[1] === REAL_AUTHORITY;
        },
      },
      taskGraphService: { readTask: () => null },
      readAuthorityForRequest: () => REAL_AUTHORITY,
    });

    const fakeRequest = new Request(
      'http://localhost/api/board?kind=session&id=session-under-test',
    );
    const result = authorization.canReadSession(
      'session-under-test',
      fakeRequest,
    );

    expect(result).toBe(true);
    expect(capturedCalls).toEqual([['session-under-test', REAL_AUTHORITY]]);
  });

  test('taskExists mirrors the sibling SpatialBoardResolver: existence + exact projectId match', () => {
    const authorization = createOrchestrationBoardAuthorization({
      orchestrationService: { canUserReadSession: () => false },
      taskGraphService: {
        readTask: (taskId: string) =>
          taskId === 'task-1' ? { projectId: 'proj-1' } : null,
      },
      readAuthorityForRequest: () => REAL_AUTHORITY,
    });

    expect(authorization.taskExists('proj-1', 'task-1')).toBe(true);
    expect(authorization.taskExists('other-project', 'task-1')).toBe(false);
    expect(authorization.taskExists('proj-1', 'task-does-not-exist')).toBe(
      false,
    );
  });

  /**
   * (a) End-to-end: the route, wired with the REAL composition (not a
   * hand-rolled stub), refuses a session the real-shaped orchestration
   * service denies — 404, before any store I/O.
   */
  test('a session the orchestration service denies is refused 404 through the route', async () => {
    const store = await boardStoreFixture();
    const authorization = createOrchestrationBoardAuthorization({
      orchestrationService: {
        canUserReadSession: (sessionId: string) =>
          sessionId === 'allowed-session',
      },
      taskGraphService: { readTask: () => null },
      readAuthorityForRequest: () => REAL_AUTHORITY,
    });
    const app = createBoardRoutes(store, authorization);

    const denied = await app.request('/?kind=session&id=denied-session');
    expect(denied.status).toBe(404);
    await expect(denied.json()).resolves.toMatchObject({
      code: 'board_reference_unresolvable',
    });

    const allowed = await app.request('/?kind=session&id=allowed-session');
    expect(allowed.status).toBe(200);
  });

  test('a Task the real composition cannot resolve is refused 404 through the route', async () => {
    const store = await boardStoreFixture();
    const authorization = createOrchestrationBoardAuthorization({
      orchestrationService: { canUserReadSession: () => false },
      taskGraphService: {
        readTask: (taskId: string) =>
          taskId === 'real-task' ? { projectId: 'real-project' } : null,
      },
      readAuthorityForRequest: () => REAL_AUTHORITY,
    });
    const app = createBoardRoutes(store, authorization);

    const missing = await app.request(
      '/?kind=task&id=nope&projectId=real-project',
    );
    expect(missing.status).toBe(404);

    const found = await app.request(
      '/?kind=task&id=real-task&projectId=real-project',
    );
    expect(found.status).toBe(200);
  });
});
