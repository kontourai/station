/**
 * station#3413 part B: the REST side of Station Control's `claim_work`,
 * `renew_claim` and `release_claim`, and the Station UI's read of the claims
 * a person may see. Mounted at `/api/orchestration/work-claims`.
 *
 * The three agent leaves act as the VERIFIED station-control caller and answer
 * `station_control_caller_required` to a request that carries none. Nothing in
 * a request names a Session: the claimant is the caller's own Session (and its
 * conversation), so a claim can be renewed or released only by the Session
 * that made it, or a later Session of the same conversation. Another
 * Session's claim id reads exactly like one that does not exist.
 *
 * A claim belongs to the claimant's own scope (`stationControlSessionScope`):
 * its Project, or the global space. A caller whose scope cannot be read
 * claims nothing. Claiming still answers the one scope rule every
 * session-aimed call answers (`refuseOutOfScopeDispatch` on the caller's own
 * Session), as `get_task_brief` does. When the Session was dispatched for a
 * Task in that Project, the claim carries the Task id.
 *
 * The UI leaf (`GET /`) answers a person, never an agent: it lists the active
 * claims of the Sessions the requester may read.
 */
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import {
  type HostedTenantRegistry,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import type { WorkClaimView } from '@kontourai/station-contracts/work-claims';
import { type Context, Hono } from 'hono';
import { getTenantRequestContext } from '../../runtime/bootstrap/runtime-tenant-context.js';
import type { StationControlDispatchScope } from '../../runtime/mcp/station-control-dispatch-scope.js';
import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
import type { EventStore } from '../../services/orchestration/event-store.js';
import type { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import {
  readWorkClaimantStates,
  type WorkClaimant,
  type WorkClaimRecord,
  type WorkClaimStore,
  workClaimantKey,
  workClaimSessionEnded,
} from '../../services/orchestration/work-claims.js';
import {
  stationControlRefusal,
  stationControlRefusalBody,
  stationControlSessionScope,
} from '../../tools/station-control-policy.js';
import type { StationControlCaller } from '../../tools/station-control-shared.js';
import { refuseOutOfScopeDispatch } from './dispatch-scope.js';
import {
  type PrincipalResolutionContext,
  resolveActorPrincipal,
} from './orchestration.js';
import {
  WORK_CLAIM_DEFAULT_TTL_SECONDS,
  WORK_CLAIM_LIST_MAX,
  WORK_CLAIM_MAX_PATHS,
  WORK_CLAIM_MAX_TTL_SECONDS,
  WORK_CLAIM_MIN_TTL_SECONDS,
  WORK_CLAIM_NOTE_MAX_CHARS,
  WORK_CLAIM_PATH_MAX_CHARS,
  WORK_CLAIM_WORK_ITEM_REF_MAX_CHARS,
} from './work-claim-limits.js';

const NO_STORE = { 'Cache-Control': 'no-store' };

export interface SessionWorkClaimRoutesDeps {
  workClaims: WorkClaimStore;
  eventStore: Pick<
    EventStore,
    'conversationForSession' | 'readProjectTaskRoomExecutionBinding'
  >;
  orchestrationService: Pick<
    OrchestrationService,
    | 'canUserReadSession'
    | 'currentConversationSessionId'
    | 'listSessionReadModel'
  >;
  stationControlDispatchScope?: StationControlDispatchScope;
  resolvePrincipal?: (c: PrincipalResolutionContext) => PrincipalRef;
  hostedTenantRegistry?: HostedTenantRegistry;
}

/** A claim as a tool or the UI reads it. */
export function workClaimView(claim: WorkClaimRecord): WorkClaimView {
  return {
    claimId: claim.claimId,
    sessionId: claim.sessionId,
    ...(claim.conversationId ? { conversationId: claim.conversationId } : {}),
    scope: claim.scope,
    ...(claim.taskId ? { taskId: claim.taskId } : {}),
    ...(claim.workItemRef ? { workItemRef: claim.workItemRef } : {}),
    ...(claim.paths.length > 0 ? { paths: claim.paths } : {}),
    ...(claim.note ? { note: claim.note } : {}),
    claimedAt: claim.claimedAt,
    renewedAt: claim.renewedAt,
    expiresAt: claim.expiresAt,
    ...(claim.releasedAt ? { releasedAt: claim.releasedAt } : {}),
    ...(claim.releaseNote ? { releaseNote: claim.releaseNote } : {}),
  };
}

const invalid = (c: Context, error: string, code = 'invalid_request') =>
  c.json({ success: false, code, error }, 400, NO_STORE);

const claimNotFound = (c: Context) =>
  c.json(
    { success: false, code: 'claim_not_found', error: 'Claim not found' },
    404,
    NO_STORE,
  );

function callerOf(c: Context): StationControlCaller | Response {
  const authority = stationControlRequestAuthority(c.req.raw);
  if (authority?.kind === 'caller') return authority.caller;
  return c.json(
    stationControlRefusalBody(
      stationControlRefusal('station_control_caller_required'),
    ),
    403,
    NO_STORE,
  );
}

/** A JSON object body, or `undefined` for anything else. */
async function objectBody(
  c: Context,
): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await c.req.text();
    const body: unknown = text.trim() === '' ? {} : JSON.parse(text);
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

/** A trimmed single-line string within `max`, or an error message. */
function lineField(
  value: unknown,
  name: string,
  max: number,
): string | undefined | { error: string } {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return { error: `${name} must be a string.` };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { error: `${name} must not be empty.` };
  if (trimmed.length > max)
    return { error: `${name} is at most ${max} characters.` };
  if (CONTROL_CHARACTERS.test(trimmed))
    return { error: `${name} must be one line of text.` };
  return trimmed;
}

const isError = (value: unknown): value is { error: string } =>
  typeof value === 'object' && value !== null && 'error' in value;

function ttlField(value: unknown): number | { error: string } {
  if (value === undefined) return WORK_CLAIM_DEFAULT_TTL_SECONDS;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < WORK_CLAIM_MIN_TTL_SECONDS ||
    value > WORK_CLAIM_MAX_TTL_SECONDS
  )
    return {
      error: `ttlSeconds must be a whole number from ${WORK_CLAIM_MIN_TTL_SECONDS} to ${WORK_CLAIM_MAX_TTL_SECONDS}.`,
    };
  return value;
}

function unknownKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
): string[] {
  return Object.keys(body).filter((key) => !allowed.includes(key));
}

