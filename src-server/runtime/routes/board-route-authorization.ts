import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type { BoardRouteAuthorization } from '../../routes/board.js';
import type { OrchestrationService } from '../../services/orchestration/orchestration-service.js';

export interface BoardRouteAuthorizationDeps {
  orchestrationService: Pick<OrchestrationService, 'canUserReadSession'>;
  /**
   * Intent-shaped, not `Pick<TaskGraphService, 'readTask'>`: this
   * composition reads only `projectId` off a Task, so the dependency asks
   * for exactly that rather than coupling to `TaskRecord`'s full shape —
   * keeps the wiring test's fakes honest (a fake supplying only what's
   * used, not a hand-fabricated `TaskRecord`) and the seam narrow.
   */
  taskGraphService: {
    readTask: (taskId: string) => { projectId: string } | null;
  };
  /** Per-request authority derivation — the SAME closure `runtime-routes.ts` builds once and reuses for every session-scoped route (`createAttachmentRoutes`'s `canReadSession`, `createConversationRoutes`'s `authorityFor`, etc.), never a second derivation. */
  readAuthorityForRequest: (request: Request) => SessionReadAuthority;
}

/**
 * The REAL `BoardRouteAuthorization` composition (station#4079 fix round,
 * delta review micro-round item 2: "the real runtime-routes.ts composition
 * ... is untested — a swapped-args bug there would be invisible"). Extracted
 * from `runtime-routes.ts` inline object literal into its own exported
 * function for two reasons: it is now reviewable in one place (this whole
 * file IS the wiring), and it is now testable in isolation —
 * `board-route-authorization.test.ts` imports THIS function and proves both
 * that a denial reaches the route as a 404 and that arguments reach
 * `canUserReadSession` in the correct order, using a fake orchestration
 * service that discriminates a swapped-args mutation (returns wrong when
 * `sessionId`/`authority` are transposed) rather than a hand-rolled stub
 * that only checks the shape of what it received.
 *
 * `canReadSession` reuses `orchestrationService.canUserReadSession` — the
 * ONE session-scoped authorization primitive this codebase has (see
 * `routes/board.ts`'s own doc comment for the trace through
 * `conversations.ts`) — with THIS request's own authority via
 * `readAuthorityForRequest`, never a second derivation.
 *
 * `taskExists` mirrors the sibling `SpatialBoardResolver`'s task resolver
 * exactly (`services/spatial-board/spatial-board-owner-resolver.ts`):
 * existence plus a `projectId` match, no per-user check — Tasks have no
 * per-user ownership anywhere in this codebase today (a pre-existing gap,
 * not introduced here).
 */
export function createOrchestrationBoardAuthorization(
  deps: BoardRouteAuthorizationDeps,
): BoardRouteAuthorization {
  return {
    canReadSession: (sessionId, request) =>
      deps.orchestrationService.canUserReadSession(
        sessionId,
        deps.readAuthorityForRequest(request),
      ),
    taskExists: (projectId, taskId) => {
      const task = deps.taskGraphService.readTask(taskId);
      return task !== null && task.projectId === projectId;
    },
  };
}
