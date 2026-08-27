/**
 * The single declared maximum for a user-authored chat prompt (station#2807),
 * imported by every server-side turn-starting text bound — `/chat`'s size
 * check on `input`, the orchestration seam's `message`/`prompt` bounds (the
 * route the composer actually posts to), and the invoke schemas — and by the
 * UI composer's courtesy check. One number, so the composer's "N characters
 * over" message can never disagree with what any route enforces.
 *
 * Why 200,000 characters: it matches the bound the orchestration seam
 * (`foregroundMessageObjectSchema.message`, and the delegation prompt) already
 * enforced before #2807 unified it, so every entry path into a Station-engine
 * turn admits the same maximum. It is far above any hand-typed message
 * (≈50k tokens) while still refusing the multi-megabyte paste that previously
 * failed deep inside the engine as a provider error.
 *
 * Length is UTF-16 code units (`String.length`) on both sides of the
 * boundary, chosen because it is the one metric both sides can compute
 * identically and cheaply — not a token count. Known imprecision, accepted:
 * code points outside the BMP (most emoji) count as 2 units each, so an
 * overage figure can overstate how many such characters to remove. Removing
 * that many CODE UNITS always suffices to get under the limit; it may remove
 * fewer code points than the number shown.
 */
export const CHAT_INPUT_MAX_CHARS = 200_000;

/**
 * The declared maximum for TOOL-CARRIED text in a chat input (station#2830):
 * a tool call's arguments (`input`) and a tool result's payload (`output`,
 * `error`, `errorText`), summed across every part of every message and
 * checked separately from authored text above.
 *
 * Why its own constant, and why 400,000 characters:
 * - Tool payloads are machine-generated (a file read, a search result), so
 *   they are legitimately larger than any hand-typed prompt; a budget at the
 *   authored limit would refuse ordinary tool round-trips.
 * - 400,000 characters (≈100k tokens) keeps the worst-case model-facing turn
 *   (200k authored + 400k tool-carried ≈ 150k tokens) inside a 200k-token
 *   context window — the bound still fires before the engine's provider
 *   error, which is the whole point of sizing at the boundary.
 * - It is deliberately a literal, NOT arithmetic on CHAT_INPUT_MAX_CHARS:
 *   coupling the two would mean lowering the authored limit later silently
 *   drags the tool budget along (the review finding that shaped this split).
 *   Two budgets, two declared sources, moved only on purpose.
 *
 * Tool-carried text that is NOT a string (a tool call's arguments are a JSON
 * object more often than not) is measured in its serialized form; a value
 * that cannot be serialized is UNRECOGNIZED, never measured as zero.
 */
export const CHAT_INPUT_TOOL_PART_MAX_CHARS = 400_000;

/**
 * Result of sizing a chat `input`: either a recognized shape with its
 * combined authored-text length and its combined tool-carried-text length,
 * or an explicit refusal to guess.
 */
export type ChatInputSize =
  | { recognized: true; length: number; toolPayloadLength: number }
  | { recognized: false };

/**
 * Size a turn's text, failing CLOSED on any shape it does not recognize.
 * (Review round on #2807: the previous parts-only sizer measured the AI SDK
 * `ModelMessage` shape — text in `content` — as ZERO, so a 500,000-character
 * prompt passed the bound unmeasured. A size guard that returns 0 for input
 * it cannot recognize fails open by construction.)
 *
 * Recognized vocabulary — exactly what `Agent.streamText` accepts for
 * `input` (`string | UIMessage[] | BaseMessage[]`, `BaseMessage` being the
 * AI SDK `ModelMessage`):
 * - a plain string;
 * - `UIMessage[]`: messages whose `parts[]` carry `{ text }` entries;
 * - `ModelMessage[]`: messages whose `content` is a string (user/system/
 *   assistant) or an array of parts carrying `{ text }` entries.
 *
 * Two budgets are computed over the same traversal:
 * - `length`: AUTHORED text — a plain string, a part's `text` field, or a
 *   message's string `content` — bounded by CHAT_INPUT_MAX_CHARS wherever a
 *   human composes the turn.
 * - `toolPayloadLength`: TOOL-CARRIED text — a tool part's `input` (a tool
 *   call's arguments), `output` (a tool result), `error`/`errorText` (a
 *   failed result), or `toolName`, in EITHER vocabulary (`UIMessage.parts`
 *   and `ModelMessage.content` tool parts both use these field names in
 *   AI SDK 6) — bounded by CHAT_INPUT_TOOL_PART_MAX_CHARS (station#2830:
 *   these fields are model-facing text in a RECOGNIZED shape that previously
 *   summed to zero, so 500k characters of tool payload was admitted, bounded
 *   only by the 22 MiB body cap). Strings measure as their `.length`;
 *   non-string values measure as their `JSON.stringify` form, and a value
 *   that cannot be serialized is UNRECOGNIZED rather than measured as zero.
 *   A part carrying BOTH `text` and tool fields contributes to BOTH budgets.
 *   All fields are measured regardless of `role` or `type` — both are
 *   client-chosen at this boundary, so filtering on either would be a
 *   smuggling hole, not a semantic distinction. A part's remaining fields
 *   (`toolCallId`, `state`, provider metadata) are identifiers or envelope
 *   vocabulary, not payload, and are not measured.
 *
 * What this sizer does NOT count, and therefore does not bound:
 * - attachment bytes: a file part's `url` is bounded separately — over this
 *   same traversal, by `collectChatInputFileParts` and the chat-attachment
 *   limits (station#2828) — while the ModelMessage image/file forms, which
 *   carry bytes in `image`/`data` fields the #2828 collector does not
 *   collect, remain bounded only by the HTTP body cap. Do not read this
 *   sizer as bounding attachments.
 *
 * Anything else is UNRECOGNIZED and the caller must refuse the request
 * rather than guess a size: a non-string, non-array input; a message that
 * is not an object; a part that is not an object; a `text` field that is
 * not a string; a `parts`/`content` that is neither array nor string; a
 * message carrying BOTH `parts` and content-shaped `content` (neither
 * vocabulary has both — measure one and the other could hide text).
 */
