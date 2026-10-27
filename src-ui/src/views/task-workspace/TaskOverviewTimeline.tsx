import type {
  TaskCapture,
  TaskReviewThreadSummary,
} from '@kontourai/station-contracts/task-review';
import {
  fetchTaskCaptureContent,
  useTaskReviewQuery,
} from '@kontourai/station-sdk';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '../../components/Button';
import {
  CameraGlyph,
  CheckGlyph,
  CodeGlyph,
  InfoGlyph,
  MonitorGlyph,
} from '../../components/icons/Glyph';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import {
  useApiBase,
  useHostRequestAuthorityScope,
} from '../../contexts/ApiBaseContext';
import './TaskOverviewTimeline.css';

function TimelineScreen({
  capture,
  threads,
  onOpenCapture,
}: {
  capture: TaskCapture;
  threads: readonly TaskReviewThreadSummary[];
  onOpenCapture: (id: string) => void;
}) {
  const content = useQuery({
    queryKey: [
      'task-review-capture-content',
      capture.taskId,
      capture.captureId,
      capture.digest,
    ],
    queryFn: ({ signal }) =>
      fetchTaskCaptureContent(capture.taskId, capture.captureId, signal),
    gcTime: 0,
    staleTime: Infinity,
  });
  const [image, setImage] = useState<{ blob: Blob; url: string }>();
  useEffect(() => {
    if (!content.data) return;
    const url = URL.createObjectURL(content.data);
    setImage({ blob: content.data, url });
    return () => URL.revokeObjectURL(url);
  }, [content.data]);
  const evidence = threads.flatMap((thread) => {
    if (thread.status !== 'available') return [];
    const event = thread.lastDeliveryEvent;
    return event?.kind === 'agent-reply' &&
      event.evidence?.captureId === capture.captureId &&
      event.evidence.commit === capture.commit &&
      event.evidence.gateRefs?.length
      ? [event.evidence]
      : [];
  });
  // These flags are produced by task-review-evidence.ts, never inferred from a label.
  const verified = evidence.some((entry) => entry.gateVerified);
  const label = capture.label ?? 'Screen';
  return (
    <li className="task-timeline__capture">
      {content.error ? (
        <ErrorState
          variant="compact"
          title={`Couldn’t load ${label}.`}
          action={
            <Button size="sm" onClick={() => void content.refetch()}>
              Retry Screen
            </Button>
          }
        />
      ) : image && image.blob === content.data ? (
        <Button
          variant="ghost"
          className="task-timeline__screen"
          aria-label={`Review ${label}`}
          onClick={() => onOpenCapture(capture.captureId)}
        >
          <img src={image.url} alt={label} />
        </Button>
      ) : (
        <SkeletonBlock label={`Loading ${label}`} />
      )}
      <div className="task-timeline__caption">
        <span className="task-timeline__label" title={label}>
          {label}
        </span>
        <time dateTime={capture.createdAt} title={capture.createdAt}>
          {new Date(capture.createdAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </time>
      </div>
      <div className="task-timeline__metadata">
        <span className="task-timeline__commit" title={capture.commit}>
          <CodeGlyph />
          {capture.commit.slice(0, 7)}
        </span>
        <span
          className="task-timeline__gate"
          data-verified={verified || undefined}
        >
          {verified ? <CheckGlyph /> : <InfoGlyph />}
          {verified ? 'Verified' : 'claimed'}
        </span>
        <span title={capture.sourceKind === 'browser' ? 'Browser' : 'Device'}>
          {capture.sourceKind === 'browser' ? (
            <MonitorGlyph />
          ) : (
            <CameraGlyph />
          )}
        </span>
      </div>
    </li>
  );
}

function Timeline({
  taskId,
  taskCreatedAt,
  onOpenCapture,
}: {
  taskId: string;
  taskCreatedAt: string;
  onOpenCapture: (id: string) => void;
}) {
  const review = useTaskReviewQuery(taskId, { staleTime: 0 });
  const unavailable = review.data?.items.some(
    (item) => item.kind === 'capture' && item.status === 'unavailable',
  );
  const captures = (review.data?.items ?? [])
    .flatMap((item) =>
      item.kind === 'capture' &&
      item.status === 'available' &&
      item.capture &&
      item.capture.taskId === taskId &&
      item.capture.taskCreatedAt === taskCreatedAt
        ? [item.capture]
        : [],
    )
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) ||
        a.captureId.localeCompare(b.captureId),
    );
  return (
    <section className="task-timeline" aria-label="Timeline">
      <h3>
        <CameraGlyph />
        Timeline
      </h3>
      {review.error && (
        <ErrorState
          variant="compact"
          title="Couldn’t refresh Timeline."
          action={
            <Button size="sm" onClick={() => void review.refetch()}>
              Retry Timeline
            </Button>
          }
        />
      )}
      {unavailable && (
        <ErrorState
          variant="compact"
          title="Some Screens are unavailable."
          action={
            <Button size="sm" onClick={() => void review.refetch()}>
              Retry unavailable Screens
            </Button>
          }
        />
      )}
      {review.isPending ? (
        <SkeletonBlock label="Loading Timeline" />
      ) : captures.length ? (
        <ol className="task-timeline__screens">
          {captures.map((capture) => (
            <TimelineScreen
              key={capture.captureId}
              capture={capture}
              threads={review.data?.threads ?? []}
              onOpenCapture={onOpenCapture}
            />
          ))}
        </ol>
      ) : (
        !review.error && !unavailable && <Empty title="No Screens yet" />
      )}
    </section>
  );
}

export function TaskOverviewTimeline(props: {
  taskId: string;
  taskCreatedAt: string;
  visible: boolean;
  onOpenCapture: (id: string) => void;
}) {
  const { apiBase } = useApiBase();
  const authority = useHostRequestAuthorityScope();
  // Unmount private image URLs when the Task, Station, principal or tab changes.
  return props.visible ? (
    <Timeline
      key={JSON.stringify([
        apiBase,
        authority?.authorityKey,
        props.taskId,
        props.taskCreatedAt,
      ])}
      {...props}
    />
  ) : null;
}
