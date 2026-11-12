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
import { requireSubtleCrypto, toHex } from '../../utils/sha256';
import { Button } from '../Button';
import { PageCallout } from '../PageCallout';
import { SkeletonBlock } from '../state';
import { navigateStarterHref } from './starterNavigation';

const STARTER_ID = 'run-scheduled-check' as const;

/**
 * One identity across every state this card renders. #1582 C4: it is the same
 * page callout as Home's other offers — same border, same tone scale, same
 * action row — rather than a fourth hand-rolled card.
 */
const CALLOUT_ID = 'starter-scheduled-check';
const CALLOUT_LABEL = 'Run a scheduled readiness check';

function isScheduledObservation(
  value: StarterWorkObservation | undefined,
): value is StarterScheduledCheckObservation {
  return value?.starterId === STARTER_ID;
}

async function scheduledCheckOperationId(): Promise<string> {
  const subtle = requireSubtleCrypto('Secure Starter identity is unavailable.');
  const digest = await subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      `${STARTER_ID}\0definition:${SCHEDULED_CHECK_STARTER_DEFINITION_VERSION}`,
    ),
  );
  return `scheduled-check:${SCHEDULED_CHECK_STARTER_DEFINITION_VERSION}:${toHex(
    new Uint8Array(digest),
  )}`;
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
      <PageCallout calloutId={CALLOUT_ID} ariaLabel={CALLOUT_LABEL} busy>
        <SkeletonBlock count={1} label="Checking scheduled readiness work" />
      </PageCallout>
    );

  const terminalConcern =
    completion === 'failed' || completion === 'indeterminate';
  const blockedLaunch =
    launchResult?.state !== undefined && launchResult.state !== 'started'
      ? launchResult
      : undefined;
  return (
    <PageCallout
      calloutId={CALLOUT_ID}
      // An owner Station cannot reach, or a check that ended badly, is not an
      // ordinary offer — the banner scale's own word for it is `warning`.
      tone={failed || terminalConcern ? 'warning' : 'info'}
      ariaLabel={CALLOUT_LABEL}
      title="Run a scheduled readiness check"
      action={
        href && completion === 'running' ? (
          <Button
            variant="primary"
            pending={launch.isPending}
            onClick={() => void run(true)}
          >
            Resume check
          </Button>
        ) : href ? (
          <Button
            variant="primary"
            onClick={() => navigateStarterHref(navigate, href)}
          >
            {terminalConcern ? 'Open result' : 'Open scheduled check'}
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
          <Button variant="primary" onClick={() => navigate('/automations')}>
            Open Automations
          </Button>
        ) : (
          <Button
            variant="primary"
            pending={launch.isPending}
            onClick={() => void run()}
          >
            Run check
          </Button>
        )
      }
    >
      {failed
        ? 'Scheduled check status is unavailable.'
        : terminalConcern
          ? completion === 'failed'
            ? 'The check failed. Open its result before taking another action.'
            : 'The check may not have finished. Open its result before taking another action.'
          : completion === 'completed'
            ? "The check completed. Its findings don't approve or block a gate."
            : completion === 'running'
              ? 'The check is running.'
              : blockedLaunch
                ? blockedLaunch.reason
                : 'Create a daily check, off until you turn it on, and run it once.'}
      {launch.isError && (
        <p className="page-callout__notice" role="alert">
          Station didn't confirm the start. Retry won't start a second run.
        </p>
      )}
    </PageCallout>
  );
}
