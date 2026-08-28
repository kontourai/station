import type { ChatMessage } from './chat-request-preparation.js';
import { extractChatUserText } from './chat-request-preparation.js';

export function createChatConversationId(userId: string): string {
  return `${userId}:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
}

export function createChatTraceId(conversationId: string): string {
  return `${conversationId}:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
}

const NEW_CHAT_TITLE = 'New chat';
const INITIAL_TITLE_MAX_CHARS = 50;

/**
 * The first prompt is the only title fallback Station writes for a new
 * conversation. It is deterministic and provider-neutral, so a missing
 * title never becomes a durable agent-name placeholder.
 */
export function deriveInitialConversationTitle(
  input: string | ChatMessage[],
): string {
  const text = (typeof input === 'string' ? input : extractChatUserText(input))
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) {
    return NEW_CHAT_TITLE;
  }
  return text.length > INITIAL_TITLE_MAX_CHARS
    ? `${text.slice(0, INITIAL_TITLE_MAX_CHARS)}...`
    : text;
}

export async function ensureChatConversation(options: {
  conversationStorage: {
    getConversation(id: string): Promise<any>;
    createConversation(payload: {
      id: string;
      resourceId: string;
      userId: string;
      title?: string;
      metadata?: any;
    }): Promise<any>;
  } | null;
  conversationId?: string;
  userId?: string;
  slug: string;
  input: string | ChatMessage[];
  title?: string;
  /**
   * S1 of archive#1302: the project the turn was sent from, if any. Stamped into
   * the persisted conversation's `metadata` so file-backed conversations
   * become project-attributable going forward, mirroring the orchestration
   * session projection (which already carries `projectSlug`). Never
   * overwrites an already-persisted conversation (this only runs on
   * create), so this is zero behavior change beyond the new field.
   */
  projectSlug?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const {
    conversationStorage,
    conversationId,
    userId,
    slug,
    input,
    title,
    projectSlug,
  } = options;
  if (!conversationStorage || !conversationId || !userId) {
    return;
  }

  const existing = await conversationStorage.getConversation(conversationId);
  if (existing) {
    return;
  }

  const explicitTitle = typeof title === 'string' ? title.trim() : '';
  const titleSource = explicitTitle ? 'provider' : 'prompt';
  const resolvedTitle = explicitTitle || deriveInitialConversationTitle(input);
  const generatedWithoutPrompt =
    !explicitTitle && resolvedTitle === NEW_CHAT_TITLE;

  await conversationStorage.createConversation({
    id: conversationId,
    resourceId: slug,
    userId,
    title: resolvedTitle,
    metadata: {
      ...(options.metadata || {}),
      ...(projectSlug ? { projectSlug } : {}),
      titleSource: generatedWithoutPrompt ? 'generated' : titleSource,
    },
  });
}

function chatMessageText(message: {
  parts?: Array<{ type?: string; text?: string }>;
}): string {
  return (message.parts || [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function hasNonTextPart(message: {
  parts?: Array<{ type?: string }>;
}): boolean {
  return Boolean(message.parts?.some((part) => part.type !== 'text'));
}

function canonicalParts(parts?: Array<Record<string, unknown>>): string {
  // Part order is part of the turn identity: sending A then B can be a
  // different instruction from sending B then A. Object property order and
  // persistence-only fields are not identity, so project only the fields the
  // provider receives in a fixed insertion order before comparing.
  return JSON.stringify(
    (parts || []).map((part) => {
      const type = typeof part.type === 'string' ? part.type : '';
      if (type === 'text') {
        return {
          type,
          text: typeof part.text === 'string' ? part.text : '',
        };
      }
      return {
        type,
        mediaType: typeof part.mediaType === 'string' ? part.mediaType : '',
        url: typeof part.url === 'string' ? part.url : '',
      };
    }),
  );
}

/**
 * The user-role messages this turn's `input` represents, in the shape the
 * conversation store persists. Mirrors the agent framework's own input
 * persistence (a bare string becomes one text message; an array is persisted
 * message-by-message) so attachments survive, not just the text.
 */
function buildUserTurnMessages(input: string | ChatMessage[]): Array<{
  id: string;
  role: 'user';
  parts: NonNullable<ChatMessage['parts']>;
}> {
  if (typeof input === 'string') {
    return input.trim()
      ? [
          {
            id: crypto.randomUUID(),
            role: 'user' as const,
            parts: [{ type: 'text', text: input }],
          },
        ]
      : [];
  }

  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .filter((message) => message.role === 'user' && message.parts?.length)
    .map((message) => ({
      id: crypto.randomUUID(),
      role: 'user' as const,
      parts: message.parts as NonNullable<ChatMessage['parts']>,
    }));
}

// archive#1293: how far back `isUserTurnAlreadyPersisted` scans looking for
// this turn's own user message before concluding it hasn't landed yet.
// Bounded deliberately narrow — see that function's doc comment for why a
// wider (or unbounded) scan would risk false-positive-skipping a genuinely
// repeated prompt from an earlier, already-answered turn.
const RECENT_MESSAGE_SCAN_WINDOW = 5;

function isSystemEventMarkerRow(text: string): boolean {
  return text.startsWith('[SYSTEM_EVENT]');
}

/**
 * archive#1293: true when `targetText` is already present as a user message
 * within the last `windowSize` entries of `stored`, walking backward from the
 * tail and stopping as soon as a turn boundary is crossed: an assistant
 * message, OR a `[SYSTEM_EVENT]`-prefixed marker row (the `[CHAT_ERROR]`
 * failed-turn marker this same module persists, `chat-lifecycle.ts`).
 *
 * The stop-at-boundary rule is what keeps this from becoming the "silent
 * data loss" alternative archive#797's review explicitly rejected: crossing either
 * boundary means the transcript already closed out a turn, so anything
 * before it is history — an EARLIER, already-answered/already-recovered
 * occurrence of the same text (a legitimately repeated prompt, e.g.
 * "continue" sent twice, or two independently failed turns that happen to
 * carry identical text) — never evidence that THIS failed turn is a
 * duplicate. Scanning past that boundary would treat a distinct turn as
 * "already persisted" and skip persisting the real one, losing it silently.
 *
 * archive#1293 review (HIGH-1): the marker half of this rule is required,
 * not optional — the marker is stored with role `'user'`, so a scan that
 * only stopped at `role === 'assistant'` walked straight past it. Two
 * back-to-back zero-output failed turns with identical text (chat-lifecycle
 * persists the user text, then the `[CHAT_ERROR]` marker, for EVERY failed
 * turn) then hit exactly the loss this function exists to prevent: turn 2's
 * scan skips over turn 1's marker, finds turn 1's identical user text, and
 * concludes "already persisted" — silently dropping turn 2's own message.
 */
function isUserTurnAlreadyPersisted(
  stored: Array<{ role?: string } & Record<string, unknown>>,
  target: { parts?: Array<Record<string, unknown>> },
  windowSize: number,
): boolean {
  const targetText = chatMessageText(target);
  const targetHasAttachment = hasNonTextPart(target);
  // The target is unchanged over the scan; canonicalize it once rather than
  // serializing it again for every candidate row.
  const targetParts = targetHasAttachment ? canonicalParts(target.parts) : '';
  let scanned = 0;
  for (
    let i = stored.length - 1;
    i >= 0 && scanned < windowSize;
    i--, scanned++
  ) {
    const candidate = stored[i];
    if (candidate?.role === 'assistant') {
      // Answered — stop. See the doc comment above.
      return false;
    }
    if (candidate?.role === 'user') {
      const text = chatMessageText(candidate as any);
      if (isSystemEventMarkerRow(text)) {
        // A system-event marker closes out the turn it belongs to — stop
        // rather than skip past it (HIGH-1 above).
        return false;
      }
      // Text alone is a sufficient identity only for a text-only turn. An
      // image-only turn has empty text, so treating every caption-less image
      // as the same turn drops a recovery replay. Compare the full multipart
      // payload whenever an attachment is present; its data URL carries the
      // exact image bytes and media type.
      if (
        text === targetText &&
        (!targetHasAttachment ||
          canonicalParts(candidate.parts as Array<Record<string, unknown>>) ===
            targetParts)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Persists this turn's user message(s) when the conversation store doesn't
 * already hold them — archive#797.
 *
 * The agent framework persists the user turn lazily, as a side effect of
 * *consuming* the model stream. A turn that fails before the first chunk (a
 * client abort, or a provider failure raised during stream setup) therefore
 * leaves the conversation holding no user message at all, so reopening the
 * session shows the failure with nothing the user actually sent — the message
 * is simply gone.
 *
 * Idempotency is decided by scanning the last few stored messages (bounded,
 * `RECENT_MESSAGE_SCAN_WINDOW`) for this turn's own user text, not just the
 * literal tail (archive#1293) — the original tail-only check
 * (`stored[stored.length - 1]`) missed the case where the framework's own
 * queued write landed this turn's user message BEFORE this read, but some
 * other row (another interleaved system event, say) became the new tail in
 * between: the tail-only check would see a mismatch and persist a second
 * copy, creating the exact duplicate-bubble race archive#1293 reported. The bounded
 * backward scan finds that already-persisted row even when it isn't
 * literally last, while `isUserTurnAlreadyPersisted`'s stop-at-boundary rule
 * (an assistant reply, OR a `[SYSTEM_EVENT]` marker row — the latter added
 * after the archive#1293 review's HIGH-1 finding) keeps it from reaching back into
 * unrelated, already-closed-out history (see that function's doc comment) —
 * so a repeated prompt across two genuinely distinct turns still persists
 * both times, exactly as before.
 *
 * Known residual race, accepted rather than papered over (archive#797 review): the
 * check is a read-then-write, and the framework's own user-turn save is queued
 * on a background queue rather than awaited. Since archive#914 this applies to every
 * agent, not just file-backed ones — runtime and model-override agents now
 * share the same durable store with the framework rather than writing to a
 * throwaway of their own, so the window below is the same one, reached by more
 * paths. The trade is unchanged: a repeated bubble on an already-failed turn
 * beats silent loss. If stream setup ran but produced
 * no output — one non-text chunk pulled, say — that queued write can land
 * after this read (with nothing yet in `stored` at all), yielding a duplicate
 * user message. The failure mode is a repeated bubble on an already-failed
 * turn; the alternative, skipping the recovery, is silent data loss. The
 * asymmetry is deliberate.
 */
export async function persistUserTurnIfMissing(options: {
  memoryAdapter: {
    addMessage(
      msg: any,
      userId: string,
      conversationId: string,
      metadata?: any,
    ): Promise<void>;
    getMessages?(userId: string, conversationId: string): Promise<any[]>;
  };
  conversationId: string;
  userId: string;
  input: string | ChatMessage[];
}): Promise<boolean> {
  const { memoryAdapter, conversationId, userId, input } = options;
  const messages = buildUserTurnMessages(input);
  if (messages.length === 0) {
    return false;
  }

  if (typeof memoryAdapter.getMessages === 'function') {
    const stored =
      (await memoryAdapter.getMessages(userId, conversationId)) || [];
    if (
      isUserTurnAlreadyPersisted(
        stored,
        messages[messages.length - 1],
        RECENT_MESSAGE_SCAN_WINDOW,
      )
    ) {
      return false;
    }
  }

  for (const message of messages) {
    await memoryAdapter.addMessage(message, userId, conversationId);
  }
  return true;
}
