import type { ConversationOpenResolution } from '@kontourai/station-contracts/orchestration';
import { authenticatedFetch } from './client/http';
import { resolveApiBase } from './query-core';

/**
 * Resolve an inventory selection before creating a local chat tab. The result
 * is total; callers render read-only recovery from its status rather than
 * guessing a Session from the selected Agent's provider.
 */
export async function resolveConversationOpen(
  conversationId: string,
  apiBase?: string,
): Promise<ConversationOpenResolution> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  let response: Response;
  try {
    response = await authenticatedFetch(
      `${resolvedApiBase}/api/conversations/${encodeURIComponent(conversationId)}/open`,
    );
  } catch (cause) {
    throw conversationOpenResolutionError('network', cause);
  }
  let result: { success?: unknown; data?: unknown; error?: unknown };
  try {
    result = (await response.json()) as typeof result;
  } catch (cause) {
    throw conversationOpenResolutionError('invalid-response', cause);
  }
  if (!response.ok || result.success !== true) {
    throw conversationOpenResolutionError(
      response.status === 404 ? 'not-found' : 'rejected',
      typeof result.error === 'string' ? result.error : undefined,
    );
  }
  if (!parseConversationOpenResolution(result.data)) {
    throw conversationOpenResolutionError('invalid-response');
  }
  return result.data;
}

/** A caller-visible open failure; never turn a transport/parser failure into an empty chat. */
export type ConversationOpenResolutionFailure = Error & {
  kind: 'network' | 'not-found' | 'rejected' | 'invalid-response';
  cause?: unknown;
};

function conversationOpenResolutionError(
  kind: ConversationOpenResolutionFailure['kind'],
  cause?: unknown,
): ConversationOpenResolutionFailure {
  const error = new Error(
    typeof cause === 'string'
      ? cause
      : `Conversation open resolution failed: ${kind}`,
  ) as ConversationOpenResolutionFailure;
  error.kind = kind;
  if (cause !== undefined && typeof cause !== 'string') error.cause = cause;
  return error;
}

/** Reject hostile/old wire shapes rather than letting UI infer a Session. */
function parseConversationOpenResolution(
  value: unknown,
): value is ConversationOpenResolution {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (
    !['resolved', 'missing-session', 'unavailable'].includes(
      String(record.status),
    ) ||
    typeof record.canContinue !== 'boolean' ||
    !Array.isArray(record.recoveryActions) ||
    !record.conversation ||
    typeof record.conversation !== 'object' ||
    !record.transcript ||
    typeof record.transcript !== 'object'
  )
    return false;
  const conversation = record.conversation as Record<string, unknown>;
  const transcript = record.transcript as Record<string, unknown>;
  if (
    typeof conversation.id !== 'string' ||
    typeof conversation.title !== 'string' ||
    typeof conversation.agentSlug !== 'string' ||
    typeof transcript.available !== 'boolean' ||
    (transcript.available &&
      (!Number.isInteger(transcript.messageCount) ||
        (transcript.messageCount as number) < 0))
  )
    return false;
  if (
    !record.answerability ||
    typeof record.answerability !== 'object' ||
    typeof (record.answerability as Record<string, unknown>).answerable !==
      'boolean'
  )
    return false;
  const actions = record.recoveryActions as unknown[];
  if (
    actions.some(
      (action) =>
        action !== 'retry' && action !== 'start-new' && action !== 'restore',
    )
  )
    return false;
  if (record.status === 'resolved') {
    return (
      typeof record.currentSessionId === 'string' &&
      record.currentSessionId.length > 0 &&
      transcript.available === true &&
      transcript.owner === 'runtime' &&
      actions.length === 0
    );
  }
  if (
    typeof record.currentSessionId !== 'undefined' ||
    record.canContinue !== false ||
    !actions.includes('retry') ||
    !actions.includes('start-new')
  )
    return false;
  if (record.status === 'missing-session') {
    return transcript.available === false && transcript.owner === 'runtime';
  }
  return (
    transcript.available === false &&
    (transcript.owner === 'store' || transcript.owner === 'runtime')
  );
}
