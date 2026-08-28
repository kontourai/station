import {
  TURN_PROVENANCE_MAX_CONTEXT_SOURCES,
  type TurnProvenanceContextInjection,
} from '@kontourai/station-contracts/turn-provenance-context';
import type { ChatMessage } from './chat-request-preparation.js';

/**
 * archive#2649: the per-turn context-injection receipt, built by the `/chat`
 * execution engine AT DISPATCH from the exact strings it composes into the
 * model input — never reconstructed later. `chat-request-preparation.ts`
 * records each block as it builds the corresponding string;
 * `chat-primary-stream.ts` adds the conversation-feedback block the stream
 * itself composes, then emits the finished record as one
 * `context-injection` SSE frame. The station-agent adapter relays that frame
 * onto the turn's `turn.completed` metadata, where the turn-provenance fold
 * reads it into the envelope's `contextInjection` slot.
 */

/** The SSE frame `type` `/chat` emits for the finished record. */
export const CHAT_CONTEXT_INJECTION_EVENT = 'context-injection';

/**
 * Byte-derived token estimate (utf8 bytes / 4) of an injected string.
 * Deliberately approximate and labeled so throughout the contract and the
 * UI (`~N`): the honest alternative to a fabricated tokenizer-precise
 * number for strings whose real tokenization Station never observes.
 */
export function approxInjectedTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

/**
 * The user message's model-facing text part — the one an applier writes into,
 * and whose absence IS the silent drop (archive#2743).
 *
 * This lives here, in the lower-level module, so the appliers in
 * `chat-context.ts` and the token measurement below resolve the same part
 * through one definition without a circular import. If the two ever
 * disagreed, the delta would measure a part nobody wrote and clamp to
 * `~0 tokens` for context that did land — a zero measurement rendered as a
 * real one, which is exactly the class of lie this receipt exists to prevent.
 */
export function userTextPart(
  input: ChatMessage[],
): { type: string; text?: string } | undefined {
  return input
    .find((message) => message.role === 'user')
    ?.parts?.find(
      (part: { type: string; text?: string }) => part.type === 'text',
    );
}

/** The model-facing text a composition step writes into. */
function modelFacingText(input: string | ChatMessage[]): string {
  if (typeof input === 'string') return input;
  return userTextPart(input)?.text ?? '';
}

/**
 * Approximate tokens a composition step ADDED to the model input, measured
 * as the byte delta between the text before and after it ran (archive#2649).
 *
 * Used for ambient context, where Station writes a wrapper around the user's
 * text rather than a standalone block: the delta counts the bytes Station
 * actually added, so the figure cannot drift from the composition even if
 * that wrapper's shape changes. Never negative — a step that shortened the
 * input added nothing to report.
 */
export function approxAppliedTokenDelta(
  before: string | ChatMessage[],
  after: string | ChatMessage[],
): number {
  const delta =
    Buffer.byteLength(modelFacingText(after), 'utf8') -
    Buffer.byteLength(modelFacingText(before), 'utf8');
  return delta > 0 ? Math.ceil(delta / 4) : 0;
}

/**
 * Caps the knowledge-source list at the contract bound and DISCLOSES the
 * truncation, mirroring `omittedNames`/`omittedObservations` upstream.
 */
export function boundContextSources(sources: string[]): {
  sources: string[];
  omittedSources: number;
} {
  if (sources.length <= TURN_PROVENANCE_MAX_CONTEXT_SOURCES) {
    return { sources: [...sources], omittedSources: 0 };
  }
  return {
    sources: sources.slice(0, TURN_PROVENANCE_MAX_CONTEXT_SOURCES),
    omittedSources: sources.length - TURN_PROVENANCE_MAX_CONTEXT_SOURCES,
  };
}

/** Sum of every recorded block's approximate token estimate. */
export function totalApproxInjectedTokens(
  record: TurnProvenanceContextInjection,
): number {
  return (
    (record.knowledge?.approxTokens ?? 0) +
    (record.projectRules?.approxTokens ?? 0) +
    (record.guidelines?.approxTokens ?? 0) +
    (record.workflowSteering?.approxTokens ?? 0) +
    (record.conversationFeedback?.approxTokens ?? 0) +
    (record.ambient?.approxTokens ?? 0)
  );
}
