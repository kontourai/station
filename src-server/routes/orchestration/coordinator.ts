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
import {
  COORDINATOR_PICTURE_FINISHED_WINDOW_MS,
  type CoordinatorDelivery,
  type CoordinatorDesignation,
  type CoordinatorDesignationRead,
} from '@kontourai/station-contracts/coordinator';
import { type Context, Hono } from 'hono';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { requestMayBeAnAgent } from '../../security/coding-authority.js';
import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
import { FeaturePreviewDisabledError } from '../../services/feature-previews/feature-preview-refusal.js';
import type { FeaturePreviewSelector } from '../../services/feature-previews/feature-preview-registry.js';
import type {
  CoordinatorDesignationRecord,
  CoordinatorStore,
} from '../../services/orchestration/coordinator-session.js';
import type { StationControlCaller } from '../../tools/station-control-shared.js';
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
  revokeCoordinatorCredentials?(conversationId: string): void;
  /** Whether Station can reach the conversation as coordinator now. */
  delivery?(conversationId: string): CoordinatorDelivery | undefined;
  now?: () => number;
  picturePreview?: FeaturePreviewSelector;
  isInternalRequest?(request: Request): boolean;
  resolvePictureCaller?(request: Request): StationControlCaller | null;
  agentMayRead?(caller: StationControlCaller, conversationId: string): boolean;
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

  const pictureDisabled = (c: Context) =>
    c.json(
      new FeaturePreviewDisabledError(
        'coordinator-picture',
        'Coordinator working picture',
      ).refusal,
      404,
      NO_STORE,
    );
  const pictureEnabled = () =>
    deps.picturePreview?.select({
      enabled: () => true,
      disabled: () => false,
    }) === true;
  const visiblePicture = (userId: string, mayRead: (id: string) => boolean) =>
    (deps.store?.pictureItems(userId) ?? []).filter(
      (item) =>
        mayRead(item.conversationId) &&
        (item.status !== 'finished' ||
          item.updatedAt >
            (deps.now?.() ?? Date.now()) -
              COORDINATOR_PICTURE_FINISHED_WINDOW_MS),
    );
  const pictureCaller = (c: Context) => {
    if (!deps.isInternalRequest?.(c.req.raw)) return undefined;
    const authority = stationControlRequestAuthority(c.req.raw);
    if (authority?.kind !== 'caller' || authority.caller.assurance !== 'bound')
      return undefined;
    const caller = deps.resolvePictureCaller?.(c.req.raw);
    if (
      !caller ||
      caller.sessionId !== authority.caller.sessionId ||
      caller.assurance !== 'bound' ||
      caller.principal?.id !== authority.caller.principal?.id
    )
      return undefined;
    const userId = caller.principal?.elevationEligible
      ? caller.principal.id
      : undefined;
    const person = deps.person(c);
    if (!userId || !person || person.userId !== userId || !deps.store)
      return undefined;
    const designation = deps.store.designation(userId);
    const conversationId = caller.conversationId ?? caller.sessionId;
    if (
      !designation ||
      designation.conversationId !== conversationId ||
      !person.mayRead(conversationId) ||
      !deps.agentMayRead?.(caller, conversationId)
    )
      return undefined;
    return {
      userId,
      mayRead: (id: string) =>
        person.mayRead(id) && deps.agentMayRead?.(caller, id) === true,
    };
  };
  app.get('/coordinator/picture', (c) => {
    const person = personFor(c);
    if (person instanceof Response) return person;
    if (!pictureEnabled()) return pictureDisabled(c);
    if (!deps.store) return unavailable(c);
    return c.json(
      {
        success: true,
        data: { items: visiblePicture(person.userId, person.mayRead) },
      },
      200,
      NO_STORE,
    );
  });
  app.get('/station-control/coordinator-picture', (c) => {
    const caller = pictureCaller(c);
    if (!caller)
      return c.json({ success: false, error: 'Not found' }, 404, NO_STORE);
    if (!pictureEnabled()) return pictureDisabled(c);
    return c.json(
      {
        success: true,
        data: { items: visiblePicture(caller.userId, caller.mayRead) },
      },
      200,
      NO_STORE,
    );
  });
  app.post('/station-control/coordinator-picture', async (c) => {
    const caller = pictureCaller(c);
    if (!caller)
      return c.json({ success: false, error: 'Not found' }, 404, NO_STORE);
    if (!pictureEnabled()) return pictureDisabled(c);
    const read = await readBoundedRequestBody(c.req.raw, 16 * 1024);
    if (read.status !== 'ok')
      return c.json({ success: false, code: 'invalid_request' }, 400, NO_STORE);
    let body: unknown;
    try {
      body = JSON.parse(read.body);
    } catch {
      body = undefined;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json({ success: false, code: 'invalid_request' }, 400, NO_STORE);
    const value = body as Record<string, unknown>;
    if (
      Object.keys(value).some(
        (key) => !['conversationId', 'status', 'summary'].includes(key),
      ) ||
      typeof value.conversationId !== 'string' ||
      !value.conversationId ||
      value.conversationId.length > 512 ||
      typeof value.status !== 'string' ||
      !['in-flight', 'waiting', 'finished', 'remove'].includes(value.status) ||
      (value.status !== 'remove' && typeof value.summary !== 'string') ||
      (value.status === 'remove' && value.summary !== undefined)
    )
      return c.json({ success: false, code: 'invalid_request' }, 400, NO_STORE);
    // The body can arrive after designation, scope, or preview changed.
    const current = pictureCaller(c);
    if (
      !current ||
      current.userId !== caller.userId ||
      !current.mayRead(value.conversationId)
    )
      return c.json({ success: false, error: 'Not found' }, 404, NO_STORE);
    if (!pictureEnabled()) return pictureDisabled(c);
    if (value.status === 'remove') {
      deps.store!.removePictureItem(caller.userId, value.conversationId);
      return c.json({ success: true, data: { removed: true } }, 200, NO_STORE);
    }
    const result = deps.store!.setPictureItem({
      userId: caller.userId,
      conversationId: value.conversationId,
      status: value.status as 'in-flight' | 'waiting' | 'finished',
      summary: value.summary as string,
      now: deps.now?.() ?? Date.now(),
    });
    if (result.outcome !== 'saved')
      return c.json({ success: false, code: result.outcome }, 400, NO_STORE);
    return c.json({ success: true, data: result }, 200, NO_STORE);
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
    if (!previous || previous.conversationId !== conversationId)
      deps.revokeCoordinatorCredentials?.(conversationId);
    if (previous && previous.conversationId !== conversationId) {
      deps.revokeCoordinatorCredentials?.(previous.conversationId);
      deps.wakes?.retire(person.userId, previous.conversationId);
    }
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
    if (previous && undesignated) {
      deps.revokeCoordinatorCredentials?.(previous.conversationId);
      deps.wakes?.retire(person.userId, previous.conversationId);
    }
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
