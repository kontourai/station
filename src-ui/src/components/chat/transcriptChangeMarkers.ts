import type { ConversationContextBoundaryPolicy } from '@kontourai/station-contracts/conversation-context-boundary';
import type { ConversationHandoffProjection } from '@kontourai/station-contracts/orchestration';
import {
  isSupportedTurnProvenanceEnvelope,
  type TurnProvenanceEngine,
} from '@kontourai/station-contracts/turn-provenance';
import type { ChatMessage } from '../../types';

/** The models two adjacent turns of one Session ran on. */
export interface TranscriptModelChange {
  from: string;
  to: string;
}

/**
 * What a transcript row says about a change of model or engine, derived only
 * from what each turn recorded and from the handoff and context-boundary
 * rows. Nothing here is written anywhere, so a reload, another device and an
 * old chat all derive the same rows.
 */
export interface TranscriptChangeFacts {
  /** Before the first answer row of a turn that ran another model. */
  modelChange?: TranscriptModelChange;
  /** On an engine-switch or fresh-context row: the engine before it. */
  previousEngine?: TurnProvenanceEngine;
  /**
   * On an engine-switch row whose target Session follows a fresh context
   * that had not run yet: how that reset started it, which is what the new
   * engine was given instead of recent messages.
   */
  startedFrom?: ConversationContextBoundaryPolicy;
  /** A switch row with no switch behind it: not drawn at all. */
  hidden?: true;
  /** The first row after a drawn switch or fresh-context row. */
  afterMarker?: true;
}

/** One turn as its rows recorded it. */
export interface RecordedTurn {
  sessionId?: string;
  /** The model Station asked for (the turn's `turn.started`). */
  requested?: string;
  /** The model the engine itself reported for this turn, when it did. */
  reported?: string;
  engine?: TurnProvenanceEngine;
  /** True once the turn ended and its record is final. */
  settled: boolean;
  /**
   * The engine moved this turn onto another model than it asked for (a
   * turn-scope `model.rerouted`). What ran is then not on record, so the
   * turn compares with nothing, in either direction.
   */
  rerouted?: true;
}

type RerouteKey = string;
const rerouteKey = (sessionId: string, turnId: string): RerouteKey =>
  `${sessionId}\u0000${turnId}`;

/**
 * The turns a reroute names, whatever its scope: that turn did not run on
 * what it asked for.
 */
function reroutedTurns(messages: readonly ChatMessage[]): Set<RerouteKey> {
  const keys = new Set<RerouteKey>();
  for (const message of messages)
    for (const part of message.contentParts ?? []) {
      const reroute = part.modelReroute;
      if (reroute?.turnId)
        keys.add(rerouteKey(reroute.sessionId, reroute.turnId));
    }
  return keys;
}

/** Sessions whose engine moved the whole session onto another model. */
function sessionReroutes(messages: readonly ChatMessage[]): Set<string> {
  const sessions = new Set<string>();
  for (const message of messages)
    for (const part of message.contentParts ?? [])
      if (part.modelReroute?.scope === 'session')
        sessions.add(part.modelReroute.sessionId);
  return sessions;
}

/** A reroute line that changes the session's model or names no turn. */
function isSessionReroute(message: ChatMessage): boolean {
  return (
    message.contentParts?.some(
      (part) =>
        part.modelReroute !== undefined &&
        (part.modelReroute.scope === 'session' || !part.modelReroute.turnId),
    ) ?? false
  );
}

function recordedTurn(
  message: ChatMessage,
  rerouted: ReadonlySet<RerouteKey> = new Set(),
): RecordedTurn {
  const envelope = isSupportedTurnProvenanceEnvelope(message.provenance)
    ? message.provenance
    : undefined;
  const requested =
    envelope?.requestedModel.state === 'observed'
      ? envelope.requestedModel.value
      : message.model;
  const sessionId = envelope?.sessionId ?? message.sessionId;
  return {
    sessionId,
    ...(sessionId &&
    message.turnId &&
    rerouted.has(rerouteKey(sessionId, message.turnId))
      ? { rerouted: true as const }
      : {}),
    ...(requested ? { requested } : {}),
    ...(envelope?.reportedModel.state === 'observed'
      ? { reported: envelope.reportedModel.value }
      : {}),
    ...(envelope?.engine.state === 'observed'
      ? { engine: envelope.engine.value }
      : {}),
    settled: envelope !== undefined,
  };
}

/**
 * The model change between two adjacent turns of one Session, compared on
 * what ran: the engine's own report when both turns have one, else what
 * Station asked for when neither has one. One report without the other is
 * not comparable (an alias against a resolved id), and a turn that recorded
 * no model at all, or that the engine rerouted, breaks the comparison. A
 * turn still running has only what was asked for: it is compared with what
 * the previous turn asked for only when that turn has no report either (an
 * engine that never reports per turn); otherwise nothing shows until it
 * ends. Once it ends, the rule above applies.
 */
export function modelChangeBetween(
  previous: RecordedTurn | undefined,
  current: RecordedTurn,
): TranscriptModelChange | undefined {
  if (!previous?.sessionId || previous.sessionId !== current.sessionId)
    return undefined;
  if (previous.rerouted || current.rerouted) return undefined;
  if (!current.settled && previous.reported) return undefined;
  const [from, to] = !current.settled
    ? [previous.requested, current.requested]
    : previous.reported && current.reported
      ? [previous.reported, current.reported]
      : !previous.reported && !current.reported
        ? [previous.requested, current.requested]
        : [undefined, undefined];
  return from && to && from !== to ? { from, to } : undefined;
}