export function createSessionWorkClaimRoutes(deps: SessionWorkClaimRoutesDeps) {
  const app = new Hono();

  const claimantOf = (caller: StationControlCaller): WorkClaimant => {
    const conversationId =
      caller.conversationId ??
      deps.eventStore.conversationForSession(caller.sessionId)?.conversationId;
    return {
      sessionId: caller.sessionId,
      ...(conversationId ? { conversationId } : {}),
    };
  };

  app.post('/', async (c) => {
    const caller = callerOf(c);
    if (caller instanceof Response) return caller;
    const body = await objectBody(c);
    if (!body) return invalid(c, 'The body must be a JSON object.');
    const extra = unknownKeys(body, [
      'workItemRef',
      'paths',
      'note',
      'ttlSeconds',
    ]);
    // A claim names no Session, owner or Project: the claimant is the caller.
    if (extra.length > 0)
      return invalid(c, `Unknown field: ${extra.join(', ')}.`);
    const workItemRef = lineField(
      body.workItemRef,
      'workItemRef',
      WORK_CLAIM_WORK_ITEM_REF_MAX_CHARS,
    );
    if (isError(workItemRef)) return invalid(c, workItemRef.error);
    const note = lineField(body.note, 'note', WORK_CLAIM_NOTE_MAX_CHARS);
    if (isError(note)) return invalid(c, note.error);
    const ttlSeconds = ttlField(body.ttlSeconds);
    if (isError(ttlSeconds)) return invalid(c, ttlSeconds.error);
    const paths: string[] = [];
    if (body.paths !== undefined) {
      if (!Array.isArray(body.paths))
        return invalid(c, 'paths must be a list of paths.');
      if (body.paths.length > WORK_CLAIM_MAX_PATHS)
        return invalid(
          c,
          `paths is at most ${WORK_CLAIM_MAX_PATHS} entries.`,
          'work_claim_too_many_paths',
        );
      for (const entry of body.paths) {
        const path = lineField(entry, 'Each path', WORK_CLAIM_PATH_MAX_CHARS);
        if (path === undefined || isError(path))
          return invalid(c, path?.error ?? 'Each path must be a string.');
        if (!paths.includes(path)) paths.push(path);
      }
    }
    if (workItemRef === undefined && paths.length === 0)
      return invalid(
        c,
        'A claim names a work item (workItemRef), paths, or both.',
        'work_claim_subject_required',
      );

    const refused = refuseOutOfScopeDispatch(
      c,
      deps.stationControlDispatchScope,
      () => ({
        kind: 'thread',
        threadId: caller.sessionId,
        remote: false,
      }),
    );
    if (refused) return refused;
    const scope = stationControlSessionScope(caller);
    if (scope.kind === 'unreadable')
      return c.json(
        {
          success: false,
          code: 'work_claim_scope_unreadable',
          error:
            "This session's Project cannot be confirmed, so it cannot claim work in it.",
        },
        409,
        NO_STORE,
      );
    // The Task only when its binding is in the claim's own Project.
    const binding = deps.eventStore.readProjectTaskRoomExecutionBinding(
      caller.sessionId,
    );
    const taskId =
      binding && scope.kind === 'project' && binding.projectId === scope.id
        ? binding.taskId
        : undefined;
    const outcome = deps.workClaims.claim({
      claimant: claimantOf(caller),
      scope,
      ...(taskId ? { taskId } : {}),
      ...(workItemRef ? { workItemRef } : {}),
      paths,
      ...(note ? { note } : {}),
      ttlSeconds,
    });
    if (outcome.kind === 'too_many')
      return c.json(
        {
          success: false,
          code: 'work_claim_limit_reached',
          error: `This session already holds ${outcome.max} active claims. Release one first.`,
        },
        409,
        NO_STORE,
      );
    return c.json(
      { success: true, data: { claim: workClaimView(outcome.claim) } },
      200,
      NO_STORE,
    );
  });

  // One handler for both leaves; each is registered by its literal path.
  const change =
    (kind: 'renew' | 'release') =>
    async (c: Context): Promise<Response> => {
      const caller = callerOf(c);
      if (caller instanceof Response) return caller;
      const claimId = c.req.param('claimId');
      if (!claimId || claimId.length > 200) return claimNotFound(c);
      const body = await objectBody(c);
      if (!body) return invalid(c, 'The body must be a JSON object.');
      const allowed = kind === 'renew' ? ['ttlSeconds'] : ['note'];
      const extra = unknownKeys(body, allowed);
      if (extra.length > 0)
        return invalid(c, `Unknown field: ${extra.join(', ')}.`);
      const claimant = claimantOf(caller);
      let outcome: ReturnType<WorkClaimStore['renew']>;
      if (kind === 'renew') {
        const ttlSeconds = ttlField(body.ttlSeconds);
        if (isError(ttlSeconds)) return invalid(c, ttlSeconds.error);
        outcome = deps.workClaims.renew(claimId, claimant, ttlSeconds);
      } else {
        const note = lineField(body.note, 'note', WORK_CLAIM_NOTE_MAX_CHARS);
        if (isError(note)) return invalid(c, note.error);
        outcome = deps.workClaims.release(claimId, claimant, note);
      }
      if (outcome.kind === 'not_found') return claimNotFound(c);
      if (outcome.kind === 'not_active')
        return c.json(
          {
            success: false,
            code: 'claim_not_active',
            error:
              kind === 'renew'
                ? 'This claim was released or has expired. Claim the work again.'
                : 'This claim was already released.',
            data: { claim: workClaimView(outcome.claim) },
          },
          409,
          NO_STORE,
        );
      return c.json(
        { success: true, data: { claim: workClaimView(outcome.claim) } },
        200,
        NO_STORE,
      );
    };
  app.post('/:claimId/renew', change('renew'));
  app.post('/:claimId/release', change('release'));

  // The Station UI's read: active claims of the Sessions this person may read.
  app.get('/', async (c) => {
    // Not an agent's: a station-control caller has its own tools.
    if (stationControlRequestAuthority(c.req.raw))
      return c.json(
        stationControlRefusalBody(
          stationControlRefusal('station_control_route_unmapped'),
        ),
        403,
        NO_STORE,
      );
    const authority = sessionReadAuthorityFromRequest(
      resolveActorPrincipal(deps, c).userId,
      getTenantRequestContext(c.req.raw),
      deps.hostedTenantRegistry,
    );
    const unexpired = deps.workClaims.listUnexpired({
      limit: WORK_CLAIM_LIST_MAX + 1,
    });
    if (unexpired.length > WORK_CLAIM_LIST_MAX)
      return c.json(
        {
          success: false,
          code: 'work_claims_too_many',
          error: `More than ${WORK_CLAIM_LIST_MAX} claims are active.`,
        },
        422,
        NO_STORE,
      );
    const readable = unexpired.filter((claim) =>
      deps.orchestrationService.canUserReadSession(claim.sessionId, authority),
    );
    const states = await readWorkClaimantStates(
      deps.orchestrationService,
      readable,
    );
    const claims = readable.filter(
      (claim) => !workClaimSessionEnded(states.get(workClaimantKey(claim))),
    );
    return c.json(
      { success: true, data: { claims: claims.map(workClaimView) } },
      200,
      NO_STORE,
    );
  });

  return app;
}
