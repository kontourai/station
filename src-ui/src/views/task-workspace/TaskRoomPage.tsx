import {
  canTransitionTaskStatus,
  TASK_STATUSES,
  type TaskKeptDeclaredPullRequest,
  type TaskRecord,
  type TaskStatus,
  taskStatusLabel,
} from '@kontourai/station-contracts/task-graph';
import {
  getJson,
  mutateJson,
  useTaskTurnReferencesQuery,
  useUpdateTaskStatusMutation,
} from '@kontourai/station-sdk';
import { useProjectTaskRoomDocumentQuery } from '@kontourai/station-sdk/project-task-rooms';
import { useTaskOutputsQuery } from '@kontourai/station-sdk/task-outputs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '../../components/Button';
import { LazyMarkdown } from '../../components/chat/LazyMarkdown';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { openChatsStore } from '../../contexts/open-chats-store';
import { ProjectTaskRoomPresence } from '../../workspace-panes/ProjectTaskRoomPresence';
import { ProjectTaskSharingControl } from '../project-page/ProjectTaskSharingControl';
import { TaskOutputRow } from './TaskOutputsSection';

async function readResult<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok || !body.success)
    throw new Error(body.error || 'Task update unavailable.');
  return body.data;
}

export function TaskRoomHeader({
  task,
  projectSlug,
  projectId,
  onDetails,
}: {
  task: TaskRecord;
  projectSlug: string;
  projectId: string;
  onDetails(): void;
}) {
  const scope = useHostRequestAuthorityScope();
  const cache = useQueryClient();
  const [title, setTitle] = useState(task.title);
  const [editing, setEditing] = useState(false);
  const status = useUpdateTaskStatusMutation();
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!editing) setTitle(task.title);
  }, [task.title, editing]);
  const rename = useMutation({
    mutationFn: async () => {
      if (!scope?.isCurrent()) throw new Error('Task connection changed.');
      return readResult<TaskRecord>(
        await mutateJson(
          `${scope.apiBase}/api/tasks/${encodeURIComponent(task.id)}/title`,
          'PATCH',
          { requestScope: scope },
          { title: title.trim(), expectedCreatedAt: task.createdAt },
        ),
      );
    },
    onSuccess: () => {
      setEditing(false);
      void cache.invalidateQueries({ queryKey: ['task-graph', task.id] });
    },
    onError: (error) => setNotice(error.message),
  });
  return (
    <header className="task-room-header">
      <div className="task-room-title">
        {editing ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              rename.mutate();
            }}
          >
            <label className="sr-only" htmlFor="task-title">
              Task title
            </label>
            <input
              id="task-title"
              value={title}
              maxLength={512}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setEditing(false);
                  setTitle(task.title);
                }
              }}
            />
            <Button type="submit" disabled={!title.trim() || rename.isPending}>
              Save title
            </Button>
            <Button onClick={() => setEditing(false)}>Cancel</Button>
          </form>
        ) : (
          <h1>
            <button
              type="button"
              onClick={() => setEditing(true)}
              aria-label={`Edit title: ${task.title}`}
            >
              {task.title}
            </button>
          </h1>
        )}
      </div>
      <label className="task-room-status">
        <span className="sr-only">Task status</span>
        <select
          aria-label="Task status"
          value={task.status}
          disabled={status.isPending}
          onChange={async (event) => {
            try {
              setNotice('');
              await status.mutateAsync({
                taskId: task.id,
                status: event.target.value as TaskStatus,
                apiBase: scope?.apiBase,
              });
              await cache.invalidateQueries({
                queryKey: ['task-graph', task.id],
              });
            } catch (error) {
              setNotice(
                error instanceof Error
                  ? error.message
                  : 'Status update failed.',
              );
            }
          }}
        >
          {TASK_STATUSES.filter((candidate) =>
            canTransitionTaskStatus(task.status, candidate),
          ).map((candidate) => (
            <option key={candidate} value={candidate}>
              {taskStatusLabel(candidate)}
            </option>
          ))}
        </select>
      </label>
      <ProjectTaskRoomPresence taskId={task.id} compact />
      <details className="task-room-share">
        <summary>Share</summary>
        <ProjectTaskSharingControl
          slug={projectSlug}
          projectId={projectId}
          task={task}
        />
      </details>
      <details className="task-room-overflow">
        <summary aria-label="Task actions">⋯</summary>
        <div>
          <Button
            onClick={(event) => {
              onDetails();
              event.currentTarget.closest('details')?.removeAttribute('open');
            }}
          >
            Task details
          </Button>
          <Button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(window.location.href);
                setNotice('Task link copied.');
              } catch {
                setNotice('The Task link could not be copied.');
              }
            }}
          >
            Copy link
          </Button>
        </div>
      </details>
      {notice && (
        <p className="task-room-inline-status" role="alert">
          {notice}
        </p>
      )}
    </header>
  );
}

