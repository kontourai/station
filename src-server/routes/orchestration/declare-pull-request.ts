/**
 * `declare_pull_request`'s REST side (#3161), mounted under
 * `/api/orchestration`. Its own leaf: the tool never reaches the commands
 * route, whose body decides what a request does.
 *
 * Only Station's own station-control tool code calls it. A request the
 * runtime boundary did not accept as Station's internal principal gets a 404.
 * The session is the VERIFIED caller's own, as the central authority guard
 * bound it to the request, and the turn is whichever turn that session is
 * running: the body names neither. What a body names is the pull request, in
 * exactly the shape the conversation link routes accept, parsed by the same
 * schema and checked by the same store rule.
 *
 * Answers `{ status }`, one of `declared`, `already-declared` or
 * `no-active-turn`. A declaration is only a candidate: it lands when the turn
 * completes, and a person keeps it onto a Task.
 */
import type { PullRequestLinkIdentity } from '@kontourai/station-contracts/conversation-pull-request-links';
import { Hono } from 'hono';
import { z } from 'zod/v3';
import type { StationControlDispatchScope } from '../../runtime/mcp/station-control-dispatch-scope.js';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
import {
  type StationControlPullRequestDeclarationOutcome,
  type StationControlPullRequestIdentity,
  StationControlPullRequestUnavailableError,
  type StationControlPullRequestUnavailableReason,
} from '../../services/orchestration/station-control-pull-request-declarations.js';
import { assertPullRequestLinkIdentity } from '../../services/pull-requests/conversation-pull-request-link-store.js';
import {
  stationControlRefusal,
  stationControlRefusalBody,
} from '../../tools/station-control-policy.js';
import { pullRequestLinkIdentitySchema } from '../pull-requests/conversation-pull-request-links.js';
import { refuseOutOfScopeDispatch } from './dispatch-scope.js';

const MAX_BODY_BYTES = 4 * 1024;
const UNAVAILABLE_COPY: Record<
  StationControlPullRequestUnavailableReason,
  string
> = {
  unconfigured: 'Pull request declarations are unavailable on this Station.',
  'too-many-declarations':
    'This session has too many declared outputs to compare against.',
  'no-workspace':
    'This session has no workspace to read the pull request from.',
  'unreadable-identity':
    'The pull request could not be read at that exact identity in this session workspace.',
  'turn-closed': 'This turn can no longer declare an output.',
  'not-admitted': 'The pull request could not be declared.',
};
const NO_STORE = { 'Cache-Control': 'no-store' };

/** The link identity plus the one optional word a person reads beside it. */
const declarePullRequestSchema = pullRequestLinkIdentitySchema
  .extend({ label: z.string().min(1).max(240).optional() })
  .strict();

interface DeclarePullRequestRoutesDeps {
  /** True only for Station's own internal principal. */
  isInternalRequest(request: Request): boolean;
  /** The scope rule's records; absent refuses every caller it constrains. */
  scope: StationControlDispatchScope | undefined;
  declare(input: {
    sessionId: string;
    pullRequest: StationControlPullRequestIdentity;
    label?: string;
  }): Promise<StationControlPullRequestDeclarationOutcome>;
}

type ParsedDeclaration =
  | { identity: PullRequestLinkIdentity; label?: string }
  | { error: string };

/**
 * The body, as the link routes would read it: the link identity schema, the
 * host lowercased, then the link store's own identity rule.
 */
async function readDeclaration(request: Request): Promise<ParsedDeclaration> {
  const read = await readBoundedRequestBody(request, MAX_BODY_BYTES);
  let body: unknown;
  try {
    body = read.status === 'ok' ? JSON.parse(read.body) : undefined;
  } catch {
    body = undefined;
  }
  const parsed = declarePullRequestSchema.safeParse(body);
  if (!parsed.success)
    return {
      error:
        'declare_pull_request needs provider, host, repository {owner, name} and ref (a positive integer string), and optionally a label.',
    };
  const { label, ...named } = parsed.data;
  // The link route lowercases the host before it compares or stores it.
  const identity: PullRequestLinkIdentity = {
    ...named,
    host: named.host.toLowerCase(),
  };
  try {
    assertPullRequestLinkIdentity(identity);
  } catch {
    return { error: 'The pull request identity is invalid.' };
  }
  return { identity, ...(label === undefined ? {} : { label }) };
}

export function createDeclarePullRequestRoutes(
  deps: DeclarePullRequestRoutesDeps,
) {
  const app = new Hono();

  app.post('/station-control/declare-pull-request', async (c) => {
    if (!deps.isInternalRequest(c.req.raw))
      return c.json({ error: { code: 'not_found' } }, 404, NO_STORE);
    const authority = stationControlRequestAuthority(c.req.raw);
    if (authority?.kind !== 'caller')
      return c.json(
        stationControlRefusalBody(
          stationControlRefusal('station_control_caller_required'),
        ),
        403,
        NO_STORE,
      );
    const sessionId = authority.caller.sessionId;
    // The declaration changes only the caller's own session, but it still
    // answers the one scope rule every session-aimed call answers: a caller
    // that is not bound never reaches a session that runs `host`, nor one
    // whose Project Station cannot confirm.
    const refused = refuseOutOfScopeDispatch(c, deps.scope, () => ({
      kind: 'thread',
      threadId: sessionId,
      remote: false,
    }));
    if (refused) return refused;

    const declaration = await readDeclaration(c.req.raw);
    if ('error' in declaration)
      return c.json(
        { success: false, error: declaration.error },
        400,
        NO_STORE,
      );
    const { identity, label } = declaration;
    try {
      const status = await deps.declare({
        sessionId,
        pullRequest: {
          provider: identity.provider,
          host: identity.host,
          owner: identity.repository.owner,
          repository: identity.repository.name,
          ref: identity.ref,
        },
        ...(label === undefined ? {} : { label }),
      });
      return c.json({ status }, 200, NO_STORE);
    } catch (error) {
      if (error instanceof StationControlPullRequestUnavailableError)
        return c.json(
          { success: false, error: UNAVAILABLE_COPY[error.reason] },
          409,
          NO_STORE,
        );
      throw error;
    }
  });

  return app;
}
