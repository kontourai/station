import type { PullRequestLinkIdentity } from '@kontourai/station-contracts/conversation-pull-request-links';
import {
  type ConversationPullRequestFeedback,
  type ProjectPullRequestFeedbackDefaults,
  type PullRequestFeedbackByPullRequest,
  type PullRequestFeedbackOwner,
  type PullRequestFeedbackSettings,
  type PullRequestFeedbackView,
  pullRequestFeedbackKey,
} from '@kontourai/station-contracts/pull-request-feedback';
import { envelopeError, StationHttpError } from './api-error-message';
import { hasCapability } from './capability';
import {
  type ClientRequestOptions,
  getJson,
  mutateJson,
  readJsonBody,
} from './http';
import { fetchPublicStationCapabilities } from './publicStationCapabilities';

type Envelope<T> = { success?: boolean; data?: T; error?: string };
async function read<T>(response: Response): Promise<T> {
  const body = (await readJsonBody(response)) as Envelope<T> | undefined;
  if (!response.ok || !body?.success || body.data === undefined)
    throw envelopeError(response, body, 'Pull request feedback unavailable');
  return body.data;
}
const path = (apiBase: string, conversationId: string, suffix = '') => {
  if (!conversationId) throw new Error('Conversation identity is required');
  return `${apiBase}/api/pull-request-feedback/conversations/${encodeURIComponent(conversationId)}${suffix}`;
};

/**
 * Whether the host serves pull request agent feedback
 * (`pullRequestFeedback`). `false` also covers a handshake that could not
 * be read.
 */
export async function readPullRequestFeedbackCapability(
  apiBase: string,
): Promise<boolean> {
  const handshake = await fetchPublicStationCapabilities(apiBase);
  return handshake ? hasCapability(handshake, 'pullRequestFeedback') : false;
}

/** Every linked pull request's feedback, as this chat's reader sees it. */
export async function getConversationPullRequestFeedback(
  apiBase: string,
  conversationId: string,
  options?: ClientRequestOptions,
): Promise<ConversationPullRequestFeedback> {
  const result = await read<ConversationPullRequestFeedback>(
    await getJson(path(apiBase, conversationId), options),
  );
  if (
    result.conversationId !== conversationId ||
    !Array.isArray(result.pullRequests)
  )
    throw new Error('Pull request feedback response has the wrong identity');
  return result;
}

/** The chat that owns a pull request's feedback, from a 409 refusal. */
export function pullRequestFeedbackOwnerOf(
  error: unknown,
): PullRequestFeedbackOwner | undefined {
  if (
    !(error instanceof StationHttpError) ||
    error.status !== 409 ||
    error.code !== 'pull_request_feedback_owned_elsewhere'
  )
    return undefined;
  const owner = (error.details as { owner?: unknown } | undefined)?.owner as
    | Partial<PullRequestFeedbackOwner>
    | undefined;
  if (!owner || typeof owner !== 'object') return undefined;
  // A chat the reader may not read is named by neither id nor title.
  return typeof owner.conversationId === 'string'
    ? {
        conversationId: owner.conversationId,
        ...(typeof owner.title === 'string' ? { title: owner.title } : {}),
      }
    : {};
}

/**
 * One pull request's feedback, whichever chat is open. To a reader who may
 * not read the owning chat the owner is `{ readable: false }` and nothing
 * else is said.
 */
export async function getPullRequestFeedbackByPullRequest(
  apiBase: string,
  identity: PullRequestLinkIdentity,
  options?: ClientRequestOptions,
): Promise<PullRequestFeedbackByPullRequest> {
  const query = new URLSearchParams({
    provider: identity.provider,
    host: identity.host,
    owner: identity.repository.owner,
    name: identity.repository.name,
    ref: identity.ref,
  });
  const result = await read<PullRequestFeedbackByPullRequest>(
    await getJson(
      `${apiBase}/api/pull-request-feedback/by-pull-request?${query}`,
      options,
    ),
  );
  if (
    !result.identity ||
    pullRequestFeedbackKey(result.identity) !== pullRequestFeedbackKey(identity)
  )
    throw new Error('Pull request feedback response has the wrong identity');
  return result;
}

/**
 * Set a pull request's switches in this chat. Another chat's feedback is
 * refused (409, see {@link pullRequestFeedbackOwnerOf}) unless `move`.
 * Leaving `reviewEachHead` out keeps the value this chat stored.
 */
export async function writePullRequestFeedback(
  apiBase: string,
  conversationId: string,
  input: {
    identity: PullRequestLinkIdentity;
    settings: Pick<
      PullRequestFeedbackSettings,
      'fixFailingChecks' | 'addressReviewComments'
    > &
      Partial<Pick<PullRequestFeedbackSettings, 'reviewEachHead'>>;
    move?: boolean;
  },
  options?: ClientRequestOptions,
): Promise<PullRequestFeedbackView> {
  return read<PullRequestFeedbackView>(
    await mutateJson(path(apiBase, conversationId), 'PUT', options, {
      identity: input.identity,
      settings: input.settings,
      ...(input.move ? { move: true } : {}),
    }),
  );
}

