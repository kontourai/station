import type {
  TaskOutputRecord,
  TaskRecord,
} from '@kontourai/station-contracts';
import {
  downloadTaskOutputContent,
  useCreateTaskOutputMutation,
  useDeleteTaskOutputMutation,
  useTaskOutputsQuery,
} from '@kontourai/station-sdk/task-outputs';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import {
  ResponsiveDialogSurface,
  ResponsiveSurfaceActions,
} from '../../components/ResponsiveDialogSurface';
import { Empty, SkeletonBlock } from '../../components/state';
import { useApiBase } from '../../contexts/ApiBaseContext';

export interface TaskOutputPromotion {
  relativePath: string;
  title: string;
  operationId: string;
}

export function TaskOutputsSection({
  task,
  promotion,
  onPromotionSettled,
}: {
  task: TaskRecord;
  promotion: TaskOutputPromotion | null;
  onPromotionSettled: (
    promotion: TaskOutputPromotion,
    success: boolean,
  ) => void;
}) {
  const outputs = useTaskOutputsQuery(task.id);
  const create = useCreateTaskOutputMutation();
  const remove = useDeleteTaskOutputMutation();
  const [feedback, setFeedback] = useState<
    { kind: 'success' | 'error'; message: string } | undefined
  >();
  const [confirming, setConfirming] = useState<TaskOutputRecord | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const attempted = useRef<string | null>(null);
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const confirmationInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (confirming)
      requestAnimationFrame(() => confirmationInput.current?.focus());
  }, [confirming]);

  useEffect(() => {
    if (!promotion || attempted.current === promotion.operationId) return;
    attempted.current = promotion.operationId;
    setFeedback(undefined);
    create.mutate(
      {
        taskId: task.id,
        operationId: promotion.operationId,
        relativePath: promotion.relativePath,
        title: promotion.title,
      },
      {
        onSuccess: async () => {
          setFeedback({
            kind: 'success',
            message: `Kept “${promotion.title}” as an immutable Task output.`,
          });
          await outputs.refetch();
          onPromotionSettled(promotion, true);
          attempted.current = null;
        },
        onError: (error) => {
          setFeedback({
            kind: 'error',
            message: `Couldn’t keep “${promotion.title}” as an output: ${message(error, 'Try again with the same file.')}`,
          });
          onPromotionSettled(promotion, false);
          attempted.current = null;
        },
      },
    );
  }, [create, outputs, promotion, task.id, onPromotionSettled]);

  function closeConfirmation(returnFocus: boolean) {
    setConfirming(null);
    setConfirmation('');
    if (returnFocus)
      requestAnimationFrame(() => deleteTrigger.current?.focus());
  }

  function deleteOutput() {
    if (!confirming || remove.isPending || confirmation !== confirming.title)
      return;
    const output = confirming;
    remove.mutate(
      { taskId: task.id, outputId: output.id },
      {
        onSuccess: async () => {
          closeConfirmation(false);
          setFeedback({
            kind: 'success',
            message: `Deleted output “${output.title}”.`,
          });
          await outputs.refetch();
          requestAnimationFrame(() => heading.current?.focus());
        },
        onError: (error) =>
          setFeedback({
            kind: 'error',
            message: `Couldn’t delete “${output.title}”: ${message(error, 'Try again.')}`,
          }),
      },
    );
  }

  return (
    <section
      className="task-workspace__section task-outputs"
      aria-labelledby="task-outputs"
    >
      <div className="task-workspace__section-heading">
        <div>
          <h3
            id="task-outputs"
            className="task-workspace__section-title"
            ref={heading}
            tabIndex={-1}
          >
            Outputs
          </h3>
          <p>
            Keep an immutable snapshot from a safely inspected local file. The
            source can change or disappear afterward.
          </p>
        </div>
      </div>
      {feedback ? (
        <p
          className={`task-outputs__feedback task-outputs__feedback--${feedback.kind}`}
          role={feedback.kind === 'error' ? 'alert' : 'status'}
        >
          {feedback.message}
        </p>
      ) : null}
      {outputs.isLoading ? (
        <SkeletonBlock count={2} label="Loading Task outputs" />
      ) : outputs.error ? (
        <div className="task-outputs__query-error" role="alert">
          <p>
            Couldn’t load Task outputs: {message(outputs.error, 'Try again.')}
          </p>
          <Button size="sm" onClick={() => void outputs.refetch()}>
            Retry outputs
          </Button>
        </div>
      ) : outputs.data?.length ? (
        <ul className="task-outputs__list" aria-label="Task outputs">
          {outputs.data.map((output) => (
            <TaskOutputRow
              key={output.id}
              taskId={task.id}
              output={output}
              onDelete={(trigger) => {
                deleteTrigger.current = trigger;
                setFeedback(undefined);
                setConfirmation('');
                setConfirming(output);
              }}
            />
          ))}
        </ul>
      ) : (
        <Empty
          variant="compact"
          label="Outputs will appear here"
          description="Open a safely resolved local reference, then choose Keep as output."
        />
      )}
      {confirming ? (
        <ResponsiveDialogSurface
          role="alertdialog"
          ariaLabelledBy="delete-output-title"
          panelClassName="task-outputs__confirmation"
          onClose={() => !remove.isPending && closeConfirmation(true)}
          initialFocusRef={confirmationInput}
          returnFocusTarget={deleteTrigger.current}
        >
          <h4 id="delete-output-title">Delete “{confirming.title}”?</h4>
          <p>
            This removes this immutable output from the Task. Type its exact
            title to confirm.
          </p>
          <label>
            Output title
            <input
              ref={confirmationInput}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              aria-label={`Confirm deletion of ${confirming.title}`}
              disabled={remove.isPending}
            />
          </label>
          <ResponsiveSurfaceActions className="task-outputs__confirmation-actions">
            <Button
              onClick={() => closeConfirmation(true)}
              disabled={remove.isPending}
              aria-label={`Cancel deleting ${confirming.title}`}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={deleteOutput}
              pending={remove.isPending}
              pendingLabel="Deleting…"
              disabled={confirmation !== confirming.title}
              aria-label={`Delete ${confirming.title}`}
            >
              Delete output
            </Button>
          </ResponsiveSurfaceActions>
        </ResponsiveDialogSurface>
      ) : null}
    </section>
  );
}