export function chatInputSize(input: unknown): ChatInputSize {
  if (typeof input === 'string') {
    return { recognized: true, length: input.length, toolPayloadLength: 0 };
  }
  if (!Array.isArray(input)) {
    return { recognized: false };
  }
  let total = 0;
  let toolPayloadTotal = 0;
  for (const message of input) {
    if (
      message === null ||
      typeof message !== 'object' ||
      Array.isArray(message)
    ) {
      return { recognized: false };
    }
    const record = message as Record<string, unknown>;
    const parts = record.parts;
    const content = record.content;
    const contentShaped = typeof content === 'string' || Array.isArray(content);
    if (Array.isArray(parts)) {
      if (contentShaped) return { recognized: false };
      const sized = sizeParts(parts);
      if (!sized.recognized) return sized;
      total += sized.length;
      toolPayloadTotal += sized.toolPayloadLength;
      continue;
    }
    if (typeof content === 'string') {
      total += content.length;
      continue;
    }
    if (Array.isArray(content)) {
      const sized = sizeParts(content);
      if (!sized.recognized) return sized;
      total += sized.length;
      toolPayloadTotal += sized.toolPayloadLength;
      continue;
    }
    return { recognized: false };
  }
  return {
    recognized: true,
    length: total,
    toolPayloadLength: toolPayloadTotal,
  };
}

/**
 * The part fields that carry model-facing TOOL text, in either message
 * vocabulary. Shape-based on purpose: a part is measured for these fields
 * whatever its `type` says, because `type` is client-chosen at this
 * boundary.
 */
const TOOL_PART_TEXT_FIELDS = [
  'input',
  'output',
  'error',
  'errorText',
  'toolName',
] as const;

function sizeParts(parts: unknown[]): ChatInputSize {
  let total = 0;
  let toolPayloadTotal = 0;
  for (const part of parts) {
    if (part === null || typeof part !== 'object' || Array.isArray(part)) {
      return { recognized: false };
    }
    const record = part as Record<string, unknown>;
    const text = record.text;
    if (text !== undefined) {
      if (typeof text !== 'string') {
        return { recognized: false };
      }
      total += text.length;
    }
    for (const field of TOOL_PART_TEXT_FIELDS) {
      const value = record[field];
      if (value === undefined) continue;
      if (typeof value === 'string') {
        toolPayloadTotal += value.length;
        continue;
      }
      // A non-string tool payload (typically JSON) is measured in the form
      // that actually rides to the model: serialized. A value that cannot be
      // serialized (BigInt, cycles) is refused rather than measured as zero.
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(value);
      } catch {
        return { recognized: false };
      }
      if (typeof serialized !== 'string') {
        return { recognized: false };
      }
      toolPayloadTotal += serialized.length;
    }
  }
  return {
    recognized: true,
    length: total,
    toolPayloadLength: toolPayloadTotal,
  };
}

/**
 * A part carrying inline attachment bytes, as the chat route accepts them
 * (`{type:'file', mediaType, url:'data:...'}`).
 */
export interface ChatInputFilePart {
  mediaType?: unknown;
  url?: unknown;
}

/**
 * Collect the attachment-bearing parts of a chat input, walking EXACTLY the
 * shapes `chatInputSize` walks.
 *
 * Sharing the traversal is the point (station#2828). `chatInputSize`
 * deliberately excludes file-part `url`s from its character count — correct,
 * because attachments ride the same array shape and counting them would
 * refuse every image turn — but that exclusion is only safe if attachments
 * are bounded separately. A second, independently-written walker would be
 * free to recognize a different set of shapes, and any shape it missed (a
 * file part under `content[]` rather than `parts[]`, say) would be an
 * unbounded hole with both guards reporting success.
 *
 * `recognized: false` mirrors the size guard's fail-closed contract, so an
 * unrecognized envelope is refused rather than silently unvalidated.
 */
export function collectChatInputFileParts(input: unknown): {
  recognized: boolean;
  parts: ChatInputFilePart[];
} {
  if (typeof input === 'string') return { recognized: true, parts: [] };
  if (!Array.isArray(input)) return { recognized: false, parts: [] };
  const collected: ChatInputFilePart[] = [];
  for (const message of input) {
    if (
      message === null ||
      typeof message !== 'object' ||
      Array.isArray(message)
    ) {
      return { recognized: false, parts: [] };
    }
    const record = message as Record<string, unknown>;
    const parts = record.parts;
    const content = record.content;
    const contentShaped = typeof content === 'string' || Array.isArray(content);
    const source = Array.isArray(parts)
      ? parts
      : Array.isArray(content)
        ? content
        : undefined;
    if (Array.isArray(parts) && contentShaped) {
      return { recognized: false, parts: [] };
    }
    if (source === undefined) {
      if (typeof content === 'string') continue;
      return { recognized: false, parts: [] };
    }
    for (const part of source) {
      if (part === null || typeof part !== 'object' || Array.isArray(part)) {
        return { recognized: false, parts: [] };
      }
      const candidate = part as Record<string, unknown>;
      if (candidate.url !== undefined) {
        collected.push({
          mediaType: candidate.mediaType ?? candidate.mimeType,
          url: candidate.url,
        });
      }
    }
  }
  return { recognized: true, parts: collected };
}
