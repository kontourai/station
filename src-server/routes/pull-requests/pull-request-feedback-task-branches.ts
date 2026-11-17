/**
 * `/api/pull-request-feedback` routes for Project defaults and pull
 * requests found on a Task's own branch, registered on the feedback routes'
 * own app (behind its preview gate):
 *
 * - `GET  /projects/:projectSlug/defaults`: a reader of the Project.
 * - `PUT  /projects/:projectSlug/defaults`: this Station's owner, in person
 *   (never Station's internal principal or a delegation credential). There
 *   is no chat to check yet: whether that person may continue the Task
 *   lead's chat is checked when a claim is made.
 * - `DELETE /conversations/:conversationId/derived`: "Remove from this
 *   chat", by a person who may change the chat's feedback.
 */
import type { Hono } from 'hono';
import { z } from 'zod/v3';
import type { PullRequestFeedbackTaskBranches } from '../../services/pull-requests/pull-request-feedback-task-branches.js';
import { getBody, param, validate } from '../schemas/schemas.js';
import { pullRequestLinkIdentitySchema } from './conversation-pull-request-links.js';
import type { PullRequestFeedbackRouteAccess } from './pull-request-feedback.js';

export interface PullRequestFeedbackTaskBranchRoutePorts {
  taskBranches: PullRequestFeedbackTaskBranches;
  canReadProject(request: Request, projectSlug: string): Promise<boolean>;
  /** After a derived link is removed: release its claim if nothing else links it. */
  dismissed(conversationId: string): void;
}

const defaultsSchema = z
  .object({
    settings: z
      .object({
        fixFailingChecks: z.boolean(),
        addressReviewComments: z.boolean(),
        reviewEachHead: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

const identityBodySchema = z
  .object({ identity: pullRequestLinkIdentitySchema })
  .strict();

export function registerPullRequestFeedbackTaskBranchRoutes(
  app: Hono,
  access: PullRequestFeedbackRouteAccess,
  ports: PullRequestFeedbackTaskBranchRoutePorts,
  /** The feedback routes' own writer rule for a chat. */
  writerId: (request: Request, conversationId: string) => string | undefined,
) {
  const unavailable = (c: any) =>
    c.json({ success: false, error: 'Project unavailable' }, 404);
  /** This Station's owner in person, never an agent: the defaults' writer. */
  const owner = (request: Request) =>
    access.current(request) && access.isPerson(request)
      ? access.operator(request)
      : undefined;
  const readable = async (request: Request, projectSlug: string) =>
    access.enabled() &&
    access.current(request) &&
    (await ports.canReadProject(request, projectSlug));

  app.get('/projects/:projectSlug/defaults', async (c) => {
    const projectSlug = param(c, 'projectSlug');
    if (!(await readable(c.req.raw, projectSlug))) return unavailable(c);
    const view = ports.taskBranches.defaults(
      projectSlug,
      !!owner(c.req.raw),
      access.readerOf(c.req.raw),
    );
    return view ? c.json({ success: true, data: view }) : unavailable(c);
  });

  app.put(
    '/projects/:projectSlug/defaults',
    validate(defaultsSchema),
    async (c) => {
      const projectSlug = param(c, 'projectSlug');
      const userId = owner(c.req.raw);
      if (!userId || !(await readable(c.req.raw, projectSlug)))
        return unavailable(c);
      const body = getBody(c) as z.infer<typeof defaultsSchema>;
      const view = ports.taskBranches.writeDefaults(
        projectSlug,
        body.settings,
        userId,
        access.readerOf(c.req.raw),
      );
      return view ? c.json({ success: true, data: view }) : unavailable(c);
    },
  );

  app.delete(
    '/conversations/:conversationId/derived',
    validate(identityBodySchema),
    async (c) => {
      const conversationId = param(c, 'conversationId');
      if (!writerId(c.req.raw, conversationId))
        return c.json(
          { success: false, error: 'Conversation unavailable' },
          404,
        );
      const body = getBody(c) as z.infer<typeof identityBodySchema>;
      if (
        !ports.taskBranches.dismiss(conversationId, {
          ...body.identity,
          host: body.identity.host.toLowerCase(),
        })
      )
        return c.json(
          { success: false, error: 'Conversation unavailable' },
          404,
        );
      ports.dismissed(conversationId);
      return c.json({ success: true, data: { conversationId } });
    },
  );
}
