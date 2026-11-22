/**
 * `/api/pull-request-feedback`: a person's switches for agent feedback on a
 * conversation's pull requests, and what Station sent.
 *
 * Reads need the conversation's read access. Writes also need a person:
 * Station's own internal principal (an agent's tool call) and another
 * Station's delegation credential are refused, so an agent can never turn
 * its own feedback on. Everything answers 404 while the
 * `pull-request-agent-feedback` Feature Preview is off.
 */
import type { PullRequestLinkIdentity } from '@kontourai/station-contracts/conversation-pull-request-links';
import { parsePullRequestFeedbackSettings } from '@kontourai/station-contracts/pull-request-feedback';
import { Hono } from 'hono';
import { z } from 'zod/v3';
import type { PullRequestFeedbackDelivery } from '../../services/pull-requests/pull-request-feedback-delivery.js';
import type { PullRequestFeedbackOwnership } from '../../services/pull-requests/pull-request-feedback-ownership.js';
import type { PullRequestHeadReviewer } from '../../services/pull-requests/pull-request-head-review.js';
import { getBody, param, validate } from '../schemas/schemas.js';
import { pullRequestLinkIdentitySchema } from './conversation-pull-request-links.js';
import {
  type PullRequestFeedbackTaskBranchRoutePorts,
  registerPullRequestFeedbackTaskBranchRoutes,
} from './pull-request-feedback-task-branches.js';

export interface PullRequestFeedbackRouteAccess {
  enabled(): boolean;
  current(request: Request): boolean;
  canRead(request: Request, conversationId: string): boolean;
  /** The person behind the request; undefined refuses a write. */
  operator(request: Request): string | undefined;
  /** What the request's principal may read now (another chat's title). */
  readerOf(request: Request): (conversationId: string) => boolean;
  /** False for Station's internal principal and delegation credentials. */
  isPerson(request: Request): boolean;
  /** The inbox's live send rule: whether this person may continue the chat. */
  mayContinue(conversationId: string, userId: string): boolean;
}

const settingsSchema = z
  .object({
    fixFailingChecks: z.boolean(),
    addressReviewComments: z.boolean(),
    reviewEachHead: z.boolean().optional(),
  })
  .strict();

const writeSchema = z
  .object({
    identity: pullRequestLinkIdentitySchema,
    settings: settingsSchema,
    move: z.boolean().optional(),
  })
  .strict();

const identityBodySchema = z
  .object({ identity: pullRequestLinkIdentitySchema })
  .strict();

const lower = (identity: PullRequestLinkIdentity): PullRequestLinkIdentity => ({
  ...identity,
  host: identity.host.toLowerCase(),
});

/**
 * The person a request may change this conversation's feedback as (Send
 * again, the switches, turning it off), or undefined: the routes' own
 * writer rule, shared with the attention item's `viewerMayChange`.
 */
export function pullRequestFeedbackWriterId(
  access: PullRequestFeedbackRouteAccess,
  request: Request,
  conversationId: string,
): string | undefined {
  if (
    !access.enabled() ||
    !access.current(request) ||
    !access.canRead(request, conversationId) ||
    !access.isPerson(request)
  )
    return undefined;
  const userId = access.operator(request);
  return userId && access.mayContinue(conversationId, userId)
    ? userId
    : undefined;
}

