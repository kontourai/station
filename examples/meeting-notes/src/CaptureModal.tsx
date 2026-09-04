/**
 * Capture pane — meeting transcript capture -> raw Kit record -> compiled
 * Kit record with a provenance link back to the raw record
 * (`s203-knowledge-meeting-notes` plan, Wave 1 Task 3, AC1a).
 *
 * Filename mirrors `examples/meeting-transcription/src/
 * MeetingTranscriptionModal.tsx` (read-only precedent) per the plan's file
 * list, even though this renders as an inline "Capture" tab pane
 * (`layout.json`) rather than a floating dialog — the tabbed layout shape is
 * the right fit here, not an overlay.
 *
 * Live capture reuses `useSTT()`'s exact call shape (same options/return
 * contract `MeetingTranscriptionModal` already uses:
 * `startListening({continuous, interimResults})` / `stopListening()` /
 * `.transcript` / `.state` / `.supported`) — verbatim, not forked. It is
 * guarded defensively: as of this Wave 1 landing, `@kontourai/station-sdk`
 * does NOT actually export `useSTT` (verified — it is defined only
 * internally at `src-ui/src/hooks/useSTT.ts`, outside the plugin boundary;
 * `MeetingTranscriptionModal.tsx`'s own `import { useSTT } from
 * '@kontourai/station-sdk'` resolves to `undefined` for the same reason).
 * This is a pre-existing SDK gap, not introduced by this task and out of
 * this task's `examples/meeting-notes/**` scope to fix. `LIVE_CAPTURE_
 * SUPPORTED` below detects the gap once, at module load, and the paste/
 * upload textarea (this task's explicitly-sanctioned v1 capture surface)
 * is always available regardless — the live-capture toggle simply doesn't
 * render until the SDK actually exports the hook, at which point it
 * activates with no further change here.
 */

import type { LayoutComponentProps } from '@kontourai/station-sdk';
import * as StationSDK from '@kontourai/station-sdk';
import { useApiBase } from '@kontourai/station-sdk';
import { createKnowledgeRecord } from '@kontourai/station-sdk/client';
import { useMutation } from '@tanstack/react-query';
import { type ChangeEvent, useCallback, useState } from 'react';
import {
  buildCompiledRecordInput,
  buildRawRecordInput,
  invokeCompileAgent,
} from './compile';
import { RootPicker } from './RootPicker';
import { ErrorState } from './state';

interface UseSTTResult {
  supported: boolean;
  state: 'idle' | 'listening' | 'error';
  transcript: string;
  startListening: (opts?: {
    continuous?: boolean;
    interimResults?: boolean;
  }) => void;
  stopListening: () => void;
}

// Computed once at module load — never changes at runtime, so gating
// `LiveCaptureSection`'s conditional render on this constant never risks
// violating rules of hooks (the hook call inside it is always unconditional
// relative to that subtree's own lifetime).
const useSTTHook = (StationSDK as Record<string, unknown>).useSTT as
  | (() => UseSTTResult)
  | undefined;
const LIVE_CAPTURE_SUPPORTED = typeof useSTTHook === 'function';

interface Notice {
  kind: 'info' | 'error' | 'success';
  text: string;
}

/**
 * Live-capture affordance — only mounted when `LIVE_CAPTURE_SUPPORTED`.
 * Mirrors `MeetingTranscriptionModal`'s Start/Pause/Resume/Clear shape, but
 * hands the recorded transcript to the parent's textarea via `onCapture`
 * instead of sending it straight to chat.
 */
function LiveCaptureSection({
  onCapture,
}: {
  onCapture: (transcript: string) => void;
}) {
  const stt = useSTTHook!();
  const [running, setRunning] = useState(false);

  const start = useCallback(() => {
    setRunning(true);
    stt.startListening({ continuous: true, interimResults: true });
  }, [stt]);

  const stop = useCallback(() => {
    stt.stopListening();
    setRunning(false);
  }, [stt]);

  const isListening = stt.state === 'listening';

  return (
    <div className="mn-live-capture" data-testid="mn-live-capture">
      <div className="mn-live-capture__controls">
        {running ? (
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={stop}
          >
            Pause
          </button>
        ) : (
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={start}
            disabled={!stt.supported}
          >
            {isListening ? 'Resume' : 'Record'}
          </button>
        )}
        <button
          type="button"
          className="button button--primary button--small"
          data-testid="mn-live-capture-use"
          disabled={!stt.transcript}
          onClick={() => onCapture(stt.transcript)}
        >
          Use this transcript
        </button>
      </div>
      {!stt.supported && (
        <p className="mn-hint">Speech recognition not supported here.</p>
      )}
      {stt.transcript && (
        <p className="mn-live-capture__preview">{stt.transcript}</p>
      )}
    </div>
  );
}