/** Lift a pause for one more round. */
export async function sendPullRequestFeedbackAgain(
  apiBase: string,
  conversationId: string,
  identity: PullRequestLinkIdentity,
  options?: ClientRequestOptions,
): Promise<void> {
  await read<{ conversationId: string }>(
    await mutateJson(
      path(apiBase, conversationId, '/send-again'),
      'POST',
      options,
      { identity },
    ),
  );
}

/**
 * Turn every switch off for a pull request this chat owns. Found by the
 * pull request, not through the chat's links, so one unlinked since can
 * still be turned off.
 */
export async function turnOffPullRequestFeedback(
  apiBase: string,
  conversationId: string,
  identity: PullRequestLinkIdentity,
  options?: ClientRequestOptions,
): Promise<PullRequestFeedbackView> {
  return read<PullRequestFeedbackView>(
    await mutateJson(path(apiBase, conversationId), 'DELETE', options, {
      identity,
    }),
  );
}

const defaultsPath = (apiBase: string, projectSlug: string) => {
  if (!projectSlug) throw new Error('Project identity is required');
  return `${apiBase}/api/pull-request-feedback/projects/${encodeURIComponent(projectSlug)}/defaults`;
};

function projectDefaultsOf(
  value: ProjectPullRequestFeedbackDefaults,
  projectSlug: string,
): ProjectPullRequestFeedbackDefaults {
  if (value.projectSlug !== projectSlug || !value.settings)
    throw new Error('Pull request feedback response has the wrong identity');
  return value;
}

/** A Project's agent feedback defaults, and whether the reader may change them. */
export async function getProjectPullRequestFeedbackDefaults(
  apiBase: string,
  projectSlug: string,
  options?: ClientRequestOptions,
): Promise<ProjectPullRequestFeedbackDefaults> {
  return projectDefaultsOf(
    await read<ProjectPullRequestFeedbackDefaults>(
      await getJson(defaultsPath(apiBase, projectSlug), options),
    ),
    projectSlug,
  );
}

/**
 * Set a Project's defaults (this Station's owner only). They apply to pull
 * requests set up from now on, never to one already set up. Leaving
 * `reviewEachHead` out keeps the stored value.
 */
export async function writeProjectPullRequestFeedbackDefaults(
  apiBase: string,
  projectSlug: string,
  settings: Pick<
    PullRequestFeedbackSettings,
    'fixFailingChecks' | 'addressReviewComments'
  > &
    Partial<Pick<PullRequestFeedbackSettings, 'reviewEachHead'>>,
  options?: ClientRequestOptions,
): Promise<ProjectPullRequestFeedbackDefaults> {
  return projectDefaultsOf(
    await read<ProjectPullRequestFeedbackDefaults>(
      await mutateJson(defaultsPath(apiBase, projectSlug), 'PUT', options, {
        settings: {
          fixFailingChecks: settings.fixFailingChecks,
          addressReviewComments: settings.addressReviewComments,
          ...(settings.reviewEachHead === undefined
            ? {}
            : { reviewEachHead: settings.reviewEachHead }),
        },
      }),
    ),
    projectSlug,
  );
}

/**
 * Remove a pull request found on the chat's Task branch from the chat, for
 * good: its feedback stops unless it is also linked or kept there.
 */
export async function removeDerivedPullRequest(
  apiBase: string,
  conversationId: string,
  identity: PullRequestLinkIdentity,
  options?: ClientRequestOptions,
): Promise<void> {
  await read<{ conversationId: string }>(
    await mutateJson(
      path(apiBase, conversationId, '/derived'),
      'DELETE',
      options,
      {
        identity,
      },
    ),
  );
}

/**
 * Run Station's review of the pull request's current head again (or for
 * the first time, before it held still). Refused (409) while the Project's
 * review limit is reached or the head cannot be reviewed.
 */
export async function reviewPullRequestHeadAgain(
  apiBase: string,
  conversationId: string,
  identity: PullRequestLinkIdentity,
  options?: ClientRequestOptions,
): Promise<void> {
  await read<{ conversationId: string }>(
    await mutateJson(
      path(apiBase, conversationId, '/head-review/again'),
      'POST',
      options,
      { identity },
    ),
  );
}

/**
 * Send the current head review's required findings to the agent, even
 * with "Address review comments" off. The feedback caps still apply.
 */
export async function sendPullRequestHeadReviewFindings(
  apiBase: string,
  conversationId: string,
  identity: PullRequestLinkIdentity,
  options?: ClientRequestOptions,
): Promise<void> {
  await read<{ conversationId: string }>(
    await mutateJson(
      path(apiBase, conversationId, '/head-review/send'),
      'POST',
      options,
      { identity },
    ),
  );
}

/** The refusals Station words itself for Review again and Send to agent. */
const HEAD_REVIEW_REFUSALS = new Set([
  'pull_request_head_review_not_started',
  'pull_request_head_review_nothing_to_send',
  'pull_request_feedback_paused',
]);

/**
 * Why Review again or Send to agent did not go, as display text: the
 * server composes these sentences itself (a busy Project, the daily limit,
 * no reviewer, a pause), so they are shown as they come. Undefined for any
 * other failure, which callers describe as usual.
 */
export function pullRequestHeadReviewRefusal(
  error: unknown,
): string | undefined {
  return error instanceof StationHttpError &&
    error.status === 409 &&
    typeof error.code === 'string' &&
    HEAD_REVIEW_REFUSALS.has(error.code)
    ? error.message
    : undefined;
}
