import {
  applyChildWorkDelta,
  type ChildWorkDelta,
  type ChildWorkItem,
  childWorkDeltaFromLegacyClaudeTaskNotification,
  childWorkKey,
  createEmptyChildWorkRegistry,
} from '@kontourai/station-contracts/child-work';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  observedAssistantMessageId,
  projectRuntimeEventsToMessages,
} from '@kontourai/station-shared/runtime-event-projection';
import { createContext, useContext } from 'react';
import type { RunBlock, ToolCallLike } from './tool-call-runs';
import type { TranscriptRow } from './transcriptProjection';

/** Loaded transcript children retain their spawn anchors and all settled results.
 * Each child uses the contract fold independently: live-registry retention must
 * not evict a historical card whose spawn is still in the loaded window.
 */
export interface TranscriptChild {
  item: ChildWorkItem;
  spawn?: {
    turnId: string;
    eventIndex: number;
    standalone: boolean;
    toolAnchor: boolean;
    messageId?: string;
    textOffset: number;
    turnTextOffset: number;
    afterToolCallId?: string;
  };
  toolAnchor: boolean;
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
  const registries = new Map<
    string,
    ReturnType<typeof createEmptyChildWorkRegistry>
  >();
  const spawns = new Map<string, TranscriptChild['spawn']>();
  const providers = new Map<string, string>();
  const textOffsets = new Map<string, number>();
  const anchors = new Map<string, string>();
  const turnTextOffsets = new Map<string, number>();
  const tools = new Set<string>();
  const lastToolByTurn = new Map<string, string>();
  for (const [eventIndex, { event }] of events.entries()) {
    if (event.method === 'turn.started') {
      const turn = JSON.stringify([event.threadId, event.turnId]);
      const messageId = observedAssistantMessageId(event.eventId);
      if (messageId) {
        anchors.set(turn, messageId);
      }
      // A steer flushes the preceding assistant row in the shared projection.
      textOffsets.set(turn, 0);
      lastToolByTurn.delete(turn);
    }
    if (event.method === 'tool.started' || event.method === 'tool.completed') {
      const call = JSON.stringify([event.threadId, event.toolCallId]);
      if (event.turnId && !tools.has(call))
        lastToolByTurn.set(
          JSON.stringify([event.threadId, event.turnId]),
          event.toolCallId,
        );
      tools.add(call);
    }
    if (event.method === 'content.text-delta') {
      const turn = JSON.stringify([event.threadId, event.turnId]);
      textOffsets.set(turn, (textOffsets.get(turn) ?? 0) + event.delta.length);
      turnTextOffsets.set(
        turn,
        (turnTextOffsets.get(turn) ?? 0) + event.delta.length,
      );
    }
    if (event.method === 'session.exited') {
      for (const [key, registry] of registries) {
        registries.set(
          key,
          applyChildWorkDelta(registry, {
            kind: 'snapshot',
            producer: 'engine-subagent',
            reporterThreadId: event.threadId,
            running: [],
          }),
        );
      }
      continue;
    }
    const delta = deltaFor(event);
    if (
      !delta ||
      delta.kind === 'not-reported' ||
      reporterOf(delta) !== event.threadId
    )
      continue;
    providers.set(event.threadId, event.provider);
    const running =
      delta.kind === 'snapshot'
        ? delta.running
        : delta.kind === 'upsert'
          ? [delta.item]
          : [];
    // Ask the canonical row projector about the spawn prefix rather than
    // maintaining a second list of event shapes that happen to create rows.
    const spawnRows = running.some(
      (item) => !spawns.has(childWorkKey(item)) && item.parent?.turnId,
    )
      ? projectRuntimeEventsToMessages(
          events.slice(0, eventIndex + 1).map((entry) => entry.event),
          { stableIds: true },
        )
      : [];
    for (const item of running) {
      const key = childWorkKey(item);
      if (!registries.has(key))
        registries.set(key, createEmptyChildWorkRegistry());
      if (!spawns.has(key) && item.parent?.turnId)
        spawns.set(key, {
          turnId: item.parent.turnId,
          eventIndex,
          // A segment empty at spawn stays standalone even if prose arrives.
          // This decision is replayable and never reparents an existing card.
          standalone: !spawnRows.some(
            (row) =>
              row.role === 'assistant' &&
              row.metadata?.sessionId === event.threadId &&
              (anchors.has(
                JSON.stringify([event.threadId, item.parent!.turnId]),
              )
                ? row.id ===
                  anchors.get(
                    JSON.stringify([event.threadId, item.parent!.turnId]),
                  )
                : !row.metadata?.turnId ||
                  row.metadata.turnId === item.parent!.turnId),
          ),
          toolAnchor: spawnRows.some(
            (row) =>
              row.role === 'assistant' &&
              row.metadata?.sessionId === event.threadId &&
              row.parts.some(
                (part) =>
                  part.type === 'tool-invocation' &&
                  part.toolCallId === item.parent?.toolCallId,
              ),
          ),
          messageId: anchors.get(
            JSON.stringify([event.threadId, item.parent.turnId]),
          ),
          afterToolCallId: lastToolByTurn.get(
            JSON.stringify([event.threadId, item.parent.turnId]),
          ),
          turnTextOffset:
            turnTextOffsets.get(
              JSON.stringify([event.threadId, item.parent.turnId]),
            ) ?? 0,
          textOffset:
            textOffsets.get(
              JSON.stringify([event.threadId, item.parent.turnId]),
            ) ?? 0,
        });
    }
    // Terminal identity can recover a loaded call's child when its running
    // listing is outside the window. It supplies no fallback spawn position.
    if (delta.kind === 'settle' && !registries.has(childWorkKey(delta)))
      registries.set(childWorkKey(delta), createEmptyChildWorkRegistry());
    for (const [key, registry] of registries) {
      if (
        delta.kind !== 'snapshot' &&
        key !== childWorkKey(delta.kind === 'upsert' ? delta.item : delta)
      )
        continue;
      const scoped =
        delta.kind === 'snapshot'
          ? {
              ...delta,
              running: delta.running.filter(
                (item) => childWorkKey(item) === key,
              ),
            }
          : delta;
      registries.set(key, applyChildWorkDelta(registry, scoped));
    }
  }
  const children = new Map<string, TranscriptChild>();
  for (const [key, registry] of registries) {
    const item = registry.items[key];
    if (!item) continue;
    const spawn = spawns.get(key);
    const toolAnchor =
      spawn?.toolAnchor ??
      Boolean(
        item.parent?.toolCallId &&
          tools.has(
            JSON.stringify([item.reporterThreadId, item.parent.toolCallId]),
          ),
      );
    if (!spawn && !toolAnchor) continue;
    children.set(key, {
      item,
      provider: providers.get(item.reporterThreadId),
      spawn,
      toolAnchor,
    });
  }
  return children.size > 0 ? children : EMPTY;
}

