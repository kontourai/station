import type {
  TaskCodeReviewEntry,
  TaskCodeReviewRequest,
} from '@kontourai/station-contracts/task-review';
import {
  useRequestTaskCodeReviewMutation,
  useTaskCodeReviewQuery,
} from '@kontourai/station-sdk';
import {
  type ApiRequestScope,
  StationHttpError,
} from '@kontourai/station-sdk/client';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { Badge, Field, Input, Select } from '@kontourai/ui/react';
import { useEffect, useId, useRef, useState } from 'react';
import { ActionRow } from '../../components/ActionRow';
import { Button } from '../../components/Button';
import { DisclosureToggle } from '../../components/DisclosureToggle';
import { StatusSummary } from '../../components/StatusSummary';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import { useNavigationActions } from '../../contexts/NavigationContext';
import { useBackgroundStatusReconciliation } from '../../hooks/useBackgroundStatusReconciliation';
import { errorText } from '../../utils/errorText';
import './TaskCodeReviewPanel.css';

const freshnessLabels = {
  'same-revision': 'Same committed revision',
  'different-revision': 'Checkout revision changed',
  unavailable: 'Revision unavailable',
};
const stateLabels = {
  running: 'Running',
  completed: 'Completed',
  rejected: 'Request rejected',
  indeterminate: 'Outcome unknown',
  'not-verified': 'Not verified',
};

