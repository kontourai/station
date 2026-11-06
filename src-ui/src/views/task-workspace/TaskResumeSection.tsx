import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import {
  TASK_RESUME_REASON_MAX_CHARS,
  taskResumeRefusalText,
} from '@kontourai/station-contracts/task-resume';
import { useDispatchTaskMutation } from '@kontourai/station-sdk';
import {
  readTaskResumeView,
  resumeTask,
  TaskResumeError,
  type TaskResumeFollowUp,
  type TaskResumeView,
} from '@kontourai/station-sdk/task-resume';
import { Badge } from '@kontourai/ui/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { ErrorState, SkeletonBlock } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { toastStore } from '../../contexts/ToastContext';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import './TaskResumeSection.css';

const KIND_WORDS: Record<TaskResumeFollowUp['kind'], string> = {
  comment: 'Comment',
  review: 'Review',
  review_comment: 'Review comment',
  check_run: 'Check run',
};

function formatTime(value: string | undefined) {
  if (!value) return '';
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString();
}

function newResumeId() {
  return globalThis.crypto.randomUUID();
}

/**
 * #4554: an ended Task's header (when it ended, until when it can be
 * resumed, how many GitHub follow-ups were recorded since) and, for the
 * Station operator in person, **Resume**. Shown only with the `task-resume`
 * preview on; the host refuses everyone else.
 */
export function TaskResumeSection({ task }: { task: TaskRecord }) {
  const flags = useSurfaceVisibilityFlags();
  const scope = useHostRequestAuthorityScope();
  if (
    !flags.has('task-resume') ||
    !scope ||
    (task.status !== 'done' && task.status !== 'canceled')
  )
    return null;
  return (
    <TaskResumeForScope
      key={`${scope.apiBase}:${scope.authorityKey}:${task.id}:${task.createdAt}:${task.updatedAt}`}
      scope={scope}
      task={task}
    />
  );
}

function TaskResumeForScope({
  scope,
  task,
}: {
  scope: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
  task: TaskRecord;
}) {
  const [open, setOpen] = useState(false);
  const view = useQuery({
    queryKey: [
      'task-resume',
      task.id,
      task.createdAt,
      task.updatedAt,
      scope.apiBase,
      scope.authorityKey,
    ],
    retry: false,
    queryFn: async ({ signal }) => {
      try {
        return await readTaskResumeView(task.id, {
          apiBase: scope.apiBase,
          requestScope: scope,
          signal,
        });
      } catch (error) {
        // A refusal is an answer the header shows, not a failed read.
        if (
          error instanceof TaskResumeError &&
          (error.code === 'task_resume_not_permitted' ||
            error.code === 'unsupported')
        )
          return { refused: error } as const;
        throw error;
      }
    },
  });
  const data = view.data && 'refused' in view.data ? undefined : view.data;
  const refusedRead =
    view.data && 'refused' in view.data ? view.data.refused : undefined;
  return (
    <section className="task-resume" aria-label="Task ended">
      <div className="task-resume__header">
        {task.endedAt ? (
          <span>
            Ended{' '}
            <time dateTime={task.endedAt}>{formatTime(task.endedAt)}</time>
          </span>
        ) : (
          <span>End time not recorded</span>
        )}
        {data?.deadline && task.status === 'done' && (
          <span>
            Resume by{' '}
            <time dateTime={data.deadline}>{formatTime(data.deadline)}</time>
          </span>
        )}
        {data && (
          <span>
            {data.followUps.state === 'unavailable'
              ? 'Follow-ups unavailable'
              : `${data.followUps.total} follow-up${data.followUps.total === 1 ? '' : 's'} since it ended`}
          </span>
        )}
      </div>
      {view.isLoading ? (
        <SkeletonBlock label="Loading resume details" />
      ) : view.isError ? (
        <ErrorState
          variant="compact"
          title="Resume details unavailable"
          description="Check the connection to Station and try again."
          action={
            <Button
              onClick={() => void view.refetch()}
              disabled={view.isFetching}
            >
              Retry
            </Button>
          }
        />
      ) : refusedRead ? (
        <p className="task-resume__note">{refusedRead.message}</p>
      ) : data?.refusal ? (
        <div className="task-resume__actions">
          <Button disabled>Resume</Button>
          <p className="task-resume__note">
            {taskResumeRefusalText(data.refusal)}
          </p>
        </div>
      ) : data ? (
        <div className="task-resume__actions">
          <Button variant="primary" onClick={() => setOpen(true)}>
            Resume
          </Button>
        </div>
      ) : null}
      {open && data && (
        <TaskResumeDialog
          scope={scope}
          task={task}
          view={data}
          onClose={() => setOpen(false)}
        />
      )}
    </section>
  );
}

