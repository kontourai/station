import type {
  ConversationPullRequestLinksProjection,
  PullRequestLinkIdentity,
} from '@kontourai/station-contracts/conversation-pull-request-links';
import { envelopeError } from './api-error-message';
import {
  type ClientRequestOptions,
  getJson,
  mutateJson,
  readJsonBody,
} from './http';

type Envelope<T> = { success?: boolean; data?: T; error?: string };
async function read<T>(response: Response): Promise<T> {
  // A refusal whose body is not JSON keeps its status; an unreadable 2xx is
  // refused the same way, with nothing to return.
  const body = (await readJsonBody(response)) as Envelope<T> | undefined;
  if (!response.ok || !body?.success || body.data === undefined)
    throw envelopeError(
      response,
      body,
      'Conversation pull requests unavailable',
    );
  return body.data;
}
const path = (apiBase: string, conversationId: string) => {
  if (!conversationId) throw new Error('Conversation identity is required');
  return `${apiBase}/api/conversation-pull-requests/${encodeURIComponent(conversationId)}`;
};

export async function getConversationPullRequestLinks(
  apiBase: string,
  conversationId: string,
  options?: ClientRequestOptions,
): Promise<ConversationPullRequestLinksProjection> {
  const result = await read<ConversationPullRequestLinksProjection>(
    await getJson(path(apiBase, conversationId), options),
  );
  if (result.conversationId !== conversationId || !Array.isArray(result.links))
    throw new Error(
      'Conversation pull request response has the wrong identity',
    );
  return result;
}

export async function linkConversationPullRequest(
  apiBase: string,
  conversationId: string,
  identity: PullRequestLinkIdentity,
  options?: ClientRequestOptions,
) {
  const result = await read<{ conversationId: string }>(
    await mutateJson(path(apiBase, conversationId), 'POST', options, identity),
  );
  if (result.conversationId !== conversationId)
    throw new Error(
      'Conversation pull request response has the wrong identity',
    );
  return result;
}

export async function unlinkConversationPullRequest(
  apiBase: string,
  conversationId: string,
  identity: PullRequestLinkIdentity,
  options?: ClientRequestOptions,
) {
  const result = await read<{ conversationId: string }>(
    await mutateJson(
      path(apiBase, conversationId),
      'DELETE',
      options,
      identity,
    ),
  );
  if (result.conversationId !== conversationId)
    throw new Error(
      'Conversation pull request response has the wrong identity',
    );
  return result;
}
