import type {
  TaskReviewAnchor,
  TaskReviewThread,
} from '@kontourai/station-contracts/task-review';
import { useId, useState } from 'react';
import { Button } from '../../../components/Button';
import { PinGlyph } from '../../../components/icons/Glyph';
import { ReviewAnchorComposer } from './ReviewAnchorComposer';

type Region = Extract<TaskReviewAnchor, { kind: 'region' }>;
const clamp = (value: number) => Math.min(0.96, Math.max(0, value));

export function ReviewImageView({
  src,
  alt,
  threads = [],
  onSelectThread,
  onCreateThread,
}: {
  src: string;
  alt: string;
  threads?: readonly TaskReviewThread[];
  onSelectThread: (threadId: string) => void;
  onCreateThread: (anchor: Region, body: string) => void | Promise<void>;
}) {
  const [cursor, setCursor] = useState({ x: 0.48, y: 0.48 });
  const helpId = useId();
  const [pin, setPin] = useState<{ anchor: Region; src: string }>();
  return (
    <section className="review-image" aria-label="Screen review">
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
            thread.anchor.kind === 'region' && (
              <Button
                key={thread.threadId}
                variant="secondary"
                className="review-image__pin"
                aria-label={`Open thread ${thread.ordinal}`}
                onClick={() => onSelectThread(thread.threadId)}
                style={{
                  left: `clamp(0px, ${thread.anchor.x * 100}%, calc(100% - var(--k-space-6) - var(--k-space-3)))`,
                  top: `clamp(0px, ${thread.anchor.y * 100}%, calc(100% - var(--k-space-6) - var(--k-space-3)))`,
                }}
              >
                <PinGlyph />
                {thread.ordinal}
              </Button>
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
      <p id={helpId} className="review-empty">
        Arrow keys to move · Enter to pin
      </p>
      <span className="review-sr-only" role="status">
        Pin at {Math.round(cursor.x * 100)}%, {Math.round(cursor.y * 100)}%
      </span>
      {pin && (
        <ReviewAnchorComposer
          onCancel={() => setPin(undefined)}
          onSubmit={(body) => {
            if (pin.src !== src)
              throw new Error('Screen changed. Place a new pin.');
            return onCreateThread(pin.anchor, body);
          }}
        />
      )}
    </section>
  );
}
