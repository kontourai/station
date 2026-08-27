import type { BoardWidgetSize } from '@kontourai/station-contracts/board';
import {
  BOARD_WIDGET_SIZES,
  isBoardReference,
} from '@kontourai/station-contracts/board';
import {
  type UIBlock,
  UIBlockProvenanceRefusedError,
} from '@kontourai/station-contracts/ui-block';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod/v3';
import { acceptUIBlockProvenance } from '../runtime/conversation/ui-block-provenance.js';
import {
  BoardCapacityError,
  BoardReferenceInvalidError,
  BoardStore,
  BoardTabNotFoundError,
  BoardUnavailableError,
  BoardWidgetNameConflictError,
  BoardWidgetNotFoundError,
} from '../services/board/board-store.js';
import { getBody, validate } from './schemas/schemas.js';

/**
 * Fix round B2 (independent review, BLOCKING): a board's owning reference
 * must be RESOLVED and the caller AUTHORIZED against it before any store
 * I/O — mirrors `createAttachmentRoutes`'s `canReadSession` composition
 * (`routes/orchestration/attachments.ts`): "The SAME session-read predicate
 * every other event read goes through, not a second derivation of it. A
 * route that re-derives an authorization check is a route that eventually
 * gets one wrong." The route stays decoupled from `OrchestrationService`/
 * `TaskGraphService` internals; `runtime-routes.ts` composes the real
 * predicates.
 *
 * There is no separate "operate" (write) authority anywhere in this
 * codebase for a session — `OrchestrationService#canUserReadSession` is the
 * ONLY session-scoped authorization primitive that exists (confirmed via
 * `routes/chat/conversations.ts`'s `authorityFor`/`canUserReadSession`
 * usage, the only session gate the whole route tree has). `canReadSession`
 * therefore gates pin/unpin/move too, not only the GET read — a disclosed
 * simplification of the review's "read for GET, operate for pin/unpin/move"
 * request, forced by what this codebase's authority model actually offers
 * today. Introducing a real write-scoped authority is out of this slice's
 * scope.
 *
 * A Task reference has no per-user ownership check anywhere in this
 * codebase either — the sibling `SpatialBoardResolver`'s own task resolver
 * (`spatial-board-owner-resolver.ts`) calls `deps.tasks.listTasks()` with NO
 * authority parameter at all, resolving purely on EXISTENCE (`task.id`
 * lookup) plus a stale-vs-current check on `projectId`. `taskExists` mirrors
 * that exactly: it closes the "board for a nonexistent Task" hole, but true
 * cross-tenant Task isolation does not exist in this codebase today and is
 * not introduced here (a pre-existing gap, not a regression from this
 * change).
 */
export interface BoardRouteAuthorization {
  canReadSession: (sessionId: string, request: Request) => boolean;
  taskExists: (projectId: string, taskId: string) => boolean;
}

const boundedTextSchema = (maxBytes: number) =>
  z
    .string()
    .min(1)
    .refine(
      (value) =>
        Buffer.byteLength(value) <= maxBytes &&
        ![...value].some((character) => {
          const code = character.charCodeAt(0);
          return code < 32 || code === 127;
        }),
      'Text exceeds its byte bound or contains control characters.',
    );

const taskReferenceSchema = z
  .object({
    kind: z.literal('task'),
    id: boundedTextSchema(4096),
    projectId: boundedTextSchema(4096),
  })
  .strict();
const sessionReferenceSchema = z
  .object({ kind: z.literal('session'), id: boundedTextSchema(4096) })
  .strict();
