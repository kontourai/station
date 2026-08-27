import {
  buildUserProfileContextBlock,
  type UserProfileSettings,
} from '@kontourai/station-contracts/user-profile';
import { feedbackOps } from '../../telemetry/metrics.js';
import { composeAmbientTurnText } from '../../utils/ambient-context.js';
import {
  approxInjectedTokens,
  userTextPart,
} from './chat-context-injection.js';
import type { ChatMessage } from './chat-request-preparation.js';

interface RatingLike {
  conversationId?: string;
  rating?: string;
  messageIndex?: number;
  reason?: string;
}

/**
 * station#2649: returns the composed context AND, when a feedback block was
 * actually appended, the receipt facts describing THAT block — one
 * derivation, so the context-injection record cannot claim a feedback block
 * this function did not compose (or miss one it did).
 */
export function injectConversationFeedbackContext(
  ratings: RatingLike[],
  conversationId: string | undefined,
  ragContext: string | null,
): {
  ragContext: string | null;
  feedback: { flaggedMessages: number; approxTokens: number } | null;
} {
  if (!conversationId) {
    return { ragContext, feedback: null };
  }

  const negativeRatings = ratings.filter(
    (rating) =>
      rating.conversationId === conversationId &&
      rating.rating === 'thumbs_down',
  );
  if (negativeRatings.length === 0) {
    return { ragContext, feedback: null };
  }

  const ratingLines = negativeRatings
    .map(
      (rating) =>
        `- Message #${rating.messageIndex} was rated negatively${rating.reason ? `: "${rating.reason}"` : ''}`,
    )
    .join('\n');
  const block = `<conversation_feedback>\nThe user has flagged these responses in this conversation:\n${ratingLines}\nAdjust your approach accordingly.\n</conversation_feedback>`;
  feedbackOps.add(negativeRatings.length, {
    operation: 'inject-conversation',
  });
  return {
    ragContext: ragContext ? `${ragContext}\n\n${block}` : block,
    feedback: {
      flaggedMessages: negativeRatings.length,
      approxTokens: approxInjectedTokens(block),
    },
  };
}

/**
 * What a composition step actually did to the model input (station#2649).
 *
 * `applied` is the AUTHORITY for the per-turn context receipt, and it is
 * deliberately not the same question as "was there context to apply". Both
 * appliers below silently drop their whole block when the user message is
 * array-shaped and carries no text part — an attachment sent with no
 * caption, which `buildConversationTurnInput`
 * (`packages/sdk/src/query-domains/chatRuntimeStream.ts`) produces by pushing
 * a text part only `if (content)`. Recording composition INTENT there would
 * state that the model read project rules and behavior guidelines it was
 * never sent: the receipt must describe the effect, so it is built from this
 * flag. The drop itself is station#2743.
 *
 * The part whose absence causes that drop is resolved by `userTextPart`,
 * imported from `chat-context-injection.ts` so the appliers here and the
 * token measurement there can never disagree about which part is
 * model-facing.
 */
export interface AppliedChatContext {
  input: string | ChatMessage[];
  applied: boolean;
}

/**
 * station#2652 chapter 2: append the `[USER PROFILE]` block for the two
 * first-run questions, composed onto `ragContext` exactly like the behaviour
 * guidelines and workflow steering above it.
 *
 * The honesty property this function exists to hold: **a user who skipped the
 * questions gets nothing added.** `buildUserProfileContextBlock` is the single
 * derivation and returns `null` for an absent profile, an empty one, and one
 * carrying values outside the declared vocabularies — there is no default role
 * and no assumed comfort level, because a `[USER PROFILE]` block the user never
 * authored reads to the model exactly like one they did.
 *
 * Reach: this composer sits on Station's own engine's turn path only, and the
 * exclusion is enforced one frame up rather than by anything here.
 * `prepareChatRequest` has exactly one non-test caller — `chat.ts`'s
 * `POST /api/agents/:slug/chat` — and that handler refuses an
 * external-engine agent BEFORE it gets this far: `resolveUnavailablePersistedAgent`
 * applies `enriched-agents.ts`'s `isHonestlyAvailableConnectedAgent` (an agent
 * bound to a ready, enabled, non-`station` engine connection) and returns a 409
 * redirect instead of running a turn. So an external engine never reaches this
 * function, and the profile genuinely has no effect there — that engine builds
 * its own context. The limit is stated in `USER_PROFILE_ENGINE_REACH_NOTE` and
 * rendered verbatim in the first-run UI rather than left for a user to discover.
 */
export function injectUserProfileContext(
  profile: UserProfileSettings | null | undefined,
  ragContext: string | null,
): string | null {
  const block = buildUserProfileContextBlock(profile);
  if (!block) return ragContext;
  return ragContext ? `${ragContext}\n\n${block}` : block;
}

/**
 * #685: compose the UI's out-of-band ambient context (timezone, geolocation)
 * into the model-facing input only. The persisted user turn keeps the typed
 * `input` — callers must keep passing the original `input` to the
 * persistence seams (`ensureChatConversation`, `finalizeChatRequest`).
 */
export function applyAmbientContextToInput(
  input: string | ChatMessage[],
  ambientContext: string | null | undefined,
): AppliedChatContext {
  if (!ambientContext?.trim()) {
    return { input, applied: false };
  }

  if (typeof input === 'string') {
    return {
      input: composeAmbientTurnText(ambientContext, input),
      applied: true,
    };
  }

  const clone = JSON.parse(JSON.stringify(input)) as ChatMessage[];
  const textPart = userTextPart(clone);
  if (textPart?.text === undefined) {
    return { input: clone, applied: false };
  }
  textPart.text = composeAmbientTurnText(ambientContext, textPart.text);
  return { input: clone, applied: true };
}

export function applyCombinedContextToInput(
  input: string | ChatMessage[],
  injectContext: string | null,
  ragContext: string | null,
): AppliedChatContext {
  const combinedContext =
    [injectContext, ragContext].filter(Boolean).join('\n\n') || null;
  if (!combinedContext) {
    return { input, applied: false };
  }

  if (typeof input === 'string') {
    return { input: `${combinedContext}\n\n${input}`, applied: true };
  }

  const clone = JSON.parse(JSON.stringify(input)) as ChatMessage[];
  const textPart = userTextPart(clone);
  if (!textPart) {
    return { input: clone, applied: false };
  }
  textPart.text = `${combinedContext}\n\n${textPart.text}`;
  return { input: clone, applied: true };
}
