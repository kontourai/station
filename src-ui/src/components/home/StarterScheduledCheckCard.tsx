import {
  SCHEDULED_CHECK_STARTER_DEFINITION_VERSION,
  type ScheduledCheckStarterLaunchResult,
  type StarterScheduledCheckObservation,
  type StarterWorkObservation,
} from '@kontourai/station-contracts/starter-work';
import {
  useLaunchScheduledCheckStarterMutation,
  useStarterWorkObservationQuery,
  useStarterWorkQuery,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import { useNavigation } from '../../contexts/NavigationContext';
import { Button } from '../Button';
import { SkeletonBlock } from '../state';
import { navigateStarterHref } from './starterNavigation';

const STARTER_ID = 'run-scheduled-check' as const;

function isScheduledObservation(
  value: StarterWorkObservation | undefined,
): value is StarterScheduledCheckObservation {
  return value?.starterId === STARTER_ID;
}

export async function scheduledCheckOperationId(): Promise<string> {
  if (!globalThis.crypto?.subtle)
    throw new Error('Secure Starter identity is unavailable.');
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      `${STARTER_ID}\0definition:${SCHEDULED_CHECK_STARTER_DEFINITION_VERSION}`,
    ),
  );
  return `scheduled-check:${SCHEDULED_CHECK_STARTER_DEFINITION_VERSION}:${[
    ...new Uint8Array(digest),
  ]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
}

export function StarterScheduledCheckCard() {
  const { navigate } = useNavigation();
  const status = useStarterWorkQuery(STARTER_ID);
  const bound = status.data?.state === 'bound';
  const observation = useStarterWorkObservationQuery(STARTER_ID, {
    enabled: bound,
  });
  const scheduledObservation = isScheduledObservation(observation.data)
    ? observation.data
    : undefined;
  const launch = useLaunchScheduledCheckStarterMutation();
  const [launchResult, setLaunchResult] =
    useState<ScheduledCheckStarterLaunchResult>();
  const loading = status.isLoading || (bound && observation.isLoading);
  const failed =
    status.isError ||
    status.data?.state === 'unavailable' ||
    (bound && observation.isError);
  const completion = scheduledObservation?.completion.state;
  const href = scheduledObservation?.href;

  const run = async (inspectRunning = false) => {
    const operationId =
      status.data?.state === 'bound'
        ? status.data.binding.operationId
        : await scheduledCheckOperationId();
    const result = await launch.mutateAsync({
      starterId: STARTER_ID,
      operationId,
    });
    setLaunchResult(result);
    if (result.state === 'started') navigateStarterHref(navigate, result.href);
    else if (inspectRunning && result.state === 'deferred' && href)
      navigateStarterHref(navigate, href);
  };

  if (loading)
    return (
      <section
        className="starter-work-card"
        aria-label="Run a scheduled readiness check"
        aria-busy="true"
      >
        <SkeletonBlock count={1} label="Checking scheduled readiness work" />
      </section>
    );

  const terminalConcern =
    completion === 'failed' || completion === 'indeterminate';
  const blockedLaunch =
    launchResult?.state !== undefined && launchResult.state !== 'started'
      ? launchResult
      : undefined;
  return (
    <section
      className="starter-work-card"
      aria-label="Run a scheduled readiness check"
    >
      <div>
        <p className="starter-work-card__title">
          Run a scheduled readiness check
        </p>
        <p className="starter-work-card__body">
          {failed
            ? 'The Scheduler receipt owner is unavailable.'
            : terminalConcern
              ? `The exact check is ${completion}. Inspect its receipt before taking another action.`
              : completion === 'completed'
                ? 'The exact check completed. Its findings remain evidence input, not a gate verdict.'
                : completion === 'running'
                  ? 'The exact check is running.'
                  : blockedLaunch
                    ? blockedLaunch.reason
                    : 'Create a disabled daily check and run it once through the real Scheduler.'}
        </p>
        {launch.isError && (
          <p className="starter-work-card__body" role="alert">
            The response was not confirmed. Retry uses the same operation and
            cannot start another run.
          </p>
        )}
      </div>
      {href && completion === 'running' ? (
        <Button
          variant="primary"
          pending={launch.isPending}
          onClick={() => void run(true)}
        >
          Resume exact check
        </Button>
      ) : href ? (
        <Button
          variant="primary"
          onClick={() => navigateStarterHref(navigate, href)}
        >
          {terminalConcern ? 'Inspect receipt' : 'Open scheduled check'}
        </Button>
      ) : failed ? (
        <Button
          onClick={() => {
            void status.refetch();
            void observation.refetch();
          }}
        >
          Retry scheduled check status
        </Button>
      ) : blockedLaunch?.retrySafe === false ? (
        <Button variant="primary" onClick={() => navigate('/schedule')}>
          Open Schedule
        </Button>
      ) : (
        <Button
          variant="primary"
          pending={launch.isPending}
          onClick={() => void run()}
        >
          Run check
        </Button>
      )}
    </section>
  );
}
