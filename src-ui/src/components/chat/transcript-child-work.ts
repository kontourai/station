import {
  applyChildWorkDelta,
  type ChildWorkDelta,
  type ChildWorkItem,
  childWorkDeltaFromLegacyClaudeTaskNotification,
  createEmptyChildWorkRegistry,
} from '@kontourai/station-contracts/child-work';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { createContext, useContext } from 'react';

/**
 * The transcript's own read of the children its tool calls spawned.
 *
 * Folded from the SAME runtime events the transcript window renders (the
 * bounded event window plus the live events stitched onto it), through the
 * contract's one reducer, so a card says what the durable record says: on a
 * cold reload a finished subagent still reads Completed with its result,
 * where the chat registry (`childWorkHandlers.ts`) keeps only what is
 * running now.
 *
 * Only a child whose engine named the tool call that spawned it
 * (`parent.toolCallId`) is indexed: that is the one fact that places it in
 * the transcript. A child without one has no spawn point to render at, and
 * stays in the Agents pane only.
 */
export interface TranscriptChild {
  item: ChildWorkItem;
  /** The engine of the session that reported the child (its event envelope). */
  provider?: string;
}

export type TranscriptChildren = ReadonlyMap<string, TranscriptChild>;

const EMPTY: TranscriptChildren = new Map();

function deltaFor(event: CanonicalRuntimeEvent): ChildWorkDelta | undefined {
  if (event.method === 'child-work.updated') return event.delta;
  // Pre-#2457 Claude history: the same translation the server projection and
  // the live client registry apply.
  if (event.method === 'extension.notification')
    return childWorkDeltaFromLegacyClaudeTaskNotification(
      event,
      event.threadId,
    );
  return undefined;
}

function reporterOf(delta: ChildWorkDelta): string {
  return delta.kind === 'upsert'
    ? delta.item.reporterThreadId
    : delta.reporterThreadId;
}

export function foldTranscriptChildren(
  events: readonly { event: CanonicalRuntimeEvent }[] | undefined,
): TranscriptChildren {
  if (!events?.length) return EMPTY;
  let registry = createEmptyChildWorkRegistry();
  const providers = new Map<string, string>();
  for (const { event } of events) {
    if (event.method === 'session.exited') {
      // The session ended: nothing it listed can still be running. An empty
      // authoritative listing turns each still-running child into
      // `unresolved` (the contract's "no outcome observed"), never into an
      // outcome, and a real settle drained after the exit still replaces it.
      registry = applyChildWorkDelta(registry, {
        kind: 'snapshot',
        producer: 'engine-subagent',
        reporterThreadId: event.threadId,
        running: [],
      });
      continue;
    }
    const delta = deltaFor(event);
    if (!delta || delta.kind === 'not-reported') continue;
    // A delta names its own reporter; one arriving on another session's
    // thread is not that session's to record (the server's rule too).
    if (reporterOf(delta) !== event.threadId) continue;
    registry = applyChildWorkDelta(registry, delta);
    providers.set(event.threadId, event.provider);
  }
  const byToolCall = new Map<string, TranscriptChild>();
  for (const item of Object.values(registry.items)) {
    const toolCallId = item.parent?.toolCallId;
    if (!toolCallId) continue;
    const provider = providers.get(item.reporterThreadId);
    // A resumed Claude agent is a second child under a new tool call, so a
    // tool call names at most one child; the latest one wins if not.
    byToolCall.set(toolCallId, { item, ...(provider ? { provider } : {}) });
  }
  return byToolCall.size > 0 ? byToolCall : EMPTY;
}

export const TranscriptChildrenContext =
  createContext<TranscriptChildren>(EMPTY);

export function useTranscriptChild(
  toolCallId: string | undefined,
): TranscriptChild | undefined {
  const children = useContext(TranscriptChildrenContext);
  return toolCallId ? children.get(toolCallId) : undefined;
}