function useKeptPullRequests(task: TaskRecord) {
  const scope = useHostRequestAuthorityScope();
  return useQuery({
    queryKey: [
      'task-kept-pull-requests',
      task.id,
      task.createdAt,
      scope?.apiBase,
      scope?.authorityKey,
    ],
    enabled: !!scope,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!scope?.isCurrent()) throw new Error('Task connection changed.');
      const result = await readResult<TaskKeptDeclaredPullRequest[]>(
        await getJson(
          `${scope.apiBase}/api/tasks/${encodeURIComponent(task.id)}/kept-pull-requests`,
          { requestScope: scope, signal },
        ),
      );
      if (!scope.isCurrent()) throw new Error('Task connection changed.');
      return result;
    },
  });
}

function useResults(task: TaskRecord) {
  const scope = useHostRequestAuthorityScope();
  const answers = useTaskTurnReferencesQuery(task.id);
  const outputs = useTaskOutputsQuery(task.id, {
    requestScope: scope,
    taskCreatedAt: task.createdAt,
  });
  const prs = useKeptPullRequests(task);
  return {
    answers,
    outputs,
    prs,
    count:
      (answers.data?.length ?? 0) +
      (outputs.data?.length ?? 0) +
      (prs.data?.length ?? 0),
    unavailable: !!(answers.error || outputs.error || prs.error),
    loading: answers.isLoading || outputs.isLoading || prs.isLoading,
  };
}

