import {
  MissingEvidenceError,
  RecordPurgedError,
  RequestKeyConflictError,
} from '@kontourai/corpus-store/errors';
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { z } from 'zod/v3';
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
  return app;
}
