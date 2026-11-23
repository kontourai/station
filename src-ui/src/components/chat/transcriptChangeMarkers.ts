import {
  isSupportedTurnProvenanceEnvelope,
  type TurnProvenanceEngine,
} from '@kontourai/station-contracts/turn-provenance';
import type { ChatMessage } from '../../types';

/** A model the person changed between two turns of one Session. */
export interface TranscriptModelChange {
  from: string;
  to: string;
}

/**
 * What a transcript row says about a change of model or engine, derived only
 * from what each turn recorded (its provenance envelope) and from the
 * handoff and context-boundary rows. Nothing here is written anywhere, so a
 * reload, another device and an old chat all derive the same rows.
 */
export interface TranscriptChangeFacts {
  /** On the first assistant row of a turn that ran a different model. */
  modelChange?: TranscriptModelChange;
  /** On an engine-switch or fresh-context row: the engine before it. */
  previousEngine?: TurnProvenanceEngine;
}

interface RecordedTurn {
  sessionId: string;
  engine: TurnProvenanceEngine;
  model?: string;
}

function recordedTurn(message: ChatMessage): RecordedTurn | undefined {
  const envelope = message.provenance;
  if (!isSupportedTurnProvenanceEnvelope(envelope)) return undefined;
  if (envelope.engine.state !== 'observed') return undefined;
  return {
    sessionId: envelope.sessionId,
    engine: envelope.engine.value,
    ...(envelope.requestedModel.state === 'observed'
      ? { model: envelope.requestedModel.value }
      : {}),
  };
}

function isBoundaryRow(message: ChatMessage): boolean {
  return (
    message.contentParts?.some(
      (part) =>
        part.type === 'conversation-handoff' ||
        part.type === 'conversation-context-boundary',
    ) ?? false
  );
}

/**
 * Facts by message index. A model change is marked only between two turns
 * that both recorded the model Station asked for, ran on the same engine and
 * in the same Session, with nothing unrecorded between them: that is the
 * only case where "same engine, same memory" is true. A turn with no record
 * (an old chat, or one still running) resets the comparison rather than
 * letting a later turn claim a change that may have happened earlier.
 *
 * An engine switch or a fresh context already has its own row, and the turn
 * after it runs in a new Session, so a model change at that point never adds
 * a second row.
 */
export function transcriptChangeFacts(
  messages: readonly ChatMessage[],
): ReadonlyMap<number, TranscriptChangeFacts> {
  const byTurn = new Map<string, RecordedTurn>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.turnId) continue;
    const turn = recordedTurn(message);
    if (turn) byTurn.set(message.turnId, turn);
  }

  const facts = new Map<number, TranscriptChangeFacts>();
  const seen = new Set<string>();
  let previous: RecordedTurn | undefined;
  messages.forEach((message, index) => {
    if (isBoundaryRow(message)) {
      if (previous) facts.set(index, { previousEngine: previous.engine });
      previous = undefined;
      return;
    }
    if (message.role !== 'assistant' || !message.turnId) return;
    if (seen.has(message.turnId)) return;
    seen.add(message.turnId);
    const current = byTurn.get(message.turnId);
    if (
      current?.model &&
      previous?.model &&
      previous.model !== current.model &&
      previous.sessionId === current.sessionId &&
      previous.engine.provider === current.engine.provider
    ) {
      facts.set(index, {
        modelChange: { from: previous.model, to: current.model },
      });
    }
    previous = current;
  });
  return facts;
}
