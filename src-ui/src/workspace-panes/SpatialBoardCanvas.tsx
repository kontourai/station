import type {
  SpatialBoard,
  SpatialBoardResolvedPin,
} from '@kontourai/station-contracts';
import { useSetSpatialBoardCameraMutation } from '@kontourai/station-sdk/spatial-board';
import type { PointerEvent } from 'react';
import { useMemo, useRef, useState } from 'react';
import { BoardMutationError } from './SpatialBoardControls';
import { SpatialPin } from './SpatialBoardPins';
import {
  boundSpatialBoardCamera,
  spatialBoardPlaneGeometry,
} from './spatial-board-geometry';

const WORK_BOARD_PERFORMANCE_BUILD_ENABLED =
  import.meta.env.VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE === '1';

type Pan = { pointerId: number; x: number; y: number };

function isCanvasBackground(
  target: EventTarget | null,
  currentTarget: EventTarget,
) {
  return (
    target === currentTarget ||
    (target instanceof HTMLElement &&
      target.classList.contains('spatial-board__plane'))
  );
}

/** Camera panning follows the same preview/commit rule as pin interactions. */
export function SpatialBoardCanvas({
  board,
  pins,
  resolution,
}: {
  board: SpatialBoard;
  pins: readonly SpatialBoard['pins'][number][];
  resolution: ReadonlyMap<string, SpatialBoardResolvedPin>;
}) {
  const camera = useSetSpatialBoardCameraMutation();
  const [preview, setPreview] = useState<SpatialBoard['camera'] | null>(null);
  const latestPreview = useRef<SpatialBoard['camera'] | null>(null);
  const pan = useRef<Pan | null>(null);
  const plane = useMemo(() => spatialBoardPlaneGeometry(pins), [pins]);
  const displayed = preview ?? board.camera;
  const begin = (event: PointerEvent<HTMLElement>) => {
    if (
      !isCanvasBackground(event.target, event.currentTarget) ||
      event.button !== 0 ||
      camera.isPending
    )
      return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pan.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    latestPreview.current = board.camera;
    setPreview(board.camera);
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const active = pan.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const next = boundSpatialBoardCamera(
      {
        ...board.camera,
        x: board.camera.x + event.clientX - active.x,
        y: board.camera.y + event.clientY - active.y,
      },
      plane,
    );
    latestPreview.current = next;
    setPreview(next);
  };
  const finish = (event: PointerEvent<HTMLElement>, commit: boolean) => {
    const active = pan.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const next = latestPreview.current;
    pan.current = null;
    latestPreview.current = null;
    setPreview(null);
    if (
      commit &&
      next &&
      (next.x !== board.camera.x || next.y !== board.camera.y)
    )
      camera.mutate({ expectedRevision: board.revision, camera: next });
  };
  return (
    <section
      className="spatial-board__canvas"
      id="spatial-board-canvas"
      aria-label="Spatial canvas"
      {...(WORK_BOARD_PERFORMANCE_BUILD_ENABLED
        ? { 'data-station-work-board-listener': true }
        : {})}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={(event) => finish(event, true)}
      onPointerCancel={(event) => finish(event, false)}
      onLostPointerCapture={(event) => finish(event, false)}
    >
      <div
        className="spatial-board__plane"
        style={{
          transform: `translate(${displayed.x}px, ${displayed.y}px) scale(${displayed.zoom})`,
          transformOrigin: 'top left',
          width: plane.width,
          height: plane.height,
        }}
      >
        {pins.map((pin) => (
          <SpatialPin
            board={board}
            pin={pin}
            resolution={resolution.get(pin.id)}
            key={pin.id}
          />
        ))}
      </div>
      <BoardMutationError error={camera.error} />
    </section>
  );
}