export const TranscriptChildrenContext =
  createContext<TranscriptChildren>(EMPTY);

export const TranscriptTurnContext = createContext<
  | {
      threadId?: string;
      turnId?: string;
      messageId?: string;
      firstRow?: boolean;
      wholeTurn?: boolean;
    }
  | undefined
>(undefined);

export function useTranscriptChildrenForCalls(
  toolCallIds: readonly string[],
): TranscriptChild[] {
  const children = useContext(TranscriptChildrenContext);
  const turn = useContext(TranscriptTurnContext);
  return [...new Set(toolCallIds)].flatMap((toolCallId) =>
    [...children.values()].filter(
      (child) =>
        (child.toolAnchor || !child.spawn?.standalone) &&
        child.item.parent?.toolCallId === toolCallId &&
        (!turn?.threadId || child.item.reporterThreadId === turn.threadId),
    ),
  );
}

type ChildBlock = { type: 'subagent'; key: string; child: TranscriptChild };

/** UI-only blocks; never add display markers to canonical events or messages. */
export function useTranscriptChildBlocks<P extends ToolCallLike>(
  blocks: RunBlock<P>[],
): (RunBlock<P> | ChildBlock)[] {
  const children = useContext(TranscriptChildrenContext);
  const turn = useContext(TranscriptTurnContext);
  const renderedCalls = new Set(
    blocks.flatMap((block) =>
      block.type === 'tool-call-run'
        ? block.calls
            .map((call) => call.part.toolCallId)
            .filter((id) => id !== undefined)
        : [],
    ),
  );
  const pending = [...children.entries()].filter(
    ([, child]) =>
      !child.toolAnchor &&
      !child.spawn?.standalone &&
      (!child.item.parent?.toolCallId ||
        !renderedCalls.has(child.item.parent.toolCallId)) &&
      child.spawn &&
      child.spawn.turnId === turn?.turnId &&
      (turn?.wholeTurn ||
        (child.spawn.messageId
          ? child.spawn.messageId === turn?.messageId
          : turn?.firstRow !== false)) &&
      child.item.reporterThreadId === turn?.threadId,
  );
  if (!pending.length) return blocks;
  const spawnOffset = (child: TranscriptChild) =>
    turn?.wholeTurn ? child.spawn!.turnTextOffset : child.spawn!.textOffset;
  const result: (RunBlock<P> | ChildBlock)[] = [];
  let offset = 0;
  const seenCalls = new Set<string | undefined>();
  for (const block of blocks) {
    if (block.type === 'tool-call-run')
      for (const call of block.calls) seenCalls.add(call.part.toolCallId);
    if (
      block.type !== 'content-part' ||
      block.part.type !== 'text' ||
      typeof block.part.content !== 'string'
    ) {
      result.push(block);
      continue;
    }
    const text = block.part.content;
    let start = 0;
    while (
      pending.length &&
      spawnOffset(pending[0][1]) <= offset + text.length &&
      (!pending[0][1].spawn!.afterToolCallId ||
        seenCalls.has(pending[0][1].spawn!.afterToolCallId))
    ) {
      const [key, child] = pending.shift()!;
      const end = Math.max(start, spawnOffset(child) - offset);
      if (end > start)
        result.push({
          ...block,
          key: `subagent-text:${block.index}:${start}`,
          part: { ...block.part, content: text.slice(start, end) },
        });
      result.push({ type: 'subagent', key, child });
      start = end;
    }
    if (start < text.length)
      result.push({
        ...block,
        key: `subagent-text:${block.index}:${start}`,
        part: { ...block.part, content: text.slice(start) },
      });
    offset += text.length;
  }
  for (const [key, child] of pending)
    result.push({ type: 'subagent', key, child });
  return result;
}

