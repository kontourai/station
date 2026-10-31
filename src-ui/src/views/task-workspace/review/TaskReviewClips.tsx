import type { Walkthrough } from '@kontourai/station-contracts/walkthrough';
import {
  useTaskWalkthroughsQuery,
  useTaskWalkthroughVideoQuery,
} from '@kontourai/station-sdk';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { useEffect, useState } from 'react';
import { Button } from '../../../components/Button';
import { Dialog } from '../../../components/Dialog';
import { PlayGlyph } from '../../../components/icons/Glyph';
import {
  Empty,
  ErrorState,
  SkeletonBlock,
  SkeletonList,
} from '../../../components/state';

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function ClipPlayer({
  taskId,
  clip,
  scope,
  onClose,
}: {
  taskId: string;
  clip: Walkthrough;
  scope: { requestScope: ApiRequestScope; taskCreatedAt: string };
  onClose: () => void;
}) {
  const video = useTaskWalkthroughVideoQuery(taskId, clip, scope);
  const [source, setSource] = useState<{ blob: Blob; url: string }>();
  useEffect(() => {
    if (!video.data) return;
    const url = URL.createObjectURL(video.data);
    setSource({ blob: video.data, url });
    return () => URL.revokeObjectURL(url);
  }, [video.data]);
  return (
    <Dialog
      open
      historyMode="none"
      title={clip.title || 'Walkthrough clip'}
      subtitle={`Commit ${clip.source.commit?.slice(0, 7)} · ${duration(clip.source.durationMs)}`}
      closeLabel="Close walkthrough clip"
      onClose={onClose}
      size="lg"
    >
      {video.error ? (
        <ErrorState
          variant="compact"
          title="Couldn’t load this clip."
          action={
            <Button size="sm" onClick={() => void video.refetch()}>
              Retry clip
            </Button>
          }
        />
      ) : !source || source.blob !== video.data ? (
        <SkeletonBlock count={1} label="Loading clip" />
      ) : (
        // biome-ignore lint/a11y/useMediaCaption: Task Browser recordings are encoded without audio.
        <video
          className="review-clip__video"
          aria-label="Walkthrough clip"
          controls
          preload="metadata"
          src={source.url}
        />
      )}
    </Dialog>
  );
}

export function TaskReviewClips({
  taskId,
  taskCreatedAt,
  requestScope,
}: {
  taskId: string;
  taskCreatedAt: string;
  requestScope: ApiRequestScope;
}) {
  const scope = { requestScope, taskCreatedAt };
  const clips = useTaskWalkthroughsQuery(taskId, scope);
  const [selected, setSelected] = useState<Walkthrough>();
  const items = clips.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <>
      {clips.isLoading ? (
        <SkeletonList count={1} withIcon={false} label="Loading clips" />
      ) : items.length === 0 && !clips.error ? (
        <Empty variant="compact" label="Ask the lead agent to record a clip." />
      ) : (
        items.map((clip) => (
          <Button
            key={clip.id}
            size="sm"
            variant="ghost"
            className="review-items__item review-clip__item"
            onClick={() => setSelected(clip)}
          >
            <PlayGlyph />
            <span>
              <span className="review-clip__title">
                {clip.title || 'Walkthrough clip'}
              </span>
              <small>
                {' '}
                {clip.source.commit?.slice(0, 7)} ·{' '}
                {duration(clip.source.durationMs)}
              </small>
            </span>
          </Button>
        ))
      )}
      {clips.error && (
        <ErrorState
          variant="compact"
          title="Couldn’t load clips."
          description="Check the preview or update Station."
          action={
            <Button
              size="sm"
              onClick={() =>
                void (clips.isFetchNextPageError
                  ? clips.fetchNextPage()
                  : clips.refetch())
              }
            >
              Retry clips
            </Button>
          }
        />
      )}
      {clips.hasNextPage && !clips.isFetchNextPageError && (
        <Button
          size="sm"
          onClick={() => void clips.fetchNextPage()}
          pending={clips.isFetchingNextPage}
        >
          Show more clips
        </Button>
      )}
      {selected && (
        <ClipPlayer
          taskId={taskId}
          clip={selected}
          scope={scope}
          onClose={() => setSelected(undefined)}
        />
      )}
    </>
  );
}
