import {
  MissingEvidenceError,
  RecordPurgedError,
  RequestKeyConflictError,
} from '@kontourai/corpus-store/errors';
import type { MemoryReviewerKind } from '@kontourai/station-contracts/knowledge-memory';
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { z } from 'zod/v3';
import { isSafePathSegment } from '../../knowledge-index/path-safety.js';
import {
  MemoryDecisionError,
  type MemoryReviewService,
} from '../../knowledge-store/memory-review.js';
import type { MemoryRootManager } from '../../knowledge-store/memory-root.js';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';

interface MemoryRouteDeps {
  manager: MemoryRootManager;
  enabled: () => boolean;
  authority: (
    request: Request,
    action: 'view' | 'create',
  ) => { scope: SessionReadAuthority; assertCurrent: () => void } | undefined;
  mayReadRoot: (request: Request, root: KnowledgeStoreRoot) => Promise<boolean>;
  review: MemoryReviewService;
  /**
   * The host's attestation of who is deciding, read from the authenticated
   * request and never from its body. `human` only for the operator in person;
   * an agent, delegation or unrecognised caller is `agent` and can only annotate.
   */
  reviewerKind: (request: Request) => MemoryReviewerKind;
  guardReadResponse: (
    request: Request,
    roots: readonly KnowledgeStoreRoot[],
    response: Response,
  ) => Promise<Response>;
}

const proposalInput = z
  .object({
    requestKey: z.string().min(1).max(1024),
    candidate: z
      .object({
        type: z.enum(['raw', 'compiled', 'concept', 'snapshot', 'person']),
        title: z.string().min(1),
        body: z.string(),
        category: z.string().min(1),
        tags: z.array(z.string()).optional(),
        aliases: z.array(z.string()).optional(),
        links: z
          .array(
            z
              .object({
                target_id: z.string().min(1),
                kind: z.string().min(1),
                label: z.string().optional(),
              })
              .strict(),
          )
          .optional(),
        provenance: z
          .object({
            agent: z.string().min(1),
            source_ids: z.array(z.string()).optional(),
            source_refs: z
              .array(
                z
                  .object({
                    kind: z.literal('session-transcript'),
                    harness: z.string().min(1),
                    session_id: z.string().min(1),
                    transcript_ref: z.string().min(1),
                    sitting_id: z.string().min(1).optional(),
                    range: z
                      .object({
                        start: z.number().int().positive(),
                        end: z.number().int().positive(),
                      })
                      .strict()
                      .refine((range) => range.end >= range.start)
                      .optional(),
                  })
                  .strict(),
              )
              .max(256)
              .optional(),
            session_id: z.string().optional(),
            note: z.string().optional(),
          })
          .strict(),
        expires_at: z.string().optional(),
        ttl_seconds: z.number().optional(),
      })
      .strict(),
    evidence: z
      .object({ agent: z.string().min(1), proposal: z.string().min(1) })
      .strict(),
  })
  .strict();

const decisionInput = z
  .object({
    outcome: z.enum(['accept', 'correct', 'reject', 'hold']),
    correctedValue: z.string().max(2000).optional(),
    rationale: z.string().max(1000).optional(),
    requestKey: z.string().min(1).max(128).optional(),
  })
  .strict();

export const MEMORY_PREVIEW_DISABLED = {
  success: false,
  error: 'Enable Private memory in Settings → Advanced → Feature previews.',
  code: 'feature_preview_disabled',
  previewId: 'private-memory',
  settingsPath: '/settings?view=feature-previews&highlight=feature-previews',
} as const;

export function isMemoryRootId(value: unknown): boolean {
  return typeof value === 'string' && /^root:memory:[a-f0-9]{64}$/.test(value);
}

