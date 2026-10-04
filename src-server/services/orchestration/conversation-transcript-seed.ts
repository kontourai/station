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
 * What the seed says about omitted messages. It names no read tool and claims
 * no unavailability: whether the receiving engine can call Station Control's
 * `get_conversation_messages` is decided after the seed is built (the target
 * Agent's authored or connection-default tool servers, the engine's delivery
 * channel, and, for ACP, a live per-connection capability), and that tool
 * reads one Session, unpaged. The stored conversation is the one fact true
 * for every target.
 */
export const TRANSCRIPT_SEED_OMITTED_NOTICE =
  'the full conversation remains stored in Station.';

/** Upper bound for a caller-supplied label (a title, an Agent) in a heading. */
const TRANSCRIPT_SEED_LABEL_MAX_BYTES = 200;

export interface TranscriptSeedEntry {
  role: 'user' | 'assistant';
  text: string;
}

export interface TranscriptSeedSource {
  entries: TranscriptSeedEntry[];
  /** User or assistant rows with no text to carry (tool, reasoning, error). */
  nonTextMessages: number;
}

export interface TranscriptSeed {
  text: string;
  /** User and assistant messages with text that the seed considered. */
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
export function transcriptSeedSource(
  messages: readonly ConversationMessage[],
): TranscriptSeedSource {
  const entries: TranscriptSeedEntry[] = [];
  let nonTextMessages = 0;
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
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
    if (text) entries.push({ role: message.role, text });
    else nonTextMessages += 1;
  }
  return { entries, nonTextMessages };
}

/**
 * Bound caller-supplied heading text by UTF-8 bytes, cutting on code points
 * and ending with a visible ellipsis, so no title can crowd out the seed.
 */
export function boundTranscriptSeedLabel(
  text: string,
  maxBytes = TRANSCRIPT_SEED_LABEL_MAX_BYTES,
): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const ellipsis = '…';
  let bytes = Buffer.byteLength(ellipsis, 'utf8');
  let kept = '';
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    kept += char;
    bytes += size;
  }
  return `${kept}${ellipsis}`;
}

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * The role label. A message whose first line is a code fence starts on its
 * own line, so the label cannot hide the fence from a Markdown reader or from
 * the fence tracking below.
 */
function prefix(entry: TranscriptSeedEntry): string {
  const label = entry.role === 'user' ? 'User' : 'Assistant';
  return FENCE_LINE.test(entry.text) ? `${label}:\n` : `${label}: `;
}

function renderEntry(entry: TranscriptSeedEntry): string {
  return `${prefix(entry)}${entry.text}`;
}

function disclosure(input: {
  total: number;
  included: number;
  omitted: number;
  nonText: number;
  shortened: boolean;
}): string {
  const lines: string[] = [];
  const one = (count: number) => count === 1;
  if (input.total === 0) {
    lines.push('There are no earlier user or assistant text messages.');
  } else if (input.omitted === 0) {
    lines.push(
      one(input.total)
        ? 'The 1 earlier user or assistant text message is included below.'
        : `All ${input.total} earlier user and assistant text messages are included below, oldest first.`,
    );
  } else {
    lines.push(
      `Only the ${input.included} most recent of ${input.total} user and assistant text messages ${one(input.included) ? 'fits' : 'fit'} the size limit and ${one(input.included) ? 'is' : 'are'} included below, oldest first. The ${input.omitted} earlier ${one(input.omitted) ? 'one is' : 'ones are'} omitted; ${TRANSCRIPT_SEED_OMITTED_NOTICE}`,
    );
  }
  if (input.nonText > 0) {
    lines.push(
      `${input.nonText} other user or assistant ${one(input.nonText) ? 'message' : 'messages'} had no text parts to carry and ${one(input.nonText) ? 'is' : 'are'} not included.`,
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
 * The code fence (backtick or tilde) still open at the end of `text`, if any:
 * CommonMark's rule that a fence closes on a line of at least as many of the
 * same character and nothing else.
 */
function openFence(text: string): string | null {
  let open: string | null = null;
  for (const line of text.split('\n')) {
    const fence = FENCE_LINE.exec(line)?.[1];
    if (!fence) continue;
    if (open === null) open = fence;
    else if (
      fence[0] === open[0] &&
      fence.length >= open.length &&
      line.trim() === fence
    )
      open = null;
  }
  return open;
}

/**
 * Keep the largest beginning-and-end of `entry` whose rendering fits
 * `available` estimated tokens, cutting on code points so no surrogate pair
 * is split. A code fence the cut leaves open is closed before the marker and
 * reopened after it. Returns null when not even the marker fits.
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
    const headFence = openFence(head);
    const tailFence = tailLength
      ? openFence(chars.slice(0, chars.length - tailLength).join(''))
      : null;
    return `${prefix(entry)}${head}${headFence ? `\n${headFence}` : ''}\n[… ${chars.length - keep} characters omitted from the middle of this message …]\n${tailFence ? `${tailFence}\n` : ''}${tail}`;
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
  nonTextMessages?: number;
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
  const nonText = input.nonTextMessages ?? 0;
  // Reserve the widest disclosure (every counter at its maximum, every
  // notice, plus slack for singular/plural wording) so the real one can never
  // push the seed over the budget.
  const reserve = approxInjectedTokens(
    `${input.heading}\n${disclosure({ total, included: total, omitted: total, nonText, shortened: true })}${' '.repeat(16)}\n\n`,
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
    disclosure({ total, included: body.length, omitted, nonText, shortened }),
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
