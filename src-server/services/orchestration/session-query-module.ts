import type {
  TaskUserInputAttachmentProjection,
  TaskUserInputProjection,
} from '@kontourai/station-contracts';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  createStationAnswerBinding,
  type StationAnswerBinding,
} from '@kontourai/station-contracts/task-basis';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';
import {
  observedAssistantMessageId,
  projectRuntimeEventsToMessages,
} from '@kontourai/station-shared/runtime-event-projection';
import type { SafeToolResultProjection } from '@kontourai/thread';
import {
  projectToolCompletedDescriptor,
  type ToolCompletedEventDescriptor,
} from './thread-tool-result-adapter.js';

/** Closed read intents exposed by the session query boundary. */
export type SessionQuery = { type: 'conversation'; threadId: string };

/** One exact, completed assistant answer within a Session. */
export type SessionAssistantTurnQuery = {
  type: 'assistant-turn';
  threadId: string;
  turnId: string;
};

/** One exact authored-input event within a Session. */
export type SessionUserInputQuery = {
  type: 'user-input';
  threadId: string;
  eventId: string;
};

/** One exact terminal tool result within a Session. */
export type SessionToolResultQuery = {
  type: 'tool-result';
  threadId: string;
  eventId: string;
};
export type SessionAnswerBasisQuery = {
  type: 'answer-basis';
  threadId: string;
  turnId: string;
};
export type SessionAnswerBasisQueryOutcome =
  | {
      status: 'found';
      sessionId: string;
      turnId: string;
      binding: StationAnswerBinding;
      /** Owner-observed completion time; never the request clock. */
      observedAt: string;
      /** Internal correlation only; never returned by the direct route. */
      projectSlug?: string;
      inputs: readonly {
        eventId: string;
        kind: 'initial' | 'steer' | 'unknown';
        prompt: string;
        attachments: readonly UserInputAttachmentProjection[];
      }[];
      /** The event id stays separate so reused toolCallId results never fold. */
      results: readonly {
        eventId: string;
        result: SafeToolResultProjection;
      }[];
    }
  | { status: 'not-found' }
  /** Descriptor owner detected corruption or a bounded-read budget breach. */
  | { status: 'corrupt' }
  | { status: 'unavailable' };

/** Shared wire shapes deliberately exclude bytes, paths, handles, and producer metadata. */
export type UserInputAttachmentProjection = TaskUserInputAttachmentProjection;
export type UserInputProjection = TaskUserInputProjection;

/** Descriptor-only EventStore fact; deliberately has no payload or bytes. */
export interface SessionUserInputEventDescriptor {
  eventId: string;
  threadId: string;
  turnId?: string;
  method: string;
  inputKind?: 'initial' | 'steer';
  prompt?: string;
  attachments: readonly UserInputAttachmentProjection[];
}

export type SessionToolResultEventDescriptor = ToolCompletedEventDescriptor;

/** One exact-answer replay may never become an unbounded transcript read. */
export const MAX_ASSISTANT_TURN_EVENTS = 1_000;
export const MAX_BASIS_TURN_DESCRIPTOR_BYTES = 128 * 1_024;

/** A fully bounded, descriptor-only turn window.  It intentionally has no
 * CanonicalRuntimeEvent/payload escape hatch: Basis must never replay a turn. */
export type SessionBasisTurnDescriptorWindow =
  | { status: 'found'; events: readonly SessionBasisTurnDescriptorEvent[] }
  | { status: 'corrupt' | 'over-budget' };
export interface SessionBasisTurnDescriptorEvent {
  eventId: string;
  threadId: string;
  turnId: string;
  method: string;
  sequence: number;
  observedAt: string;
  finishReason?: string;
  /** A bounded, non-empty text delta exists; text itself is never selected. */
  textDelta?: boolean;
  /** A bounded, non-empty terminal outputText exists; content never crosses this seam. */
  outputText?: boolean;
  input?: {
    kind: 'initial' | 'steer' | 'unknown';
    prompt: string;
    attachments: readonly UserInputAttachmentProjection[];
  };
  tool?: SessionToolResultEventDescriptor;
}

