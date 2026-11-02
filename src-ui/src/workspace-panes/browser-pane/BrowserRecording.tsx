import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { IconButton } from '../../components/IconButton';
import { RecordGlyph } from '../../components/icons/Glyph';
import type { BrowserPaneApi } from './browserPaneApi';

export function useBrowserRecording(
  api: BrowserPaneApi,
  sessionId: string,
  generation: number | undefined,
  live: boolean,
) {
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = useRef({ api, sessionId, generation, mounted: true });
  owner.current = {
    api,
    sessionId,
    generation,
    mounted: owner.current.mounted,
  };
  const idRef = useRef<string | null>(null);
  idRef.current = recordingId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a generation change must cancel its prior recording.
  useEffect(() => {
    owner.current.mounted = true;
    setRecordingId(null);
    setStopping(false);
    setError(null);
    return () => {
      owner.current.mounted = false;
      if (idRef.current)
        void api.cancelRecording(sessionId, idRef.current).catch(() => {});
    };
  }, [api, sessionId, generation]);
  useEffect(() => {
    if (!live && idRef.current) {
      void api.cancelRecording(sessionId, idRef.current).catch(() => {});
      setRecordingId(null);
      setStopping(false);
    }
  }, [api, live, sessionId]);
  const start = useMutation({
    mutationFn: () => {
      if (generation === undefined)
        throw new Error('Browser generation is unavailable.');
      return api.startRecording(sessionId, generation);
    },
    onSuccess: ({ recordingId: id }) => {
      if (
        !owner.current.mounted ||
        owner.current.sessionId !== sessionId ||
        owner.current.generation !== generation
      ) {
        void api.cancelRecording(sessionId, id).catch(() => {});
        return;
      }
      setError(null);
      setStopping(false);
      setRecordingId(id);
    },
    onError: () =>
      setError(
        'Could not start recording. Check Browser access and media tools.',
      ),
  });
  const status = useQuery({
    queryKey: ['browser-recording', sessionId, generation, recordingId],
    queryFn: ({ signal }) =>
      api.recordingStatus(sessionId, recordingId!, signal),
    enabled: live && generation !== undefined && !!recordingId,
    refetchInterval: (query) =>
      query.state.data?.state === 'ready' ||
      query.state.data?.state === 'failed'
        ? false
        : 1000,
    retry: false,
  });
  const video = useQuery({
    queryKey: ['browser-recording-video', sessionId, generation, recordingId],
    queryFn: ({ signal }) =>
      api.recordingVideo(sessionId, recordingId!, signal),
    enabled: live && !!recordingId && status.data?.state === 'ready',
    retry: false,
    gcTime: 0,
  });
  const stop = useMutation({
    mutationFn: () => api.stopRecording(sessionId, recordingId!),
    onMutate: () => {
      setStopping(true);
    },
    onSuccess: () => {
      void status.refetch();
    },
    onError: () => {
      setStopping(false);
      setError('Could not stop recording.');
    },
  });
  const phase = start.isPending
    ? 'starting'
    : status.isError
      ? 'failed'
      : (status.data?.state ?? (recordingId ? 'starting' : 'idle'));
  const active = phase === 'starting' || phase === 'recording';
  const toggle = () => {
    if (active && recordingId && !stopping) stop.mutate();
    else if (phase === 'idle' && live && generation !== undefined)
      start.mutate();
  };
  const reset = () => {
    if (recordingId)
      void api.cancelRecording(sessionId, recordingId).catch(() => {});
    setRecordingId(null);
    setStopping(false);
    setError(null);
  };
  return {
    phase,
    active,
    stopping,
    error:
      error ??
      (status.isError || video.isError
        ? 'Recording is unavailable.'
        : (status.data?.error ?? null)),
    video: video.data,
    toggle,
    reset,
    busy: start.isPending || stop.isPending,
  };
}

type Recording = ReturnType<typeof useBrowserRecording>;
export function BrowserRecordingButton({
  recording,
  live,
}: {
  recording: Recording;
  live: boolean;
}) {
  const label = recording.active ? 'Stop recording' : 'Record';
  return (
    <IconButton
      aria-label={label}
      title={label}
      active={recording.active}
      disabled={
        !live ||
        recording.busy ||
        recording.stopping ||
        (!recording.active && recording.phase !== 'idle')
      }
      onClick={recording.toggle}
    >
      <RecordGlyph />
    </IconButton>
  );
}
export function BrowserRecordingStatus({
  recording,
}: {
  recording: Recording;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!recording.video) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(recording.video);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [recording.video]);
  if (recording.phase === 'idle' && !recording.error) return null;
  return (
    <div className="browser-pane__overlay-notice" role="status">
      <p>
        {recording.error ??
          (recording.phase === 'ready'
            ? 'Recording ready.'
            : recording.phase === 'starting'
              ? 'Starting recording…'
              : recording.stopping || recording.phase === 'encoding'
                ? 'Finishing recording…'
                : 'Recording…')}
      </p>
      {url ? (
        <a
          className="button button--primary button--small browser-pane__control browser-pane__link-button"
          href={url}
          download="browser-recording.webm"
        >
          Save clip
        </a>
      ) : null}
      {recording.phase === 'ready' ||
      recording.phase === 'failed' ||
      recording.error ? (
        <Button size="sm" onClick={recording.reset}>
          Dismiss
        </Button>
      ) : null}
    </div>
  );
}
