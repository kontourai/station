import type { EngineId } from '@kontourai/station-contracts/provider';
import { isSupportedTurnProvenanceEnvelope } from '@kontourai/station-contracts/turn-provenance';
import type { ChatMessage } from '../../types';

export interface ForkTurnSource {
  turnId: string;
  agentSlug: string;
  sessionId?: string;
  provider?: EngineId;
  model?: string;
}

/** Immutable execution identity recorded on the selected historical row. */
export function forkTurnSource(
  message: ChatMessage,
  exactSessionFallback?: Pick<ForkTurnSource, 'agentSlug'>,
): ForkTurnSource | null {
  if (!message.turnId || !message.answerEligible) return null;
  const agentSlug = message.agentSlug ?? exactSessionFallback?.agentSlug;
  if (!agentSlug) return null;
  const provenance = isSupportedTurnProvenanceEnvelope(message.provenance)
    ? message.provenance
    : null;
  const provider =
    provenance?.engine.state === 'observed'
      ? provenance.engine.value.provider
      : undefined;
  const model =
    provenance?.reportedModel.state === 'observed'
      ? provenance.reportedModel.value
      : provenance?.requestedModel.state === 'observed'
        ? provenance.requestedModel.value
        : message.model;
  return {
    turnId: message.turnId,
    agentSlug,
    sessionId: provenance?.sessionId ?? message.sessionId,
    provider,
    model,
  };
}

/**
 * #2216: a user row can fork from the nearest preceding completed assistant
 * turn. Failed assistant rows are not eligible, so this walks past them.
 */
export function precedingForkSource(
  messages: readonly ChatMessage[],
  userIndex: number,
): ForkTurnSource | null {
  for (let index = userIndex - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate?.role !== 'assistant') continue;
    const source = forkTurnSource(candidate);
    if (source) return source;
  }
  return null;
}

/**
 * #4406: a person's message that Regenerate or Edit and resend can send
 * again, in a fork that keeps everything before it (the original stays).
 */
export interface MessageResendSource {
  /**
   * The completed turn the fork keeps. `null` only when the message opened
   * the conversation: a fork before it is an empty chat, so the action starts
   * a new chat with the same Agent and Project instead.
   */
  fork: ForkTurnSource | null;
  text: string;
  /** The message's own parts; its file parts are the attachments re-sent. */
  parts: NonNullable<ChatMessage['contentParts']>;
}

export interface MessageResendRequest extends MessageResendSource {
  /** `regenerate` sends the message again; `edit` puts it in the composer. */
  mode: 'regenerate' | 'edit';
}

const NO_PARTS: NonNullable<ChatMessage['contentParts']> = [];

function authoredText(message: ChatMessage): string {
  const parts = message.contentParts ?? [];
  return (
    parts
      .filter((part) => part.type === 'text')
      .map((part) => part.content ?? '')
      .join('\n') ||
    message.content ||
    ''
  );
}

/**
 * The person's message at `userIndex` as something to send again, or `null`
 * when it cannot be: not the person's own words (an agent's message, a
 * Station check-back or continuation, a system event), a steer inside a
 * running turn, or a message whose earlier history has no turn a fork can
 * keep — sending it again there would silently drop that history.
 */
export function messageResendSource(
  messages: readonly ChatMessage[],
  userIndex: number,
): MessageResendSource | null {
  const message = messages[userIndex];
  if (
    message?.role !== 'user' ||
    message.ephemeral ||
    message.sender ||
    message.stationCheckBack ||
    message.stationMemoryContinuation
  )
    return null;
  if (
    message.turnId !== undefined &&
    messages[userIndex - 1]?.turnId === message.turnId
  )
    return null;
  const text = authoredText(message);
  if (!text.trim() || text.startsWith('[SYSTEM_EVENT]')) return null;
  const fork = precedingForkSource(messages, userIndex);
  if (!fork && hasEarlierExchange(messages, userIndex)) return null;
  return { fork, text, parts: message.contentParts ?? NO_PARTS };
}

function hasEarlierExchange(
  messages: readonly ChatMessage[],
  index: number,
): boolean {
  for (let earlier = 0; earlier < index; earlier += 1) {
    const message = messages[earlier];
    if (message && !message.ephemeral && message.role !== 'system') return true;
  }
  return false;
}

/**
 * The message that produced the answer at `answerIndex`: the nearest earlier
 * row of the person's, passing only the answer's own turn and transcript
 * notices. An answer no message of the person's asked for (another turn sits
 * in between) has nothing to regenerate from.
 */
export function regenerateSource(
  messages: readonly ChatMessage[],
  answerIndex: number,
): MessageResendSource | null {
  const answer = messages[answerIndex];
  if (answer?.role !== 'assistant') return null;
  for (let index = answerIndex - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (!candidate || candidate.ephemeral) continue;
    if (candidate.role === 'user') {
      if (
        candidate.turnId !== undefined &&
        answer.turnId !== undefined &&
        candidate.turnId !== answer.turnId
      )
        return null;
      return messageResendSource(messages, index);
    }
    if (candidate.role === 'assistant' && candidate.turnId !== answer.turnId)
      return null;
  }
  return null;
}

/** Same message and same fork point: a memoized row keeps its props. */
export function sameMessageResendSource(
  left: MessageResendSource | null | undefined,
  right: MessageResendSource | null | undefined,
): boolean {
  if (!left || !right) return left === right;
  if (left.text !== right.text || left.parts !== right.parts) return false;
  if (!left.fork || !right.fork) return left.fork === right.fork;
  return (
    left.fork.turnId === right.fork.turnId &&
    left.fork.agentSlug === right.fork.agentSlug &&
    left.fork.sessionId === right.fork.sessionId &&
    left.fork.provider === right.fork.provider &&
    left.fork.model === right.fork.model
  );
}