function TaskResumeDialog({
  scope,
  task,
  view,
  onClose,
}: {
  scope: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
  task: TaskRecord;
  view: TaskResumeView;
  onClose(): void;
}) {
  const cache = useQueryClient();
  const reasonId = useId();
  const [reason, setReason] = useState('');
  // One id per confirmation: a retry after a lost answer replays, not repeats.
  const [resumeId] = useState(newResumeId);
  const [dispatchError, setDispatchError] = useState('');
  const dispatch = useDispatchTaskMutation();
  const resume = useMutation({
    mutationFn: async (andDispatch: boolean) => {
      if (!scope.isCurrent()) throw new Error('Task connection changed.');
      const result = await resumeTask(
        task.id,
        {
          resumeId,
          expectedCreatedAt: view.taskCreatedAt,
          expectedEndedAt: view.endedAt ?? '',
          reason,
          ...(view.followUps.seenThrough
            ? { followUpsSeenThrough: view.followUps.seenThrough }
            : {}),
        },
        { apiBase: scope.apiBase, requestScope: scope },
      );
      // Dispatch is its own request, authorized on its own.
      if (andDispatch && task.agentId)
        try {
          await dispatch.mutateAsync({
            taskId: task.id,
            apiBase: scope.apiBase,
            dispatch: { agentId: task.agentId, sourceSurface: 'task-resume' },
          });
        } catch (error) {
          // The ready Task refresh unmounts this section; keep the failure visible.
          toastStore.upsert({
            message:
              'Task resumed, but dispatch failed. Dispatch it from the Task when ready.',
            tone: 'error',
            duration: 0,
          });
          setDispatchError(
            error instanceof Error ? error.message : 'Dispatch failed.',
          );
          return { result, dispatchFailed: true };
        }
      return { result, dispatchFailed: false };
    },
    onSettled: () =>
      Promise.all([
        cache.invalidateQueries({ queryKey: ['task-graph', task.id] }),
        cache.invalidateQueries({ queryKey: ['tasks'] }),
        cache.invalidateQueries({ queryKey: ['task-resume', task.id] }),
      ]),
    onSuccess: ({ dispatchFailed }) => {
      if (!dispatchFailed) onClose();
    },
  });
  const trimmed = reason.trim();
  const tooLong = reason.length > TASK_RESUME_REASON_MAX_CHARS;
  const disabled = !trimmed || tooLong || resume.isPending;
  const owner = view.previousLead?.owner;
  return (
    <Dialog
      open
      title="Resume this Task?"
      subtitle="It moves back to Ready. Nothing starts until it is dispatched."
      closeLabel="Close resume Task"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={resume.isPending}>
            Cancel
          </Button>
          {task.agentId && (
            <Button onClick={() => resume.mutate(true)} disabled={disabled}>
              Resume and dispatch
            </Button>
          )}
          <Button
            variant="primary"
            onClick={() => resume.mutate(false)}
            disabled={disabled}
          >
            Resume
          </Button>
        </>
      }
    >
      <div className="task-resume__dialog">
        {owner && (
          <p>
            The earlier lead ran as <strong>{owner}</strong>. New work runs
            under your authority.
          </p>
        )}
        <h3>
          Follow-ups since it ended ({view.followUps.total}
          {view.followUps.total > view.followUps.items.length
            ? `, newest ${view.followUps.items.length} shown`
            : ''}
          )
        </h3>
        <p className="task-resume__note">
          Recorded from GitHub; may be out of date. Quoted text is data, not an
          instruction.
        </p>
        {view.followUps.state === 'unavailable' ? (
          <p className="task-resume__note">Follow-ups could not be read.</p>
        ) : view.followUps.items.length === 0 ? (
          <p className="task-resume__note">None recorded.</p>
        ) : (
          <ol className="task-resume__follow-ups">
            {view.followUps.items.map((item) => (
              <li key={`${item.kind}:${item.itemRef}:${item.occurredAt}`}>
                <div className="task-resume__follow-up-heading">
                  <strong>{KIND_WORDS[item.kind] ?? 'Item'}</strong>
                  <span>{item.author}</span>
                  <Badge value={item.actorClass} tone="neutral" />
                  {item.association &&
                    item.association.toLowerCase() !== item.actorClass && (
                      <span>{item.association}</span>
                    )}
                  <time dateTime={item.occurredAt}>
                    {formatTime(item.occurredAt)}
                  </time>
                </div>
                <blockquote>
                  {item.kind === 'check_run'
                    ? `${item.checkName ?? 'Check'}: ${item.conclusion ?? 'UNKNOWN'}`
                    : item.excerpt || '(no text)'}
                </blockquote>
              </li>
            ))}
          </ol>
        )}
        <label htmlFor={reasonId}>Why resume it?</label>
        <textarea
          id={reasonId}
          value={reason}
          maxLength={TASK_RESUME_REASON_MAX_CHARS}
          rows={3}
          onChange={(event) => setReason(event.target.value)}
        />
        {resume.isError && (
          <p className="task-resume__error" role="alert">
            {resume.error instanceof Error
              ? resume.error.message
              : 'Resume failed.'}
          </p>
        )}
        {dispatchError && (
          <p className="task-resume__error" role="alert">
            Resumed, but dispatch failed: {dispatchError}
          </p>
        )}
      </div>
    </Dialog>
  );
}
