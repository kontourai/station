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
  })
  .strict();

type Identity = (c: any) => string | undefined;
export function createPullRequestRoutes(
  providers: () => IPullRequestProvider[],
  context: (c: any) => Promise<any>,
  options: { operatorIdentityForRequest: Identity },
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
          await x.provider.mergePullRequest(x.context, param(c, 'ref'), input),
        ),
      });
    },
  );
  return app;
}
