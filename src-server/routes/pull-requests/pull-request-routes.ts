import {
  type IPullRequestProvider,
  narrowMergeMethods,
  narrowToOffered,
  type PullRequestResult,
} from '@kontourai/station-contracts/pull-request-provider';
import { Hono } from 'hono';
import { z } from 'zod/v3';
import { pullRequestOps } from '../../telemetry/metrics.js';
import { getBody, param, validate } from '../schemas/schemas.js';

const mergeInputSchema = z
  .object({
    method: z.enum(['merge', 'squash', 'rebase']),
    autoMerge: z.boolean().optional(),
    expectedHeadSha: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/i)
      .optional(),
  })
  .strict();

const reviewInputSchema = z
  .object({
    action: z.enum(['comment', 'approve']),
    expectedHeadSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
    body: z.string().max(16_384).optional(),
  })
  .strict()
  .refine(
    (value) => value.action !== 'comment' || Boolean(value.body?.trim()),
    { message: 'A comment needs text.' },
  );

type Identity = (c: any) => string | undefined;
export function createPullRequestRoutes(
  providers: () => IPullRequestProvider[],
  context: (c: any) => Promise<any>,
  options: {
    operatorIdentityForRequest: Identity;
    isRequestPrincipalCurrent?: (request: Request) => boolean;
  },
) {
  const app = new Hono();
  const resolve = async (c: any) => {
    const resolution = await context(c);
    if (!resolution?.available) return undefined;
    const provider = providers().find(
      (x) =>
        x.id === c.req.param('provider') &&
        x.canServeHost(c.req.param('host')) &&
        x.getHost(resolution.context) === c.req.param('host'),
    );
    if (!provider) return undefined;
    const { owner, repo } = c.req.param();
    if (
      owner !== resolution.context.repository.owner ||
      repo !== resolution.context.repository.name
    ) {
      return { mismatch: true };
    }
    return { provider, context: resolution.context };
  };
  const operator = (c: any) => options.operatorIdentityForRequest(c);
  const current = (c: any) =>
    options.isRequestPrincipalCurrent?.(c.req.raw) ?? true;
  const narrow = <T>(
    provider: IPullRequestProvider,
    result: PullRequestResult<T>,
  ): PullRequestResult<T> => ({
    ...result,
    effectiveCapabilities: narrowToOffered(
      provider.offeredCapabilities,
      result.effectiveCapabilities,
    ),
    effectiveMergeMethods: narrowMergeMethods(
      provider.offeredMergeMethods,
      result.effectiveMergeMethods,
    ),
  });
  app.get('/context', async (c) => {
    const resolution = await context(c);
    if (!resolution?.available) {
      return c.json({
        success: true,
        data: {
          available: false,
          reason: resolution?.reason ?? 'Pull request context is unavailable',
          // #1536 G5: carried through so the panel can tell the ordinary
          // local repository from a forge that refused.
          ...(resolution?.cause ? { cause: resolution.cause } : {}),
        },
      });
    }
    const provider = providers().find((candidate) => {
      const host = candidate.getHost(resolution.context);
      return candidate.canServeHost(host);
    });
    if (!provider) {
      return c.json({
        success: true,
        data: { available: false, reason: 'Provider unavailable' },
      });
    }
    return c.json({
      success: true,
      data: {
        available: true,
        provider: provider.id,
        host: provider.getHost(resolution.context),
        repository: {
          owner: resolution.context.repository.owner,
          name: resolution.context.repository.name,
        },
        branch: resolution.context.branch,
      },
    });
  });
  app.get('/:provider/:host/:owner/:repo', async (c) => {
    const x = await resolve(c);
    if (!x || 'mismatch' in x)
      return c.json({ success: false, error: 'Provider unavailable' }, 404);
    pullRequestOps.add(1, {
      operation: 'list',
      repo: `${x.context.repository.owner}/${x.context.repository.name}`,
    });
    return c.json({
      success: true,
      data: narrow(
        x.provider,
        await x.provider.listPullRequests(x.context, {
          state: c.req.query('state'),
          limit: Number(c.req.query('limit')) || undefined,
        }),
      ),
    });
  });
  app.get('/:provider/:host/:owner/:repo/:ref', async (c) => {
    const x = await resolve(c);
    if (!x || 'mismatch' in x)
      return c.json({ success: false, error: 'Provider unavailable' }, 404);
    return c.json({
      success: true,
      data: narrow(
        x.provider,
        await x.provider.getPullRequest(x.context, c.req.param('ref')),
      ),
    });
  });
  app.get('/:provider/:host/:owner/:repo/:ref/review', async (c) => {
    if (!current(c))
      return c.json({ success: false, error: 'Station access changed' }, 403);
    const x = await resolve(c);
    if (!x || 'mismatch' in x)
      return c.json({ success: false, error: 'Provider unavailable' }, 404);
    if (!/^[1-9]\d*$/.test(param(c, 'ref')))
      return c.json(
        { success: false, error: 'An exact pull request number is required' },
        400,
      );
    c.header('Cache-Control', 'private, no-store');
    if (!x.provider.getReviewSnapshot) {
      const availability = await x.provider.getAvailability(x.context);
      return c.json({
        success: true,
        data: narrow(x.provider, {
          ...availability,
          available: false,
          reason: 'This provider does not support in-app review snapshots.',
        }),
      });
    }
    const result = await x.provider.getReviewSnapshot(
      x.context,
      param(c, 'ref'),
    );
    if (!current(c))
      return c.json({ success: false, error: 'Station access changed' }, 403);
    return c.json({ success: true, data: narrow(x.provider, result) });
  });
  app.post(
    '/:provider/:host/:owner/:repo/:ref/review',
    validate(reviewInputSchema),
    async (c) => {
      const actor = operator(c);
      if (!actor)
        return c.json(
          { success: false, error: 'Operator authentication required' },
          403,
        );
      const x = await resolve(c);
      if (!x || 'mismatch' in x)
        return c.json({ success: false, error: 'Provider unavailable' }, 404);
      if (!/^[1-9]\d*$/.test(param(c, 'ref')))
        return c.json(
          { success: false, error: 'An exact pull request number is required' },
          400,
        );
      const input: z.infer<typeof reviewInputSchema> = getBody(c);
      const availability = await x.provider.getAvailability(x.context);
      const capabilities = narrowToOffered(
        x.provider.offeredCapabilities,
        availability.effectiveCapabilities,
      );
      if (
        !availability.available ||
        !capabilities[input.action] ||
        !x.provider.submitReview
      )
        return c.json(
          {
            success: false,
            error: 'This provider review capability is unavailable',
          },
          409,
        );
      if (operator(c) !== actor || !current(c))
        return c.json(
          { success: false, error: 'Operator authentication changed' },
          403,
        );
      return c.json({
        success: true,
        data: narrow(
          x.provider,
          await x.provider.submitReview(x.context, param(c, 'ref'), input, {
            isCurrent: () => current(c) && operator(c) === actor,
          }),
        ),
      });
    },
  );
  app.post('/:provider/:host/:owner/:repo/open', async (c) => {
    if (!operator(c))
      return c.json(
        { success: false, error: 'Operator authentication required' },
        403,
      );
    const x = await resolve(c);
    if (!x || 'mismatch' in x)
      return c.json({ success: false, error: 'Provider unavailable' }, 404);
    pullRequestOps.add(1, {
      operation: 'open',
      repo: `${x.context.repository.owner}/${x.context.repository.name}`,
    });
    return c.json({
      success: true,
      data: narrow(
        x.provider,
        await x.provider.openPullRequest(x.context, getBody(c) as any),
      ),
    });
  });
  app.post('/:provider/:host/:owner/:repo/:ref/comments', async (c) => {
    if (!operator(c))
      return c.json(
        { success: false, error: 'Operator authentication required' },
        403,
      );
    const x = await resolve(c);
    if (!x || 'mismatch' in x)
      return c.json({ success: false, error: 'Provider unavailable' }, 404);
    pullRequestOps.add(1, {
      operation: 'comment',
      repo: `${x.context.repository.owner}/${x.context.repository.name}`,
    });
    return c.json({
      success: true,
      data: narrow(
        x.provider,
        await x.provider.createComment(
          x.context,
          c.req.param('ref'),
          getBody(c) as any,
        ),
      ),
    });
  });
  app.post('/:provider/:host/:owner/:repo/:ref/approve', async (c) => {
    if (!operator(c))
      return c.json(
        { success: false, error: 'Operator authentication required' },
        403,
      );
    const x = await resolve(c);
    if (!x || 'mismatch' in x)
      return c.json({ success: false, error: 'Provider unavailable' }, 404);
    pullRequestOps.add(1, {
      operation: 'approve',
      repo: `${x.context.repository.owner}/${x.context.repository.name}`,
    });
    return c.json({
      success: true,
      data: narrow(
        x.provider,
        await x.provider.approvePullRequest(
          x.context,
          c.req.param('ref'),
          getBody(c) as any,
        ),
      ),
    });
  });
  app.post(
    '/:provider/:host/:owner/:repo/:ref/merge',
    validate(mergeInputSchema),
    async (c) => {
      if (!operator(c))
        return c.json(
          { success: false, error: 'Operator authentication required' },
          403,
        );
      const x = await resolve(c);
      if (!x || 'mismatch' in x)
        return c.json({ success: false, error: 'Provider unavailable' }, 404);
      const input = getBody(c);
      const availability = await x.provider.getAvailability(x.context);
      const capability = input.autoMerge ? 'autoMerge' : 'merge';
      const effective = narrowToOffered(
        x.provider.offeredCapabilities,
        availability.effectiveCapabilities,
      );
      if (!effective[capability])
        return c.json(
          {
            success: false,
            error: `Pull request capability unavailable: ${capability}`,
          },
          409,
        );
      pullRequestOps.add(1, {
        operation: capability,
        repo: `${x.context.repository.owner}/${x.context.repository.name}`,
      });
      return c.json({
        success: true,
        data: narrow(
          x.provider,
          input.expectedHeadSha
            ? await x.provider.mergePullRequest(
                x.context,
                param(c, 'ref'),
                input,
                { isCurrent: () => current(c) && !!operator(c) },
              )
            : await x.provider.mergePullRequest(
                x.context,
                param(c, 'ref'),
                input,
              ),
        ),
      });
    },
  );
  return app;
}
