import { useStarterWorkQuery, useTaskQuery } from '@kontourai/station-sdk';
import { useNavigation } from '../../contexts/NavigationContext';
import { useProjects } from '../../contexts/ProjectsContext';
import { Button } from '../Button';
import { PageCallout } from '../PageCallout';
import { SkeletonBlock } from '../state';

const START_TASK = 'start-task';

/**
 * One identity across every state this card renders — loading, unavailable,
 * bound, unbound. They are the same offer in different conditions, so a
 * stack must never show two of them.
 */
const STARTER_CALLOUT_ID = 'starter-work';

/**
 * The Home affordance owns no completion state.  It offers an existing Task
 * creation surface for a real Project, and on later visits opens the exact
 * bound Task.  The Starter Work ledger is correlation only.
 */
export function StarterWorkCard() {
  const { projects, isLoading } = useProjects();
  const { navigate } = useNavigation();
  const starter = useStarterWorkQuery(START_TASK);
  const status = starter.data;
  const boundTaskId =
    status?.state === 'bound' && status.binding.targetRef.kind === 'task'
      ? status.binding.targetRef.id
      : '';
  const boundTask = useTaskQuery(boundTaskId, {
    enabled: boundTaskId.length > 0,
  });

  // No project means there is no valid owner for a Task.  Do not synthesize
  // one merely to make an onboarding card actionable.
  if (isLoading || projects.length === 0) return null;
  if (starter.isError)
    return <StarterWorkUnavailable onRetry={() => void starter.refetch()} />;
  if (starter.isLoading || !status)
    return (
      <PageCallout calloutId={STARTER_CALLOUT_ID} ariaLabel="Starter work" busy>
        <SkeletonBlock count={1} label="Checking starter work" />
      </PageCallout>
    );
  if (status.state === 'unavailable')
    return <StarterWorkUnavailable onRetry={() => void starter.refetch()} />;
  if (status?.state === 'bound' && status.binding.targetRef.kind === 'task') {
    if (boundTask.isLoading)
      return (
        <PageCallout
          calloutId={STARTER_CALLOUT_ID}
          ariaLabel="Starter work"
          busy
        >
          <SkeletonBlock count={1} label="Resolving your starter task" />
        </PageCallout>
      );
    if (boundTask.isError || !boundTask.data)
      return (
        <PageCallout
          calloutId={STARTER_CALLOUT_ID}
          tone="warning"
          ariaLabel="Starter work"
          role="status"
          action={
            <Button onClick={() => void boundTask.refetch()}>Try again</Button>
          }
        >
          {/* archive#3965: was "Starter task is NOT_VERIFIED or unavailable" —
              an internal verification token, and two states at once. */}
          We couldn’t open your first task.
        </PageCallout>
      );
    return (
      <PageCallout
        calloutId={STARTER_CALLOUT_ID}
        ariaLabel="Starter work"
        data-testid="starter-work-card"
        title="Your first task is ready"
        action={
          <Button
            variant="primary"
            onClick={() =>
              navigate(
                `/tasks/${encodeURIComponent(status.binding.targetRef.id)}`,
              )
            }
          >
            Open task
          </Button>
        }
      >
        Resume the exact task you started.
      </PageCallout>
    );
  }
  return (
    <PageCallout
      calloutId={STARTER_CALLOUT_ID}
      ariaLabel="Starter work"
      data-testid="starter-work-card"
      title="Start your first task"
      action={
        <Button
          variant="primary"
          onClick={() =>
            navigate(`/projects/${encodeURIComponent(projects[0].slug)}`, {
              starter: START_TASK,
            })
          }
        >
          Create task
        </Button>
      }
    >
      Create one focused task in {projects[0].name || projects[0].slug}.
    </PageCallout>
  );
}

/**
 * One unreachable-ledger state, rendered from one place. It was written out
 * twice — for the query error and for the server's own `unavailable` — with
 * byte-identical copy, which is two chances for the two to drift apart.
 */
function StarterWorkUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <PageCallout
      calloutId={STARTER_CALLOUT_ID}
      tone="warning"
      ariaLabel="Starter work"
      role="status"
      action={<Button onClick={onRetry}>Retry</Button>}
    >
      Starter Work is unavailable.
    </PageCallout>
  );
}