export interface SessionConversationProjection {
  id: string;
  agentSlug: string;
  projectSlug?: string;
  title: string;
  model?: string;
  acceptedModel?: string;
  environmentId?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  mutable: false;
}

/**
 * Total outcome for a session read. `not-found` deliberately covers an
 * unauthorized thread so the query boundary does not disclose its existence.
 * `unavailable` means the authorized query could not observe durable state;
 * callers that need a complete index must fail rather than silently omit it.
 */
export type SessionQueryOutcome =
  | {
      status: 'found';
      conversation: SessionConversationProjection;
      messages: readonly ConversationMessage[];
    }
  | { status: 'not-found' }
  | { status: 'unavailable' };

/**
 * An exact assistant-answer read. `not-found` deliberately covers a missing
 * Session, a denied Session, a missing/unfinished turn, and a turn with no
 * assistant answer so callers cannot distinguish any of those conditions.
 */
export type SessionAssistantTurnQueryOutcome =
  | {
      status: 'found';
      sessionId: string;
      turnId: string;
      projectSlug?: string;
      message: ConversationMessage;
    }
  | { status: 'not-found' }
  | { status: 'unavailable' };

export type SessionUserInputQueryOutcome =
  | {
      status: 'found';
      sessionId: string;
      eventId: string;
      turnId: string;
      projectSlug?: string;
      input: UserInputProjection;
    }
  | { status: 'not-found' }
  | { status: 'unavailable' };

export type SessionToolResultQueryOutcome =
  | {
      status: 'found';
      sessionId: string;
      eventId: string;
      projectSlug?: string;
      result: SafeToolResultProjection;
    }
  | { status: 'not-found' }
  | { status: 'unavailable' };

/** The narrow durable/read-model facts the module needs for this intent. */
export interface SessionConversationQuerySource<Session> {
  findSession(threadId: string): Promise<Session | null>;
  projectConversation(
    session: Session,
    events: readonly CanonicalRuntimeEvent[],
  ): {
    assignedAgentSlug?: string;
    conversationId?: string;
    environmentId?: string;
    acceptedModel?: string;
    projectSlug?: string;
    reportedModel?: string;
    effectiveModel?: string;
    model?: string;
    createdAt: string;
    updatedAt: string;
    lastEventAt?: string;
  } | null;
  canReadSession(threadId: string, authority: SessionReadAuthority): boolean;
  listEvents(threadId: string): readonly CanonicalRuntimeEvent[];
  /** Exact descriptor-only point lookup; no transcript or attachment bytes. */
  userInputEventById?(
    eventId: string,
  ): SessionUserInputEventDescriptor | undefined;
  /** Exact descriptor-only terminal tool lookup; never transcript hydration. */
  toolCompletedEventById?(
    threadId: string,
    eventId: string,
  ): SessionToolResultEventDescriptor | undefined;
  /**
   * Descriptor-only, exact turn window for Basis. Implementations must select
   * only the lifecycle, answer, authored-input descriptor, and safe tool
   * result fields needed below; raw payloads, attachment bytes, tool args,
   * and structured results must never cross this seam. Absent is unavailable
   * rather than permission to fall back to a Session transcript.
   */
  listBasisEventsForTurn?(
    threadId: string,
    turnId: string,
  ): SessionBasisTurnDescriptorWindow | readonly CanonicalRuntimeEvent[];
  /** Exact answer route seam; Basis itself is forbidden from using this. */
  listEventsForTurn?(
    threadId: string,
    turnId: string,
  ): readonly CanonicalRuntimeEvent[];
  /**
   * Durable, indexed Session project scope. This is intentionally separate
   * from a turn window: session.started/configured facts need not carry this
   * turn id, and inferring scope from the window silently treats a scoped
   * Session as global.
   */
  projectSlugForSession?(
    session: Session,
    threadId: string,
  ): string | undefined;
  /** Internal-only observation of a failed durable projection. */
  reportUnavailable?(
    query:
      | SessionQuery
      | SessionAssistantTurnQuery
      | SessionUserInputQuery
      | SessionToolResultQuery
      | SessionAnswerBasisQuery,
    error: unknown,
  ): void;
}

