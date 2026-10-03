import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';
import { approxInjectedTokens } from '../../routes/chat/chat-context-injection.js';

/**
 * #3164: the one provider-neutral transcript seed for every fresh engine
 * session that has to be told what came before — an Agent/engine handoff and
 * a continuation that cannot resume a native cursor — and for the `seed` a
 * replay-seed fork returns.
 *
 * Messages are carried whole, newest first, under a token budget. Older
 * messages that do not fit are left out and counted, and the seed tells the
 * engine so. Only the newest message can be shortened, and only when it alone
 * exceeds the budget; its middle is then replaced by a marker that says how
 * much was cut.
 *
 * Tokens are Station's existing byte-derived estimate
 * (`approxInjectedTokens`, UTF-8 bytes / 4), the same one the context
 * receipt reports. It is an estimate, not a tokenizer.
 */

/** Default seed budget, in estimated tokens (about 32 KB of UTF-8 text). */
export const TRANSCRIPT_SEED_DEFAULT_TOKEN_BUDGET = 8_000;
/** Budgets above this are refused, never silently clamped. */
export const TRANSCRIPT_SEED_MAX_TOKEN_BUDGET = 64_000;
/** Below this the disclosure alone could crowd out every message. */
export const TRANSCRIPT_SEED_MIN_TOKEN_BUDGET = 1_000;

/**
 * No Station tool can page through a conversation's lineage for the engine
 * that receives the seed (`get_conversation_messages` reads one Session,
 * unpaged, and only Agents that author station-control have it), so the seed
 * says the omitted history is unavailable rather than naming a tool.
 */
export const TRANSCRIPT_SEED_OMITTED_UNAVAILABLE =
  'The omitted messages are not available to you in this session; ask the user if you need earlier detail.';

export interface TranscriptSeedEntry {
  role: 'user' | 'assistant';
  text: string;
}

export interface TranscriptSeed {
  text: string;
  /** Messages with text that the seed considered. */
  totalMessages: number;
  /** Messages present in the seed, including a shortened newest message. */
  includedMessages: number;
  /** Older messages left out whole. */
  omittedMessages: number;
  /** The newest message alone exceeded the budget and its middle was cut. */
  newestShortened: boolean;
}

/**
 * Conversation text only: user and assistant rows, their `text` parts, no
 * reasoning, tool rows or runtime errors. A legacy file-store message with a
 * string `content` is read as its text.
 */
export function transcriptSeedEntries(
  messages: readonly ConversationMessage[],
): TranscriptSeedEntry[] {
  return messages.flatMap((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') return [];
    const legacy = (message as { content?: unknown }).content;
    const text =
      typeof legacy === 'string'
        ? legacy.trim()
        : (message.parts ?? [])
            .filter(
              (part) =>
                part.type === 'text' &&
                typeof part.text === 'string' &&
                !part.runtimeError,
            )
            .map((part) => part.text!.trim())
            .filter(Boolean)
            .join('\n');
    return text ? [{ role: message.role, text }] : [];
  });
}

function label(entry: TranscriptSeedEntry): string {
  return entry.role === 'user' ? 'User' : 'Assistant';
}

function renderEntry(entry: TranscriptSeedEntry): string {
  return `${label(entry)}: ${entry.text}`;
}

function disclosure(input: {
  total: number;
  included: number;
  omitted: number;
  shortened: boolean;
}): string {
  const lines: string[] = [];
  if (input.total === 0) {
    lines.push('There are no earlier messages.');
  } else if (input.omitted === 0) {
    lines.push(
      `All ${input.total} earlier messages are included below, oldest first.`,
    );
  } else {
    lines.push(
      `Only the ${input.included} most recent of ${input.total} messages fit the size limit and are included below, oldest first. The ${input.omitted} earlier messages are omitted. ${TRANSCRIPT_SEED_OMITTED_UNAVAILABLE}`,
    );
  }
  if (input.shortened) {
    lines.push(
      'The most recent message was too long to include whole: its beginning and end are shown, and its middle is marked as omitted.',
    );
  }
  return lines.join('\n');
}

function render(heading: string, head: string, body: string[]): string {
  return [`${heading}\n${head}`, ...body].join('\n\n');
}

/**
 * Keep the largest beginning-and-end of `entry` whose rendering fits
 * `available` estimated tokens, cutting on code points so no surrogate pair
 * is split. Returns null when not even the marker fits.
 */
function shortenNewest(
  entry: TranscriptSeedEntry,
  available: number,
): string | null {
  const chars = Array.from(entry.text);
  const shortened = (keep: number) => {
    const headLength = Math.ceil(keep / 2);
    const tailLength = keep - headLength;
    const head = chars.slice(0, headLength).join('');
    const tail = tailLength
      ? chars.slice(chars.length - tailLength).join('')
      : '';
    return `${label(entry)}: ${head}\n[… ${chars.length - keep} characters omitted from the middle of this message …]\n${tail}`;
  };
  let low = 0;
  let high = chars.length - 1;
  if (approxInjectedTokens(`${shortened(low)}\n\n`) > available) return null;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (approxInjectedTokens(`${shortened(middle)}\n\n`) <= available)
      low = middle;
    else high = middle - 1;
  }
  return shortened(low);
}

/**
 * Render whole messages, newest first, until the next one would exceed the
 * budget. The result's estimated size never exceeds `budgetTokens`.
 */
export function buildTranscriptSeed(input: {
  heading: string;
  entries: readonly TranscriptSeedEntry[];
  budgetTokens?: number;
}): TranscriptSeed {
  const budget = input.budgetTokens ?? TRANSCRIPT_SEED_DEFAULT_TOKEN_BUDGET;
  if (
    !Number.isInteger(budget) ||
    budget < TRANSCRIPT_SEED_MIN_TOKEN_BUDGET ||
    budget > TRANSCRIPT_SEED_MAX_TOKEN_BUDGET
  ) {
    throw new RangeError(
      `Transcript seed budget must be an integer from ${TRANSCRIPT_SEED_MIN_TOKEN_BUDGET} to ${TRANSCRIPT_SEED_MAX_TOKEN_BUDGET} estimated tokens; received ${budget}.`,
    );
  }
  const entries = input.entries;
  const total = entries.length;
  // Reserve the widest disclosure (every counter at its maximum, both
  // notices) so the real one can never push the seed over the budget.
  const reserve = approxInjectedTokens(
    `${input.heading}\n${disclosure({ total, included: total, omitted: total, shortened: true })}\n\n`,
  );
  if (reserve > budget) {
    throw new RangeError(
      'Transcript seed heading and disclosure alone exceed the seed budget.',
    );
  }
  let available = budget - reserve;
  const body: string[] = [];
  for (let index = total - 1; index >= 0; index--) {
    const rendered = renderEntry(entries[index]!);
    const cost = approxInjectedTokens(`${rendered}\n\n`);
    if (cost > available) break;
    body.unshift(rendered);
    available -= cost;
  }
  let shortened = false;
  if (body.length === 0 && total > 0) {
    const newest = shortenNewest(entries[total - 1]!, available);
    if (newest !== null) {
      body.push(newest);
      shortened = true;
    }
  }
  const omitted = total - body.length;
  const text = render(
    input.heading,
    disclosure({ total, included: body.length, omitted, shortened }),
    body,
  );
  return {
    text,
    totalMessages: total,
    includedMessages: body.length,
    omittedMessages: omitted,
    newestShortened: shortened,
  };
}
