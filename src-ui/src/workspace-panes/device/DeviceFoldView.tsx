import type {
  LiveSurfaceFold,
  LiveSurfaceInput,
} from '@kontourai/station-contracts/live-surface';
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useDeviceSettings } from '../../contexts/DeviceSettingsContext';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import type {
  LiveSurfaceProjection,
  LiveSurfaceProjectionSource,
} from '../../live-surface/LiveSurfaceCanvas';
import {
  type FoldPresentation,
  flattened,
  foldFitScale,
  foldPerspective,
  foldPresentation,
  unprojectFoldPoint,
  unturnQuarter,
} from './deviceFold';
import './DeviceFold.css';

/**
 * A foldable device's lit display drawn bent at its hinge (#1970 foldables).
 *
 * INTEGRATION POINT for every host of the shared live-surface viewer that
 * shows a device (the Device pane, its full-screen view, the float over
 * chat): `useDeviceFold` turns the surface's reported `fold` into a
 * `projection` for `LiveSurfaceCanvas` plus the state `DeviceFoldControls`
 * needs. A host:
 *   1. calls `useDeviceFold()` once;
 *   2. passes `fold.reportStatus` as the canvas `onProducerStatus` (it keeps
 *      reporting in full screen, where `renderHeader` is not mounted);
 *   3. passes `fold.projection` as the canvas `projection` (fit mode);
 *   4. renders `<DeviceFoldControls {...fold.controls} />` in its controls,
 *      including the full-screen bar's `renderImmersiveActions`.
 */

export interface DeviceFoldState {
  /** The device's fold, as last reported; undefined for a phone that does not fold. */
  fold: LiveSurfaceFold | undefined;
  /** Report the stream's current fold state (idempotent). */
  report: (fold: LiveSurfaceFold | undefined) => void;
  /** `report` for a canvas's `onProducerStatus`. */
  reportStatus: (status: { fold?: LiveSurfaceFold }) => void;
  /** Undefined unless the device folds, so a flat phone is untouched. */
  projection: LiveSurfaceProjection | undefined;
  /** Props for `DeviceFoldControls` (add `sendInput` and `inputReady`). */
  controls: DeviceFoldViewControls;
}

/** What the fold controls need from `useDeviceFold`. */
export interface DeviceFoldViewControls {
  fold: LiveSurfaceFold | undefined;
  previewAngle: number | null;
  onPreviewAngle: (angle: number | null) => void;
  /** Draw the display bent in 3D (a viewer preference; default flat). */
  bent: boolean;
  onBent: (bent: boolean) => void;
  /** Turn a landscape display a quarter to fill a portrait screen. */
  turnToFit: boolean;
  onTurnToFit: (turn: boolean) => void;
  /** The screen is portrait, so turning a landscape display can help. */
  turnToFitOffered: boolean;
}

/**
 * A fold-view preference kept on this device in the device-settings registry
 * (never sent to the surface).
 */
function useFoldViewSetting(
  key: 'deviceFoldBentView' | 'deviceFoldTurnToFit',
): [boolean, (value: boolean) => void] {
  const value = useDeviceSettings()[key];
  const store = useCallback(
    (next: boolean) => deviceSettingsStore.set(key, next),
    [key],
  );
  return [value, store];
}

const PORTRAIT_QUERY = '(orientation: portrait)';