/**
 * A deep query Interface for one conversation intent.
 *
 * Invariants: authority is checked before durable replay; denied and absent
 * sessions are indistinguishable; the returned messages and title derive from
 * the same ordered event sequence. Ordering: resolve session identity, check
 * authority, then replay exactly once in event-store order. Performance: no
 * caller may separately replay the thread for its message body. Errors are
 * totalized as `unavailable`; this module neither mutates nor retries state.
 */
export interface SessionQueryModule {
  read(
    query: SessionQuery,
    authority: SessionReadAuthority,
  ): Promise<SessionQueryOutcome>;
  readAssistantTurn(
    query: SessionAssistantTurnQuery,
    authority: SessionReadAuthority,
  ): Promise<SessionAssistantTurnQueryOutcome>;
  readUserInput(
    query: SessionUserInputQuery,
    authority: SessionReadAuthority,
  ): Promise<SessionUserInputQueryOutcome>;
  readToolResult?(
    query: SessionToolResultQuery,
    authority: SessionReadAuthority,
  ): Promise<SessionToolResultQueryOutcome>;
  readAnswerBasis?(
    query: SessionAnswerBasisQuery,
    authority: SessionReadAuthority,
  ): Promise<SessionAnswerBasisQueryOutcome>;
}

function conversationTitle(
  messages: readonly ConversationMessage[],
  agentSlug: string,
): string {
  const firstUserText = messages
    .find((message) => message.role === 'user')
    ?.parts.find((part) => part.type === 'text')?.text;
  return firstUserText?.trim().slice(0, 80) || `${agentSlug} chat`;
}

function isCompletedAssistantAnswer(
  message: ConversationMessage,
  turnId: string,
): boolean {
  return (
    message.role === 'assistant' &&
    message.metadata?.turnId === turnId &&
    message.parts.some(
      (part) =>
        part.type === 'text' &&
        part.runtimeError !== true &&
        typeof part.text === 'string' &&
        part.text.trim().length > 0,
    )
  );
}

/**
 * A Task may pin an answer only after the turn's own ordered lifecycle says
 * it completed normally. A later abort (or a provider's cancelled completion)
 * wins over an earlier completion: rendering a partial/cancelled response as
 * a durable answer would give it a confidence it never earned.
 */
function hasSuccessfulCompletion(
  events: readonly CanonicalRuntimeEvent[],
  threadId: string,
  turnId: string,
): boolean {
  let started = false;
  let terminal: 'completed' | 'cancelled' | undefined;
  let invalidLifecycle = false;

  for (const event of events) {
    if (event.threadId !== threadId || event.turnId !== turnId) continue;
    if (event.method === 'turn.started') {
      // Claude may re-announce the active turn when a steer is accepted.
      // Repeated starts before settlement are idempotent lifecycle evidence,
      // not a new turn. A start after any terminal is contradictory.
      if (terminal !== undefined) invalidLifecycle = true;
      started = true;
      continue;
    }
    const method = event.method as string;
    const isCompleted = event.method === 'turn.completed';
    const isCancelled =
      method === 'turn.aborted' ||
      method === 'turn.cancelled' ||
      method === 'turn.failed' ||
      (isCompleted && event.finishReason === 'cancelled');
    if (!isCompleted && !isCancelled) continue;
    // A terminal observed before its start cannot be repaired by a later
    // start: accepting it would turn a corrupt partial history into an answer.
    if (!started) {
      invalidLifecycle = true;
      continue;
    }
    if (isCancelled) {
      // Any cancelled terminal sequence makes the answer unavailable,
      // including duplicate aborts. It must never be treated as a harmless
      // idempotent completed event.
      if (terminal !== undefined) invalidLifecycle = true;
      terminal = 'cancelled';
      continue;
    }
    if (isCompleted) {
      if (terminal === undefined) {
        terminal = 'completed';
      } else if (terminal !== 'completed') {
        invalidLifecycle = true;
      }
    }
  }
  return started && terminal === 'completed' && !invalidLifecycle;
}

