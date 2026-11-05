import type {
  LiveSurfaceFold,
  LiveSurfaceInput,
  LiveSurfacePosture,
} from '@kontourai/station-contracts/live-surface';
import { type ReactNode, useId, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { ArrowDownGlyph } from '../../components/icons/Glyph';
import type { DeviceFoldViewControls } from './DeviceFoldView';
import { snapHingeAngle, standOf } from './deviceFold';
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

export interface DeviceFoldControlsProps extends DeviceFoldViewControls {
  sendInput: (events: LiveSurfaceInput[]) => void;
  inputReady: boolean;
  /** One stand picker and a Fold settings disclosure (phone width). */
  compact?: boolean;
}

/**
 * Which stand the device is in: a named stand, or the shut/flat state its
 * hinge plainly reports. A stand the person just chose is not claimed
 * until the device reports it.
 */
function currentStand(
  fold: LiveSurfaceFold,
  previewAngle: number | null,
): LiveSurfacePosture | null {
  return previewAngle === null ? standOf(fold) : null;
}

/** The stand picker: labelled buttons, or one select when compact. */
export function DevicePostureControl({
  fold,
  previewAngle,
  onPreviewAngle,
  sendInput,
  inputReady,
  compact = false,
}: Pick<
  DeviceFoldControlsProps,
  | 'fold'
  | 'previewAngle'
  | 'onPreviewAngle'
  | 'sendInput'
  | 'inputReady'
  | 'compact'
>): ReactNode {
  if (!fold) return null;
  const current = currentStand(fold, previewAngle);
  const choose = (posture: LiveSurfacePosture) => {
    onPreviewAngle(null);
    sendInput([{ kind: 'fold', posture }]);
  };
  if (compact) {
    const angle = previewAngle ?? fold.hingeAngle;
    // The shell's compact value picker (`.choice-trigger` + caret), so the
    // full-screen bar's select matches its other controls in both themes.
    return (
      <span className="device-fold-controls__stand-picker">
        <select
          aria-label="Stand"
          className="choice-trigger device-fold-controls__stand-select"
          disabled={!inputReady}
          onChange={(event) =>
            choose(event.currentTarget.value as LiveSurfacePosture)
          }
          title="Stand"
          value={current ?? ''}
        >
          {current === null ? (
            <option disabled value="">
              {angle === null
                ? 'Between stands'
                : `Hinge ${Math.round(angle)}°`}
            </option>
          ) : null}
          {fold.postures.map((posture) => (
            <option key={posture} value={posture}>
              {POSTURE_LABEL[posture]}
            </option>
          ))}
        </select>
        <ArrowDownGlyph className="choice-caret device-fold-controls__stand-caret" />
      </span>
    );
  }
  return (
    <div
      aria-label="Stand"
      className="device-fold-controls__stands"
      role="radiogroup"
    >
      {fold.postures.map((posture) => {
        const checked = current === posture;
        return (
          <Button
            aria-checked={checked}
            className="device-fold-controls__stand"
            disabled={!inputReady}
            key={posture}
            onClick={() => choose(posture)}
            role="radio"
            size="sm"
            title={POSTURE_LABEL[posture]}
            variant={checked ? 'secondary' : 'ghost'}
          >
            <PostureGlyph posture={posture} />
            <span className="device-fold-controls__stand-label">
              {POSTURE_LABEL[posture]}
            </span>
          </Button>
        );
      })}
    </div>
  );
}

/** The hinge, table mode, face up/down and how the display is drawn. */
export function DeviceFoldSettings({
  fold,
  previewAngle,
  onPreviewAngle,
  sendInput,
  inputReady,
  bent,
  onBent,
  turnToFit,
  onTurnToFit,
  turnToFitOffered,
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
    <>
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
        <label className="device-fold-controls__toggle">
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
      {fold.facingControl ? (
        // Actions, not a toggle: the device does not report which way it faces.
        <div className="device-fold-controls__facing">
          {(['up', 'down'] as const).map((facing) => (
            <Button
              disabled={!inputReady}
              key={facing}
              onClick={() => sendInput([{ kind: 'fold', facing }])}
              size="sm"
              variant="ghost"
            >
              {facing === 'up' ? 'Lay face up' : 'Lay face down'}
            </Button>
          ))}
        </div>
      ) : null}
      {/* How THIS viewer draws the display; nothing is sent to the device. */}
      <label className="device-fold-controls__toggle">
        <input
          checked={bent}
          onChange={(event) => onBent(event.currentTarget.checked)}
          type="checkbox"
        />
        3D view
      </label>
      {turnToFitOffered ? (
        <label className="device-fold-controls__toggle">
          <input
            checked={turnToFit}
            onChange={(event) => onTurnToFit(event.currentTarget.checked)}
            type="checkbox"
          />
          Rotate picture to fit
        </label>
      ) : null}
    </>
  );
}

/** The stands and the settings together (the Device pane's fold row). */
export function DeviceFoldControls(props: DeviceFoldControlsProps): ReactNode {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsId = useId();
  if (!props.fold) return null;
  if (props.compact)
    return (
      <fieldset
        aria-label="Fold"
        className="device-fold-controls device-fold-controls--compact"
        data-testid="device-fold-controls"
      >
        <DevicePostureControl {...props} compact />
        <Button
          aria-controls={settingsId}
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((open) => !open)}
          size="sm"
          variant="ghost"
        >
          Fold settings
        </Button>
        {settingsOpen ? (
          <div className="device-fold-controls__settings" id={settingsId}>
            <DeviceFoldSettings {...props} />
          </div>
        ) : null}
      </fieldset>
    );
  return (
    <fieldset
      aria-label="Fold"
      className="device-fold-controls"
      data-testid="device-fold-controls"
    >
      <DevicePostureControl {...props} />
      <DeviceFoldSettings {...props} />
    </fieldset>
  );
}
