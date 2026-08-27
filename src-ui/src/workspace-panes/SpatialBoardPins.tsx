import type {
  SpatialBoard,
  SpatialBoardPin,
  SpatialBoardResolvedPin,
  WorkReference,
} from '@kontourai/station-contracts';
import {
  useRemoveSpatialBoardPinMutation,
  useReplaceSpatialBoardPinMutation,
} from '@kontourai/station-sdk/spatial-board';
import { Badge } from '@kontourai/ui/react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { useRef, useState } from 'react';
import { Button } from '../components/Button';
import { BoardMutationError } from './SpatialBoardControls';
import { spatialBoardCardBounds } from './spatial-board-geometry';
import {
  PIN_STATE_COPY,
  PIN_STATE_TONE,
  referenceKindLabel,
  referenceLabel,
} from './spatial-board-types';

const WORK_BOARD_PERFORMANCE_BUILD_ENABLED =
  import.meta.env.VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE === '1';

export function PinResolution({
  resolution,
  reference,
  allowNavigation = true,
}: {
  resolution?: SpatialBoardResolvedPin;
  reference: WorkReference;
  allowNavigation?: boolean;
}) {
  const state = resolution?.state ?? 'NOT_VERIFIED';
  const title = resolution?.title ?? referenceLabel(reference);
  return (
    <div className="spatial-board__pin-content">
      <div className="spatial-board__pin-eyebrow">
        <span aria-hidden="true">◇</span>
        <span>{referenceKindLabel(reference)}</span>
        <span title={PIN_STATE_COPY[state].detail}>
          <Badge
            value={PIN_STATE_COPY[state].label}
            tone={PIN_STATE_TONE[state]}
          />
        </span>
      </div>
      {allowNavigation && resolution?.href ? (
        <a className="spatial-board__pin-title" href={resolution.href}>
          {title}
        </a>
      ) : (
        <strong className="spatial-board__pin-title">{title}</strong>
      )}
      <code title={referenceLabel(reference)}>{referenceLabel(reference)}</code>
    </div>
  );
}

type Drag = {
  pointerId: number;
  startX: number;
  startY: number;
  pin: SpatialBoardPin;
  mode: 'move' | 'resize';
};
const minWidth = 152;
const minHeight = 240;

