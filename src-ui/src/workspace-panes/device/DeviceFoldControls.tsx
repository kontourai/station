import type {
  LiveSurfaceFold,
  LiveSurfaceInput,
  LiveSurfacePosture,
} from '@kontourai/station-contracts/live-surface';
import { type ReactNode, useId, useRef } from 'react';
import { Button } from '../../components/Button';
import { snapHingeAngle } from './deviceFold';
import './DeviceFold.css';

/**
 * A foldable's stands, hinge and table mode (#1970 foldables). Every
 * change is ordinary surface input (`kind: 'fold'`), so it needs and claims
 * control exactly like a tap, and is disabled while input cannot arrive.
 *
 * The hinge slider previews while it moves (the view bends at once) and
 * sends one angle when released; near a stand's angle it settles there.
 * See `useDeviceFold` for how a host wires this beside its viewer.
 */

const POSTURE_LABEL: Record<LiveSurfacePosture, string> = {
  closed: 'Closed',
  open: 'Open flat',
  book: 'Book',
  laptop: 'Laptop',
  tent: 'Tent',
};

/** Side views of each stand: two strokes meeting at the hinge dot. */
function PostureGlyph({ posture }: { posture: LiveSurfacePosture }) {
  const paths: Record<LiveSurfacePosture, string> = {
    closed: 'M5 9h14M5 11h14',
    open: 'M3 12h18',
    book: 'M4 7l8 6 8-6',
    laptop: 'M4 17h8V5',
    tent: 'M4 19l8-13 8 13',
  };
  const hinge: Record<LiveSurfacePosture, [number, number]> = {
    closed: [19, 10],
    open: [12, 12],
    book: [12, 13],
    laptop: [12, 17],
    tent: [12, 6],
  };
  const [cx, cy] = hinge[posture];
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="20"
    >
      <path d={paths[posture]} />
      <circle cx={cx} cy={cy} fill="currentColor" r="1.5" stroke="none" />
    </svg>
  );
}

export interface DeviceFoldControlsProps {
  fold: LiveSurfaceFold | undefined;
  previewAngle: number | null;
  onPreviewAngle: (angle: number | null) => void;
  sendInput: (events: LiveSurfaceInput[]) => void;
  inputReady: boolean;
}

export function DeviceFoldControls({
  fold,
  previewAngle,
  onPreviewAngle,
  sendInput,
  inputReady,
}: DeviceFoldControlsProps): ReactNode {
  const sliderId = useId();
  // Release, key-up and blur can all end one drag: send its angle once.
  const sentAngle = useRef<number | null>(null);
  if (!fold) return null;
  const shownAngle = previewAngle ?? fold.hingeAngle;
  const commit = () => {
    if (previewAngle === null || previewAngle === sentAngle.current) return;
    sentAngle.current = previewAngle;
    sendInput([{ kind: 'fold', hingeAngle: previewAngle }]);
  };
  return (
    <fieldset
      aria-label="Fold"
      className="device-fold-controls"
      data-testid="device-fold-controls"
    >
      <div
        aria-label="Stand"
        className="device-fold-controls__stands"
        role="radiogroup"
      >
        {fold.postures.map((posture) => {
          const current = fold.posture === posture && previewAngle === null;
          return (
            <Button
              aria-checked={current}
              aria-label={POSTURE_LABEL[posture]}
              className="device-fold-controls__stand"
              disabled={!inputReady}
              key={posture}
              onClick={() => {
                onPreviewAngle(null);
                sendInput([{ kind: 'fold', posture }]);
              }}
              role="radio"
              size="sm"
              title={POSTURE_LABEL[posture]}
              variant={current ? 'secondary' : 'ghost'}
            >
              <PostureGlyph posture={posture} />
            </Button>
          );
        })}
      </div>
      {fold.angleControl ? (
        <div className="device-fold-controls__hinge">
          <label htmlFor={sliderId}>Hinge</label>
          <input
            disabled={!inputReady}
            id={sliderId}
            max={180}
            min={0}
            onChange={(event) => {
              sentAngle.current = null;
              onPreviewAngle(
                snapHingeAngle(
                  Number(event.currentTarget.value),
                  fold.postures,
                ),
              );
            }}
            onKeyUp={commit}
            onPointerUp={commit}
            onBlur={commit}
            step={1}
            type="range"
            value={shownAngle ?? 180}
            aria-valuetext={
              shownAngle === null ? 'Unknown' : `${Math.round(shownAngle)}°`
            }
          />
          <output htmlFor={sliderId}>
            {shownAngle === null ? '—' : `${Math.round(shownAngle)}°`}
          </output>
        </div>
      ) : null}
      {fold.tableMode !== undefined ? (
        <label className="device-fold-controls__table">
          <input
            checked={fold.tableMode}
            disabled={!inputReady}
            onChange={(event) =>
              sendInput([
                { kind: 'fold', tableMode: event.currentTarget.checked },
              ])
            }
            type="checkbox"
          />
          Table mode
        </label>
      ) : null}
    </fieldset>
  );
}
