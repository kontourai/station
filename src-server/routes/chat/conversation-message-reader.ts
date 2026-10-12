/**
 * The one unified conversation read (moved out of `conversations.ts` so a
 * second route — the station-control `read_conversation` read,
 * `conversation-reference-read.ts` — serves exactly what the chat UI, the
 * export and the fork read serve, through the same owner checks and the
 * same serve-time sanitization, rather than a copy of them).
 */
import {
  isHostedSessionReadAuthority,
  type SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';
import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';
import type { FileMemoryAdapter } from '../../adapters/file/memory-adapter.js';
import { scrubChatErrorMarkers } from '../../runtime/conversation/chat-error-marker.js';
import { resolveConversationTranscriptSource } from '../../runtime/conversation/conversation-transcript-source.js';
import { sanitizeConversationMessagesUIBlockProvenance } from '../../runtime/conversation/ui-block-provenance.js';
import { isPrincipalScopedAgentRequest } from '../../security/station-control-request-authority.js';
import { runtimeAgentKey } from '../../services/agents/runtime-agent-identity.js';
import type { Logger } from '../../utils/logger.js';

export interface ConversationMessageReaderDeps {
  /** The memory adapter for a runtime agent key, created lazily when allowed. */
  getAdapter(runtimeSlug: string): FileMemoryAdapter | null;
  authorityFor(request: Request): SessionReadAuthority;
  sessionMessageReader?: ConversationLineageReader & {
    readSessionMessages(
      threadId: string,
      authority: SessionReadAuthority,
    ): ConversationMessage[];
  };
  logger: Pick<Logger, 'warn'>;
}

export interface ConversationLineageReader {
  /**
   * #3112: the conversation's execution Sessions in lineage order (the id
   * itself when it has none). A follow-up its current Session could not take
   * runs in a successor, and its turns are stored under that Session's id.
   */
  conversationSessionIds?(conversationId: string): readonly string[];
}

/**
 * #3112: the most execution Sessions one conversation read follows. A
 * conversation gains a Session only when its current one cannot take the
 * next turn, so a longer lineage is refused rather than read partially.
 */
export const CONVERSATION_READ_MAX_SESSIONS = 64;

/** The outward refusal for a lineage past the bound; no internal detail. */
export const CONVERSATION_LINEAGE_TOO_LONG_REFUSAL = `This conversation spans more than ${CONVERSATION_READ_MAX_SESSIONS} Sessions and cannot be read in one piece.`;

export class ConversationLineageTooLongError extends Error {
  readonly name = 'ConversationLineageTooLongError';
  readonly code = 'conversation_lineage_too_long';
  constructor(readonly sessionCount: number) {
    super(
      `This conversation spans ${sessionCount} Sessions; at most ${CONVERSATION_READ_MAX_SESSIONS} can be read.`,
    );
  }
}

/** The conversation's lineage Session ids, refused past the read bound. */
export function boundedConversationSessionIds(
  reader: ConversationLineageReader | undefined,
  conversationId: string,
): readonly string[] {
  const sessionIds = reader?.conversationSessionIds?.(conversationId) ?? [
    conversationId,
  ];
  if (sessionIds.length > CONVERSATION_READ_MAX_SESSIONS)
    throw new ConversationLineageTooLongError(sessionIds.length);
  return sessionIds;
}

export interface ConversationMessageRead {
  messages: ConversationMessage[];
  source: 'store' | 'orchestration' | 'empty';
  /**
   * Why an empty read was empty, for callers that answer the user with it.
   * Left unset when we did not determine it — either because the read
   * succeeded, or because nothing here looked (see the hosted branch
   * below). A caller must not read absent as "we asked and it does not
   * exist" (archive#3158).
   */
  absence?: 'not-found' | 'no-messages';
}

/** One Session's unsanitized share of a conversation read. */
interface SessionSegmentRead {
  rows: ConversationMessage[];
  source: ConversationMessageRead['source'];
  absence?: ConversationMessageRead['absence'];
}

export function createConversationMessageReader({
  getAdapter,
  authorityFor,
  sessionMessageReader,
  logger,
}: ConversationMessageReaderDeps): {
  readConversationMessages(
    request: Request,
    slug: string,
    conversationId: string,
    resolvedAuthority?: SessionReadAuthority,
  ): Promise<ConversationMessageRead>;
} {
  /**
   * archive#1399 fix round 2, B2 (independent review) — the SERVE-boundary
   * sanitizer wrapper. `readConversationMessages` below is the one unified
   * read seam, so this is the one place that guarantees every caller (the
   * `/messages` route, `/export`, fork, summary) sees provenance the SERVER
   * has actually recomputed — never a `ConversationMessage[]` served
   * verbatim from the FileMemory store (`memory-adapter-messages.ts`'s
   * `readStoredMessages`, which serializes and reads back `parts` with no
   * equivalent write-time seam) nor a stale copy from before this fix
   * shipped. See `ui-block-provenance.ts`'s `sanitizeConversationMessagesUIBlockProvenance`
   * docblock for why serve-time sanitization (not only write-time) is
   * required here.
   */
  const sanitizeServedMessages = (
    messages: ConversationMessage[],
  ): ConversationMessage[] =>
    sanitizeConversationMessagesUIBlockProvenance(
      // A failed-turn marker persisted before its text was made
      // outward-safe may hold a provider's error body; serve the generic.
      scrubChatErrorMarkers(messages),
      (message, meta) => logger.warn(message, meta),
    );

  /**
   * One execution Session's share of a conversation read: memory store first
   * (standard userId, then location scan), then the runtime-event projection
   * for native-SDK sessions. Unsanitized; the conversation read sanitizes
   * what it serves.
   */
  const readSessionSegment = async (
    request: Request,
    runtimeSlug: string,
    authority: SessionReadAuthority,
    sessionId: string,
  ): Promise<SessionSegmentRead> => {
    const adapter = getAdapter(runtimeSlug);
    const hosted = isHostedSessionReadAuthority(authority);

    // Hosted file conversations have no persisted tenant binding. Do not
    // scan them as a fallback: an empty result must not reveal whether an
    // unbound transcript exists. Runtime sessions remain available through
    // the authority-gated projection below.
    let messages: ConversationMessage[] = [];
    let absence: 'not-found' | 'no-messages' | undefined;
    // #2377 slice B: the memory store serves a transcript by conversation id
    // alone. A station-control agent reads only a conversation its session's
    // owner owns (a bound operator caller is not scoped); anyone else's
    // falls through to the owner-scoped runtime projection below, which
    // answers as if the store held nothing.
    const storeReadable =
      !adapter ||
      !isPrincipalScopedAgentRequest(request) ||
      (await adapter.getConversation(sessionId))?.userId === authority.userId;
    if (adapter && !hosted && storeReadable) {
      // archive#4080 follow-up: the conventional-userId-then-
      // conversation-lookup fallback is the ONE shared definition of "which
      // store serves this conversation" — see
      // `conversation-transcript-source.ts`'s own doc.
      const source =
        await resolveConversationTranscriptSource<ConversationMessage>(
          adapter,
          `agent:${runtimeSlug}`,
          sessionId,
        );
      messages = source.messages;
      if (!source.occupied) {
        // The record is the distinction: a record not found means no
        // conversation by that id, a record whose reads stay empty means
        // one exists that nothing was ever said in.
        absence = source.conversationRecordFound ? 'no-messages' : 'not-found';
      }
    }
    if (messages.length > 0) return { rows: messages, source: 'store' };

    // Native-SDK (Claude/Codex) turns persist as runtime events, not in the
    // memory store. When the store has nothing, project the session's events
    // (threadId === sessionId) into the same message shape so these chats
    // refresh through this one unified read path. Additive: only fires on an
    // empty store, so ACP/internal conversations are unaffected.
    if (sessionMessageReader) {
      const projected = sessionMessageReader.readSessionMessages(
        sessionId,
        authority,
      );
      if (projected.length > 0) {
        return { rows: projected, source: 'orchestration' };
      }
      // The memory store is NOT the store of record for native-SDK
      // conversations — their turns persist as runtime events. So a null
      // there means "not in that store", which is true of every Claude Code
      // and Codex conversation, and it must not be reported as "no such
      // conversation" once this projection has also been consulted.
      //
      // `readSessionMessages` returns [] for both "no such session" and
      // "the authority denied it", with no existence channel — so once it
      // has run and found nothing, which absence occurred is genuinely
      // undetermined. Say that rather than claim the stronger one
      // (archive#3158 review).
      if (absence === 'not-found') absence = undefined;
    }
    return { rows: [], source: 'empty', absence };
  };

  /**
   * The one unified conversation read every engine family flows through.
   * Shared by the /messages and /export routes, fork, summary and the
   * station-control reference read, so each sees exactly what the chat UI
   * sees. `source` lets each caller record its own metrics.
   *
   * #3112: a conversation is every execution Session in its lineage. A
   * follow-up its current Session could not take (a failed Station-agent
   * turn ends that binding) runs in a successor Session, and that turn is
   * stored under the successor's id — so each Session is read in lineage
   * order, under the same per-Session owner checks, and the reads are
   * concatenated. A successor stores only its own turns: prior history
   * reaches its model through the read-only lineage memory view or the
   * model-only transcript seed, never as stored messages. A lineage past
   * {@link CONVERSATION_READ_MAX_SESSIONS} is refused.
   */
  const readConversationMessages = async (
    request: Request,
    slug: string,
    conversationId: string,
    resolvedAuthority?: SessionReadAuthority,
  ): Promise<ConversationMessageRead> => {
    const runtimeSlug = runtimeAgentKey(slug);
    const authority = resolvedAuthority ?? authorityFor(request);
    const sessionIds = boundedConversationSessionIds(
      sessionMessageReader,
      conversationId,
    );
    const messages: ConversationMessage[] = [];
    const sources = new Set<ConversationMessageRead['source']>();
    let absence: ConversationMessageRead['absence'];
    for (const sessionId of sessionIds) {
      const segment = await readSessionSegment(
        request,
        runtimeSlug,
        authority,
        sessionId,
      );
      messages.push(...segment.rows);
      sources.add(segment.source);
      // The conversation's own record answers why an empty read was empty.
      if (sessionId === conversationId) absence = segment.absence;
    }
    if (messages.length === 0)
      return { messages: [], source: 'empty', absence };
    // The serve-boundary sanitizer (see `sanitizeServedMessages`): required
    // for stored messages, an idempotent belt for projected ones.
    return {
      messages: sanitizeServedMessages(messages),
      source: sources.has('store') ? 'store' : 'orchestration',
    };
  };

  return { readConversationMessages };
}
