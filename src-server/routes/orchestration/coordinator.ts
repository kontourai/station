/**
 * #3628: a person's coordinator designation, read and changed by the person.
 *
 * Every route is the person's own act on their own record: the user id is the
 * request principal's, never a body field, and a request that may be an
 * agent's is refused, so an agent cannot designate itself. Designating needs
 * the same authority as sending to the conversation; a second designation is
 * refused unless the body asks to replace the first. A designation whose
 * conversation the person can no longer read (deleted, or access withdrawn)
 * counts as absent: GET shows none, and PUT replaces it. Replacing or removing
 * a designation withdraws the wakes still queued for the old conversation.
 */
import type {
  CoordinatorDelivery,
  CoordinatorDesignation,
  CoordinatorDesignationRead,
} from '@kontourai/station-contracts/coordinator';
import { type Context, Hono } from 'hono';
import { requestMayBeAnAgent } from '../../security/coding-authority.js';
import type {
  CoordinatorDesignationRecord,
  CoordinatorStore,
} from '../../services/orchestration/coordinator-session.js';
import type {
  AgentScheduleActor,
  AgentSchedulePerson,
} from './agent-schedule.js';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;
const CONVERSATION_ID_MAX_CHARS = 512;

export interface CoordinatorRoutesDeps {
  /** Absent (hosted, or no durable store): every route answers unavailable. */
  readonly store: CoordinatorStore | undefined;
  person(c: Context): AgentSchedulePerson | undefined;
  /** Who a dispatch from this request would act as (`resolveDispatchActor`). */
  dispatchActor(c: Context): AgentScheduleActor;
  /** Withdraws queued wakes for a conversation that stopped being the coordinator. */
  readonly wakes?: { retire(userId: string, conversationId: string): number };
  /** Whether Station can reach the conversation as coordinator now. */
  delivery?(conversationId: string): CoordinatorDelivery | undefined;
  now?: () => number;
}

function publicDesignation(
  record: CoordinatorDesignationRecord,
): CoordinatorDesignation {
  return {
    conversationId: record.conversationId,
    designatedAt: record.designatedAt,
  };
}

export function createCoordinatorRoutes(deps: CoordinatorRoutesDeps): Hono {
  const app = new Hono();

  const personFor = (c: Context): AgentSchedulePerson | Response => {
    if (requestMayBeAnAgent(c.req.raw))
      return c.json(
        { success: false, code: 'person-approval-required' },
        403,
        NO_STORE,
      );
    const person = deps.person(c);
    if (!person)
      return c.json({ success: false, error: 'Not found' }, 404, NO_STORE);
    return person;
  };
  const unavailable = (c: Context) =>
    c.json({ success: false, code: 'coordinator_unavailable' }, 503, NO_STORE);

  app.get('/coordinator', (c) => {
    const person = personFor(c);
    if (person instanceof Response) return person;
    if (!deps.store) return unavailable(c);
    const record = deps.store.designation(person.userId);
    // A designation the person can no longer read is not shown as theirs.
    const shown =
      record && person.mayRead(record.conversationId) ? record : undefined;
    const delivery = shown && deps.delivery?.(shown.conversationId);
    const data: CoordinatorDesignationRead = {
      designation: shown ? publicDesignation(shown) : null,
      ...(delivery ? { delivery } : {}),
    };
    return c.json({ success: true, data }, 200, NO_STORE);
  });

  app.put('/coordinator', async (c) => {
    const person = personFor(c);
    if (person instanceof Response) return person;
    if (!deps.store) return unavailable(c);
    let body: { conversationId?: unknown; replace?: unknown } | null;
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      body = null;
    }
    const conversationId = body?.conversationId;
    if (
      typeof conversationId !== 'string' ||
      conversationId.length === 0 ||
      conversationId.length > CONVERSATION_ID_MAX_CHARS ||
      (body?.replace !== undefined && typeof body.replace !== 'boolean')
    )
      return c.json({ success: false, code: 'invalid_request' }, 400, NO_STORE);
    if (!person.mayMutate(conversationId))
      return c.json({ success: false, error: 'Not found' }, 404, NO_STORE);
    const actor = deps.dispatchActor(c);
    if (actor.userId !== person.userId)
      return c.json(
        { success: false, code: 'person-approval-required' },
        403,
        NO_STORE,
      );
    const previous = deps.store.designation(person.userId);
    // A designation of a conversation the person can no longer read is
    // replaced without asking: nothing can show it to them to replace.
    const dangling =
      previous !== undefined &&
      previous.conversationId !== conversationId &&
      !person.mayRead(previous.conversationId);
    const result = deps.store.designate({
      conversationId,
      actor: {
        userId: person.userId,
        ...(actor.ownerAttribution
          ? { attribution: actor.ownerAttribution }
          : {}),
        ...(actor.principal ? { principal: actor.principal } : {}),
      },
      replace: body?.replace === true || dangling,
      now: deps.now?.() ?? Date.now(),
    });
    if (result.outcome === 'refused')
      return c.json({ success: false, code: result.code }, 409, NO_STORE);
    if (previous && previous.conversationId !== conversationId)
      deps.wakes?.retire(person.userId, previous.conversationId);
    const delivery = deps.delivery?.(conversationId);
    return c.json(
      {
        success: true,
        data: {
          designation: publicDesignation(result.designation),
          ...(delivery ? { delivery } : {}),
        },
      },
      200,
      NO_STORE,
    );
  });

  app.delete('/coordinator', (c) => {
    const person = personFor(c);
    if (person instanceof Response) return person;
    if (!deps.store) return unavailable(c);
    const previous = deps.store.designation(person.userId);
    const undesignated = deps.store.undesignate(person.userId);
    if (previous) deps.wakes?.retire(person.userId, previous.conversationId);
    return c.json(
      {
        success: true,
        data: { undesignated },
      },
      200,
      NO_STORE,
    );
  });

  return app;
}