function sessionTimes(messages: readonly ChatMessage[]) {
  const times = new Map<string, number[]>();
  for (const message of messages) {
    if (message.role === 'system' || !message.sessionId) continue;
    if (typeof message.timestamp !== 'number') continue;
    const list = times.get(message.sessionId) ?? [];
    list.push(message.timestamp);
    times.set(message.sessionId, list);
  }
  return times;
}

interface ResetStart {
  policy: ConversationContextBoundaryPolicy;
  consumedAt: number;
}

/**
 * A switch row is drawn only for a switch that ran: a turn of the target
 * Session started after the switch was recorded. A record whose target is a
 * fresh context's Session that was already in use (the reset was consumed
 * before the switch was recorded) is a refused switch: the server reuses
 * that Session. That is read from the reset rows, which cover the whole
 * conversation, and compares two server times, so it holds before older
 * pages load and on every device.
 */
function switchRan(
  handoff: ConversationHandoffProjection,
  times: ReadonlyMap<string, number[]>,
  resets: ReadonlyMap<string, ResetStart>,
): boolean {
  const at = Date.parse(handoff.createdAt);
  if (Number.isNaN(at)) return false;
  const reset = resets.get(handoff.sessionId);
  if (reset && !(reset.consumedAt >= at)) return false;
  return (times.get(handoff.sessionId) ?? []).some((t) => t >= at);
}

/**
 * The last turn the rows recorded, for a turn still streaming outside them;
 * undefined when a switch or fresh context was drawn after it (the next turn
 * then runs in another Session anyway).
 */
export function lastRecordedTurn(
  messages: readonly ChatMessage[],
  facts: ReadonlyMap<number, TranscriptChangeFacts>,
): RecordedTurn | undefined {
  const rerouted = reroutedTurns(messages);
  const sessionScoped = sessionReroutes(messages);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const boundary = message.contentParts?.some(
      (part) => part.conversationHandoff || part.conversationContextBoundary,
    );
    if (boundary && !facts.get(index)?.hidden) return undefined;
    if (isSessionReroute(message)) return undefined;
    if (message.role === 'assistant' && message.turnId) {
      const turn = recordedTurn(message, rerouted);
      // The last turn is at or after any reroute of its session that the
      // rows hold, so a session-scope one covers it.
      return turn.sessionId && sessionScoped.has(turn.sessionId)
        ? { ...turn, rerouted: true }
        : turn;
    }
  }
  return undefined;
}

/** Facts by message index; see `TranscriptChangeFacts`. */
export function transcriptChangeFacts(
  messages: readonly ChatMessage[],
): ReadonlyMap<number, TranscriptChangeFacts> {
  const times = sessionTimes(messages);
  const rerouted = reroutedTurns(messages);
  // Sessions the walk has passed a session-scope reroute in.
  const reroutedSessions = new Set<string>();
  const resets = new Map<string, ResetStart>();
  for (const message of messages)
    for (const part of message.contentParts ?? []) {
      const boundary = part.conversationContextBoundary;
      if (boundary)
        resets.set(boundary.successorSessionId, {
          policy: boundary.policy,
          consumedAt: Date.parse(boundary.consumedAt),
        });
    }

  // A turn can span rows (a steer splits it); its record is the settled one.
  const byTurn = new Map<string, RecordedTurn>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.turnId) continue;
    const turn = recordedTurn(message, rerouted);
    if (turn.settled || !byTurn.has(message.turnId))
      byTurn.set(message.turnId, turn);
  }

  const facts = new Map<number, TranscriptChangeFacts>();
  const set = (index: number, fact: TranscriptChangeFacts) =>
    facts.set(index, { ...facts.get(index), ...fact });
  const seen = new Set<string>();
  let previous: RecordedTurn | undefined;
  let lastEngine: TurnProvenanceEngine | undefined;
  let markerDrawn = false;
  messages.forEach((message, index) => {
    const parts = message.contentParts ?? [];
    const handoff = parts.find(
      (part) => part.conversationHandoff,
    )?.conversationHandoff;
    const reset = parts.some((part) => part.conversationContextBoundary);
    if (handoff) {
      if (!switchRan(handoff, times, resets)) {
        set(index, { hidden: true });
        return;
      }
      const startedFrom = resets.get(handoff.sessionId)?.policy;
      set(index, {
        ...(lastEngine ? { previousEngine: lastEngine } : {}),
        ...(startedFrom ? { startedFrom } : {}),
      });
      // The engine before a switch is no longer the one running.
      lastEngine = undefined;
      markerDrawn = true;
      return;
    }
    if (reset) {
      if (lastEngine) set(index, { previousEngine: lastEngine });
      markerDrawn = true;
      return;
    }
    // A session-wide reroute changes the model without the person: the next
    // turn compares with nothing before it, and nor does any later one.
    if (isSessionReroute(message)) previous = undefined;
    for (const part of parts)
      if (part.modelReroute?.scope === 'session')
        reroutedSessions.add(part.modelReroute.sessionId);
    if (markerDrawn) set(index, { afterMarker: true });
    markerDrawn = false;
    if (message.role !== 'assistant' || !message.turnId) return;
    if (seen.has(message.turnId)) return;
    seen.add(message.turnId);
    const recorded =
      byTurn.get(message.turnId) ?? recordedTurn(message, rerouted);
    const sessionId = recorded.sessionId;
    // The turn a session-scope reroute names is marked by `reroutedTurns`;
    // its line comes after that turn's rows, so every later turn is covered.
    const current =
      sessionId && reroutedSessions.has(sessionId)
        ? { ...recorded, rerouted: true as const }
        : recorded;
    const change = modelChangeBetween(previous, current);
    if (change) set(index, { modelChange: change });
    if (current.engine) lastEngine = current.engine;
    previous = current;
  });
  return facts;
}
