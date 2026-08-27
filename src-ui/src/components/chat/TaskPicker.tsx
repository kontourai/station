import type { TaskRecord } from '@kontourai/station-sdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { Empty, ErrorState, SkeletonList } from '../state';
import './TaskPicker.css';

/** A Task picker needs identity and title; status is optional presentation metadata. */
export type TaskPickerTask = Pick<TaskRecord, 'id' | 'title'> & {
  status?: TaskRecord['status'];
};

/** Small host-owned seam: the picker never decides what an explicit reference means. */
export interface TaskPickerAdapter {
  tasks?: readonly TaskPickerTask[];
  isLoading?: boolean;
  error?: unknown;
  refetch?: () => unknown;
  isPending?: boolean;
}

export interface TaskPickerProps<TTarget> {
  target: TTarget;
  triggerLabel: string;
  /** More precise control name when compact visible copy is enough. */
  triggerAriaLabel?: string;
  dialogTitle: string;
  eyebrow: string;
  projectId?: string;
  adapter: TaskPickerAdapter;
  /** Opens a newly-mounted picker for a host-captured immutable target. */
  initiallyOpen?: boolean;
  /** Lets a host provide the trigger while this picker owns its dialog. */
  hideTrigger?: boolean;
  /** Explicit opener for hosts that mount the dialog after their own trigger. */
  returnFocusTarget?: HTMLElement | null;
  onOpen?: () => void;
  onClose?: () => void;
  onAttached?: (task: TaskPickerTask) => void;
  /** Receives the target captured when this dialog opened, never live row props. */
  attach: (taskId: string, target: TTarget) => Promise<unknown>;
  successMessage: (task: TaskPickerTask) => string;
}

function sortTasks(tasks: readonly TaskPickerTask[]): TaskPickerTask[] {
  return [...tasks].sort((left, right) =>
    left.title.localeCompare(right.title),
  );
}

function taskDescription(task: TaskPickerTask): string {
  return task.status ? `${task.id} · ${task.status}` : task.id;
}

/** Shared explicit-Task chooser with a captured dialog target. */
export function TaskPicker<TTarget>({
  target,
  triggerLabel,
  triggerAriaLabel,
  dialogTitle,
  eyebrow,
  projectId,
  adapter,
  initiallyOpen = false,
  hideTrigger = false,
  returnFocusTarget,
  onOpen,
  onClose,
  onAttached,
  attach,
  successMessage,
}: TaskPickerProps<TTarget>) {
  const [openTarget, setOpenTarget] = useState<TTarget | null>(() =>
    initiallyOpen ? target : null,
  );
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [submissionFailed, setSubmissionFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [attachedTask, setAttachedTask] = useState<TaskPickerTask | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const initialOpenActionRef = useRef(onOpen);
  const tasks = useMemo(() => sortTasks(adapter.tasks ?? []), [adapter.tasks]);
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const term = search.trim().toLocaleLowerCase();
  const visibleTasks = term
    ? tasks.filter((task) =>
        `${task.title} ${task.id}`.toLocaleLowerCase().includes(term),
      )
    : tasks;
  const isPending = (adapter.isPending ?? false) || submitting;

  useEffect(() => {
    if (selectedTaskId && !selectedTask) setSelectedTaskId(null);
  }, [selectedTask, selectedTaskId]);

  useEffect(() => {
    if (initiallyOpen) initialOpenActionRef.current?.();
  }, [initiallyOpen]);

  function close() {
    setOpenTarget(null);
    setSelectedTaskId(null);
    setSearch('');
    setSubmissionFailed(false);
    setSubmitting(false);
    onClose?.();
  }

  function openDialog() {
    onOpen?.();
    setSubmissionFailed(false);
    setOpenTarget(target);
  }

  async function submit() {
    if (!selectedTask || openTarget === null || isPending) return;
    setSubmissionFailed(false);
    setSubmitting(true);
    try {
      await attach(selectedTask.id, openTarget);
      setAttachedTask(selectedTask);
      onAttached?.(selectedTask);
      close();
    } catch {
      // Protected tuple/content details may be present in an error body.
      setSubmissionFailed(true);
      setSubmitting(false);
    }
  }

  return (
    <span className="task-picker">
      {!hideTrigger && (
        <Button
          variant="ghost"
          size="sm"
          className="task-picker__trigger"
          onClick={openDialog}
          aria-label={triggerAriaLabel ?? triggerLabel}
        >
          {triggerLabel}
        </Button>
      )}
      {attachedTask && (
        <span className="task-picker__status" role="status">
          {successMessage(attachedTask)}
        </span>
      )}
      {openTarget !== null && (
        <Dialog
          eyebrow={eyebrow}
          title={dialogTitle}
          subtitle={
            projectId
              ? 'Choose a Task in this project.'
              : 'Choose a Task you can access.'
          }
          closeLabel={`Close ${dialogTitle}`}
          onClose={close}
          returnFocusTarget={returnFocusTarget}
          initialFocusRef={searchRef}
          initialFocusPolicy="desktop"
          panelClassName="task-picker__dialog"
          footer={
            <>
              <Button size="sm" onClick={close} disabled={isPending}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void submit()}
                disabled={!selectedTask}
                pending={isPending}
                pendingLabel="Adding…"
              >
                Add to Task
              </Button>
            </>
          }
        >
          <div className="task-picker__dialog-body">
            <label className="task-picker__search-label">
              Find a Task
              <input
                ref={searchRef}
                type="search"
                className="task-picker__search"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setSelectedTaskId(null);
                }}
                placeholder="Search Tasks"
                aria-label="Find a Task"
              />
            </label>
            {adapter.error ? (
              <ErrorState
                variant="compact"
                title="Unable to load Tasks"
                description="Task choices are unavailable."
                action={
                  adapter.refetch ? (
                    <Button size="sm" onClick={() => void adapter.refetch?.()}>
                      Retry
                    </Button>
                  ) : undefined
                }
              />
            ) : adapter.isLoading ? (
              <SkeletonList count={4} label="Loading Tasks" />
            ) : visibleTasks.length === 0 ? (
              <Empty
                variant="compact"
                label={
                  tasks.length === 0
                    ? 'Tasks are not available'
                    : 'Task search has no matches'
                }
                description={
                  tasks.length === 0
                    ? 'Create a Task before adding this reference.'
                    : 'Try a different Task name or identifier.'
                }
              />
            ) : (
              <ul className="task-picker__task-list" aria-label="Tasks">
                {visibleTasks.map((task) => {
                  const selected = task.id === selectedTaskId;
                  return (
                    <li key={task.id}>
                      <button
                        type="button"
                        className={`task-picker__task${selected ? ' task-picker__task--selected' : ''}`}
                        aria-pressed={selected}
                        onClick={() => setSelectedTaskId(task.id)}
                      >
                        <span className="task-picker__task-title">
                          {task.title}
                        </span>
                        <span className="task-picker__task-meta">
                          {taskDescription(task)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {submissionFailed && (
              <p className="task-picker__submission-error" role="alert">
                Unable to add this to the Task. Try again.
              </p>
            )}
          </div>
        </Dialog>
      )}
    </span>
  );
}