// `boundedTextSchema` is a coarse pre-bound (length + no control chars); the
// FULL `.`/`..`/path-separator denylist (station#4079 fix round, B1 layer
// (a)) is enforced explicitly by `validateReferenceShape` below, in EVERY
// handler at the SAME point and with the SAME response shape — not via a
// zod `.refine` here. `routes/spatial-board.ts`'s own
// `.refine(isSpatialBoardWorkReference, ...)` idiom would work for POST
// (whose body already runs through `validate()`), but GET has no body to
// validate against and would need to hand-roll the identical zod failure
// envelope to match it — two independent copies of "what counts as a valid
// reference" is exactly the class of bug the delta review's taxonomy
// finding is about. One explicit check, reused everywhere, both closes
// that gap and gives every refusal the SAME typed `code`
// (`board_reference_invalid`) instead of GET's custom shape diverging from
// POST's generic zod-validation-failure envelope.
const referenceSchema = z.union([taskReferenceSchema, sessionReferenceSchema]);

const cardFieldSchema = z
  .object({ label: z.string(), value: z.string() })
  .strict();
const formFieldSchema = z
  .object({
    name: z.string(),
    label: z.string(),
    type: z.enum(['text', 'textarea', 'select', 'checkbox']),
    required: z.boolean().optional(),
    placeholder: z.string().optional(),
    defaultValue: z.string().optional(),
    options: z.array(z.string()).optional(),
  })
  .strict();

// `derivedFrom` is intentionally freeform here (any array of plain objects):
// `acceptUIBlockProvenance` -> `parseUIBlockSourceRefs` is the single source
// of truth for what counts as a valid source ref (station#1399's contract),
// same as `render_component`'s own MCP-tool-facing schema. Re-validating its
// exact shape here would risk a second, divergent definition.
const derivedFromSchema = z.array(z.record(z.string(), z.unknown())).optional();
const attestationDeclarationSchema = z
  .enum(['attested', 'unattested', 'decorative'])
  .optional();

const cardBlockInputSchema = z
  .object({
    type: z.literal('card'),
    id: z.string().optional(),
    title: z.string().optional(),
    body: z.string(),
    tone: z.enum(['default', 'success', 'warning', 'danger']).optional(),
    fields: z.array(cardFieldSchema).optional(),
    derivedFrom: derivedFromSchema,
    attestationState: attestationDeclarationSchema,
  })
  .strict();
const tableBlockInputSchema = z
  .object({
    type: z.literal('table'),
    id: z.string().optional(),
    title: z.string().optional(),
    caption: z.string().optional(),
    columns: z.array(z.string()).min(1),
    rows: z.array(
      z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
    ),
    derivedFrom: derivedFromSchema,
    attestationState: attestationDeclarationSchema,
  })
  .strict();
const codeBlockInputSchema = z
  .object({
    type: z.literal('code'),
    id: z.string().optional(),
    title: z.string().optional(),
    code: z.string(),
    language: z.string().optional(),
    caption: z.string().optional(),
    derivedFrom: derivedFromSchema,
    attestationState: attestationDeclarationSchema,
  })
  .strict();
const formBlockInputSchema = z
  .object({
    type: z.literal('form'),
    id: z.string().optional(),
    title: z.string().optional(),
    fields: z.array(formFieldSchema).min(1),
    submitLabel: z.string().optional(),
    description: z.string().optional(),
    derivedFrom: derivedFromSchema,
    attestationState: attestationDeclarationSchema,
  })
  .strict();
const blockInputSchema = z.discriminatedUnion('type', [
  cardBlockInputSchema,
  tableBlockInputSchema,
  codeBlockInputSchema,
  formBlockInputSchema,
]);

const sizeSchema = z.enum(
  BOARD_WIDGET_SIZES as unknown as [BoardWidgetSize, ...BoardWidgetSize[]],
);

const pinSchema = z
  .object({
    reference: referenceSchema,
    name: boundedTextSchema(512),
    tabId: boundedTextSchema(160).optional(),
    tabTitle: boundedTextSchema(512).optional(),
    size: sizeSchema.optional(),
    after: boundedTextSchema(512).optional(),
    block: blockInputSchema,
  })
  .strict();
const unpinSchema = z
  .object({ reference: referenceSchema, name: boundedTextSchema(512) })
  .strict();
