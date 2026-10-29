import type {
  TaskCapture,
  TaskReviewThreadSummary,
} from '@kontourai/station-contracts/task-review';
import {
  fetchTaskCaptureContent,
  useTaskReviewQuery,
} from '@kontourai/station-sdk';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { useIsMobile } from '../../hooks/useIsMobile';
import './TaskOverviewTimeline.css';

const TIMELINE_PAGE_SIZE = 12;
const MAX_CONCURRENT_CONTENT_READS = 4;

function createContentAdmission() {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T,>(
    signal: AbortSignal,
    read: () => Promise<T>,
  ): Promise<T> => {
    await new Promise<void>((resolve, reject) => {
      const admit = () => {
        signal.removeEventListener('abort', cancel);
        active++;
        resolve();
      };
      const cancel = () => {
        const index = waiting.indexOf(admit);
        if (index >= 0) waiting.splice(index, 1);
        reject(signal.reason);
      };
      if (signal.aborted) return cancel();
      if (active < MAX_CONCURRENT_CONTENT_READS) admit();
      else {
        waiting.push(admit);
        signal.addEventListener('abort', cancel, { once: true });
      }
    });
    try {
      return await read();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

type ContentAdmission = ReturnType<typeof createContentAdmission>;

function TimelineScreen({
  capture,
  threads,
  onOpenCapture,
  admit,
  scope,
}: {
  capture: TaskCapture;
  threads: readonly TaskReviewThreadSummary[];
  onOpenCapture: (id: string) => void;
  admit: ContentAdmission;
  scope: string;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        setNear(Boolean(entry?.isIntersecting));
      },
      { rootMargin: '200px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <li ref={ref} className="task-timeline__capture">
      <TimelineScreenContent
        capture={capture}
        threads={threads}
        onOpenCapture={onOpenCapture}
        admit={admit}
        scope={scope}
        near={near}
      />
    </li>
  );
}

function TimelineScreenContent({
  capture,
  threads,
  onOpenCapture,
  admit,
  scope,
  near,
}: {
  capture: TaskCapture;
  threads: readonly TaskReviewThreadSummary[];
  onOpenCapture: (id: string) => void;
  admit: ContentAdmission;
  scope: string;
  near: boolean;
}) {
  const content = useQuery({
    queryKey: [
      'task-review-capture-content',
      capture.taskId,
      scope,
      capture.digest,
    ],
    queryFn: ({ signal }) =>
      admit(signal, () =>
        fetchTaskCaptureContent(capture.taskId, capture.captureId, signal),
      ),
    enabled: near,
    gcTime: 0,
    staleTime: Infinity,
  });
  const imageRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (!near || !content.data || !imageRef.current) return;
    const element = imageRef.current;
    const url = URL.createObjectURL(content.data);
    element.src = url;
    return () => {
      element.removeAttribute('src');
      URL.revokeObjectURL(url);
    };
  }, [content.data, near]);
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
    <>
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
      ) : near && content.data ? (
        <Button
          variant="ghost"
          className="task-timeline__screen"
          aria-label={`Review ${label}`}
          onClick={() => onOpenCapture(capture.captureId)}
        >
          <img ref={imageRef} alt={label} />
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
    </>
  );
}

function Timeline({
  taskId,
  taskCreatedAt,
  onOpenCapture,
  scope,
}: {
  taskId: string;
  taskCreatedAt: string;
  onOpenCapture: (id: string) => void;
  scope: string;
}) {
  const mobile = useIsMobile();
  const [limit, setLimit] = useState(TIMELINE_PAGE_SIZE);
  const admit = useMemo(createContentAdmission, []);
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
    <section
      className="task-timeline"
      data-mobile={mobile || undefined}
      aria-label="Timeline"
    >
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
        <>
          <ol className="task-timeline__screens">
            {captures.slice(-limit).map((capture) => (
              <TimelineScreen
                key={capture.captureId}
                capture={capture}
                threads={review.data?.threads ?? []}
                onOpenCapture={onOpenCapture}
                admit={admit}
                scope={scope}
              />
            ))}
          </ol>
          {limit < captures.length && (
            <Button
              size="sm"
              onClick={() => setLimit((value) => value + TIMELINE_PAGE_SIZE)}
            >
              Show more
            </Button>
          )}
        </>
      ) : (
        !review.error &&
        !unavailable && (
          <Empty label="Capture a Screen in Review to start the Timeline." />
        )
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
      scope={JSON.stringify([
        apiBase,
        authority?.authorityKey,
        props.taskCreatedAt,
      ])}
    />
  ) : null;
}
