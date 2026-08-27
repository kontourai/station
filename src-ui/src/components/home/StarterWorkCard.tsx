import { useStarterWorkQuery, useTaskQuery } from '@kontourai/station-sdk';
import { useNavigation } from '../../contexts/NavigationContext';
import { useProjects } from '../../contexts/ProjectsContext';
import { Button } from '../Button';
import { SkeletonBlock } from '../state';

const START_TASK = 'start-task';

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
    return (
      <section
        className="starter-work-card"
        role="status"
        aria-label="Starter work"
      >
        Starter Work is unavailable.{' '}
        <Button onClick={() => void starter.refetch()}>Retry</Button>
      </section>
    );
  if (starter.isLoading || !status)
    return (
      <section
        className="starter-work-card"
        aria-label="Starter work"
        aria-busy="true"
      >
        <SkeletonBlock count={1} label="Checking starter work" />
      </section>
    );
  if (status.state === 'unavailable')
    return (
      <section
        className="starter-work-card"
        role="status"
        aria-label="Starter work"
      >
        Starter Work is unavailable.{' '}
        <Button onClick={() => void starter.refetch()}>Retry</Button>
      </section>
    );
  if (status?.state === 'bound' && status.binding.targetRef.kind === 'task') {
    if (boundTask.isLoading)
      return (
        <section
          className="starter-work-card"
          aria-label="Starter work"
          aria-busy="true"
        >
          <SkeletonBlock count={1} label="Resolving your starter task" />
        </section>
      );
    if (boundTask.isError || !boundTask.data)
      return (
        <section
          className="starter-work-card"
          role="status"
          aria-label="Starter work"
        >
          {/* station#3965: was "Starter task is NOT_VERIFIED or unavailable" —
              an internal verification token, and two states at once. */}
          We couldn’t open your first task.{' '}
          <Button onClick={() => void boundTask.refetch()}>Try again</Button>
        </section>
      );
    return (
      <section
        className="starter-work-card"
        aria-label="Starter work"
        data-testid="starter-work-card"
      >
        <div>
          <p className="starter-work-card__title">Your first task is ready</p>
          <p className="starter-work-card__body">
            Resume the exact task you started.
          </p>
        </div>
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
      </section>
    );
  }
  return (
    <section
      className="starter-work-card"
      aria-label="Starter work"
      data-testid="starter-work-card"
    >
      <div>
        <p className="starter-work-card__title">Start your first task</p>
        <p className="starter-work-card__body">
          Create one focused task in {projects[0].name || projects[0].slug}.
        </p>
      </div>
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
    </section>
  );
}