export function TaskCodeReviewPanel({
  authority,
  projectId,
  taskId,
  taskCreatedAt,
  visible,
}: {
  authority: ApiRequestScope & { draftRecoveryKey?: string };
  projectId: string;
  taskId: string;
  taskCreatedAt: string;
  visible: boolean;
}) {
  const { navigate } = useNavigationActions();
  const query = useTaskCodeReviewQuery(
    authority,
    projectId,
    taskId,
    taskCreatedAt,
    visible,
  );
  const mutation = useRequestTaskCodeReviewMutation(
    authority,
    projectId,
    taskId,
    taskCreatedAt,
  );
  const [details, setDetails] = useState(false);
  const [reviewer, setReviewer] = useState('');
  const [base, setBase] = useState<string | null>(null);
  const recoveryKey = JSON.stringify([
    'task-code-review',
    authority.apiBase,
    authority.draftRecoveryKey ?? authority.authorityKey,
    projectId,
    taskId,
    taskCreatedAt,
  ]);
  const [operation, setOperation] = useState<TaskCodeReviewRequest | null>(
    () => {
      try {
        const saved = JSON.parse(sessionStorage.getItem(recoveryKey) ?? 'null');
        return saved?.projectId === projectId &&
          typeof saved.projectCreatedAt === 'string' &&
          saved.projectCreatedAt.length > 0 &&
          saved.taskCreatedAt === taskCreatedAt &&
          typeof saved.requestId === 'string' &&
          typeof saved.reviewerAgentSlug === 'string' &&
          /^[0-9a-f]{40}$/.test(saved.baseSha) &&
          /^[0-9a-f]{40}$/.test(saved.headSha)
          ? saved
          : null;
      } catch {
        return null;
      }
    },
  );
  const [recoveryError, setRecoveryError] = useState(false);
  const sending = useRef(false);
  const id = useId();
  const view = query.data;
  const tracked = operation
    ? view?.requests.find(
        (request) => request.requestId === operation.requestId,
      )
    : undefined;
  const refused =
    mutation.error instanceof StationHttpError &&
    (mutation.error.status === 400 ||
      (mutation.error.status === 409 &&
        mutation.error.code === 'review_request_conflict'));
  const uncertain = Boolean(
    view && operation && !mutation.isPending && !refused && !tracked,
  );
  const reviewReconcile = useBackgroundStatusReconciliation({
    active: uncertain,
    resetKey: operation?.requestId ?? '',
    initialDelayMs: 1_500,
    intervalsMs: [3_000, 6_000],
    check: async () => {
      const result = await query.refetch();
      return result.data?.requests.some(
        (request) => request.requestId === operation?.requestId,
      )
        ? 'settled'
        : 'pending';
    },
  });
  useEffect(() => {
    if (tracked) {
      try {
        sessionStorage.removeItem(recoveryKey);
      } catch {
        /* The confirmed server record owns recovery now. */
      }
    }
  }, [tracked, recoveryKey]);
  const refresh = (label: string) => (
    <Button
      size="sm"
      aria-label={label}
      onClick={() => void query.refetch()}
      pending={query.isFetching}
    >
      {label === 'Refresh code review' ? 'Refresh' : label}
    </Button>
  );
  if (query.error)
    return (
      <ErrorState
        variant="compact"
        title="Code review unavailable"
        description={
          query.error instanceof StationHttpError &&
          (query.error.status === 401 || query.error.status === 403)
            ? 'Access to this Task changed. Reopen it to continue.'
            : query.error instanceof StationHttpError &&
                query.error.status === 404
              ? 'Update this Station or enable the Task review preview.'
              : 'Review data could not be read. Reload it to check the current status.'
        }
        action={refresh('Reload review data')}
      />
    );
  if (!view) return <SkeletonBlock label="Loading code review" />;
  const selectedReviewer = reviewer || view.reviewers[0]?.slug || '';
  const selectedBase = base ?? view.workspace.baseSha ?? '';
  const blocked = !view.canRequest
    ? view.requestUnavailableReason === 'task-ended'
      ? 'This Task has ended. Its review history remains available.'
      : 'Your current access permits inspection but cannot start a review.'
    : !view.implementerAgentSlug
      ? 'Assign a lead agent to this Task before requesting review.'
      : !view.reviewers.length
        ? 'Configure a separate Codex agent to review this Task.'
        : view.workspace.state !== 'available' || !view.workspace.headSha
          ? 'The Task checkout must be available to request review.'
          : undefined;
  async function requestReview() {
    if (sending.current || !view?.workspace.headSha) return;
    const request: TaskCodeReviewRequest =
      uncertain && operation
        ? operation
        : {
            requestId: randomCorrelationId(),
            projectId,
            projectCreatedAt: view.projectCreatedAt,
            taskCreatedAt,
            baseSha: selectedBase.trim().toLowerCase(),
            headSha: view.workspace.headSha,
            reviewerAgentSlug: selectedReviewer,
          };
    try {
      sessionStorage.setItem(recoveryKey, JSON.stringify(request));
      setRecoveryError(false);
    } catch {
      setRecoveryError(true);
      return;
    }
    sending.current = true;
    setOperation(request);
    try {
      await mutation.mutateAsync(request);
    } catch (error) {
      if (
        error instanceof StationHttpError &&
        (error.status === 400 ||
          (error.status === 409 && error.code === 'review_request_conflict'))
      ) {
        try {
          sessionStorage.removeItem(recoveryKey);
        } catch {
          /* Retain a conservative recovery marker when storage is unavailable. */
        }
        setOperation(null);
      }
    } finally {
      sending.current = false;
    }
  }
  return (
    <section
      className="task-code-review task-workspace__section content-stack"
      aria-labelledby={`${id}-title`}
    >
      <div className="task-code-review__heading">
        <div>
          <h3 id={`${id}-title`}>Code review</h3>
          <p>Committed changes, reviewed independently.</p>
        </div>
        <ActionRow
          primary={refresh('Refresh code review')}
          overflowLabel="More code review actions"
        />
      </div>
      <StatusSummary
        title={
          view.workspace.kind === 'task-worktree'
            ? 'Task worktree'
            : view.workspace.kind === 'project-checkout'
              ? 'Project checkout'
              : 'Checkout unknown'
        }
        badge={
          view.workspace.state === 'unavailable'
            ? { label: 'Unavailable', tone: 'caution' }
            : null
        }
        current={
          view.workspace.branch === 'HEAD'
            ? 'Detached head'
            : view.workspace.branch
        }
        checkedAt={query.dataUpdatedAt}
      />
      {view.workspace.dirty && (
        <p className="task-code-review__note">
          Uncommitted changes are outside this review.
        </p>
      )}
      <DisclosureToggle
        expanded={details}
        onToggle={() => setDetails(!details)}
        controls={`${id}-details`}
      >
        Checkout and comparison
      </DisclosureToggle>
      {details && (
        <div id={`${id}-details`} className="task-code-review__details">
          <dl>
            <div>
              <dt>Path</dt>
              <dd>{view.workspace.path ?? 'Unavailable'}</dd>
            </div>
            <div>
              <dt>Branch</dt>
              <dd>{view.workspace.branch ?? 'Unavailable'}</dd>
            </div>
            <div>
              <dt>Head commit</dt>
              <dd>{view.workspace.headSha ?? 'Unavailable'}</dd>
            </div>
          </dl>
          <Field label="Base commit" htmlFor={`${id}-base`}>
            <Input
              id={`${id}-base`}
              value={selectedBase}
              onChange={(event) => setBase(event.target.value)}
              placeholder="Full commit SHA"
              spellCheck={false}
              disabled={uncertain || mutation.isPending}
            />
          </Field>
        </div>
      )}
      {blocked ? (
        <Empty
          variant="compact"
          label="Review cannot start"
          description={blocked}
          action={
            view.canRequest &&
            view.implementerAgentSlug &&
            !view.reviewers.length ? (
              <Button size="sm" onClick={() => navigate('/agents')}>
                Open Agents
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="task-code-review__request">
          <div className="task-code-review__controls">
            <Field
              className="task-code-review__reviewer"
              label="Reviewer"
              htmlFor={`${id}-reviewer`}
            >
              <Select
                id={`${id}-reviewer`}
                value={selectedReviewer}
                onChange={(event) => setReviewer(event.target.value)}
                disabled={uncertain || mutation.isPending}
              >
                {view.reviewers.map((agent) => (
                  <option key={agent.slug} value={agent.slug}>
                    {agent.name}
                  </option>
                ))}
              </Select>
            </Field>
            <ActionRow
              overflowLabel="More review request actions"
              primary={
                <Button
                  variant="primary"
                  onClick={() => void requestReview()}
                  pending={mutation.isPending}
                  pendingLabel="Requesting review…"
                  disabled={
                    !uncertain &&
                    (selectedBase.trim().toLowerCase() ===
                      view.workspace.headSha ||
                      !/^[a-f0-9]{40}$/i.test(selectedBase.trim()) ||
                      !view.reviewers.some(
                        (agent) => agent.slug === selectedReviewer,
                      ))
                  }
                >
                  {uncertain ? 'Retry request' : 'Request review'}
                </Button>
              }
            />
          </div>
          <p className="task-code-review__note">
            Runs the selected agent and may incur provider charges.
          </p>
          {(!selectedBase ||
            selectedBase.trim().toLowerCase() === view.workspace.headSha) && (
            <p>Choose an earlier base commit in Checkout and comparison.</p>
          )}
        </div>
      )}
      {recoveryError && (
        <ErrorState
          variant="compact"
          title="Request recovery could not be saved"
          description="Allow browser storage before requesting review."
          action={refresh('Check status')}
        />
      )}
      {uncertain && !reviewReconcile.exhausted && (
        <p role="status">Confirming review request…</p>
      )}
      {((uncertain && reviewReconcile.exhausted) ||
        (mutation.isError && !tracked && !uncertain)) && (
        <ErrorState
          variant="compact"
          title={
            uncertain ? 'Request outcome unknown' : 'Request could not complete'
          }
          description={
            uncertain
              ? 'Refresh to check delivery, or retry the same request and commits.'
              : errorText(mutation.error)
          }
          action={refresh('Check request')}
        />
      )}
      {mutation.isPending && (
        <p role="status">
          Review requested. Waiting for the provider response…
        </p>
      )}
      {view.requestsUnavailable && (
        <ErrorState
          variant="compact"
          title="Some review history is unavailable"
          description="Refresh to read the missing review records."
          action={refresh('Retry history')}
        />
      )}
      {view.requests.length ? (
        <div className="task-code-review__history">
          {view.requests.map((entry) => (
            <ReviewEntry key={entry.requestId} entry={entry} />
          ))}
        </div>
      ) : (
        !view.requestsUnavailable &&
        !blocked && (
          <Empty
            variant="compact"
            label="Nothing here yet"
            description="Request a review of the committed changes in this checkout."
          />
        )
      )}
      {view.omittedRequests > 0 && (
        <p className="task-code-review__note">
          {view.omittedRequests} older requests are not shown.
        </p>
      )}
    </section>
  );
}

function ReviewEntry({ entry }: { entry: TaskCodeReviewEntry }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const incomplete = entry.reviewers.some(
    (reviewer) => reviewer.status !== 'completed',
  );
  return (
    <article className="task-code-review__entry">
      <StatusSummary
        title={
          entry.reviewers.map((reviewer) => reviewer.name).join(', ') ||
          'Code review'
        }
        badge={{
          label:
            entry.state === 'completed'
              ? incomplete
                ? 'Review incomplete'
                : 'Review recorded'
              : stateLabels[entry.state],
          tone:
            entry.state === 'rejected' ||
            entry.state === 'indeterminate' ||
            incomplete
              ? 'caution'
              : 'neutral',
        }}
      />
      <p className="task-code-review__note">
        {entry.headSha
          ? freshnessLabels[entry.freshness]
          : 'Review evidence pending'}
      </p>
      {incomplete && (
        <p className="task-code-review__note">
          Reviewer execution did not complete.
        </p>
      )}
      {entry.failureReason && <p>{entry.failureReason}</p>}
      <DisclosureToggle
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        controls={`${id}-findings`}
      >
        {incomplete
          ? 'Review details'
          : `${entry.findings.length + entry.omittedFindings} ${entry.findings.length + entry.omittedFindings === 1 ? 'finding' : 'findings'} · Details`}
      </DisclosureToggle>
      {expanded && (
        <div id={`${id}-findings`}>
          <p className="task-code-review__note">
            Requested {new Date(entry.startedAt).toLocaleString()}
          </p>
          <dl>
            {entry.baseSha && (
              <div>
                <dt>Base commit</dt>
                <dd>
                  <code>{entry.baseSha}</code>
                </dd>
              </div>
            )}
            {entry.headSha && (
              <div>
                <dt>Reviewed commit</dt>
                <dd>
                  <code>{entry.headSha}</code>
                </dd>
              </div>
            )}
            {entry.receiptId && (
              <div>
                <dt>Receipt</dt>
                <dd>
                  <code>{entry.receiptId}</code>
                </dd>
              </div>
            )}
          </dl>
          {entry.findings.length ? (
            <ul>
              {entry.findings.map((finding) => (
                <li key={finding.findingId}>
                  <strong>{finding.summary}</strong>
                  <p>
                    <Badge
                      value={finding.severity}
                      tone={
                        finding.severity === 'critical' ||
                        finding.severity === 'high'
                          ? 'negative'
                          : finding.severity === 'medium'
                            ? 'caution'
                            : 'neutral'
                      }
                    />{' '}
                    <code>
                      {finding.location.file}:{finding.location.line}
                    </code>
                  </p>
                  <p>{finding.scenario.stateOrInput}</p>
                  <p>{finding.scenario.wrongOutcome}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p>
              {incomplete
                ? 'Findings are unavailable because the review did not finish.'
                : 'No findings recorded. Review evidence is separate from acceptance.'}
            </p>
          )}
          {entry.omittedFindings > 0 && (
            <p>{entry.omittedFindings} additional findings are not shown.</p>
          )}
        </div>
      )}
    </article>
  );
}