/** Lifecycle validation over a descriptor window, with no payload replay. */
function hasSuccessfulBasisCompletion(
  events: readonly SessionBasisTurnDescriptorEvent[],
  threadId: string,
  turnId: string,
): boolean {
  let started = false;
  let terminal: 'completed' | 'cancelled' | undefined;
  for (const event of events) {
    if (event.threadId !== threadId || event.turnId !== turnId) return false;
    if (event.method === 'turn.started') {
      if (terminal) return false;
      started = true;
      continue;
    }
    const cancelled =
      event.method === 'turn.aborted' ||
      event.method === 'turn.cancelled' ||
      event.method === 'turn.failed' ||
      (event.method === 'turn.completed' && event.finishReason === 'cancelled');
    if (!cancelled && event.method !== 'turn.completed') continue;
    if (!started || terminal === 'cancelled') return false;
    if (cancelled) {
      terminal = 'cancelled';
      continue;
    }
    terminal = 'completed';
  }
  return started && terminal === 'completed';
}

/** Do not turn chain-of-thought or tool internals into a Task answer. */
function answerOnly(message: ConversationMessage): ConversationMessage | null {
  const parts = message.parts.filter(
    (part) =>
      part.type === 'text' &&
      part.runtimeError !== true &&
      typeof part.text === 'string' &&
      part.text.trim().length > 0,
  );
  if (parts.length === 0) return null;
  return { ...message, parts };
}

const MAX_BASIS_ID_BYTES = 1_024;

function boundedBasisText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maximum
  );
}

/** All owner ids placed on the public Basis wire pass this boundary first. */
function boundedBasisId(value: unknown): value is string {
  return boundedBasisText(value, MAX_BASIS_ID_BYTES);
}

function isObservedAt(value: unknown): value is string {
  return boundedBasisText(value, 128) && Number.isFinite(Date.parse(value));
}

function projectUserInput(
  event: SessionUserInputEventDescriptor,
): UserInputProjection | null {
  const hasPrompt = typeof event.prompt === 'string' && event.prompt.trim();
  if (
    event.method !== 'turn.started' ||
    !event.turnId ||
    (!hasPrompt && event.attachments.length === 0)
  ) {
    return null;
  }
  const prompt = event.prompt?.trim() ? event.prompt : '';
  return {
    inputKind: event.inputKind ?? 'unknown',
    prompt,
    attachments: event.attachments,
  };
}