export type ChildTranscriptRow =
  | TranscriptRow
  | {
      readonly id: string;
      readonly kind: 'subagent';
      readonly child: TranscriptChild;
    };

/** Insert orphaned spawn blocks before the next event-backed row, never in
 * a later turn. Stable child keys survive live completion and cold replay.
 */
export function projectTranscriptChildRows(
  rows: readonly TranscriptRow[],
  children: TranscriptChildren,
  events: readonly { event: CanonicalRuntimeEvent }[] | undefined,
): readonly ChildTranscriptRow[] {
  const positions = new Map<string, number>();
  events?.forEach(({ event }, index) => {
    if (event.method === 'turn.started') {
      positions.set(`${event.eventId}:user`, index);
      positions.set(`${event.eventId}:assistant`, index + 0.5);
    }
  });
  const pending = [...children.entries()].filter(
    ([, child]) => !child.toolAnchor && child.spawn?.standalone,
  );
  if (!pending.length) return rows;
  const result: ChildTranscriptRow[] = [];
  const append = (key: string, child: TranscriptChild) => {
    result.push({ id: `subagent:${key}`, kind: 'subagent', child });
  };
  for (const row of rows) {
    const position =
      positions.get(row.message.id ?? '') ??
      positions.get(`${row.message.sourceEventId}:user`);
    // The segment's assistant row starts before its contents, but an empty
    // segment's card must precede any prose that arrives after its spawn.
    for (let i = 0; i < pending.length; ) {
      const [key, child] = pending[i];
      if (
        (position !== undefined && position > child.spawn!.eventIndex) ||
        (row.message.role === 'assistant' &&
          row.message.sessionId === child.item.reporterThreadId &&
          (!row.message.turnId || row.message.turnId === child.spawn!.turnId) &&
          (!child.spawn!.messageId ||
            row.message.id === child.spawn!.messageId))
      ) {
        append(key, child);
        pending.splice(i, 1);
      } else i += 1;
    }
    result.push(row);
  }
  for (const [key, child] of pending) append(key, child);
  return result;
}
