import { useCallback, useSyncExternalStore } from 'react';
import { getActiveReplay } from '../../hooks/orchestration/replay/controller';
import type { ReplayObservation } from '../../hooks/orchestration/replay/observe';
import './ReplayTransport.css';

function transcriptElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[role="log"][aria-label="Conversation transcript"]',
  );
}

export function ReplayTransport({ sessionId }: { sessionId: string }) {
  const replay = useSyncExternalStore(
    (onStoreChange) => {
      const active = getActiveReplay();
      if (!active || active.replayId !== sessionId) return () => {};
      return active.player.subscribe(onStoreChange);
    },
    () => getActiveReplay(),
    () => getActiveReplay(),
  );
  const observation: ReplayObservation | null =
    replay?.replayId === sessionId
      ? (replay.player.lastObservation ??
        replay.player.observe(transcriptElement()))
      : null;

  const step = useCallback(() => {
    getActiveReplay()?.player.step(transcriptElement());
  }, []);
  const back = useCallback(() => {
    getActiveReplay()?.player.back(transcriptElement());
  }, []);

  if (!replay || replay.replayId !== sessionId || !observation) {
    return (
      <div className="replay-transport" role="status">
        Event replay is not attached to this chat.
      </div>
    );
  }

  const cursorLabel =
    observation.cursor.index < 0
      ? `0 / ${observation.cursor.eventCount}`
      : `${observation.cursor.index + 1} / ${observation.cursor.eventCount}`;
  const method = observation.cursor.method ?? 'start';
  const issueSummary =
    observation.issues.length === 0
      ? 'No issues detected.'
      : observation.issues.map((issue) => issue.code).join(', ');

  return (
    <div className="replay-transport" data-testid="replay-transport">
      <div className="replay-transport__bar">
        <button
          type="button"
          className="button button--secondary"
          onClick={back}
          disabled={observation.cursor.index < 0}
        >
          Back
        </button>
        <button
          type="button"
          className="button button--primary"
          onClick={step}
          disabled={observation.atEnd && observation.cursor.index >= 0}
        >
          Step
        </button>
        <p className="replay-transport__status" aria-live="polite">
          {cursorLabel}
          {' · '}
          {method}
          {observation.streaming.present ? ' · streaming' : ''}
          {' · '}
          {issueSummary}
        </p>
      </div>
      {observation.issues.length > 0 ? (
        <ul className="replay-transport__issues" aria-label="Replay issues">
          {observation.issues.map((issue) => (
            <li key={issue.code}>{issue.detail}</li>
          ))}
        </ul>
      ) : null}
      <section aria-label="Replay observation">
        <pre
          className="replay-transport__observation"
          data-testid="replay-observation"
        >
          {JSON.stringify(observation, null, 2)}
        </pre>
      </section>
    </div>
  );
}
