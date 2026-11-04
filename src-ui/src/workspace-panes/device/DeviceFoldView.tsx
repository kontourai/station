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
import type {
  LiveSurfaceProjection,
  LiveSurfaceProjectionSource,
} from '../../live-surface/LiveSurfaceCanvas';
import {
  type FoldPresentation,
  foldPerspective,
  foldPresentation,
  unprojectFoldPoint,
} from './deviceFold';
import './DeviceFold.css';

/**
 * A foldable device's lit display drawn bent at its hinge (#1970 foldables).
 *
 * INTEGRATION POINT for any host of the shared live-surface viewer (the
 * Device pane today; the immersive/fullscreen viewer and the float-over-chat
 * when they host a device): `useDeviceFold` turns the surface's reported
 * `fold` into a `projection` for `LiveSurfaceCanvas` plus the state
 * `DeviceFoldControls` needs. A host:
 *   1. calls `useDeviceFold()` once;
 *   2. reports the stream's fold: `fold.report(api.surface.producerStatus.fold)`
 *      from its `renderHeader` (or wherever it reads producer status);
 *   3. passes `fold.projection` as the canvas `projection` (fit mode);
 *   4. renders `<DeviceFoldControls {...fold.controls} />` in its controls.
 */

export interface DeviceFoldState {
  /** The device's fold, as last reported; undefined for a phone that does not fold. */
  fold: LiveSurfaceFold | undefined;
  /** Report the stream's current fold state (idempotent). */
  report: (fold: LiveSurfaceFold | undefined) => void;
  /** Undefined unless the device folds, so a flat phone is untouched. */
  projection: LiveSurfaceProjection | undefined;
  /** Props for `DeviceFoldControls` (add `sendInput` and `inputReady`). */
  controls: {
    fold: LiveSurfaceFold | undefined;
    previewAngle: number | null;
    onPreviewAngle: (angle: number | null) => void;
  };
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
  const projection = useMemo<LiveSurfaceProjection | undefined>(() => {
    if (!fold) return undefined;
    return {
      toFrame(client, box, shown) {
        const presentation = foldPresentation(fold, shown, previewAngle);
        const flat = unprojectFoldPoint(
          { x: client.x - box.left, y: client.y - box.top },
          box,
          presentation,
        );
        if (!flat || box.width <= 0 || box.height <= 0) return null;
        return {
          x: (flat.x * shown.width) / box.width,
          y: (flat.y * shown.height) / box.height,
        };
      },
      render(source) {
        return (
          <DeviceFoldView
            presentation={foldPresentation(fold, source.shown, previewAngle)}
            source={source}
          />
        );
      },
    };
  }, [fold, previewAngle]);
  return {
    fold,
    report,
    projection,
    controls: { fold, previewAngle, onPreviewAngle },
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
  return 1 - Math.min(0.45, Math.abs(turn) / 200);
}

export function DeviceFoldView({
  presentation,
  source,
}: {
  presentation: FoldPresentation;
  source: LiveSurfaceProjectionSource;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const halvesRef = useRef<
    [HTMLCanvasElement | null, HTMLCanvasElement | null]
  >([null, null]);
  const [box, setBox] = useState({ width: 0, height: 0 });
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
      style={flat ? undefined : { perspective: `${foldPerspective(box)}px` }}
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
      {flat ? null : <div aria-hidden="true" className="device-fold__crease" />}
    </div>
  );
}

/** The fold input a stand button sends. */
export function postureInput(
  posture: LiveSurfaceFold['postures'][number],
): LiveSurfaceInput {
  return { kind: 'fold', posture };
}
