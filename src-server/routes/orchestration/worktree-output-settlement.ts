/**
 * #4771: what became of a worktree Session's output, mounted under
 * `/api/orchestration`.
 *
 * `GET` reads the Session's record (or `null`) with Session read authority.
 * `POST` settles it once: a person with Session mutation authority names the
 * outcome and a request key, and nothing else. Who settled it is the
 * request's authenticated principal; a body that names an actor is refused.
 * Agent callers are refused, as for every person-only Session control.
 */

import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type {
  WorktreeOutputSettlementRefusal,
  WorktreeOutputSettlementRequest,
} from '@kontourai/station-contracts/workspace-isolation';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
import type { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import {
  sessionWorktreeForSettlement,
  type WorktreeOutputSettlementService,
} from '../../services/projects/worktree-output-settlement-service.js';
import { isNonPersonCaller } from '../plugins/plugin-person-approval.js';
import { pullRequestLinkIdentitySchema } from '../pull-requests/conversation-pull-request-links.js';

const MAX_BODY_BYTES = 4 * 1024;
const NO_STORE = { 'Cache-Control': 'private, no-store' };

const requestKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

/** Strict: an `actor` (or any other field) is not the caller's to name. */
const settlementRequestSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      requestKey,
      outcome: z.literal('discarded'),
      acceptUncommittedLoss: z.boolean().optional(),
    })
    .strict(),
  z.object({ requestKey, outcome: z.literal('kept') }).strict(),
  z
    .object({
      requestKey,
      outcome: z.literal('released'),
      pullRequest: pullRequestLinkIdentitySchema,
    })
    .strict(),
]);

const REFUSAL_STATUS: Record<WorktreeOutputSettlementRefusal, 404 | 409> = {
  'authority-changed': 404,
  'already-settled': 409,
  'request-key-mismatch': 409,
  'settlement-pending': 409,
  'not-a-worktree-session': 404,
  'task-owned-worktree': 409,
  'worktree-missing': 409,
  'unsafe-repository-config': 409,
  'uncommitted-changes': 409,
  'branch-moved': 409,
  'no-new-commits': 409,
  'base-unresolvable': 409,
  'base-does-not-contain-head': 409,
  'pull-request-unavailable': 409,
  'pull-request-not-open-or-merged': 409,
  'pull-request-mismatch': 409,
};

export function createWorktreeOutputSettlementRoutes(deps: {
  orchestration: Pick<
    OrchestrationService,
    'canUserReadSession' | 'canUserMutateSession' | 'readSession'
  >;
  /** Read per request: absent when this Station has no orchestration store. */
  settlements: () => WorktreeOutputSettlementService | undefined;
  authority(request: Request): SessionReadAuthority;
  current(request: Request): boolean;
}) {
  const app = new Hono();
  const path = '/sessions/:threadId/worktree-settlement';
  const notFound = (c: Context) =>
    c.json({ success: false, error: 'Session not found' }, 404, NO_STORE);
  const unavailable = (c: Context) =>
    c.json(
      { success: false, error: 'Worktree settlement is unavailable.' },
      503,
      NO_STORE,
    );
  const person = (request: Request) =>
    stationControlRequestAuthority(request) === undefined &&
    getRuntimeAuthenticatedRequestPrincipal(request)?.kind === 'credential' &&
    !isNonPersonCaller(request);

  app.get(path, (c) => {
    const id = c.req.param('threadId');
    if (
      !deps.current(c.req.raw) ||
      !deps.orchestration.canUserReadSession(id, deps.authority(c.req.raw))
    )
      return notFound(c);
    const settlements = deps.settlements();
    if (!settlements) return unavailable(c);
    return c.json(
      { success: true, data: { settlement: settlements.read(id) ?? null } },
      200,
      NO_STORE,
    );
  });

  app.post(path, async (c) => {
    const id = c.req.param('threadId');
    const authority = deps.authority(c.req.raw);
    if (
      !deps.current(c.req.raw) ||
      !person(c.req.raw) ||
      !deps.orchestration.canUserMutateSession(
        id,
        authority.userId,
        authority.tenantExecutionContext,
      )
    )
      return notFound(c);
    const parsed = await readSettlementRequest(c.req.raw);
    if ('error' in parsed)
      return c.json({ success: false, error: parsed.error }, 400, NO_STORE);
    const settlements = deps.settlements();
    if (!settlements) return unavailable(c);
    const detail = await deps.orchestration.readSession(id, authority, {
      eventMethods: ['session.started'],
    });
    if (!detail) return notFound(c);
    const worktree = sessionWorktreeForSettlement(detail.events, id);
    if (worktree.kind !== 'session')
      return refusal(
        c,
        worktree.kind === 'task-owned'
          ? 'task-owned-worktree'
          : 'not-a-worktree-session',
        worktree.kind === 'task-owned'
          ? "This Session runs in its Task's worktree, which is settled with the Task."
          : 'This Session did not start in a worktree of its own.',
      );
    const result = await settlements.settle({
      sessionId: id,
      metadata: worktree.metadata,
      actor: { kind: 'person', id: authority.userId },
      request: parsed.request,
      stillAuthorized: () =>
        deps.current(c.req.raw) &&
        deps.orchestration.canUserMutateSession(
          id,
          authority.userId,
          authority.tenantExecutionContext,
        ),
    });
    if (result.kind === 'refused')
      return refusal(c, result.reason, result.detail, result.settlement);
    return c.json(
      {
        success: true,
        data: {
          status: result.kind,
          settlement: result.settlement,
        },
      },
      result.kind === 'recorded' ? 201 : 200,
      NO_STORE,
    );
  });
  return app;
}

function refusal(
  c: Context,
  code: WorktreeOutputSettlementRefusal,
  error: string,
  settlement?: unknown,
) {
  return c.json(
    {
      success: false,
      code,
      error,
      ...(settlement ? { data: { settlement } } : {}),
    },
    REFUSAL_STATUS[code],
    NO_STORE,
  );
}

async function readSettlementRequest(
  request: Request,
): Promise<{ request: WorktreeOutputSettlementRequest } | { error: string }> {
  const read = await readBoundedRequestBody(request, MAX_BODY_BYTES);
  if (read.status === 'too-large')
    return { error: 'The settlement request is too large.' };
  let body: unknown;
  try {
    body = read.status === 'ok' ? JSON.parse(read.body) : undefined;
  } catch {
    body = undefined;
  }
  if (body && typeof body === 'object' && 'actor' in body)
    return {
      error:
        'Station records who settled a worktree from the signed-in person; the request cannot name an actor.',
    };
  const parsed = settlementRequestSchema.safeParse(body);
  if (!parsed.success)
    return {
      error:
        'A settlement names requestKey (1-128 of A-Z a-z 0-9 . _ : -) and outcome: discarded (with optional acceptUncommittedLoss), kept, or released with pullRequest {provider, host, repository {owner, name}, ref}.',
    };
  const value = parsed.data;
  return {
    request:
      value.outcome === 'released'
        ? {
            ...value,
            pullRequest: {
              ...value.pullRequest,
              host: value.pullRequest.host.toLowerCase(),
            },
          }
        : value,
  };
}