const moveSchema = z
  .object({
    reference: referenceSchema,
    name: boundedTextSchema(512),
    tabId: boundedTextSchema(160).optional(),
    after: boundedTextSchema(512).optional(),
  })
  .strict();

type RouteError = {
  status: 400 | 404 | 409 | 413 | 422 | 503;
  code:
    | 'board_reference_invalid'
    | 'board_widget_not_found'
    | 'board_tab_not_found'
    | 'board_capacity'
    | 'board_name_conflict'
    | 'board_provenance_refused'
    | 'board_unavailable';
  error: string;
};

function routeError(error: unknown): RouteError {
  if (error instanceof UIBlockProvenanceRefusedError) {
    return {
      status: 422,
      code: 'board_provenance_refused',
      error: error.message,
    };
  }
  // Fix round B1: the store's own containment/grammar backstops
  // (`pathFor`'s layers (b)/(c)) throw this if a reference somehow reaches
  // them unauthorized/unvalidated — a 400, never a 500/503, since it is
  // always a caller-input problem, not a store-availability one.
  if (error instanceof BoardReferenceInvalidError) {
    return {
      status: 400,
      code: 'board_reference_invalid',
      error: error.message,
    };
  }
  if (error instanceof BoardWidgetNotFoundError) {
    return {
      status: 404,
      code: 'board_widget_not_found',
      error: error.message,
    };
  }
  if (error instanceof BoardTabNotFoundError) {
    return { status: 404, code: 'board_tab_not_found', error: error.message };
  }
  if (error instanceof BoardWidgetNameConflictError) {
    return { status: 409, code: 'board_name_conflict', error: error.message };
  }
  if (error instanceof BoardCapacityError) {
    return { status: 413, code: 'board_capacity', error: error.message };
  }
  return {
    status: 503,
    code: 'board_unavailable',
    error:
      error instanceof BoardUnavailableError
        ? error.message
        : 'Board is unavailable.',
  };
}

type BoardReferenceInput =
  | { kind: 'session'; id: string }
  | { kind: 'task'; id: string; projectId: string };

