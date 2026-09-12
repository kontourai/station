import { useState, useSyncExternalStore } from 'react';
import { getActiveReplay } from '../../hooks/orchestration/replay/controller';
import { downloadSessionTape } from '../../hooks/orchestration/replay/tape-file';
import './ReplayTransport.css';

function transcriptElement(): HTMLElement | null {
  return (
    [
      ...document.querySelectorAll<HTMLElement>(
        '[role="log"][aria-label="Conversation transcript"]',
      ),
    ].find(
      (element) =>
        element.dataset.chatSessionId === getActiveReplay()?.replayId,
    ) ?? null
  );
}

export function ReplayTransport({ sessionId }: { sessionId: string }) {
  const observation = useSyncExternalStore(
    (listener) => {
      const active = getActiveReplay();
      return active?.replayId === sessionId
        ? active.player.subscribe(listener)
        : () => {};
    },
    () =>
      getActiveReplay()?.replayId === sessionId
        ? getActiveReplay()!.player.lastObservation
        : null,
    () => null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [speed, setSpeed] = useState(1);
  const [position, setPosition] = useState('0');
  const [includeContent, setIncludeContent] = useState(false);
  const replay = getActiveReplay();
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  if (!replay || replay.replayId !== sessionId || !observation)
    return (
      <div className="replay-transport" role="status">
        Event replay is not attached to this chat.
      </div>
    );
  const { player } = replay;
  const running = observation.playback?.playing ?? false;
  const frame = player.frames[observation.cursor.index];
  return (
    <div className="replay-transport" data-testid="replay-transport">
      <details className="replay-transport__controls">
        <summary>
          Replay controls · {observation.cursor.index + 1} /{' '}
          {observation.cursor.eventCount}
        </summary>
        <div className="replay-transport__bar">
          <button
            type="button"
            className="button button--secondary"
            disabled={busy || running || observation.cursor.index < 0}
            onClick={() =>
              void run(async () => {
                player.back();
                await player.observeRendered(transcriptElement);
              })
            }
          >
            Back
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={busy || running || observation.atEnd}
            onClick={() =>
              void run(() => player.stepRendered(transcriptElement))
            }
          >
            Step
          </button>
          {running ? (
            <button
              type="button"
              className="button button--secondary"
              onClick={() => player.pause()}
            >
              Pause
            </button>
          ) : (
            <>
              <button
                type="button"
                className="button button--secondary"
                disabled={busy || observation.atEnd}
                onClick={() =>
                  void run(() => player.play(transcriptElement, { speed }))
                }
              >
                Play
              </button>
              <button
                type="button"
                className="button button--secondary"
                disabled={busy || observation.atEnd}
                onClick={() =>
                  void run(() =>
                    player.play(transcriptElement, { untilIssue: true }),
                  )
                }
              >
                Run until issue
              </button>
            </>
          )}
          <label>
            Speed{' '}
            <select
              value={speed}
              disabled={running}
              onChange={(event) => setSpeed(Number(event.target.value))}
            >
              {[0.5, 1, 2, 4, 8, 16, 32].map((value) => (
                <option key={value} value={value}>
                  {value}×
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="replay-transport__status" aria-live="polite">
          {observation.cursor.index + 1} / {observation.cursor.eventCount} ·{' '}
          {observation.cursor.method ?? frame?.kind ?? 'start'}
          {` · ${observation.execution.orchestrationStatus ?? observation.execution.status ?? 'idle'}`}
          {observation.streaming.present ? ' · streaming' : ''}
          {observation.issues.length
            ? ` · ${observation.issues.length} issue(s)`
            : ' · No issues detected in observed state.'}
        </p>
        <p className="replay-transport__status">
          {observation.frame?.coverage === 'client-capture'
            ? 'Client capture: runtime, committed history-reader state, and connection activity.'
            : 'Server event archive: historical client history responses and connection timing were not recorded.'}
          {player.tape.redacted
            ? ' Content is redacted; text layout differs.'
            : ''}
          {player.tape.stoppedReason ? ` ${player.tape.stoppedReason}` : ''}
          {` Render: ${observation.performance?.render?.phase ?? 'not observed for this frame'}.`}
        </p>
        <form
          className="replay-transport__bar"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              player.pause();
              player.seek(Number(position) - 1);
              await player.observeRendered(transcriptElement);
            });
          }}
        >
          <label>
            Frame{' '}
            <input
              type="number"
              min={0}
              max={player.eventCount}
              value={position}
              onChange={(event) => setPosition(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="button button--secondary"
            disabled={busy || running}
          >
            Go
          </button>
          <button
            type="button"
            className="button button--secondary"
            disabled={busy || running}
            onClick={() =>
              void run(() => player.observeRendered(transcriptElement))
            }
          >
            Observe UI
          </button>
        </form>
        {error && <p role="alert">{error}</p>}
        {observation.issues.length > 0 && (
          <ul className="replay-transport__issues" aria-label="Replay issues">
            {observation.issues.map((issue) => (
              <li key={issue.code}>{issue.detail}</li>
            ))}
          </ul>
        )}
        <details>
          <summary>Event and state change</summary>
          <pre className="replay-transport__observation">
            {JSON.stringify(
              { frame, stateChanges: observation.delta?.stateChanges },
              null,
              2,
            )}
          </pre>
        </details>
        <details>
          <summary>Rendered UI and performance</summary>
          <pre
            className="replay-transport__observation"
            data-testid="replay-observation"
          >
            {JSON.stringify(observation, null, 2)}
          </pre>
        </details>
        <details>
          <summary>Export tape</summary>
          <label>
            <input
              type="checkbox"
              checked={includeContent}
              onChange={(event) => setIncludeContent(event.target.checked)}
            />{' '}
            Include conversation content
          </label>
          <p>
            {includeContent
              ? 'Includes prompts and tool output, which can contain private data.'
              : 'Text is redacted by default; original text layout is not preserved.'}
          </p>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => downloadSessionTape(player.tape, includeContent)}
          >
            Download tape
          </button>
        </details>
      </details>
    </div>
  );
}
