import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ActionRow } from '../../components/ActionRow';
import { Button } from '../../components/Button';
import { IconButton } from '../../components/IconButton';
import { CloseGlyph } from '../../components/icons/Glyph';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { navigationStore } from '../../contexts/navigation-store';
import { describeStationFailure } from '../../utils/stationFailure';
import { BROWSER_PAGE_CONTENT_NOTICE } from './browserArtifactContent';
import { BrowserApiError, type BrowserPaneApi } from './browserPaneApi';
import { useBrowserArtifactIntake } from './useBrowserArtifactIntake';

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
      const active = navigationStore.getSnapshot().activeChat;
      const matches = Object.entries(activeChatsStore.getSnapshot()).filter(
        ([key, chat]) => key === active || chat.conversationId === active,
      );
      const [key, chat] =
        matches.length === 1 ? matches[0]! : [undefined, undefined];
      const taskSessionId =
        chat && !chat.conversationOpenPending && !chat.conversationOpenFailed
          ? (chat.currentSessionId ?? key)
          : undefined;
      return api.startRecording(sessionId, generation, taskSessionId);
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
    api,
    sessionId,
    generation,
    recordingId,
    task: status.data?.task,
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
export function BrowserRecordingStatus({
  recording,
}: {
  recording: Recording;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [taskResult, setTaskResult] = useState<{
    id: string;
    message: string;
    success: boolean;
  } | null>(null);
  const taskMessage =
    taskResult?.id === recording.recordingId ? taskResult.message : null;
  const [publishing, setPublishing] = useState(false);
  const alive = useRef(true);
  const beginIntake = useBrowserArtifactIntake();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const attach = async () => {
    if (
      !recording.recordingId ||
      recording.generation === undefined ||
      attaching
    )
      return;
    setAttaching(true);
    setAttachError(null);
    try {
      const intake = beginIntake(() => alive.current);
      const result = await recording.api.recordingFrames(
        recording.sessionId,
        recording.recordingId,
      );
      if (result.frames.length !== 4)
        throw new Error('Recording frames are unavailable.');
      const files: File[] = [];
      for (const [index, frame] of result.frames.entries()) {
        let data = Uint8Array.from(atob(frame.data), (c) => c.charCodeAt(0));
        if (data.byteLength > 1024 * 1024) {
          const { downscaleImageToFit } = await import(
            '../../utils/downscaleImage'
          );
          const resized = await downscaleImageToFit(
            new Blob([data], { type: 'image/jpeg' }),
            'image/jpeg',
            1024 * 1024,
          );
          if (
            resized.status !== 'resized' ||
            resized.image.mimeType !== 'image/jpeg'
          )
            throw new Error(
              'Recording frames could not be prepared for chat. Save the clip instead.',
            );
          data = Uint8Array.from(
            atob(resized.image.dataUrl.split(',')[1]!),
            (c) => c.charCodeAt(0),
          );
        }
        files.push(
          new File(
            [data],
            `Recording frames (4) - untrusted page content - ${index + 1}.jpg`,
            {
              type: 'image/jpeg',
            },
          ),
        );
      }
      const metadata = {
        kind: 'browser-recording-frames',
        label: 'Recording frames (4)',
        browserSessionId: recording.sessionId,
        tab: recording.sessionId,
        generation: recording.generation,
        frames: result.frames.map(({ data: _data, ...frame }, index) => ({
          file: files[index]!.name,
          ...frame,
          notice: BROWSER_PAGE_CONTENT_NOTICE,
        })),
      };
      files.push(
        new File([JSON.stringify(metadata, null, 2)], 'recording-frames.json', {
          type: 'application/json',
        }),
      );
      if (files.reduce((sum, file) => sum + file.size, 0) > 5 * 1024 * 1024)
        throw new Error(
          'Recording frames exceed the chat attachment limit. Save the clip instead.',
        );
      await intake(files);
    } catch (error) {
      if (alive.current)
        setAttachError(
          error instanceof BrowserApiError &&
            error.code === 'contact-unavailable'
            ? 'Recording frames are unavailable or too large. Save the clip instead.'
            : describeStationFailure(error).body,
        );
    } finally {
      if (alive.current) setAttaching(false);
    }
  };
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
      <ActionRow
        overflowLabel="More recording actions"
        label="Recording actions"
        primary={
          recording.active ? (
            <Button
              size="sm"
              variant="primary"
              disabled={recording.busy || recording.stopping}
              onClick={recording.toggle}
            >
              Stop recording
            </Button>
          ) : url ? (
            <a
              className="button button--primary button--small browser-pane__control browser-pane__link-button"
              href={url}
              download="browser-recording.webm"
            >
              Save clip
            </a>
          ) : undefined
        }
        secondary={
          recording.phase === 'ready' && recording.video ? (
            <Button
              size="sm"
              disabled={attaching}
              onClick={() => void attach()}
            >
              Attach frames to chat
            </Button>
          ) : undefined
        }
        overflow={
          recording.phase === 'ready' &&
          recording.task?.kind === 'ready' &&
          recording.recordingId
            ? [
                {
                  key: 'task',
                  label: 'Add to Task clips',
                  disabled:
                    publishing ||
                    (taskResult?.id === recording.recordingId &&
                      taskResult.success),
                  onSelect: () => {
                    const id = recording.recordingId;
                    if (!id) return;
                    setPublishing(true);
                    void recording.api
                      .publishRecordingToTask(recording.sessionId, id)
                      .then(
                        () => {
                          if (alive.current)
                            setTaskResult({
                              id,
                              message: 'Recording added to Task clips.',
                              success: true,
                            });
                        },
                        () => {
                          if (alive.current)
                            setTaskResult({
                              id,
                              message:
                                'Could not add this recording to Task clips.',
                              success: false,
                            });
                        },
                      )
                      .finally(() => {
                        if (alive.current) setPublishing(false);
                      });
                  },
                },
              ]
            : []
        }
      />
      {attachError ? <p>{attachError}</p> : null}
      {recording.task?.kind === 'unavailable' ? (
        <p>{recording.task.reason}</p>
      ) : null}
      {taskMessage ? <p>{taskMessage}</p> : null}
      {recording.phase === 'ready' ||
      recording.phase === 'failed' ||
      recording.error ? (
        <IconButton aria-label="Dismiss" onClick={recording.reset}>
          <CloseGlyph />
        </IconButton>
      ) : null}
    </div>
  );
}
