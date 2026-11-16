import type { PullRequestLinkIdentity } from '@kontourai/station-contracts/conversation-pull-request-links';
import type {
  ConversationPullRequestFeedback,
  PullRequestFeedbackOwner,
  PullRequestFeedbackSettings,
  PullRequestFeedbackView,
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
  if (typeof owner?.conversationId !== 'string') return undefined;
  return {
    conversationId: owner.conversationId,
    ...(typeof owner.title === 'string' ? { title: owner.title } : {}),
  };
}

/**
 * Set a pull request's switches in this chat. Another chat's feedback is
 * refused (409, see {@link pullRequestFeedbackOwnerOf}) unless `move`.
 */
export async function writePullRequestFeedback(
  apiBase: string,
  conversationId: string,
  input: {
    identity: PullRequestLinkIdentity;
    settings: Pick<
      PullRequestFeedbackSettings,
      'fixFailingChecks' | 'addressReviewComments'
    >;
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