function usePortraitViewport(): boolean {
  const read = () =>
    typeof window !== 'undefined' &&
    Boolean(window.matchMedia) &&
    window.matchMedia(PORTRAIT_QUERY).matches;
  const [portrait, setPortrait] = useState(read);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const media = window.matchMedia(PORTRAIT_QUERY);
    const onChange = () => setPortrait(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return portrait;
}

export function useDeviceFold(): DeviceFoldState {
  const [fold, setFold] = useState<LiveSurfaceFold | undefined>(undefined);
  const [previewAngle, setPreviewAngle] = useState<number | null>(null);
  const report = useCallback((next: LiveSurfaceFold | undefined) => {
    setFold((previous) =>
      JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
    );
  }, []);
  // A preview ends when the device reports the angle it was dragged to
  // (or any change of stand): from then the device's own state is shown.
  const reportedAngle = fold?.hingeAngle ?? null;
  const reportedPosture = fold?.posture ?? null;
  const previewFrom = useRef<{
    angle: number | null;
    posture: unknown;
  } | null>(null);
  useEffect(() => {
    const from = previewFrom.current;
    if (
      from &&
      (from.angle !== reportedAngle || from.posture !== reportedPosture)
    ) {
      previewFrom.current = null;
      setPreviewAngle(null);
    }
  }, [reportedAngle, reportedPosture]);
  const onPreviewAngle = useCallback(
    (angle: number | null) => {
      previewFrom.current =
        angle === null
          ? null
          : { angle: reportedAngle, posture: reportedPosture };
      setPreviewAngle(angle);
    },
    [reportedAngle, reportedPosture],
  );
  const [bent, onBent] = useFoldViewSetting('deviceFoldBentView');
  const [turnToFit, onTurnToFit] = useFoldViewSetting('deviceFoldTurnToFit');
  const portrait = usePortraitViewport();
  const reportStatus = useCallback(
    (status: { fold?: LiveSurfaceFold }) => report(status.fold),
    [report],
  );
  const projection = useMemo<LiveSurfaceProjection | undefined>(() => {
    if (!fold) return undefined;
    const present = (shown: { width: number; height: number }) => {
      const presentation = foldPresentation(fold, shown, previewAngle);
      return bent ? presentation : flattened(presentation);
    };
    /** A landscape display on a portrait screen, turned a quarter to fit. */
    const turned = (shown: { width: number; height: number }) =>
      turnToFit && portrait && shown.width > shown.height;
    return {
      fitAspect(shown) {
        return turned(shown)
          ? shown.height / shown.width
          : shown.width / shown.height;
      },
      toFrame(client, box, shown) {
        if (box.width <= 0 || box.height <= 0) return null;
        let point = { x: client.x - box.left, y: client.y - box.top };
        let drawing = { width: box.width, height: box.height };
        if (turned(shown)) {
          point = unturnQuarter(point, drawing);
          drawing = { width: box.height, height: box.width };
        }
        const flat = unprojectFoldPoint(point, drawing, present(shown));
        if (!flat) return null;
        return {
          x: (flat.x * shown.width) / drawing.width,
          y: (flat.y * shown.height) / drawing.height,
        };
      },
      render(source) {
        return (
          <DeviceFoldView
            presentation={present(source.shown)}
            quarterTurn={turned(source.shown)}
            source={source}
          />
        );
      },
    };
  }, [fold, previewAngle, bent, turnToFit, portrait]);
  return {
    fold,
    report,
    reportStatus,
    projection,
    controls: {
      fold,
      previewAngle,
      onPreviewAngle,
      bent,
      onBent,
      turnToFit,
      onTurnToFit,
      turnToFitOffered: portrait && fold?.activeDisplay === 'inner',
    },
  };
}

/** Each half's CSS turn about the crease (see `deviceFold.ts` for the signs). */
function halfTransform(
  presentation: FoldPresentation,
  half: 0 | 1,
): CSSProperties {
  const turn = presentation.turns[half];
  if (presentation.crease === 'vertical')
    return {
      transform: `rotateY(${half === 0 ? turn : -turn}deg)`,
      transformOrigin: half === 0 ? 'right center' : 'left center',
    };
  return {
    transform: `rotateX(${half === 0 ? -turn : turn}deg)`,
    transformOrigin: half === 0 ? 'center bottom' : 'center top',
  };
}

/** A half turned away from the light reads darker, which sells the bend. */
function halfShade(turn: number): number {
  return 1 - Math.min(0.3, Math.abs(turn) / 300);
}

export function DeviceFoldView({
  presentation,
  source,
  quarterTurn = false,
}: {
  presentation: FoldPresentation;
  source: LiveSurfaceProjectionSource;
  /** Drawn turned a quarter clockwise inside its (portrait) box. */
  quarterTurn?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const halvesRef = useRef<
    [HTMLCanvasElement | null, HTMLCanvasElement | null]
  >([null, null]);
  const [outer, setBox] = useState({ width: 0, height: 0 });
  /** The unturned drawing's box: the outer box, sides swapped when turned. */
  const box = quarterTurn
    ? { width: outer.height, height: outer.width }
    : outer;
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      setBox((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const { crease } = presentation;
  const { canvas } = source;
  const copy = useCallback(() => {
    if (!canvas) return;
    const { width, height } = canvas;
    const halves = halvesRef.current;
    const pieces: [number, number, number, number][] = !crease
      ? [[0, 0, width, height]]
      : crease === 'vertical'
        ? [
            [0, 0, Math.floor(width / 2), height],
            [Math.floor(width / 2), 0, width - Math.floor(width / 2), height],
          ]
        : [
            [0, 0, width, Math.floor(height / 2)],
            [0, Math.floor(height / 2), width, height - Math.floor(height / 2)],
          ];
    pieces.forEach(([sx, sy, sw, sh], index) => {
      const target = halves[index];
      if (!target || sw <= 0 || sh <= 0) return;
      if (target.width !== sw) target.width = sw;
      if (target.height !== sh) target.height = sh;
      const context = target.getContext('2d');
      context?.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    });
  }, [canvas, crease]);
  useEffect(() => {
    copy();
    return source.subscribe(copy);
  }, [copy, source.subscribe]);

  const flat = !crease;
  return (
    <div
      className={`device-fold${flat ? ' device-fold--flat' : ` device-fold--${crease}`}`}
      data-crease={crease ?? 'none'}
      data-testid="device-fold-view"
      ref={containerRef}
    >
      <div
        className="device-fold__turn"
        data-quarter-turn={quarterTurn ? '' : undefined}
        style={
          quarterTurn
            ? {
                width: `${box.width}px`,
                height: `${box.height}px`,
                left: `${(outer.width - box.width) / 2}px`,
                top: `${(outer.height - box.height) / 2}px`,
                transform: 'rotate(90deg)',
              }
            : undefined
        }
      >
        <div
          className="device-fold__bend"
          style={
            flat
              ? undefined
              : {
                  perspective: `${foldPerspective(box)}px`,
                  transform: `scale(${foldFitScale(box, presentation)})`,
                }
          }
        >
          {flat ? (
            <canvas
              className="device-fold__half device-fold__half--whole"
              ref={(element) => {
                halvesRef.current[0] = element;
              }}
            />
          ) : (
            ([0, 1] as const).map((half) => (
              <canvas
                className={`device-fold__half device-fold__half--${half === 0 ? 'first' : 'second'}`}
                data-turn={presentation.turns[half]}
                key={half}
                ref={(element) => {
                  halvesRef.current[half] = element;
                }}
                style={{
                  ...halfTransform(presentation, half),
                  filter: `brightness(${halfShade(presentation.turns[half])})`,
                }}
              />
            ))
          )}
          {flat ? null : (
            <div aria-hidden="true" className="device-fold__crease" />
          )}
        </div>
      </div>
    </div>
  );
}

/** The fold input a stand button sends. */
export function postureInput(
  posture: LiveSurfaceFold['postures'][number],
): LiveSurfaceInput {
  return { kind: 'fold', posture };
}
