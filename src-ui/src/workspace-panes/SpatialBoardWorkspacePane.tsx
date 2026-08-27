import {
  useResolvedSpatialBoardQuery,
  useSpatialBoardQuery,
  useUndoSpatialBoardMutation,
} from '@kontourai/station-sdk/spatial-board';
import { useMemo, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { LazyBoundary } from '../components/LazyBoundary';
import { Empty, ErrorState, SkeletonBlock } from '../components/state';
import type { BuiltinWorkspacePaneProps } from './builtinWorkspacePaneRegistry';
import { SpatialBoardCanvas } from './SpatialBoardCanvas';
import {
  AddPinForm,
  BoardMutationError,
  BoardTitleEditor,
  CameraControls,
  CleanupMissingPins,
} from './SpatialBoardControls';
import { OrderedPin } from './SpatialBoardPins';
import './SpatialBoardWorkspacePane.css';

const WORK_BOARD_PERFORMANCE_BUILD_ENABLED =
  import.meta.env.VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE === '1';
const loadWorkBoardPerformanceInstrumentation =
  WORK_BOARD_PERFORMANCE_BUILD_ENABLED
    ? async () => {
        const module = await import(
          '../performance/WorkBoardPerformanceInstrumentation'
        );
        return { default: module.WorkBoardPerformanceInstrumentation };
      }
    : null;

/** Stable Pane interface: data observation and composition only. */
export function SpatialBoardWorkspacePane({
  instance,
}: BuiltinWorkspacePaneProps) {
  const projectId = instance.boundContext?.projectId;
  const board = useSpatialBoardQuery();
  const resolved = useResolvedSpatialBoardQuery();
  const undo = useUndoSpatialBoardMutation();
  const rootRef = useRef<HTMLElement | null>(null);
  const addKindRef = useRef<HTMLSelectElement | null>(null);
  const [addOpen, setAddOpen] = useState(true);
  const [canvasVisible, setCanvasVisible] = useState(false);
  const pins = useMemo(
    () => [...(board.data?.pins ?? [])].sort((a, b) => a.order - b.order),
    [board.data?.pins],
  );
  const resolution = useMemo(() => {
    const projection = resolved.data;
    return new Map(
      (projection && projection.revision === board.data?.revision
        ? projection.pins
        : []
      ).map((pin) => [pin.pinId, pin]),
    );
  }, [board.data?.revision, resolved.data]);
  const missing = useMemo(
    () =>
      pins
        .filter((pin) => resolution.get(pin.id)?.state === 'missing')
        .map((pin) => pin.reference),
    [pins, resolution],
  );
  const refresh = () => {
    void board.refetch();
    void resolved.refetch();
  };
  const focusAddPin = () => {
    setAddOpen(true);
    addKindRef.current?.focus();
  };
  if (!projectId)
    return (
      <ErrorState
        title="Work Board is unavailable"
        description="This Pane has no exact Project host identity."
      />
    );
  if (board.isLoading)
    return <SkeletonBlock count={3} label="Loading Work Board" />;
  if (board.isError || !board.data)
    return (
      <ErrorState
        title="Could not load Work Board"
        description="The personal board store is unavailable or could not be verified."
        action={<Button onClick={refresh}>Retry</Button>}
      />
    );
  return (
    <section
      className="spatial-board"
      data-canvas-visible={canvasVisible}
      aria-label="Personal Work Board"
      ref={rootRef}
    >
      {loadWorkBoardPerformanceInstrumentation ? (
        <LazyBoundary
          load={loadWorkBoardPerformanceInstrumentation}
          componentProps={{ rootRef }}
          pending={null}
        />
      ) : null}
      <header className="spatial-board__header">
        <div className="spatial-board__identity">
          <h2>{board.data.title}</h2>
          <p>Personal layout · revision {board.data.revision}</p>
        </div>
        <section
          className="spatial-board__control-group"
          aria-label="Board identity"
        >
          <BoardTitleEditor board={board.data} />
        </section>
        <section
          className="spatial-board__control-group"
          aria-label="Canvas camera"
        >
          <CameraControls board={board.data} />
        </section>
        <section
          className="spatial-board__control-group spatial-board__maintenance"
          aria-label="Board maintenance"
        >
          <CleanupMissingPins board={board.data} missingReferences={missing} />
          <Button size="sm" onClick={refresh}>
            Refresh Board
          </Button>
          <Button
            size="sm"
            disabled={!board.data.undo || undo.isPending}
            onClick={() =>
              undo.mutate({ expectedRevision: board.data.revision })
            }
          >
            Undo
          </Button>
        </section>
      </header>
      {resolved.isLoading ? (
        <p className="spatial-board__resolution-status" role="status">
          Resolving pinned work…
        </p>
      ) : null}
      {resolved.isError ? (
        <div className="spatial-board__resolution-status" role="alert">
          <span>
            Couldn’t resolve pinned work. Existing pin identities are unchanged.
          </span>
          <Button size="sm" onClick={refresh}>
            Retry resolution
          </Button>
        </div>
      ) : null}
      <BoardMutationError error={undo.error} />
      <AddPinForm
        board={board.data}
        open={addOpen}
        onOpenChange={setAddOpen}
        initialFieldRef={addKindRef}
      />
      {pins.length === 0 ? (
        <div className="spatial-board__first-pin">
          <Empty label="Pin work to arrange it here." />
          <Button variant="primary" onClick={focusAddPin}>
            Add a pin
          </Button>
        </div>
      ) : (
        <div className="spatial-board__body">
          <div className="spatial-board__canvas-toggle">
            <Button
              size="sm"
              aria-expanded={canvasVisible}
              aria-controls="spatial-board-canvas"
              onClick={() => setCanvasVisible((visible) => !visible)}
            >
              {canvasVisible ? 'Hide canvas' : 'Open canvas'}
            </Button>
          </div>
          <SpatialBoardCanvas
            board={board.data}
            pins={pins}
            resolution={resolution}
          />
          <ol
            className="spatial-board__ordered"
            aria-label="Pinned work in order"
          >
            {pins.map((pin) => (
              <OrderedPin
                board={board.data}
                pin={pin}
                resolution={resolution.get(pin.id)}
                key={pin.id}
              />
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
