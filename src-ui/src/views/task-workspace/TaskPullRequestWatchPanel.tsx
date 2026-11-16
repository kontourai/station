import { PULL_REQUEST_FEEDBACK_PREVIEW_ID } from '@kontourai/station-contracts/pull-request-feedback';
import {
  PULL_REQUEST_WATCH_REFUSAL_WORDS,
  type TaskPullRequestWatchModeInput,
  type TaskPullRequestWatchState,
  type TaskPullRequestWatchView,
} from '@kontourai/station-contracts/pull-request-watch';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { readPullRequestFeedbackCapability } from '@kontourai/station-sdk/pull-request-feedback';
import {
  getTaskPullRequestWatch,
  setTaskPullRequestWatch,
} from '@kontourai/station-sdk/pull-request-watch';
import { type SemanticTone, StatusBadge } from '@kontourai/ui/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { DisclosureToggle } from '../../components/DisclosureToggle';
import { ErrorState, SkeletonList } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import { userFacingErrorMessage } from '../../utils/errorText';
import './TaskPullRequestWatchPanel.css';

/** How often an open Task re-reads its pull request watch. */
const REFRESH_MS = 30_000;

const shortSha = (sha: string) => sha.slice(0, 7);

/** One watched pull request's state, as a badge word and tone. */
export function watchStateBadge(state: TaskPullRequestWatchState): {
  word: string;
  tone: SemanticTone;
} {
  switch (state.state) {
    case 'ready':
      return { word: 'Ready for you', tone: 'positive' };
    case 'fixing':
      return { word: 'Fixing', tone: 'active' };
    case 'budget-spent':
      return { word: 'Fix attempts used', tone: 'caution' };
    case 'elsewhere':
      return { word: 'Another chat', tone: 'neutral' };
    case 'unavailable':
      return { word: 'Unavailable', tone: 'caution' };
    case 'closed':
      return { word: 'Closed', tone: 'neutral' };
    default:
      return { word: 'Watching', tone: 'neutral' };
  }
}

/** The one line under a watched pull request, or nothing. */
export function watchStateLine(
  pullRequest: TaskPullRequestWatchView['pullRequests'][number],
): string | undefined {
  const state = pullRequest.watch;
  if (state.state === 'budget-spent')
    return state.failing.length
      ? `Still failing: ${state.failing.join(', ')}`
      : `Checks still fail on ${shortSha(state.headSha)}`;
  if (state.state === 'ready')
    return `Checks pass and reviews are answered on ${shortSha(state.headSha)}`;
  if (state.state === 'elsewhere')
    return 'A person sends its feedback to another chat';
  if (state.state === 'closed' || state.state === 'unavailable')
    return undefined;
  return `${pullRequest.fixAttempts} of ${pullRequest.maxFixAttempts} fix attempts used`;
}

function useTaskPullRequestWatch(task: TaskRecord) {
  const scope = useHostRequestAuthorityScope();
  const preview = useSurfaceVisibilityFlags().has(
    PULL_REQUEST_FEEDBACK_PREVIEW_ID,
  );
  // The same key as the chat's feedback hook, so one read serves both.
  const capability = useQuery({
    queryKey: ['pull-request-feedback-capability', scope?.apiBase],
    queryFn: () => readPullRequestFeedbackCapability(scope!.apiBase),
    enabled: preview && !!scope?.isCurrent(),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const available = preview && capability.data === true;
  const queryKey = [
    'task-pull-request-watch',
    scope?.apiBase,
    scope?.authorityKey,
    task.id,
    task.createdAt,
  ];
  const view = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      getTaskPullRequestWatch(scope!.apiBase, task.id, {
        signal,
        requestScope: scope!,
      }),
    enabled: available && !!scope?.isCurrent(),
    refetchInterval: REFRESH_MS,
    retry: false,
  });
  const queryClient = useQueryClient();
  const setMode = useMutation({
    mutationFn: (mode: TaskPullRequestWatchModeInput) => {
      if (!scope?.isCurrent()) throw new Error('Task connection changed.');
      return setTaskPullRequestWatch(scope.apiBase, task.id, mode, {
        requestScope: scope,
      });
    },
    onSuccess: (data) => {
      if (scope?.isCurrent()) queryClient.setQueryData(queryKey, data);
    },
  });
  return { available, view, setMode };
}