export function createPullRequestFeedbackRoutes(
  ownership: PullRequestFeedbackOwnership,
  delivery: () => PullRequestFeedbackDelivery | undefined,
  refresh: (conversationId: string) => void,
  access: PullRequestFeedbackRouteAccess,
  /** Project defaults and Task-branch pull requests, when composed. */
  taskBranches?: PullRequestFeedbackTaskBranchRoutePorts,
  /**
   * Station's review of each head; undefined while the
   * `pull-request-head-review` preview is off (its routes then answer 404).
   */
  headReview: () =>
    | Pick<PullRequestHeadReviewer, 'reviewAgain' | 'sendFindings'>
    | undefined = () => undefined,
) {
  const app = new Hono();
  // Before any body is parsed: while the preview is off every route answers
  // 404, a malformed body included.
  // Only the methods the routes serve: an all-method `use` would register
  // HEAD and PATCH paths the pairing table does not classify, and the
  // runtime refuses to start with an unclassified route.
  app.on(['GET', 'PUT', 'POST', 'DELETE'], '*', async (c, next) => {
    if (!access.enabled())
      return c.json({ success: false, error: 'Conversation unavailable' }, 404);
    await next();
  });
  const unavailable = (c: any) =>
    c.json({ success: false, error: 'Conversation unavailable' }, 404);
  const readable = (c: any, conversationId: string) =>
    access.enabled() &&
    access.current(c.req.raw) &&
    access.canRead(c.req.raw, conversationId);
  const viewerOf = (c: any, userId: string) => ({
    userId,
    canRead: access.readerOf(c.req.raw),
  });
  const writer = (c: any, conversationId: string) => {
    const userId = pullRequestFeedbackWriterId(
      access,
      c.req.raw,
      conversationId,
    );
    return userId ? viewerOf(c, userId) : undefined;
  };

  // Whichever chat is open: a reader who may not read the owning chat
  // learns only that another chat owns it (see `byPullRequest`).
  app.get('/by-pull-request', async (c) => {
    if (!access.current(c.req.raw)) return unavailable(c);
    const { provider, host, owner, name, ref } = c.req.query();
    const identity = pullRequestLinkIdentitySchema.safeParse({
      provider,
      host,
      repository: { owner, name },
      ref,
    });
    if (!identity.success)
      return c.json(
        { success: false, error: 'A pull request identity is required' },
        400,
      );
    return c.json({
      success: true,
      data: ownership.byPullRequest(lower(identity.data), {
        canRead: access.readerOf(c.req.raw),
      }),
    });
  });

  app.get('/conversations/:conversationId', async (c) => {
    const conversationId = param(c, 'conversationId');
    if (!readable(c, conversationId)) return unavailable(c);
    return c.json({
      success: true,
      data: {
        ...(await ownership.view(
          conversationId,
          viewerOf(c, access.operator(c.req.raw) ?? ''),
        )),
        viewerMayChange: !!writer(c, conversationId),
      },
    });
  });

  app.put(
    '/conversations/:conversationId',
    validate(writeSchema),
    async (c) => {
      const conversationId = param(c, 'conversationId');
      const actor = writer(c, conversationId);
      if (!actor) return unavailable(c);
      const body = getBody(c) as z.infer<typeof writeSchema>;
      const settings = parsePullRequestFeedbackSettings(body.settings);
      if (!settings)
        return c.json({ success: false, error: 'Settings are invalid' }, 400);
      // Left out, "Review each new head" keeps what this chat stored: a
      // client that knows only the two sending switches must not turn it off.
      const { reviewEachHead, ...sends } = settings;
      const result = await ownership.write({
        conversationId,
        identity: lower(body.identity),
        // Ignored while review of each head is not offered (its preview off).
        settings:
          body.settings.reviewEachHead === undefined || !headReview()
            ? sends
            : { ...sends, reviewEachHead },
        viewer: actor,
        ...(body.move ? { move: true } : {}),
      });
      switch (result.kind) {
        case 'ok':
          refresh(conversationId);
          return c.json({ success: true, data: result.view });
        case 'conflict':
          return c.json(
            {
              success: false,
              code: 'pull_request_feedback_owned_elsewhere',
              error: result.owner.title
                ? `Feedback for this pull request goes to “${result.owner.title}”.`
                : 'Feedback for this pull request goes to another chat.',
              details: { owner: result.owner },
            },
            409,
          );
        case 'not-linked':
          return c.json(
            {
              success: false,
              code: 'pull_request_not_linked',
              error: 'Link this pull request to the chat first.',
            },
            409,
          );
        case 'reviewer':
        case 'not-permitted':
          return unavailable(c);
        default:
          return c.json(
            { success: false, error: 'Pull request feedback unavailable' },
            503,
          );
      }
    },
  );

  app.delete(
    '/conversations/:conversationId',
    validate(identityBodySchema),
    async (c) => {
      const conversationId = param(c, 'conversationId');
      const actor = writer(c, conversationId);
      if (!actor) return unavailable(c);
      const body = getBody(c) as z.infer<typeof identityBodySchema>;
      const result = await ownership.off({
        conversationId,
        identity: lower(body.identity),
        viewer: actor,
      });
      if (result.kind !== 'ok') return unavailable(c);
      // Settles its notice, if it was paused or waiting.
      void delivery()?.deliver(conversationId);
      return c.json({ success: true, data: result.view });
    },
  );

  app.post(
    '/conversations/:conversationId/send-again',
    validate(identityBodySchema),
    async (c) => {
      const conversationId = param(c, 'conversationId');
      const actor = writer(c, conversationId);
      if (!actor) return unavailable(c);
      const body = getBody(c) as z.infer<typeof identityBodySchema>;
      const claim = ownership.ownedClaim(conversationId, lower(body.identity));
      const sender = delivery();
      if (!claim || !sender) return unavailable(c);
      const outcome = await sender.sendAgain(claim.prKey);
      if (outcome === 'not-paused')
        return c.json(
          {
            success: false,
            code: 'pull_request_feedback_not_paused',
            error: 'Feedback for this pull request is not paused.',
          },
          409,
        );
      return c.json({ success: true, data: { conversationId } });
    },
  );

  // Station's review of the pull request's current head: run it again, or
  // send its required findings to the agent with "Address review comments"
  // off. Only the owning chat, by the same writer rule as the switches.
  const headReviewAction = (action: 'again' | 'send') => async (c: any) => {
    const conversationId = param(c, 'conversationId');
    const actor = writer(c, conversationId);
    const reviewer = headReview();
    if (!actor || !reviewer) return unavailable(c);
    const body = getBody(c) as z.infer<typeof identityBodySchema>;
    const claim = ownership.ownedClaim(conversationId, lower(body.identity));
    if (!claim) return unavailable(c);
    if (action === 'send') {
      const outcome = await reviewer.sendFindings(claim.prKey);
      if (outcome === 'queued')
        return c.json({ success: true, data: { conversationId } });
      return c.json(
        outcome === 'paused'
          ? {
              success: false,
              code: 'pull_request_feedback_paused',
              error:
                'Feedback for this pull request is paused. Send again to lift it.',
            }
          : {
              success: false,
              code: 'pull_request_head_review_nothing_to_send',
              error: 'This head has no required findings to send.',
            },
        409,
      );
    }
    const started = await reviewer.reviewAgain(claim.prKey);
    if (started.outcome === 'started' || started.outcome === 'running')
      return c.json({ success: true, data: { conversationId } });
    return c.json(
      {
        success: false,
        code: 'pull_request_head_review_not_started',
        // The reviewer's own reason: a busy Project, the daily limit, no
        // reviewer, a head not here yet. Display text, built server-side.
        error: started.reason ?? 'Station could not start the review.',
        details: { outcome: started.outcome },
      },
      409,
    );
  };
  app.post(
    '/conversations/:conversationId/head-review/again',
    validate(identityBodySchema),
    headReviewAction('again'),
  );
  app.post(
    '/conversations/:conversationId/head-review/send',
    validate(identityBodySchema),
    headReviewAction('send'),
  );

  if (taskBranches)
    registerPullRequestFeedbackTaskBranchRoutes(
      app,
      access,
      taskBranches,
      (request, conversationId) =>
        pullRequestFeedbackWriterId(access, request, conversationId),
    );
  return app;
}
