import type {
  ConversationPullRequestLink,
  ConversationPullRequestLinkObservation,
  PullRequestLinkIdentity,
} from '@kontourai/station-contracts/conversation-pull-request-links';
import type {
  IPullRequestProvider,
  PullRequest,
  PullRequestResult,
} from '@kontourai/station-contracts/pull-request-provider';
import { Hono } from 'hono';
import { z } from 'zod/v3';
import type { ConversationPullRequestLinkStore } from '../../services/pull-requests/conversation-pull-request-link-store.js';
import { getBody, param, validate } from '../schemas/schemas.js';

const identitySchema = z
  .object({
    provider: z.string().min(1).max(255),
    host: z.string().min(1).max(255),
    repository: z.object({
      owner: z.string().min(1).max(255),
      name: z.string().min(1).max(255),
    }),
    ref: z
      .string()
      .regex(/^[1-9]\d*$/)
      .max(32),
  })
  .strict();

type Access = {
  canRead: (request: Request, conversationId: string) => boolean;
  current: (request: Request) => boolean;
  operator: (request: Request) => string | undefined;
  declared?: (
    request: Request,
    conversationId: string,
  ) => Promise<ConversationPullRequestLink[]>;
};

export function createConversationPullRequestLinkRoutes(
  store: ConversationPullRequestLinkStore,
  providers: () => IPullRequestProvider[],
  access: Access,
) {
  const app = new Hono();
  const allowed = (c: any, conversationId: string) =>
    access.current(c.req.raw) && access.canRead(c.req.raw, conversationId);

  app.get('/:conversationId', async (c) => {
    const conversationId = param(c, 'conversationId');
    if (!allowed(c, conversationId))
      return c.json({ success: false, error: 'Conversation unavailable' }, 404);
    const links = [
      ...store.list(conversationId),
      ...(access.declared
        ? await access.declared(c.req.raw, conversationId)
        : []),
    ];
    const observedAt = new Date().toISOString();
    const observations: ConversationPullRequestLinkObservation[] = [];
    const observe = async (
      link: (typeof links)[number],
    ): Promise<ConversationPullRequestLinkObservation> => {
      const provider = providers().find(
        (candidate) =>
          candidate.id === link.provider && candidate.canServeHost(link.host),
      );
      if (!provider?.getPullRequestByIdentity)
        return {
          ...link,
          observedAt,
          status: {
            state: 'unsupported',
            reason:
              'This provider cannot refresh an explicitly linked pull request.',
          },
        };
      let result: PullRequestResult<PullRequest>;
      try {
        result = await provider.getPullRequestByIdentity(
          { host: link.host, repository: link.repository },
          link.ref,
        );
      } catch {
        return {
          ...link,
          observedAt,
          status: {
            state: 'unavailable',
            reason: 'The provider refresh failed for this pull request.',
          },
        };
      }
      const pullRequest = result.available ? result.data : undefined;
      return {
        ...link,
        observedAt,
        status: pullRequest
          ? {
              state: 'current',
              title: pullRequest.title,
              pullRequestState: pullRequest.state,
              ...(pullRequest.headSha ? { head: pullRequest.headSha } : {}),
            }
          : {
              state: 'unavailable',
              reason:
                result.reason ??
                'The provider did not return this pull request.',
            },
      };
    };
    // Bound provider subprocess pressure while avoiding one 10-second timeout
    // per link in series. Four fully-qualified reads run at a time.
    for (let offset = 0; offset < links.length; offset += 4) {
      observations.push(
        ...(await Promise.all(links.slice(offset, offset + 4).map(observe))),
      );
      if (!allowed(c, conversationId))
        return c.json(
          { success: false, error: 'Conversation unavailable' },
          404,
        );
    }
    return c.json({
      success: true,
      data: { conversationId, observedAt, links: observations },
    });
  });

  app.post('/:conversationId', validate(identitySchema), async (c) => {
    const conversationId = param(c, 'conversationId');
    const actor = access.operator(c.req.raw);
    if (!actor || !allowed(c, conversationId))
      return c.json({ success: false, error: 'Conversation unavailable' }, 404);
    const submitted = getBody(c) as PullRequestLinkIdentity;
    const identity: PullRequestLinkIdentity = {
      ...submitted,
      host: submitted.host.toLowerCase(),
    };
    const provider = providers().find(
      (candidate) =>
        candidate.id === identity.provider &&
        candidate.canServeHost(identity.host) &&
        candidate.getPullRequestByIdentity,
    );
    if (!provider?.getPullRequestByIdentity)
      return c.json(
        { success: false, error: 'Pull request provider unsupported' },
        409,
      );
    const resolved = await provider.getPullRequestByIdentity(
      { host: identity.host, repository: identity.repository },
      identity.ref,
    );
    if (!resolved.available || !resolved.data)
      return c.json(
        {
          success: false,
          error: resolved.reason ?? 'Pull request unavailable',
        },
        409,
      );
    const exact = resolved.data;
    if (
      exact.provider !== identity.provider ||
      exact.host !== identity.host ||
      exact.repository.owner !== identity.repository.owner ||
      exact.repository.name !== identity.repository.name ||
      exact.ref !== identity.ref
    )
      return c.json(
        { success: false, error: 'Provider identity mismatch' },
        409,
      );
    const links = await store.link(conversationId, identity, actor, () =>
      allowed(c, conversationId),
    );
    return c.json({ success: true, data: { conversationId, links } }, 201);
  });

  app.delete('/:conversationId', validate(identitySchema), async (c) => {
    const conversationId = param(c, 'conversationId');
    if (!access.operator(c.req.raw) || !allowed(c, conversationId))
      return c.json({ success: false, error: 'Conversation unavailable' }, 404);
    const links = await store.unlink(
      conversationId,
      getBody(c) as PullRequestLinkIdentity,
      () => allowed(c, conversationId),
    );
    return c.json({ success: true, data: { conversationId, links } });
  });
  return app;
}