export function createMemoryRoutes(deps: MemoryRouteDeps) {
  const app = new Hono();
  app.use('/memory/*', async (c, next) => {
    if (!deps.enabled()) return c.json(MEMORY_PREVIEW_DISABLED, 404);
    await next();
  });

  app.post('/memory/root', async (c) => {
    const caller = deps.authority(c.req.raw, 'create');
    if (!caller)
      return c.json(
        { success: false, error: 'Private memory access denied.' },
        403,
      );
    try {
      const root = await deps.manager.ensureRoot(
        caller.scope,
        caller.assertCurrent,
      );
      if (!(await deps.mayReadRoot(c.req.raw, root)))
        return c.json(
          { success: false, error: 'Private memory access denied.' },
          403,
        );
      return deps.guardReadResponse(
        c.req.raw,
        [root],
        c.json({ success: true, data: root }),
      );
    } catch {
      return c.json(
        { success: false, error: 'Private memory is unavailable.' },
        503,
      );
    }
  });

  app.post('/memory/proposals', async (c) => {
    const caller = deps.authority(c.req.raw, 'create');
    if (!caller)
      return c.json(
        { success: false, error: 'Private memory access denied.' },
        403,
      );
    const raw = await readBoundedRequestBody(c.req.raw, 1024 * 1024);
    if (raw.status === 'too-large')
      return c.json({ success: false, error: 'Proposal is too large.' }, 413);
    if (raw.status !== 'ok')
      return c.json({ success: false, error: 'Invalid proposal.' }, 400);
    let input: unknown;
    try {
      input = JSON.parse(raw.body);
    } catch {
      return c.json({ success: false, error: 'Invalid proposal.' }, 400);
    }
    const parsed = proposalInput.safeParse(input);
    if (!parsed.success)
      return c.json({ success: false, error: 'Invalid proposal.' }, 400);
    try {
      const root = await deps.manager.findRoot(
        caller.scope,
        caller.assertCurrent,
      );
      if (!root || !(await deps.mayReadRoot(c.req.raw, root)))
        return c.json(
          { success: false, error: 'Private memory not found.' },
          404,
        );
      const id = await deps.manager.propose(
        caller.scope,
        root,
        caller.assertCurrent,
        parsed.data.candidate,
        parsed.data.evidence,
        caller.scope.userId,
        parsed.data.requestKey,
      );
      return deps.guardReadResponse(
        c.req.raw,
        [root],
        c.json({ success: true, data: { id } }, 201),
      );
    } catch (error) {
      if (
        error instanceof RequestKeyConflictError ||
        error instanceof RecordPurgedError
      )
        return c.json(
          {
            success: false,
            error: 'Proposal conflicts with existing memory.',
            code: error.code,
          },
          409,
        );
      if (error instanceof MissingEvidenceError)
        return c.json(
          { success: false, error: 'Invalid proposal.', code: error.code },
          400,
        );
      return c.json(
        { success: false, error: 'Private memory is unavailable.' },
        503,
      );
    }
  });

  app.get('/memory/erasure-preview', async (c) => {
    const caller = deps.authority(c.req.raw, 'view');
    if (!caller)
      return c.json(
        { success: false, error: 'Private memory access denied.' },
        403,
      );
    const kind = c.req.query('kind');
    const id = c.req.query('id');
    if (
      (kind !== 'record' && kind !== 'proposal') ||
      !isSafePathSegment(id) ||
      id.length > 200
    )
      return c.json({ success: false, error: 'Invalid memory target.' }, 400);
    try {
      const root = await deps.manager.findRoot(
        caller.scope,
        caller.assertCurrent,
      );
      if (!root || !(await deps.mayReadRoot(c.req.raw, root)))
        return c.json(
          { success: false, error: 'Private memory not found.' },
          404,
        );
      const target = await deps.manager.previewErasureTarget(
        caller.scope,
        root,
        caller.assertCurrent,
        kind,
        id,
      );
      if (!target)
        return c.json(
          { success: false, error: 'Memory target not found.' },
          404,
        );
      return deps.guardReadResponse(
        c.req.raw,
        [root],
        c.json({ success: true, data: target }),
      );
    } catch {
      return c.json(
        { success: false, error: 'Private memory is unavailable.' },
        503,
      );
    }
  });

  app.get('/memory/proposals', async (c) => {
    const caller = deps.authority(c.req.raw, 'view');
    if (!caller)
      return c.json(
        { success: false, error: 'Private memory access denied.' },
        403,
      );
    try {
      const root = await deps.manager.findRoot(
        caller.scope,
        caller.assertCurrent,
      );
      if (!root || !(await deps.mayReadRoot(c.req.raw, root)))
        return c.json(
          { success: false, error: 'Private memory not found.' },
          404,
        );
      const proposals = await deps.manager.listProposals(
        caller.scope,
        root,
        caller.assertCurrent,
      );
      return deps.guardReadResponse(
        c.req.raw,
        [root],
        c.json({ success: true, data: proposals }),
      );
    } catch {
      return c.json(
        { success: false, error: 'Private memory is unavailable.' },
        503,
      );
    }
  });

  /**
   * Every review, recall and brief route derives authority from the request,
   * finds only this caller's root, re-checks that the caller may read it, and
   * hands the response to the delivery-time guard. One helper keeps the four
   * from drifting apart.
   */
  type Caller = NonNullable<ReturnType<MemoryRouteDeps['authority']>>;
  const withRoot = async (
    c: import('hono').Context,
    run: (
      caller: Caller,
      root: KnowledgeStoreRoot,
    ) => Promise<{ body: unknown; status?: 200 | 201 } | Response>,
  ): Promise<Response> => {
    const caller = deps.authority(c.req.raw, 'view');
    if (!caller)
      return c.json(
        { success: false, error: 'Private memory access denied.' },
        403,
      );
    try {
      const root = await deps.manager.findRoot(
        caller.scope,
        caller.assertCurrent,
      );
      if (!root || !(await deps.mayReadRoot(c.req.raw, root)))
        return c.json(
          { success: false, error: 'Private memory not found.' },
          404,
        );
      const result = await run(caller, root);
      if (result instanceof Response) return result;
      return deps.guardReadResponse(
        c.req.raw,
        [root],
        c.json({ success: true, data: result.body }, result.status ?? 200),
      );
    } catch (error) {
      if (error instanceof MemoryDecisionError)
        return c.json(
          {
            success: false,
            error: 'A correction needs the value you say is right.',
          },
          400,
        );
      return c.json(
        { success: false, error: 'Private memory is unavailable.' },
        503,
      );
    }
  };
  const itemParam = (c: import('hono').Context) => {
    const id = c.req.param('itemId');
    return typeof id === 'string' && /^memory-change\.[a-f0-9]{32}$/.test(id)
      ? id
      : null;
  };

  app.get('/memory/queue', (c) =>
    withRoot(c, async (caller, root) => ({
      body: await deps.review.queue(caller.scope, root, caller.assertCurrent),
    })),
  );

  app.post('/memory/queue/:itemId/open', async (c) => {
    const itemId = itemParam(c);
    if (!itemId)
      return c.json({ success: false, error: 'Invalid review item.' }, 400);
    return await withRoot(c, async (caller, root) => {
      const found = await deps.review.open(
        caller.scope,
        root,
        caller.assertCurrent,
        itemId,
        deps.reviewerKind(c.req.raw),
      );
      return found
        ? { body: { itemId } }
        : c.json({ success: false, error: 'Review item not found.' }, 404);
    });
  });

  app.post('/memory/queue/:itemId/decision', async (c) => {
    const itemId = itemParam(c);
    if (!itemId)
      return c.json({ success: false, error: 'Invalid review item.' }, 400);
    const raw = await readBoundedRequestBody(c.req.raw, 16 * 1024);
    if (raw.status === 'too-large')
      return c.json({ success: false, error: 'Decision is too large.' }, 413);
    let input: unknown;
    try {
      input = raw.status === 'ok' ? JSON.parse(raw.body) : undefined;
    } catch {
      input = undefined;
    }
    // `.strict()`: a body that names a reviewer or a reviewer kind is refused,
    // not ignored, so no client can believe it set one.
    const parsed = decisionInput.safeParse(input);
    if (!parsed.success)
      return c.json({ success: false, error: 'Invalid decision.' }, 400);
    return withRoot(c, async (caller, root) => {
      const result = await deps.review.decide(
        caller.scope,
        root,
        caller.assertCurrent,
        itemId,
        parsed.data,
        deps.reviewerKind(c.req.raw),
      );
      return result
        ? { body: result, status: 201 }
        : c.json({ success: false, error: 'Review item not found.' }, 404);
    });
  });

  app.get('/memory/recall', (c) => {
    const query = (c.req.query('q') ?? '').slice(0, 200);
    const limit = Math.min(
      Math.max(Number.parseInt(c.req.query('limit') ?? '25', 10) || 25, 1),
      100,
    );
    return withRoot(c, async (caller, root) => ({
      body: await deps.review.recall(
        caller.scope,
        root,
        caller.assertCurrent,
        query,
        limit,
      ),
    }));
  });

  app.get('/memory/brief', (c) =>
    withRoot(c, async (caller, root) => ({
      body: await deps.review.brief(caller.scope, root, caller.assertCurrent, {
        includeUnreviewed: c.req.query('includeUnreviewed') === '1',
      }),
    })),
  );

  app.get('/memory/measurement', (c) =>
    withRoot(c, async (caller, root) => ({
      body: await deps.review.measurement(
        caller.scope,
        root,
        caller.assertCurrent,
      ),
    })),
  );
  return app;
}