export function TaskRoomResults({ task }: { task: TaskRecord }) {
  const { answers, outputs, prs, unavailable } = useResults(task);
  const [selected, setSelected] = useState<string>();
  const [runNotice, setRunNotice] = useState('');
  const openRun = async (sessionId: string) => {
    setRunNotice('');
    if (!(await openChatsStore.openConversation(sessionId)))
      setRunNotice(
        'This run could not be opened. Try again when the chat dock is ready.',
      );
  };
  return (
    <section aria-label="Task results" className="task-room-results">
      <h2>Results</h2>
      {runNotice && <p role="alert">{runNotice}</p>}
      <p className="task-room-hint">
        Answers, files, and pull requests kept for this Task.
      </p>
      {unavailable && (
        <p role="alert">
          Some results could not be loaded. Reopen Results to retry.
        </p>
      )}
      {(answers.isLoading || outputs.isLoading || prs.isLoading) && (
        <p role="status">Loading results…</p>
      )}
      <ul aria-label="Kept results">
        {answers.data?.map((answer, index) =>
          answer.state === 'available' ? (
            <li key={answer.id}>
              <span className="task-room-result-kind">Answer</span>
              <Button
                onClick={() =>
                  setSelected(selected === answer.id ? undefined : answer.id)
                }
              >
                {answer.answer.content
                  .split('\n')
                  .find((line) => line.trim())
                  ?.replace(/^#+\s*/, '')
                  .slice(0, 120) || 'Kept answer'}
              </Button>
              <Button onClick={() => void openRun(answer.sessionId)}>
                Open full run
              </Button>
              {selected === answer.id && (
                <div className="task-room-result-content">
                  <LazyMarkdown>{answer.answer.content}</LazyMarkdown>
                </div>
              )}
            </li>
          ) : (
            <li key={`unavailable-${index}`}>Kept answer unavailable</li>
          ),
        )}
        {outputs.data?.map((output) => (
          <TaskOutputRow
            key={output.id}
            taskId={task.id}
            taskCreatedAt={task.createdAt}
            output={output}
            compact
          />
        ))}
        {prs.data?.map((pr) => (
          <li key={`${pr.provider}:${pr.host}:${pr.nativeId}`}>
            <span className="task-room-result-kind">Pull request</span>
            <strong>
              {pr.repository.owner}/{pr.repository.name} #{pr.ref}
            </strong>
            <span>
              {task.closeOnMerge
                ? 'Closes Task when all kept PRs merge'
                : 'Kept on this Task'}
            </span>
            <Button onClick={() => void openRun(pr.provenance.sessionId)}>
              Open full run
            </Button>
          </li>
        ))}
      </ul>
      {!unavailable &&
        !answers.isLoading &&
        !outputs.isLoading &&
        !prs.isLoading &&
        !(answers.data?.length || outputs.data?.length || prs.data?.length) && (
          <p>Keep an agent answer or a file to collect results here.</p>
        )}
    </section>
  );
}

export function TaskRoomRail({
  task,
  projectSlug,
  onBrief,
  onResults,
}: {
  task: TaskRecord;
  projectSlug: string;
  onBrief(): void;
  onResults(): void;
}) {
  const document = useProjectTaskRoomDocumentQuery(task.id);
  const { count, unavailable, loading, answers, outputs, prs } =
    useResults(task);
  const text =
    document.data?.kind === 'snapshot' || document.data?.kind === 'delta'
      ? document.data.text
      : '';
  const source = (text || task.description || '').trim();
  const lines = source.split('\n');
  const section = (name: string) => {
    const start = lines.findIndex((line) =>
      new RegExp(`^#{1,6}\\s+${name}\\s*#*\\s*$`, 'i').test(line),
    );
    if (start < 0) return undefined;
    const following = lines.slice(start + 1);
    const end = following.findIndex((line) => /^#{1,6}\s/.test(line));
    return following
      .slice(0, end < 0 ? undefined : end)
      .join('\n')
      .trim();
  };
  const goalSection = section('Goal');
  const doneSection = section('Done when');
  const firstHeading = lines.findIndex((line) => /^#{1,6}\s/.test(line));
  const prose = lines
    .slice(0, firstHeading < 0 ? undefined : firstHeading)
    .join('\n')
    .trim();
  const goal = goalSection ?? prose.slice(0, 800);
  const checklist = (doneSection ?? '').split('\n').flatMap((line) => {
    const match = /^\s*(?:[-*+]|\d+\.)\s+(?:\[([ xX])\]\s+)?(.+)$/.exec(line);
    return match
      ? [
          {
            done:
              match[1] === undefined ? null : match[1].toLowerCase() === 'x',
            text: match[2],
          },
        ]
      : [];
  });
  return (
    <div className="task-room-rail-content">
      <section>
        <h3>Goal</h3>
        {goal ? (
          <LazyMarkdown loadingProjection="Loading brief…">{goal}</LazyMarkdown>
        ) : (
          <p>
            {document.isLoading
              ? 'Loading brief…'
              : 'Add the goal to the shared brief.'}
          </p>
        )}
        <Button onClick={onBrief} size="sm">
          Edit brief
        </Button>
      </section>
      <section>
        <h3>Done when</h3>
        {checklist.length ? (
          <ul className="task-room-checklist">
            {checklist.map((item, index) => (
              <li key={index}>
                {item.done === null ? (
                  <span aria-hidden="true">•</span>
                ) : (
                  <span
                    role="img"
                    aria-label={item.done ? 'Checked' : 'Unchecked'}
                  >
                    {item.done ? '☑' : '☐'}
                  </span>
                )}
                <LazyMarkdown>{item.text}</LazyMarkdown>
              </li>
            ))}
          </ul>
        ) : doneSection ? (
          <LazyMarkdown loadingProjection="Loading brief…">
            {doneSection}
          </LazyMarkdown>
        ) : (
          <p>Add a checklist in the brief.</p>
        )}
      </section>
      <section>
        <h3>Results</h3>
        <Button onClick={onResults} size="sm">
          {loading
            ? 'Loading results…'
            : unavailable
              ? 'Results unavailable'
              : `${count} kept ${count === 1 ? 'result' : 'results'}`}
        </Button>
      </section>
      {!loading && !unavailable && count > 0 && (
        <ul className="task-room-result-summary">
          {answers.data
            ?.filter((answer) => answer.state === 'available')
            .slice(0, 2)
            .map(
              (answer) =>
                answer.state === 'available' && (
                  <li key={answer.id}>
                    <Button size="sm" onClick={onResults}>
                      {answer.answer.content
                        .split('\n')
                        .find((line) => line.trim())
                        ?.replace(/^#+\s*/, '')
                        .slice(0, 80) || 'Kept answer'}
                    </Button>
                  </li>
                ),
            )}
          {outputs.data?.slice(0, 2).map((output) => (
            <li key={output.id}>
              <Button size="sm" onClick={onResults}>
                {output.title}
              </Button>
            </li>
          ))}
          {prs.data?.slice(0, 2).map((pr) => (
            <li key={pr.nativeId}>
              <Button size="sm" onClick={onResults}>
                PR #{pr.ref}
                {task.closeOnMerge ? ' · closes Task on merge' : ''}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ProjectTaskRoomPresence taskId={task.id} />
      <footer>
        <span>{projectSlug}</span>
        <span>{task.workspaceBinding?.branch ?? 'Branch not recorded'}</span>
        {task.workItemRef && <span>{task.workItemRef}</span>}
      </footer>
    </div>
  );
}

export function TaskRoomResultCount({ task }: { task: TaskRecord }) {
  const results = useResults(task);
  return !results.loading && !results.unavailable && results.count > 0 ? (
    <span className="task-room-count">{results.count}</span>
  ) : null;
}