export function createSessionQueryModule<Session>(
  source: SessionConversationQuerySource<Session>,
): SessionQueryModule {
  return {
    async read(query, authority) {
      try {
        const session = await source.findSession(query.threadId);
        if (!session) return { status: 'not-found' };
        if (!source.canReadSession(query.threadId, authority)) {
          return { status: 'not-found' };
        }
        const events = source.listEvents(query.threadId);
        const conversationSession = source.projectConversation(session, events);
        if (!conversationSession?.assignedAgentSlug) {
          return { status: 'not-found' };
        }
        const messages = projectRuntimeEventsToMessages([...events]);
        const model =
          conversationSession.reportedModel ??
          conversationSession.effectiveModel ??
          conversationSession.model;
        return {
          status: 'found',
          conversation: {
            id: conversationSession.conversationId ?? query.threadId,
            agentSlug: conversationSession.assignedAgentSlug,
            ...(conversationSession.projectSlug
              ? { projectSlug: conversationSession.projectSlug }
              : {}),
            title: conversationTitle(
              messages,
              conversationSession.assignedAgentSlug,
            ),
            ...(model ? { model } : {}),
            ...(conversationSession.acceptedModel
              ? { acceptedModel: conversationSession.acceptedModel }
              : {}),
            ...(conversationSession.environmentId
              ? { environmentId: conversationSession.environmentId }
              : {}),
            createdAt: conversationSession.createdAt,
            updatedAt:
              conversationSession.lastEventAt ?? conversationSession.updatedAt,
            messageCount: messages.length,
            mutable: false,
          },
          messages,
        };
      } catch (error) {
        try {
          source.reportUnavailable?.(query, error);
        } catch {
          // Observation must never turn a total query outcome into a throw.
        }
        return { status: 'unavailable' };
      }
    },
    async readAssistantTurn(query, authority) {
      try {
        const session = await source.findSession(query.threadId);
        if (!session) return { status: 'not-found' };
        if (!source.canReadSession(query.threadId, authority)) {
          return { status: 'not-found' };
        }
        // This must stay an exact, turn-indexed read. The ordinary
        // conversation query intentionally replays a whole Session; doing
        // that once for every Task reference turns a small Basis panel into
        // N unbounded replays of the same durable history.
        const events = source.listEventsForTurn
          ? source.listEventsForTurn(query.threadId, query.turnId)
          : // Assistant-turn is the legacy conversation API, not Basis. Its
            // compatibility window is deliberately rejected by readAnswerBasis.
            source.listBasisEventsForTurn
            ? (() => {
                const window = source.listBasisEventsForTurn!(
                  query.threadId,
                  query.turnId,
                );
                return Array.isArray(window) ? window : [];
              })()
            : source
                .listEvents(query.threadId)
                .filter((event) => event.turnId === query.turnId);
        if (events.length > MAX_ASSISTANT_TURN_EVENTS) {
          // The backing adapter must ask for MAX+1 and surface an explicit
          // unavailable outcome rather than returning a partial lifecycle.
          return { status: 'unavailable' };
        }
        if (!hasSuccessfulCompletion(events, query.threadId, query.turnId)) {
          return { status: 'not-found' };
        }
        // A steered Claude turn may have a partial assistant row before the
        // final post-steer row. Only the latest normally settled projection is
        // an attachable answer; never marry terminal provenance to that prior
        // partial row.
        const message = projectRuntimeEventsToMessages([...events])
          .filter(
            (candidate) =>
              isCompletedAssistantAnswer(candidate, query.turnId) &&
              candidate.metadata?.answerEligible === true,
          )
          .at(-1);
        const answer = message ? answerOnly(message) : null;
        if (!answer) return { status: 'not-found' };
        const projectSlug = source.projectSlugForSession?.(
          session,
          query.threadId,
        );
        return {
          status: 'found',
          sessionId: query.threadId,
          turnId: query.turnId,
          ...(projectSlug ? { projectSlug } : {}),
          message: answer,
        };
      } catch (error) {
        try {
          source.reportUnavailable?.(query, error);
        } catch {
          // Observation must never turn a total query outcome into a throw.
        }
        return { status: 'unavailable' };
      }
    },
    async readUserInput(query, authority) {
      try {
        const session = await source.findSession(query.threadId);
        if (!session) return { status: 'not-found' };
        if (!source.canReadSession(query.threadId, authority)) {
          return { status: 'not-found' };
        }
        if (!source.userInputEventById) return { status: 'unavailable' };
        // Never derive a user row from transcript position or a turn window:
        // two steer prompts can share one turn id. This is a bounded exact-id
        // lookup when backed by EventStore.
        const event = source.userInputEventById(query.eventId);
        const input = event ? projectUserInput(event) : null;
        if (
          !event ||
          !input ||
          event.eventId !== query.eventId ||
          event.threadId !== query.threadId
        ) {
          return { status: 'not-found' };
        }
        const projectSlug = source.projectSlugForSession?.(
          session,
          query.threadId,
        );
        return {
          status: 'found',
          sessionId: query.threadId,
          eventId: query.eventId,
          turnId: event.turnId!,
          ...(projectSlug ? { projectSlug } : {}),
          input,
        };
      } catch (error) {
        try {
          source.reportUnavailable?.(query, error);
        } catch {
          // Observation must never turn a total query outcome into a throw.
        }
        return { status: 'unavailable' };
      }
    },
    async readToolResult(query, authority) {
      try {
        const session = await source.findSession(query.threadId);
        if (!session) return { status: 'not-found' };
        if (!source.canReadSession(query.threadId, authority)) {
          return { status: 'not-found' };
        }
        if (!source.toolCompletedEventById) return { status: 'unavailable' };
        const event = source.toolCompletedEventById(
          query.threadId,
          query.eventId,
        );
        if (
          !event ||
          event.eventId !== query.eventId ||
          event.threadId !== query.threadId
        ) {
          return { status: 'not-found' };
        }
        const projection = projectToolCompletedDescriptor(event);
        if (projection?.state !== 'available') {
          return { status: 'not-found' };
        }
        const projectSlug = source.projectSlugForSession?.(
          session,
          query.threadId,
        );
        return {
          status: 'found',
          sessionId: query.threadId,
          eventId: query.eventId,
          ...(projectSlug ? { projectSlug } : {}),
          result: projection.result,
        };
      } catch (error) {
        try {
          source.reportUnavailable?.(query, error);
        } catch {
          // Observation must never turn a total query outcome into a throw.
        }
        return { status: 'unavailable' };
      }
    },
    async readAnswerBasis(query, authority) {
      try {
        if (!boundedBasisId(query.threadId) || !boundedBasisId(query.turnId))
          return { status: 'not-found' };
        const session = await source.findSession(query.threadId);
        if (!session || !source.canReadSession(query.threadId, authority))
          return { status: 'not-found' };
        if (!source.listBasisEventsForTurn) return { status: 'unavailable' };
        const window = source.listBasisEventsForTurn(
          query.threadId,
          query.turnId,
        );
        // Legacy raw windows are intentionally rejected.  Keeping this union
        // for source migration makes the failure explicit rather than quietly
        // replaying payloads through the Basis boundary.
        if (Array.isArray(window)) return { status: 'not-found' };
        const descriptor = window as SessionBasisTurnDescriptorWindow;
        if (descriptor.status !== 'found') return { status: 'corrupt' };
        const events = descriptor.events;
        if (
          events.length > MAX_ASSISTANT_TURN_EVENTS ||
          !hasSuccessfulBasisCompletion(events, query.threadId, query.turnId)
        )
          return { status: 'not-found' };
        // A text delta or a bounded terminal outputText after the last
        // re-announced start is enough for Basis; its public contract exposes
        // only the answer tuple, never answer text or structured content.
        const lastStart = [...events]
          .reverse()
          .find((event) => event.method === 'turn.started');
        if (
          !lastStart ||
          !events.some(
            (event) =>
              event.sequence >= lastStart.sequence &&
              (event.textDelta === true || event.outputText === true),
          )
        )
          return { status: 'not-found' };
        const completion = [...events]
          .reverse()
          .find((event) => event.method === 'turn.completed');
        if (!completion) return { status: 'not-found' };
        const messageId = observedAssistantMessageId(lastStart.eventId);
        if (!messageId) return { status: 'not-found' };
        const binding = createStationAnswerBinding({
          sessionId: query.threadId,
          turnId: query.turnId,
          messageId,
        });
        const inputs = events.flatMap((event) => {
          if (
            event.threadId !== query.threadId ||
            event.turnId !== query.turnId
          )
            return [];
          return event.input
            ? [{ eventId: event.eventId, ...event.input }]
            : [];
        });
        const results = events.flatMap((event) => {
          if (
            event.threadId !== query.threadId ||
            event.turnId !== query.turnId ||
            event.method !== 'tool.completed' ||
            !event.tool
          ) {
            return [];
          }
          const projected = projectToolCompletedDescriptor(event.tool);
          return projected?.state === 'available'
            ? [{ eventId: event.eventId, result: projected.result }]
            : [];
        });
        const projectSlug = source.projectSlugForSession?.(
          session,
          query.threadId,
        );
        return {
          status: 'found',
          sessionId: query.threadId,
          turnId: query.turnId,
          binding,
          // EventStore descriptors always carry this. The epoch fallback is
          // only for older injected descriptor providers; it is deterministic
          // and explicitly never a request-time clock.
          observedAt: isObservedAt(completion.observedAt)
            ? completion.observedAt
            : '1970-01-01T00:00:00.000Z',
          ...(projectSlug ? { projectSlug } : {}),
          inputs,
          results,
        };
      } catch (error) {
        try {
          source.reportUnavailable?.(query, error);
        } catch {}
        return { status: 'unavailable' };
      }
    },
  };
}
