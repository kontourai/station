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
}

function recordedTurn(message: ChatMessage): RecordedTurn {
  const envelope = isSupportedTurnProvenanceEnvelope(message.provenance)
    ? message.provenance
    : undefined;
  const requested =
    envelope?.requestedModel.state === 'observed'
      ? envelope.requestedModel.value
      : message.model;
  return {
    sessionId: envelope?.sessionId ?? message.sessionId,
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
 * no model at all breaks the comparison. A turn still running has only what
 * was asked for, compared with what the previous turn asked for; once it
 * ends, the rule above applies, so the pill names what ran, or goes away
 * when the same model ran.
 */
export function modelChangeBetween(
  previous: RecordedTurn | undefined,
  current: RecordedTurn,
): TranscriptModelChange | undefined {
  if (!previous?.sessionId || previous.sessionId !== current.sessionId)
    return undefined;
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

/**
 * A switch row is drawn only for a switch that ran: a turn of the target
 * Session started after the switch was recorded. A record whose target is a
 * fresh-context Session that had already run turns before it is a refused
 * switch (the server reuses that Session), never a switch.
 */
function switchRan(
  handoff: ConversationHandoffProjection,
  times: ReadonlyMap<string, number[]>,
  resetSessions: ReadonlySet<string>,
): boolean {
  const at = Date.parse(handoff.createdAt);
  const turns = times.get(handoff.sessionId) ?? [];
  if (Number.isNaN(at)) return false;
  if (resetSessions.has(handoff.sessionId) && turns.some((t) => t < at))
    return false;
  return turns.some((t) => t >= at);
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
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const boundary = message.contentParts?.some(
      (part) => part.conversationHandoff || part.conversationContextBoundary,
    );
    if (boundary && !facts.get(index)?.hidden) return undefined;
    if (message.role === 'assistant' && message.turnId)
      return recordedTurn(message);
  }
  return undefined;
}

/** Facts by message index; see `TranscriptChangeFacts`. */
export function transcriptChangeFacts(
  messages: readonly ChatMessage[],
): ReadonlyMap<number, TranscriptChangeFacts> {
  const times = sessionTimes(messages);
  const resets = new Map<string, ConversationContextBoundaryPolicy>();
  for (const message of messages)
    for (const part of message.contentParts ?? [])
      if (part.conversationContextBoundary)
        resets.set(
          part.conversationContextBoundary.successorSessionId,
          part.conversationContextBoundary.policy,
        );

  // A turn can span rows (a steer splits it); its record is the settled one.
  const byTurn = new Map<string, RecordedTurn>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.turnId) continue;
    const turn = recordedTurn(message);
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
      if (!switchRan(handoff, times, new Set(resets.keys()))) {
        set(index, { hidden: true });
        return;
      }
      const startedFrom = resets.get(handoff.sessionId);
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
    if (markerDrawn) set(index, { afterMarker: true });
    markerDrawn = false;
    if (message.role !== 'assistant' || !message.turnId) return;
    if (seen.has(message.turnId)) return;
    seen.add(message.turnId);
    const current = byTurn.get(message.turnId) ?? recordedTurn(message);
    const change = modelChangeBetween(previous, current);
    if (change) set(index, { modelChange: change });
    if (current.engine) lastEngine = current.engine;
    previous = current;
  });
  return facts;
}
