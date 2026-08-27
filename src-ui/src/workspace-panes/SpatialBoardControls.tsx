import type {
  SpatialBoard,
  SpatialBoardPin,
  WorkReference,
} from '@kontourai/station-contracts';
import {
  useCleanupSpatialBoardPinsMutation,
  useCreateSpatialBoardPinMutation,
  useSetSpatialBoardCameraMutation,
  useSetSpatialBoardTitleMutation,
} from '@kontourai/station-sdk/spatial-board';
import type { FormEvent, RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../components/Button';

export function BoardMutationError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="spatial-board__mutation-error" role="alert">
      The Board change could not be confirmed. Refresh the Board before trying
      again.
    </p>
  );
}

export function BoardTitleEditor({ board }: { board: SpatialBoard }) {
  const title = useSetSpatialBoardTitleMutation();
  const [value, setValue] = useState(board.title);
  const [editing, setEditing] = useState(false);
  const observedBoardTitle = useRef(board.title);
  useEffect(() => {
    if (observedBoardTitle.current === board.title) return;
    observedBoardTitle.current = board.title;
    if (!editing) setValue(board.title);
  }, [board.title, editing]);
  return (
    <form
      className="spatial-board__title"
      onSubmit={(event) => {
        event.preventDefault();
        const next = value.trim();
        if (next && next !== board.title)
          title.mutate({ expectedRevision: board.revision, title: next });
      }}
    >
      <label>
        Board title
        <input
          aria-label="Board title"
          value={value}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <Button size="sm" type="submit" pending={title.isPending}>
        Save title
      </Button>
      <BoardMutationError error={title.error} />
    </form>
  );
}

export function CameraControls({ board }: { board: SpatialBoard }) {
  const camera = useSetSpatialBoardCameraMutation();
  const set = (zoom: number, reset = false) =>
    camera.mutate({
      expectedRevision: board.revision,
      camera: reset
        ? { x: 0, y: 0, zoom: 1 }
        : { ...board.camera, zoom: Math.max(0.1, Math.min(8, zoom)) },
    });
  return (
    <fieldset className="spatial-board__camera">
      <legend>Canvas zoom</legend>
      <Button
        size="sm"
        pending={camera.isPending}
        aria-label="Zoom out"
        onClick={() => set(board.camera.zoom / 1.25)}
      >
        −
      </Button>
      <output aria-label="Zoom level">
        {Math.round(board.camera.zoom * 100)}%
      </output>
      <Button
        size="sm"
        pending={camera.isPending}
        aria-label="Zoom in"
        onClick={() => set(board.camera.zoom * 1.25)}
      >
        +
      </Button>
      <Button
        size="sm"
        pending={camera.isPending}
        aria-label="Reset canvas"
        onClick={() => set(1, true)}
      >
        Reset
      </Button>
      <BoardMutationError error={camera.error} />
    </fieldset>
  );
}

export function CleanupMissingPins({
  board,
  missingReferences,
}: {
  board: SpatialBoard;
  missingReferences: readonly WorkReference[];
}) {
  const cleanup = useCleanupSpatialBoardPinsMutation();
  if (!missingReferences.length) return null;
  return (
    <div className="spatial-board__cleanup">
      <Button
        size="sm"
        onClick={() =>
          cleanup.mutate({
            expectedRevision: board.revision,
            missingReferences,
          })
        }
        pending={cleanup.isPending}
        aria-label={`Remove ${missingReferences.length} confirmed missing pins`}
      >
        Remove missing ({missingReferences.length})
      </Button>
      <BoardMutationError error={cleanup.error} />
    </div>
  );
}

export function AddPinForm({
  board,
  open,
  onOpenChange,
  initialFieldRef,
}: {
  board: SpatialBoard;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialFieldRef?: RefObject<HTMLSelectElement | null>;
}) {
  const create = useCreateSpatialBoardPinMutation();
  const [kind, setKind] = useState<
    | 'project'
    | 'task'
    | 'session'
    | 'approval'
    | 'agent'
    | 'scheduler-receipt'
    | 'review-receipt'
    | 'flow-run'
    | 'artifact'
  >('task');
  const [id, setId] = useState('');
  const [scope, setScope] = useState('');
  const [gateId, setGateId] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = id.trim();
    if (!trimmed) return;
    const scoped = scope.trim();
    const reference: WorkReference | null =
      kind === 'task'
        ? scoped
          ? { kind, id: trimmed, projectId: scoped }
          : null
        : kind === 'scheduler-receipt'
          ? { kind: 'receipt', owner: 'scheduler-run', id: trimmed }
          : kind === 'review-receipt'
            ? scoped
              ? {
                  kind: 'receipt',
                  owner: 'independent-review',
                  id: trimmed,
                  projectSlug: scoped,
                }
              : null
            : kind === 'flow-run'
              ? scoped
                ? {
                    kind: 'run',
                    owner: 'flow',
                    id: trimmed,
                    projectId: scoped,
                    ...(gateId.trim() ? { gateId: gateId.trim() } : {}),
                  }
                : null
              : kind === 'artifact'
                ? scoped
                  ? {
                      kind: 'artifact',
                      owner: 'run-output',
                      id: trimmed,
                      runId: scoped,
                    }
                  : null
                : { kind, id: trimmed };
    if (!reference) return;
    const pin: SpatialBoardPin = {
      id: crypto.randomUUID(),
      reference,
      x: 24 + (board.pins.length % 4) * 220,
      y: 24 + Math.floor(board.pins.length / 4) * 280,
      width: 200,
      height: 240,
      order: board.pins.length,
    };
    create.mutate(
      { expectedRevision: board.revision, pin },
      { onSuccess: () => setId('') },
    );
  };
  return (
    <details
      className="spatial-board__add-disclosure"
      open={open}
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
    >
      <summary>Add a pin</summary>
      <form className="spatial-board__add" onSubmit={submit}>
        <label>
          Reference kind
          <select
            ref={initialFieldRef}
            value={kind}
            onChange={(event) => setKind(event.target.value as typeof kind)}
          >
            <option value="task">Task</option>
            <option value="session">Session</option>
            <option value="project">Project</option>
            <option value="approval">Approval request</option>
            <option value="scheduler-receipt">Scheduled outcome</option>
            <option value="review-receipt">Receipt</option>
            <option value="flow-run">Gate or run</option>
            <option value="artifact">Artifact</option>
            <option value="agent">Agent</option>
          </select>
        </label>
        <label>
          Exact reference ID
          <input value={id} onChange={(event) => setId(event.target.value)} />
        </label>
        {['task', 'review-receipt', 'flow-run', 'artifact'].includes(kind) && (
          <label>
            {kind === 'task'
              ? 'Exact Task Project slug'
              : kind === 'flow-run'
                ? 'Exact Project ID'
                : kind === 'review-receipt'
                  ? 'Exact Project slug'
                  : 'Exact run ID'}
            <input
              value={scope}
              onChange={(event) => setScope(event.target.value)}
            />
          </label>
        )}
        {kind === 'flow-run' && (
          <label>
            Exact gate ID (optional)
            <input
              value={gateId}
              onChange={(event) => setGateId(event.target.value)}
            />
          </label>
        )}
        <Button type="submit" variant="primary" pending={create.isPending}>
          Pin work
        </Button>
        <BoardMutationError error={create.error} />
      </form>
    </details>
  );
}
