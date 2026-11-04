/**
 * Capture tab: pasted/uploaded text becomes a raw record; compilation invokes
 * an Agent and separately writes a linked compiled record.
 * The current public SDK has no useSTT export, so the optional live control is
 * hidden. Meeting Transcription's voiceRegistry integration is a separate path.
 */

import type { LayoutComponentProps } from '@kontourai/station-sdk';
import * as StationSDK from '@kontourai/station-sdk';
import { useApiBase } from '@kontourai/station-sdk';
import { createKnowledgeRecord } from '@kontourai/station-sdk/client';
import { useMutation } from '@tanstack/react-query';
import { type ChangeEvent, useCallback, useRef, useState } from 'react';
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

interface CaptureRequest {
  rootId: string;
  transcript: string;
  revision: number;
}

interface CompileRequest extends CaptureRequest {
  rawRecordId: string;
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
  const [compiledRecord, setCompiledRecord] = useState<{
    id: string;
    rawRecordId: string;
  } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const draftRevision = useRef(0);

  const saveMutation = useMutation({
    mutationFn: async (request: CaptureRequest) => {
      const record = await createKnowledgeRecord(
        apiBase,
        request.rootId,
        buildRawRecordInput(request.transcript),
      );
      return record.id;
    },
    onSuccess: (id, request) => {
      if (request.revision !== draftRevision.current) return;
      setRawRecordId(id);
      setCompiledRecord(null);
      setNotice({
        kind: 'success',
        text: `Saved raw transcript record ${id}.`,
      });
    },
    onError: (error: unknown, request) => {
      if (request.revision !== draftRevision.current) return;
      setNotice({
        kind: 'error',
        text: `Could not save transcript: ${error instanceof Error ? error.message : String(error)}`,
      });
    },
  });

  const compileMutation = useMutation({
    mutationFn: async (request: CompileRequest) => {
      const result = await invokeCompileAgent(request.transcript);
      const record = await createKnowledgeRecord(
        apiBase,
        request.rootId,
        buildCompiledRecordInput(request.rawRecordId, result),
      );
      return record.id;
    },
    onSuccess: (id, request) => {
      if (request.revision !== draftRevision.current) return;
      setCompiledRecord({ id, rawRecordId: request.rawRecordId });
      setNotice({
        kind: 'success',
        text: `Compiled note ${id}, linked to raw transcript ${request.rawRecordId}.`,
      });
    },
    onError: (error: unknown, request) => {
      if (request.revision !== draftRevision.current) return;
      setNotice({
        kind: 'error',
        text: `Could not compile transcript: ${error instanceof Error ? error.message : String(error)}`,
      });
    },
  });

  const handleRootChange = useCallback((newRootId: string) => {
    draftRevision.current += 1;
    setRootId(newRootId);
    setRawRecordId(null);
    setCompiledRecord(null);
    setNotice(null);
  }, []);

  const replaceTranscript = useCallback((text: string) => {
    draftRevision.current += 1;
    setTranscript(text);
    setRawRecordId(null);
    setCompiledRecord(null);
    setNotice(null);
  }, []);

  const uploadTranscript = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = '';
    const revision = ++draftRevision.current;
    setNotice(null);
    try {
      const text = await file.text();
      if (revision === draftRevision.current) replaceTranscript(text);
    } catch (error) {
      if (revision !== draftRevision.current) return;
      setNotice({
        kind: 'error',
        text: `Could not read transcript: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

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
            replaceTranscript(transcript ? `${transcript}\n\n${text}` : text);
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
          onChange={(event) => replaceTranscript(event.target.value)}
        />
      </label>
      <input
        type="file"
        accept=".txt,text/plain"
        aria-label="Upload transcript"
        data-testid="mn-transcript-upload"
        className="mn-file-input"
        onChange={uploadTranscript}
      />

      <div className="mn-actions">
        <button
          type="button"
          className="button button--secondary"
          data-testid="mn-save-transcript"
          disabled={!rootId || !transcript.trim() || saveMutation.isPending}
          onClick={() => {
            if (rootId)
              saveMutation.mutate({
                rootId,
                transcript: transcript.trim(),
                revision: draftRevision.current,
              });
          }}
        >
          {saveMutation.isPending ? 'Saving…' : 'Save transcript'}
        </button>
        <button
          type="button"
          className="button button--primary"
          data-testid="mn-compile"
          disabled={!rawRecordId || compileMutation.isPending}
          onClick={() => {
            if (rootId && rawRecordId)
              compileMutation.mutate({
                rootId,
                rawRecordId,
                transcript: transcript.trim(),
                revision: draftRevision.current,
              });
          }}
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
      {compiledRecord && (
        <p className="mn-record-link" data-testid="mn-compiled-record">
          Compiled note record: <code>{compiledRecord.id}</code> — links to{' '}
          <code>{compiledRecord.rawRecordId}</code> (<code>kind: "source"</code>
          )
        </p>
      )}
    </div>
  );
}

export default CaptureModal;