function TaskOutputRow({
  taskId,
  output,
  onDelete,
}: {
  taskId: string;
  output: TaskOutputRecord;
  onDelete: (trigger: HTMLButtonElement) => void;
}) {
  const [showContent, setShowContent] = useState(false);
  const deleteRef = useRef<HTMLButtonElement | null>(null);
  return (
    <li className="task-outputs__item">
      <div className="task-outputs__summary">
        <strong>{output.title}</strong>
        <span>{output.materialization.mediaType}</span>
        <span>{bytes(output.materialization.byteLength)}</span>
        <span title={output.materialization.digest}>
          {output.materialization.digest}
        </span>
        <span>{output.source.relativePath}</span>
        <time dateTime={output.createdAt}>{time(output.createdAt)}</time>
      </div>
      <div className="task-outputs__actions">
        <Button
          size="sm"
          onClick={() => setShowContent((value) => !value)}
          aria-label={`${showContent ? 'Hide' : 'View'} output ${output.title}`}
        >
          {showContent ? 'Hide' : 'View'}
        </Button>
        <Button
          size="sm"
          ref={deleteRef}
          onClick={() => deleteRef.current && onDelete(deleteRef.current)}
          aria-label={`Delete output ${output.title}`}
        >
          Delete
        </Button>
      </div>
      {showContent ? (
        <TaskOutputContent taskId={taskId} output={output} />
      ) : null}
    </li>
  );
}

function TaskOutputContent({
  taskId,
  output,
}: {
  taskId: string;
  output: TaskOutputRecord;
}) {
  const { apiBase } = useApiBase();
  const [state, setState] = useState<
    | { kind: 'loading' }
    | {
        kind: 'ready';
        bytes: Uint8Array;
        mediaType: string;
        fileName: string | null;
        safePreview: 'image/png' | null;
      }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' });
  const [safePngUrl, setSafePngUrl] = useState<string>();
  const canPreview =
    output.materialization.mediaType === 'text/plain' ||
    output.materialization.mediaType === 'application/json';
  useEffect(() => {
    let active = true;
    setState({ kind: 'loading' });
    void downloadTaskOutputContent(apiBase, taskId, output.id)
      .then((content) => {
        if (active) setState({ kind: 'ready', ...content });
      })
      .catch((error) => {
        if (active)
          setState({
            kind: 'error',
            message: message(error, 'Output content is unavailable.'),
          });
      });
    return () => {
      active = false;
    };
  }, [apiBase, output.id, taskId]);
  const safePng =
    state.kind === 'ready' &&
    state.safePreview === 'image/png' &&
    state.mediaType === 'image/png' &&
    output.materialization.mediaType === 'image/png';
  useEffect(() => {
    if (!safePng || state.kind !== 'ready') {
      setSafePngUrl(undefined);
      return;
    }
    const copy = new Uint8Array(state.bytes.byteLength);
    copy.set(state.bytes);
    const url = URL.createObjectURL(
      new Blob([copy.buffer], { type: 'image/png' }),
    );
    setSafePngUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [safePng, state]);
  function download() {
    if (state.kind !== 'ready') return;
    const copy = new Uint8Array(state.bytes.byteLength);
    copy.set(state.bytes);
    const url = URL.createObjectURL(
      new Blob([copy.buffer], { type: state.mediaType }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = state.fileName ?? output.materialization.fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  if (state.kind === 'loading')
    return <SkeletonBlock count={1} label="Loading output content" />;
  if (state.kind === 'error')
    return <p role="alert">Output content is unavailable: {state.message}</p>;
  if (safePng && safePngUrl)
    return (
      <section
        className="task-outputs__preview"
        aria-label={`Preview of output ${output.title}`}
      >
        <img src={safePngUrl} alt={output.title} />
        <Button
          size="sm"
          onClick={download}
          aria-label={`Download output ${output.title}`}
        >
          Download
        </Button>
      </section>
    );
  if (!canPreview || state.mediaType !== output.materialization.mediaType)
    return (
      <div className="task-outputs__download-only">
        <p>
          This output is download-only. Station never executes or inlines it.
        </p>
        <Button
          size="sm"
          onClick={download}
          aria-label={`Download output ${output.title}`}
        >
          Download
        </Button>
      </div>
    );
  const bounded = state.bytes.slice(0, 256 * 1024);
  return (
    <section
      className="task-outputs__preview"
      aria-label={`Preview of output ${output.title}`}
    >
      <pre>{new TextDecoder().decode(bounded)}</pre>
      {state.bytes.length > bounded.length ? (
        <p>
          Preview limited to the first 256 KiB. Download for the full output.
        </p>
      ) : null}
      <Button
        size="sm"
        onClick={download}
        aria-label={`Download output ${output.title}`}
      >
        Download
      </Button>
    </section>
  );
}

function message(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}
function bytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return 'Unavailable';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
function time(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? 'Unavailable'
    : parsed.toLocaleString();
}
