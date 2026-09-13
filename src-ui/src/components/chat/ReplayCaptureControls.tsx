import { useState, useSyncExternalStore } from 'react';
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
      <label>
        Import replay file
        <input
          type="file"
          accept="application/json,.json"
          onChange={async (event) => {
            const file = event.target.files?.[0];
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
      </label>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
