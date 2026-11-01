import type {
  ProjectSupervisionIntent,
  ProjectSupervisionView,
} from '@kontourai/station-contracts/project-supervision';
import {
  getJson,
  mutateJson,
  readEnvelopeOrThrow,
} from '@kontourai/station-sdk';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Button } from '../../components/Button';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import { errorText } from '../../utils/errorText';
import './TaskSupervisionPanel.css';

export function TaskSupervisionPanel(props: {
  taskId: string;
  taskCreatedAt: string;
  projectId: string;
  authority: ApiRequestScope;
}) {
  const flags = useSurfaceVisibilityFlags();
  return flags.has('project-supervision') ? (
    <SupervisionControls {...props} />
  ) : null;
}
function SupervisionControls({
  taskId,
  taskCreatedAt,
  projectId,
  authority,
}: {
  taskId: string;
  taskCreatedAt: string;
  projectId: string;
  authority: ApiRequestScope;
}) {
  const client = useQueryClient();
  const key = [
    'project-supervision',
    authority.apiBase,
    authority.authorityKey,
    projectId,
    taskId,
    taskCreatedAt,
  ];
  const path = `${authority.apiBase}/api/tasks/${encodeURIComponent(taskId)}/supervision?taskCreatedAt=${encodeURIComponent(taskCreatedAt)}`;
  const query = useQuery({
    queryKey: key,
    retry: false,
    queryFn: async () => {
      const response = await getJson(path, { requestScope: authority });
      if (response.status === 404 || response.status === 501)
        throw new Error(
          'Project supervision is unavailable. Enable its Feature Preview or update this Station.',
        );
      return readEnvelopeOrThrow<ProjectSupervisionView>(response);
    },
  });
  const [maxWakes, setMaxWakes] = useState(3);
  const id = useId();
  const mutate = useMutation({
    retry: false,
    mutationFn: async (state: ProjectSupervisionIntent['state']) => {
      const view = query.data;
      if (
        !view?.coordinatorConversationId &&
        !view?.intent?.coordinatorConversationId
      )
        throw new Error(
          'Designate your coordinator before enabling supervision.',
        );
      return readEnvelopeOrThrow(
        await mutateJson(
          path,
          'PUT',
          { requestScope: authority },
          {
            projectId,
            taskCreatedAt,
            expectedGeneration: view?.intent?.generation ?? 0,
            state,
            coordinatorConversationId:
              view?.intent?.coordinatorConversationId ??
              view?.coordinatorConversationId,
            policy: view?.intent?.policy ?? {
              maxWakes,
              maxNoProgressWakes: 2,
              minIntervalMs: 60_000,
              stopAt: (view?.serverNow ?? 0) + 24 * 60 * 60_000,
            },
          },
        ),
      );
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: key });
    },
  });
  const intent = query.data?.intent;
  return (
    <section
      aria-label="Project supervision"
      className="task-supervision-panel"
    >
      <h3>Project supervision</h3>
      <p>Wake the coordinator when an actionable Task checkpoint changes.</p>
      {query.isLoading && <SkeletonBlock />}
      {query.isError && (
        <ErrorState
          variant="compact"
          title={errorText(query.error)}
          action={
            <Button onClick={() => void query.refetch()}>
              Reload supervision
            </Button>
          }
        />
      )}
      {query.data && !intent && (
        <>
          <Empty
            variant="compact"
            label="Supervision is off"
            description="Enabling it can spend model credits. It grants no setup or publication permission."
          />
          <label htmlFor={id}>Maximum coordinator wakes</label>
          <input
            id={id}
            type="number"
            min={1}
            max={12}
            value={maxWakes}
            onChange={(event) => setMaxWakes(Number(event.target.value))}
          />
          <p>
            Stops after one day, completion, cancellation or two wakes without a
            new substantive checkpoint.
          </p>
          <Button
            variant="primary"
            disabled={
              mutate.isPending ||
              !query.data.coordinatorConversationId ||
              !Number.isInteger(maxWakes) ||
              maxWakes < 1 ||
              maxWakes > 12
            }
            onClick={() => mutate.mutate('active')}
          >
            Enable supervision
          </Button>
        </>
      )}
      {intent && (
        <>
          <dl>
            <dt>State</dt>
            <dd>{intent.state}</dd>
            <dt>Observed wait</dt>
            <dd>{intent.observation?.wait ?? 'unknown'}</dd>
            <dt>Reason</dt>
            <dd>{intent.observation?.reason ?? 'No observation yet'}</dd>
            <dt>Next eligible action</dt>
            <dd>
              {intent.observation?.nextEligibleAt
                ? new Date(intent.observation.nextEligibleAt).toISOString()
                : 'No eligible action observed'}
            </dd>
            <dt>Last substantive checkpoint</dt>
            <dd>{intent.observation?.checkpointRevision || 'unknown'}</dd>
          </dl>
          {intent.attention && <p>{intent.attention}</p>}
          {intent.state === 'active' ? (
            <Button
              disabled={mutate.isPending}
              onClick={() => mutate.mutate('paused')}
            >
              Pause supervision
            </Button>
          ) : (
            <Button
              disabled={mutate.isPending}
              onClick={() => mutate.mutate('active')}
            >
              Resume supervision
            </Button>
          )}
          {intent.state !== 'cancelled' && (
            <Button
              disabled={mutate.isPending}
              onClick={() => mutate.mutate('cancelled')}
            >
              Stop supervision
            </Button>
          )}
          <details>
            <summary>Wake limits and recent outcomes (up to 20)</summary>
            <p>
              {intent.policy.maxWakes} wakes; stop at{' '}
              {new Date(intent.policy.stopAt).toISOString()}.
            </p>
            <ul>
              {query.data?.wakes.map((wake) => (
                <li key={wake.id}>
                  {wake.state}
                  {wake.reason ? `: ${wake.reason}` : ''}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
      {mutate.isError && (
        <ErrorState
          variant="compact"
          title={errorText(mutate.error)}
          action={
            <Button onClick={() => void query.refetch()}>
              Check supervision outcome
            </Button>
          }
        />
      )}
    </section>
  );
}
