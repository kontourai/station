import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { activeChatsStore } from '../../contexts/active-chats-store';
import {
  getActiveReplay,
  getConversationTimelineContext,
  returnToLatestConversation,
  selectConversationTimelineExecution,
} from '../../hooks/orchestration/replay/controller';
import {
  activeTimelineLandmarkIndex,
  conversationTimelineLandmarks,
} from '../../hooks/orchestration/replay/timeline';
import { type ForkTurnSource, forkTurnSource } from './fork-turn-source';
import './ConversationTimeline.css';

function tapeDateRange(
  events: readonly { createdAt: string }[],
): string | undefined {
  const first = events[0]?.createdAt;
  const last = events.at(-1)?.createdAt;
  if (!first || !last) return undefined;
  const formatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const format = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : formatter.format(date);
  };
  const firstLabel = format(first);
  const lastLabel = format(last);
  if (!firstLabel || !lastLabel) return undefined;
  return first === last ? firstLabel : `${firstLabel} – ${lastLabel}`;
}

export function ConversationTimeline({
  sessionId,
  onForkFromTurn,
}: {
  sessionId: string;
  onForkFromTurn?: (source: ForkTurnSource) => void;
}) {
  const pendingScrubIndex = useRef<number | undefined>(undefined);
  const scrubFrame = useRef<number | undefined>(undefined);
  const [switchingExecution, setSwitchingExecution] = useState(false);
  const [switchError, setSwitchError] = useState<string>();
  const observation = useSyncExternalStore(
    (listener) => {
      const replay = getActiveReplay();
      return replay?.replayId === sessionId
        ? replay.player.subscribe(listener)
        : () => {};
    },
    () => getActiveReplay()?.player.lastObservation,
    () => null,
  );
  useEffect(
    () => () => {
      if (scrubFrame.current !== undefined)
        cancelAnimationFrame(scrubFrame.current);
    },
    [],
  );
  const replay = getActiveReplay();
  const context = getConversationTimelineContext();
  if (!replay || replay.replayId !== sessionId || !context || !observation)
    return null;
  const landmarks = conversationTimelineLandmarks(replay.player);
  const activeIndex = activeTimelineLandmarkIndex(
    landmarks,
    observation.cursor.index,
  );
  const active = landmarks[activeIndex];
  const dateRange = tapeDateRange(replay.player.tape.events);
  const seek = (index: number) => {
    const landmark = landmarks[index];
    if (landmark) replay.player.seek(landmark.endFrame);
  };
  const seekFromControl = (index: number) => {
    if (scrubFrame.current !== undefined) {
      cancelAnimationFrame(scrubFrame.current);
      scrubFrame.current = undefined;
      pendingScrubIndex.current = undefined;
    }
    seek(index);
  };
  const scheduleSeek = (index: number) => {
    if (index === activeIndex || index === pendingScrubIndex.current) return;
    pendingScrubIndex.current = index;
    if (scrubFrame.current !== undefined) return;
    scrubFrame.current = requestAnimationFrame(() => {
      scrubFrame.current = undefined;
      const target = pendingScrubIndex.current;
      pendingScrubIndex.current = undefined;
      if (target !== undefined) seek(target);
    });
  };
  const replayMessages = activeChatsStore.getSnapshot()[sessionId]?.messages;
  const forkCandidate = active?.forkable
    ? [...(replayMessages ?? [])]
        .reverse()
        .find(
          (message) =>
            message.role === 'assistant' && message.turnId === active.turnId,
        )
    : undefined;
  const validatedForkSource = forkCandidate
    ? forkTurnSource(forkCandidate, {
        agentSlug: replay.player.tape.source.agentSlug,
      })
    : null;
  const forkSource: ForkTurnSource | undefined = validatedForkSource
    ? {
        ...validatedForkSource,
        sessionId: context.selectedExecutionId,
      }
    : undefined;
  return (
    <section
      className="conversation-timeline"
      aria-label="Historical conversation view"
    >
      <div className="conversation-timeline__status" role="status">
        <strong>Earlier in this conversation</strong>
        <span>
          {activeIndex + 1} of {landmarks.length} user turns
        </span>
        {dateRange && <span>{dateRange}</span>}
        {replay.player.tape.stoppedReason && (
          <span>Archive incomplete: {replay.player.tape.stoppedReason}</span>
        )}
        {context.executions.length > 1 && (
          <label>
            Conversation section{' '}
            <select
              value={context.selectedExecutionId}
              disabled={switchingExecution}
              onChange={(event) => {
                setSwitchingExecution(true);
                setSwitchError(undefined);
                void selectConversationTimelineExecution(
                  event.currentTarget.value,
                )
                  .catch((error: unknown) =>
                    setSwitchError(
                      error instanceof Error
                        ? error.message
                        : 'That part of the conversation could not be loaded.',
                    ),
                  )
                  .finally(() => setSwitchingExecution(false));
              }}
            >
              {context.executions.map((execution, index) => (
                <option key={execution.sessionId} value={execution.sessionId}>
                  {index + 1}. {execution.agentName ?? 'Conversation'}
                </option>
              ))}
            </select>
          </label>
        )}
        {switchError && <span role="alert">{switchError}</span>}
      </div>
      <label className="conversation-timeline__map">
        <span className="conversation-timeline__map-label">
          Turn {activeIndex + 1}: {active?.label ?? 'No turns recorded'}
        </span>
        <input
          type="range"
          min={0}
          max={Math.max(0, landmarks.length - 1)}
          value={Math.max(0, activeIndex)}
          disabled={landmarks.length === 0}
          aria-label="Conversation position"
          onChange={(event) => scheduleSeek(Number(event.currentTarget.value))}
        />
      </label>
      <div className="conversation-timeline__actions">
        <button
          type="button"
          className="button button--secondary"
          disabled={activeIndex <= 0}
          onClick={() => seekFromControl(activeIndex - 1)}
        >
          Previous turn
        </button>
        <button
          type="button"
          className="button button--secondary"
          disabled={activeIndex < 0 || activeIndex >= landmarks.length - 1}
          onClick={() => seekFromControl(activeIndex + 1)}
        >
          Next turn
        </button>
        <button
          type="button"
          className="button button--secondary"
          onClick={returnToLatestConversation}
        >
          Return to latest
        </button>
        <button
          type="button"
          className="button button--primary"
          disabled={!forkSource || !onForkFromTurn}
          title={
            forkSource && onForkFromTurn
              ? 'Create a new conversation from this completed turn'
              : 'This point has no supported fork source'
          }
          onClick={() => forkSource && onForkFromTurn?.(forkSource)}
        >
          Fork from here…
        </button>
      </div>
    </section>
  );
}