/** Local preview only. A single revisioned CAS write happens on pointer-up. */
export function SpatialPin({
  board,
  pin,
  resolution,
}: {
  board: SpatialBoard;
  pin: SpatialBoardPin;
  resolution?: SpatialBoardResolvedPin;
}) {
  const replace = useReplaceSpatialBoardPinMutation();
  const remove = useRemoveSpatialBoardPinMutation();
  const [preview, setPreview] = useState<SpatialBoardPin | null>(null);
  const [selected, setSelected] = useState(false);
  const latestPreview = useRef<SpatialBoardPin | null>(null);
  const drag = useRef<Drag | null>(null);
  const displayed = preview ?? pin;
  const cardBounds = spatialBoardCardBounds(displayed);
  const active = selected || drag.current !== null;
  const change = (next: SpatialBoardPin) =>
    replace.mutate({ expectedRevision: board.revision, pin: next });
  const begin = (event: PointerEvent<HTMLElement>, mode: Drag['mode']) => {
    if (replace.isPending || remove.isPending || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      pin,
      mode,
    };
    latestPreview.current = pin;
    setPreview(pin);
  };
  const movePointer = (event: PointerEvent<HTMLElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const dx = event.clientX - active.startX;
    const dy = event.clientY - active.startY;
    const zoom = Math.max(Number.EPSILON, board.camera.zoom);
    const next =
      active.mode === 'move'
        ? {
            ...active.pin,
            x: active.pin.x + dx / zoom,
            y: active.pin.y + dy / zoom,
          }
        : {
            ...active.pin,
            width: Math.max(minWidth, active.pin.width + dx / zoom),
            height: Math.max(minHeight, active.pin.height + dy / zoom),
          };
    latestPreview.current = next;
    setPreview(next);
  };
  const finish = (event: PointerEvent<HTMLElement>, commit: boolean) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const next = latestPreview.current;
    drag.current = null;
    latestPreview.current = null;
    setPreview(null);
    if (commit && next && JSON.stringify(next) !== JSON.stringify(active.pin))
      change(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      replace.isPending ||
      remove.isPending ||
      !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
    )
      return;
    event.preventDefault();
    const delta = event.shiftKey ? 20 : 10;
    if (event.shiftKey) {
      change({
        ...pin,
        width: Math.max(
          minWidth,
          pin.width +
            (event.key === 'ArrowRight'
              ? delta
              : event.key === 'ArrowLeft'
                ? -delta
                : 0),
        ),
        height: Math.max(
          minHeight,
          pin.height +
            (event.key === 'ArrowDown'
              ? delta
              : event.key === 'ArrowUp'
                ? -delta
                : 0),
        ),
      });
      return;
    }
    change({
      ...pin,
      x:
        pin.x +
        (event.key === 'ArrowRight'
          ? delta
          : event.key === 'ArrowLeft'
            ? -delta
            : 0),
      y:
        pin.y +
        (event.key === 'ArrowDown'
          ? delta
          : event.key === 'ArrowUp'
            ? -delta
            : 0),
    });
  };
  return (
    <article
      className={`spatial-board__pin ${active ? 'spatial-board__pin--selected' : ''}`}
      aria-label={`${referenceKindLabel(pin.reference)} pin ${referenceLabel(pin.reference)}`}
      style={{
        left: displayed.x,
        top: displayed.y,
        width: cardBounds.width,
        height: cardBounds.height,
        zIndex: active ? 10_000 : displayed.order + 1,
      }}
    >
      <header className="spatial-board__pin-header">
        <button
          type="button"
          className="spatial-board__move"
          {...(WORK_BOARD_PERFORMANCE_BUILD_ENABLED
            ? { 'data-station-work-board-listener': true }
            : {})}
          disabled={replace.isPending || remove.isPending}
          aria-label={`Move ${referenceLabel(pin.reference)}. Arrow keys move; Shift plus Arrow keys resize.`}
          onFocus={() => setSelected(true)}
          onBlur={() => setSelected(false)}
          onKeyDown={onKeyDown}
          onPointerDown={(event) => begin(event, 'move')}
          onPointerMove={movePointer}
          onPointerUp={(event) => finish(event, true)}
          onPointerCancel={(event) => finish(event, false)}
          onLostPointerCapture={(event) => finish(event, false)}
        >
          Drag
        </button>
      </header>
      <div className="spatial-board__pin-main">
        <PinResolution resolution={resolution} reference={pin.reference} />
      </div>
      <footer className="spatial-board__pin-actions">
        <button
          type="button"
          className="spatial-board__resize"
          {...(WORK_BOARD_PERFORMANCE_BUILD_ENABLED
            ? { 'data-station-work-board-listener': true }
            : {})}
          disabled={replace.isPending || remove.isPending}
          aria-label={`Resize ${referenceLabel(pin.reference)}`}
          onFocus={() => setSelected(true)}
          onBlur={() => setSelected(false)}
          onPointerDown={(event) => begin(event, 'resize')}
          onPointerMove={movePointer}
          onPointerUp={(event) => finish(event, true)}
          onPointerCancel={(event) => finish(event, false)}
          onLostPointerCapture={(event) => finish(event, false)}
        >
          Resize
        </button>
        <Button
          size="sm"
          disabled={replace.isPending || remove.isPending}
          aria-label={`Remove ${referenceLabel(pin.reference)} from canvas`}
          onClick={() =>
            remove.mutate({ expectedRevision: board.revision, pinId: pin.id })
          }
        >
          Remove
        </Button>
      </footer>
      {replace.error || remove.error ? (
        <p className="spatial-board__mutation-error" role="alert">
          The Board change could not be confirmed. Refresh the Board before
          deciding whether to try again.
        </p>
      ) : null}
    </article>
  );
}

export function OrderedPin({
  board,
  pin,
  resolution,
}: {
  board: SpatialBoard;
  pin: SpatialBoardPin;
  resolution?: SpatialBoardResolvedPin;
}) {
  const remove = useRemoveSpatialBoardPinMutation();
  return (
    <li className="spatial-board__ordered-pin">
      <div className="spatial-board__ordered-content">
        <PinResolution resolution={resolution} reference={pin.reference} />
      </div>
      <Button
        size="sm"
        pending={remove.isPending}
        aria-label={`Remove ${referenceLabel(pin.reference)} from ordered list`}
        onClick={() =>
          remove.mutate({ expectedRevision: board.revision, pinId: pin.id })
        }
      >
        Remove
      </Button>
      <BoardMutationError error={remove.error} />
    </li>
  );
}
