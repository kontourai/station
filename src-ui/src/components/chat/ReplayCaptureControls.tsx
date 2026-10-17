import { useId, useRef, useState, useSyncExternalStore } from 'react';
import { openReplayFromTape } from '../../hooks/orchestration/replay/controller';
import {
  getCapturedTape,
  getReplayCaptureStatus,
  startReplayCapture,
  stopReplayCapture,
  subscribeReplayCapture,
} from '../../hooks/orchestration/replay/recorder';
import type { SessionTapeSource } from '../../hooks/orchestration/replay/tape';
import {
  downloadSessionTape,
  readSessionTapeFile,
} from '../../hooks/orchestration/replay/tape-file';

export interface ReplayCaptureSource {
  apiBase: string;
  source: SessionTapeSource;
  agentName: string;
}

export function ReplayCaptureControls({
  source,
  onOpen,
}: {
  source?: ReplayCaptureSource;
  onOpen: () => void;
}) {
  const status = useSyncExternalStore(
    subscribeReplayCapture,
    getReplayCaptureStatus,
    getReplayCaptureStatus,
  );
  const [error, setError] = useState<string>();
  const [includeContent, setIncludeContent] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const importInputId = useId();
  const tape = getCapturedTape();
  const guard = (action: () => void) => {
    try {
      setError(undefined);
      action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <div className="replay-capture">
      {source && (
        <button
          type="button"
          className="button button--secondary"
          onClick={() =>
            guard(() => {
              if (status.recording) stopReplayCapture();
              else startReplayCapture(source.apiBase, source.source);
            })
          }
        >
          {status.recording
            ? 'Stop debugging capture'
            : 'Record UI and transport activity'}
        </button>
      )}
      <p role="status">
        {status.recording
          ? 'Recording runtime events, history reads, and reconnects on this client.'
          : (status.stoppedReason ??
            'Capture is off. Start before reproducing the problem.')}
      </p>
      {tape && !status.recording && (
        <>
          <button
            type="button"
            className="button button--secondary"
            onClick={() =>
              guard(() => {
                openReplayFromTape(tape, {
                  agentSlug: tape.source.agentSlug,
                  agentName: source?.agentName ?? 'Replay',
                });
                onOpen();
              })
            }
          >
            Replay captured activity
          </button>
          <label>
            <input
              type="checkbox"
              checked={includeContent}
              onChange={(event) => setIncludeContent(event.target.checked)}
            />{' '}
            Include conversation content in export
          </label>
          <p>
            {includeContent
              ? 'The file includes prompts, tool output, and any private content they contain.'
              : 'Text is redacted by default; text layout will differ from the original.'}
          </p>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => downloadSessionTape(tape, includeContent)}
          >
            Export capture
          </button>
        </>
      )}
      {/* The native file input draws the platform's own "Choose File" chrome
          beside these styled buttons, so a matching button opens it instead.
          The input stays labelled and in the document for the picker and for
          assistive technology that reaches it directly. */}
      <button
        type="button"
        className="button button--secondary"
        onClick={() => importInputRef.current?.click()}
      >
        Import replay file…
      </button>
      <label className="sr-only" htmlFor={importInputId}>
        Import replay file
      </label>
      <input
        ref={importInputRef}
        id={importInputId}
        className="sr-only"
        tabIndex={-1}
        type="file"
        accept="application/json,.json"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          // Choosing the same file again must still fire a change.
          event.target.value = '';
          if (!file) return;
          try {
            const imported = await readSessionTapeFile(file);
            openReplayFromTape(imported, {
              agentSlug: imported.source.agentSlug,
              agentName: 'Replay',
            });
            onOpen();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        }}
      />
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