/**
 * The Task's pull request watch: whether it watches the pull requests kept
 * on it, where each stands, and what Station refused its agent. Hidden
 * unless the pull request agent feedback preview is on and the host serves
 * it.
 */
export function TaskPullRequestWatchPanel({ task }: { task: TaskRecord }) {
  const { available, view, setMode } = useTaskPullRequestWatch(task);
  const [refusalsOpen, setRefusalsOpen] = useState(false);
  if (!available) return null;
  const ended = task.status === 'done' || task.status === 'canceled';
  const data = view.data;
  return (
    <section
      aria-labelledby="task-pr-watch-heading"
      className="task-pr-watch content-stack"
    >
      <div className="task-pr-watch__header">
        <h2 id="task-pr-watch-heading">Pull request watch</h2>
        {data && (
          <StatusBadge
            tone={data.watching ? 'active' : 'neutral'}
            status={data.watching ? 'Watching' : 'Not watching'}
          />
        )}
      </div>
      {view.isLoading && (
        <SkeletonList count={1} label="Loading pull request watch" />
      )}
      {view.error && (
        <ErrorState
          variant="compact"
          title="Could not load the pull request watch"
          description={userFacingErrorMessage(view.error)}
          action={
            <Button
              size="sm"
              disabled={view.isFetching}
              onClick={() => void view.refetch()}
            >
              Retry
            </Button>
          }
        />
      )}
      {data && (
        <>
          <p className="task-pr-watch__meta">
            {data.watching
              ? 'Station wakes the agent when CI fails or a reviewer writes. Merging stays with you.'
              : data.source === 'task'
                ? 'Watching is off for this Task.'
                : 'This Project does not watch Task pull requests.'}
          </p>
          {!ended && (
            <div className="task-pr-watch__actions">
              <Button
                size="sm"
                disabled={setMode.isPending}
                onClick={() => setMode.mutate(data.watching ? 'off' : 'on')}
              >
                {data.watching ? 'Stop watching' : 'Watch pull requests'}
              </Button>
              {data.mode !== 'project' && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={setMode.isPending}
                  onClick={() => setMode.mutate('project')}
                >
                  Use Project setting
                </Button>
              )}
            </div>
          )}
          {setMode.error && (
            <ErrorState
              variant="compact"
              title="Could not change watching"
              description={userFacingErrorMessage(setMode.error)}
            />
          )}
          {data.pullRequests.length > 0 && (
            <ul
              aria-label="Watched pull requests"
              className="task-pr-watch__list"
            >
              {data.pullRequests.map((pullRequest) => {
                const badge = watchStateBadge(pullRequest.watch);
                const line = watchStateLine(pullRequest);
                const name = `${pullRequest.identity.repository.owner}/${pullRequest.identity.repository.name} #${pullRequest.identity.ref}`;
                return (
                  <li key={name}>
                    <span className="task-pr-watch__name">
                      {pullRequest.url ? (
                        <a
                          href={pullRequest.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {name}
                        </a>
                      ) : (
                        name
                      )}
                    </span>
                    {data.watching && (
                      <StatusBadge tone={badge.tone} status={badge.word} />
                    )}
                    {data.watching && line && (
                      <span className="task-pr-watch__line">{line}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {data.refusals.length > 0 && (
            <div>
              <DisclosureToggle
                expanded={refusalsOpen}
                onToggle={() => setRefusalsOpen((open) => !open)}
                controls="task-pr-watch-refusals"
              >
                Refused actions · {data.refusals.length}
              </DisclosureToggle>
              {refusalsOpen && (
                <ul id="task-pr-watch-refusals" className="task-pr-watch__list">
                  {data.refusals.map((refusal) => (
                    <li key={refusal.id}>
                      <span className="task-pr-watch__name">
                        {PULL_REQUEST_WATCH_REFUSAL_WORDS[refusal.kind]}
                      </span>
                      <StatusBadge
                        tone={
                          refusal.outcome === 'refused' ? 'caution' : 'active'
                        }
                        status={
                          refusal.outcome === 'refused'
                            ? 'Refused'
                            : 'Asked you'
                        }
                      />
                      <code className="task-pr-watch__line">
                        {refusal.detail}
                      </code>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