export function createBoardRoutes(
  store: BoardStore,
  authz: BoardRouteAuthorization,
) {
  const app = new Hono();
  const respond = async (operation: () => Promise<unknown>) => {
    try {
      return { ok: true as const, data: await operation() };
    } catch (error) {
      return { ok: false as const, failure: routeError(error) };
    }
  };
  const json = (c: Context, result: Awaited<ReturnType<typeof respond>>) =>
    result.ok
      ? c.json({ success: true, data: result.data })
      : c.json(
          {
            success: false,
            code: result.failure.code,
            error: result.failure.error,
          },
          result.failure.status,
        );

  /**
   * Micro-round fix (delta review, LOW/taxonomy): the ONE shape-validation
   * response, shared by every handler, checked at the SAME point (right
   * after the reference is parsed, BEFORE `authorizeReference`) — replaces
   * the zod-schema-level `.refine(isBoardReference, ...)` this file used to
   * carry, which gave POST a DIFFERENT wire shape (`validate()`'s generic
   * `{error:'Validation failed', details:{...}}`, no `code`) than GET's
   * custom `board_reference_invalid` response for the identical garbage
   * reference. One explicit check + one response shape, reused by
   * GET/pin/unpin/move, is what makes "board_reference_invalid on every
   * method" actually true rather than a claim two independent code paths
   * could silently drift apart from.
   */
  function validateReferenceShape(
    c: Context,
    reference: unknown,
  ): Response | null {
    if (isBoardReference(reference)) return null;
    return c.json(
      {
        success: false,
        code: 'board_reference_invalid',
        error: 'Invalid board reference.',
      },
      400,
    );
  }

  /**
   * Fix round B2: resolve + authorize BEFORE any store I/O. Returns the
   * refused response, or `null` when the caller may proceed — mirroring
   * `createAttachmentRoutes`'s "authorize before reading" shape. An
   * unresolvable/unauthorized reference answers 404, the same "does not
   * exist to you" posture `attachments.ts` uses for the identical reason:
   * a caller who cannot read a session must not learn whether it exists.
   *
   * Callers MUST run {@link validateReferenceShape} first — this function
   * trusts `reference` is already shape-valid (station#4079 fix round,
   * B1/B2 ordering: shape THEN authorization, everywhere).
   */
  function authorizeReference(
    c: Context,
    reference: BoardReferenceInput,
  ): Response | null {
    const authorized =
      reference.kind === 'session'
        ? authz.canReadSession(reference.id, c.req.raw)
        : authz.taskExists(reference.projectId, reference.id);
    if (authorized) return null;
    return c.json(
      {
        success: false,
        code: 'board_reference_unresolvable',
        error: 'This board reference does not resolve for the caller.',
      },
      404,
    );
  }

  app.get('/', async (c) => {
    const kind = c.req.query('kind');
    const id = c.req.query('id');
    const projectId = c.req.query('projectId');
    let reference: BoardReferenceInput | undefined;
    if (kind === 'session' && id) {
      reference = { kind: 'session', id };
    } else if (kind === 'task' && id && projectId) {
      reference = { kind: 'task', id, projectId };
    }
    if (!reference) {
      return c.json(
        {
          success: false,
          code: 'board_unavailable',
          error:
            'Query params kind=session&id=<id> or kind=task&id=<id>&projectId=<projectId> are required.',
        },
        400,
      );
    }
    // Shape-validate BEFORE authorizing — exactly POST's order below.
    const invalid = validateReferenceShape(c, reference);
    if (invalid) return invalid;
    const denied = authorizeReference(c, reference);
    if (denied) return denied;
    return json(c, await respond(() => store.read(reference)));
  });

  app.post('/pin', validate(pinSchema), async (c) => {
    const body = getBody(c) as z.infer<typeof pinSchema>;
    const invalid = validateReferenceShape(c, body.reference);
    if (invalid) return invalid;
    const denied = authorizeReference(c, body.reference);
    if (denied) return denied;
    return json(
      c,
      await respond(async () => {
        // `acceptUIBlockProvenance` takes the raw derivedFrom/attestationState
        // as SEPARATE (untrusted) params and stamps them back on itself — the
        // base block passed as its first argument must not already carry
        // them (mirrors vended-tool-compat.ts#validateUIBlock's own call
        // shape, which builds a clean per-type object rather than forwarding
        // the raw input object verbatim).
        const {
          derivedFrom: rawDerivedFrom,
          attestationState: declaredAttestation,
          ...blockFields
        } = body.block;
        const acceptedBlock = acceptUIBlockProvenance(
          blockFields as unknown as UIBlock,
          rawDerivedFrom,
          declaredAttestation,
          'board_pin',
        );
        const { board } = await store.pin(body.reference, {
          block: acceptedBlock,
          name: body.name,
          tabId: body.tabId,
          tabTitle: body.tabTitle,
          size: body.size,
          after: body.after,
        });
        return board;
      }),
    );
  });

  app.post('/unpin', validate(unpinSchema), async (c) => {
    const body = getBody(c) as z.infer<typeof unpinSchema>;
    const invalid = validateReferenceShape(c, body.reference);
    if (invalid) return invalid;
    const denied = authorizeReference(c, body.reference);
    if (denied) return denied;
    return json(c, await respond(() => store.unpin(body.reference, body.name)));
  });

  app.post('/move', validate(moveSchema), async (c) => {
    const body = getBody(c) as z.infer<typeof moveSchema>;
    const invalid = validateReferenceShape(c, body.reference);
    if (invalid) return invalid;
    const denied = authorizeReference(c, body.reference);
    if (denied) return denied;
    return json(
      c,
      await respond(() =>
        store.move(body.reference, body.name, {
          tabId: body.tabId,
          after: body.after,
        }),
      ),
    );
  });

  return app;
}
