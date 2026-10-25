import {
  parseTaskCapture,
  parseTaskReviewAnchor,
  type TaskCapture,
  type TaskReviewAnchor,
  type TaskReviewArtifactRef,
  type TaskReviewThreadView,
} from '@kontourai/station-contracts/task-review';
import { Fragment, useId, useState } from 'react';
import { Button } from '../../../components/Button';
import { CodeGlyph, PinGlyph } from '../../../components/icons/Glyph';
import { ReviewAnchorComposer } from './ReviewAnchorComposer';
import { useReviewContext } from './ReviewContext';

type Region = Extract<TaskReviewAnchor, { kind: 'region' }>;
const clamp = (value: number) => Math.min(0.96, Math.max(0, value));

export function ReviewImageView({
  src,
  alt,
  threads = [],
  artifact,
  draftScope,
  capture,
  onSelectThread,
  onCreateThread,
}: {
  src: string;
  artifact: TaskReviewArtifactRef & { kind: 'capture' };
  draftScope: string;
  capture?: TaskCapture;
  alt: string;
  threads?: readonly Omit<TaskReviewThreadView, 'events'>[];
  onSelectThread: (threadId: string) => void;
  onCreateThread: (anchor: Region, body: string) => void | Promise<void>;
}) {
  const review = useReviewContext();
  const [cursor, setCursor] = useState({ x: 0.48, y: 0.48 });
  const helpId = useId();
  const [pin, setPin] = useState<{
    anchor: Region;
    src: string;
    artifactId: string;
    revision: string;
  }>();
  const metadata = parseTaskCapture(capture);
  return (
    <section className="review-image" aria-label="Screen review">
      {metadata && (
        <header className="review-document__header">
          <span>{metadata.label ?? alt}</span>
          <span className="review-chip" title={metadata.commit}>
            <CodeGlyph />
            {metadata.commit.slice(0, 7)}
          </span>
        </header>
      )}
      <div className="review-image__stage">
        <img src={src} alt={alt} draggable={false} />
        <button
          type="button"
          className="review-image__target"
          aria-label="Place region pin"
          aria-describedby={helpId}
          onClick={(event) => {
            if (pin) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const point =
              event.detail === 0
                ? cursor
                : {
                    x: clamp((event.clientX - rect.left) / rect.width - 0.02),
                    y: clamp((event.clientY - rect.top) / rect.height - 0.02),
                  };
            setCursor(point);
            setPin({
              anchor: { kind: 'region', ...point, w: 0.04, h: 0.04 },
              src,
              artifactId: artifact.id,
              revision: artifact.revision,
            });
          }}
          onKeyDown={(event) => {
            const delta = {
              ArrowLeft: [-0.02, 0],
              ArrowRight: [0.02, 0],
              ArrowUp: [0, -0.02],
              ArrowDown: [0, 0.02],
            }[event.key];
            if (!delta || pin) return;
            event.preventDefault();
            setCursor((previous) => ({
              x: clamp(previous.x + delta[0]),
              y: clamp(previous.y + delta[1]),
            }));
          }}
        >
          <span
            className="review-image__cursor"
            style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%` }}
          >
            <PinGlyph />
          </span>
        </button>
        {threads.map(
          (thread) =>
            thread.baseState !== 'resolved' &&
            thread.artifact.kind === 'capture' &&
            thread.artifact.id === artifact.id &&
            thread.artifact.revision === artifact.revision &&
            parseTaskReviewAnchor(thread.anchor)?.kind === 'region' &&
            thread.anchor.kind === 'region' && (
              <Fragment key={thread.threadId}>
                <span
                  className="review-image__region"
                  data-review-emphasized={
                    review?.emphasizedThread === thread.threadId || undefined
                  }
                  style={{
                    left: `${thread.anchor.x * 100}%`,
                    top: `${thread.anchor.y * 100}%`,
                    width: `${thread.anchor.w * 100}%`,
                    height: `${thread.anchor.h * 100}%`,
                  }}
                />
                <Button
                  variant="ghost"
                  className="review-image__pin"
                  aria-label={`Open thread ${thread.ordinal}`}
                  aria-controls={`review-thread-${thread.threadId}`}
                  data-review-pin={thread.threadId}
                  data-review-emphasized={
                    review?.emphasizedThread === thread.threadId || undefined
                  }
                  onMouseEnter={() => review?.emphasize(thread.threadId)}
                  onMouseLeave={() => review?.emphasize(undefined)}
                  onFocus={() => review?.emphasize(thread.threadId)}
                  onBlur={() => review?.emphasize(undefined)}
                  onClick={() => {
                    onSelectThread(thread.threadId);
                    const card = document.getElementById(
                      `review-thread-${thread.threadId}`,
                    );
                    card?.scrollIntoView?.({ block: 'nearest' });
                    card?.focus();
                  }}
                  style={{
                    left: `${thread.anchor.x * 100}%`,
                    top: `${thread.anchor.y * 100}%`,
                  }}
                >
                  <span className="review-image__marker">
                    <svg viewBox="0 0 20 24" aria-hidden="true">
                      <path d="M10 24 2.9 16.1A10 10 0 1 1 17.1 16.1Z" />
                    </svg>
                    <span>{thread.ordinal}</span>
                  </span>
                </Button>
              </Fragment>
            ),
        )}
        {pin && (
          <span
            className="review-image__region"
            style={{
              left: `${pin.anchor.x * 100}%`,
              top: `${pin.anchor.y * 100}%`,
              width: `${pin.anchor.w * 100}%`,
              height: `${pin.anchor.h * 100}%`,
            }}
          />
        )}
      </div>
      <p id={helpId} className="review-image__hint">
        Arrow keys to move · Enter to pin
      </p>
      <span className="sr-only" role="status">
        Pin at {Math.round(cursor.x * 100)}%, {Math.round(cursor.y * 100)}%
      </span>
      {pin && (
        <ReviewAnchorComposer
          draftKey={`${draftScope}:capture:${artifact.id}:${artifact.revision}:${JSON.stringify(pin.anchor)}`}
          onCancel={() => setPin(undefined)}
          onSubmit={(body) => {
            if (
              pin.src !== src ||
              pin.artifactId !== artifact.id ||
              pin.revision !== artifact.revision
            )
              throw new Error('Screen changed. Place a new pin.');
            const valid = parseTaskReviewAnchor(pin.anchor);
            if (valid?.kind !== 'region')
              throw new Error('Invalid pin. Place a new pin.');
            return onCreateThread(valid, body);
          }}
        />
      )}
    </section>
  );
}