export function CaptureModal(_props: LayoutComponentProps) {
  const { apiBase } = useApiBase();
  const [rootId, setRootId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState('');
  const [rawRecordId, setRawRecordId] = useState<string | null>(null);
  const [compiledRecordId, setCompiledRecordId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!rootId) throw new Error('Select a knowledge root first.');
      const text = transcript.trim();
      if (!text) throw new Error('Paste or capture a transcript first.');
      const record = await createKnowledgeRecord(
        apiBase,
        rootId,
        buildRawRecordInput(text),
      );
      return record.id;
    },
    onSuccess: (id) => {
      setRawRecordId(id);
      setCompiledRecordId(null);
      setNotice({
        kind: 'success',
        text: `Saved raw transcript record ${id}.`,
      });
    },
    onError: (error: unknown) => {
      setNotice({
        kind: 'error',
        text: `Could not save transcript: ${error instanceof Error ? error.message : String(error)}`,
      });
    },
  });

  const compileMutation = useMutation({
    mutationFn: async () => {
      if (!rootId) throw new Error('Select a knowledge root first.');
      if (!rawRecordId)
        throw new Error('Save the transcript before compiling.');
      const text = transcript.trim();
      if (!text) throw new Error('Paste or capture a transcript first.');
      const result = await invokeCompileAgent(text);
      const record = await createKnowledgeRecord(
        apiBase,
        rootId,
        buildCompiledRecordInput(rawRecordId, result),
      );
      return record.id;
    },
    onSuccess: (id) => {
      setCompiledRecordId(id);
      setNotice({
        kind: 'success',
        text: `Compiled note ${id}, linked to raw transcript ${rawRecordId}.`,
      });
    },
    onError: (error: unknown) => {
      setNotice({
        kind: 'error',
        text: `Could not compile transcript: ${error instanceof Error ? error.message : String(error)}`,
      });
    },
  });

  const handleRootChange = useCallback((newRootId: string) => {
    setRootId(newRootId);
    setRawRecordId(null);
    setCompiledRecordId(null);
    setNotice(null);
  }, []);

  const handleTranscriptChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      setTranscript(event.target.value);
      setRawRecordId(null);
      setCompiledRecordId(null);
    },
    [],
  );

  if (!apiBase) {
    return (
      <ErrorState
        title="Station API is not available"
        description="This pane needs a live Station connection to save records."
      />
    );
  }

  return (
    <div className="mn-shell" data-testid="mn-capture-pane">
      <div className="mn-toolbar">
        <RootPicker value={rootId} onChange={handleRootChange} />
      </div>

      {LIVE_CAPTURE_SUPPORTED && (
        <LiveCaptureSection
          onCapture={(text) => {
            setTranscript((prev) => (prev ? `${prev}\n\n${text}` : text));
            setRawRecordId(null);
            setCompiledRecordId(null);
          }}
        />
      )}

      <label className="mn-field" htmlFor="mn-transcript">
        <span className="mn-field__label">Transcript</span>
        <textarea
          id="mn-transcript"
          data-testid="mn-transcript"
          className="mn-textarea"
          rows={12}
          placeholder="Paste a meeting transcript, or upload one below…"
          value={transcript}
          onChange={handleTranscriptChange}
        />
      </label>
      <input
        type="file"
        accept=".txt,text/plain"
        data-testid="mn-transcript-upload"
        className="mn-file-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          file.text().then((text) => {
            setTranscript(text);
            setRawRecordId(null);
            setCompiledRecordId(null);
          });
        }}
      />

      <div className="mn-actions">
        <button
          type="button"
          className="button button--secondary"
          data-testid="mn-save-transcript"
          disabled={!rootId || !transcript.trim() || saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
        >
          {saveMutation.isPending ? 'Saving…' : 'Save transcript'}
        </button>
        <button
          type="button"
          className="button button--primary"
          data-testid="mn-compile"
          disabled={!rawRecordId || compileMutation.isPending}
          onClick={() => compileMutation.mutate()}
        >
          {compileMutation.isPending ? 'Compiling…' : 'Compile'}
        </button>
      </div>

      {notice && (
        <div
          className={`mn-notice mn-notice-${notice.kind}`}
          data-testid="mn-notice"
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          {notice.text}
        </div>
      )}

      {rawRecordId && (
        <p className="mn-record-link" data-testid="mn-raw-record">
          Raw transcript record: <code>{rawRecordId}</code>
        </p>
      )}
      {compiledRecordId && (
        <p className="mn-record-link" data-testid="mn-compiled-record">
          Compiled note record: <code>{compiledRecordId}</code> — links to{' '}
          <code>{rawRecordId}</code> (<code>kind: "source"</code>)
        </p>
      )}
    </div>
  );
}

export default CaptureModal;
