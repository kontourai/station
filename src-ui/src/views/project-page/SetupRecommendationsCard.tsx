import {
  taskQueries,
  useCreateTaskMutation,
  useCreateTaskReferenceMutation,
  useQueryClient,
  useTasksQuery,
  useUpdateProjectMutation,
} from '@kontourai/station-sdk';
import { useId, useMemo, useState } from 'react';
import { ActionRow } from '../../components/ActionRow';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Checkbox';
import { ErrorState } from '../../components/state';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import {
  clearPendingContinuation,
  readPendingContinuation,
} from '../../lib/continue-in-project';
import { errorText } from '../../utils/errorText';
import {
  type SetupRecommendation,
  settleSetupRecommendations,
  setupRecommendations,
  setupRecommendationsSettled,
} from './setup-recommendations';
import './SetupRecommendationsCard.css';

/**
 * #5071: a new Project starts with Setup recommendations instead of an empty
 * page. Each is toggled on and visible; Apply creates what is still on, and
 * nothing is created before that. Shown while the Project has no Tasks and
 * the person has neither applied nor dismissed it.
 */
export function SetupRecommendationsCard(props: {
  project: { id: string; slug: string; name: string; description?: string };
  hasRepository: boolean;
}) {
  const enabled = useSurfaceVisibilityFlags().has('continue-in-project');
  return enabled ? <SetupRecommendations {...props} /> : null;
}

function SetupRecommendations({
  project,
  hasRepository,
}: {
  project: { id: string; slug: string; name: string; description?: string };
  hasRepository: boolean;
}) {
  const tasks = useTasksQuery(project.slug);
  const [settled, setSettled] = useState(() =>
    setupRecommendationsSettled(project.id),
  );
  const [continuation] = useState(() => readPendingContinuation(new Date()));
  // Recomputed as facts arrive (the repository check answers after paint);
  // a recommendation that appears later starts on, like the rest.
  const recommendations = useMemo(
    () =>
      setupRecommendations({
        project: {
          name: project.name,
          ...(project.description ? { description: project.description } : {}),
          hasRepository,
        },
        ...(continuation ? { continuation } : {}),
      }),
    [project.name, project.description, hasRepository, continuation],
  );
  if (
    settled ||
    !tasks.isSuccess ||
    (tasks.data?.length ?? 0) > 0 ||
    recommendations.length === 0
  )
    return null;
  return (
    <SetupRecommendationsForm
      project={project}
      recommendations={recommendations}
      onSettled={(outcome) => {
        settleSetupRecommendations(project.id, outcome);
        if (continuation) clearPendingContinuation();
        setSettled(true);
      }}
    />
  );
}

function SetupRecommendationsForm({
  project,
  recommendations,
  onSettled,
}: {
  project: { id: string; slug: string; name: string };
  recommendations: SetupRecommendation[];
  onSettled(outcome: 'applied' | 'dismissed'): void;
}) {
  const headingId = useId();
  const briefId = useId();
  const queryClient = useQueryClient();
  const createTask = useCreateTaskMutation();
  const createReference = useCreateTaskReferenceMutation();
  const updateProject = useUpdateProjectMutation();
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const isOn = (id: string) => enabled[id] ?? true;
  const briefRecommendation = recommendations.find(
    (item) => item.kind === 'brief',
  );
  const [brief, setBrief] = useState(
    briefRecommendation?.kind === 'brief' ? briefRecommendation.brief : '',
  );
  /** Recommendations already applied, so a retry never creates one twice. */
  const [applied, setApplied] = useState<Record<string, true>>({});
  /** Tasks created whose citation has not landed yet; a retry reuses them. */
  const [createdTasks, setCreatedTasks] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();
  const chosen = recommendations.filter((item) => isOn(item.id));

  async function apply() {
    setPending(true);
    setFailure(undefined);
    const done = { ...applied };
    const created = { ...createdTasks };
    try {
      for (const item of chosen) {
        if (done[item.id]) continue;
        if (item.kind === 'brief') {
          if (brief.trim())
            await updateProject.mutateAsync({
              slug: project.slug,
              description: brief.trim(),
            });
        } else {
          const taskId =
            created[item.id] ??
            (
              await createTask.mutateAsync({
                projectId: project.slug,
                title: item.task.title,
                description: item.task.description,
                createdBy: 'user',
              })
            ).id;
          created[item.id] = taskId;
          setCreatedTasks({ ...created });
          if (item.task.reference)
            await createReference.mutateAsync({
              taskId,
              kind: 'turn',
              sessionId: item.task.reference.sessionId,
              turnId: item.task.reference.turnId,
              sourceSurface: 'chat',
            });
        }
        done[item.id] = true;
        setApplied({ ...done });
      }
      await queryClient.invalidateQueries({
        queryKey: taskQueries.list(project.slug).queryKey,
      });
      onSettled('applied');
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="setup-recommendations" aria-labelledby={headingId}>
      <h2 id={headingId} className="setup-recommendations__title">
        Setup recommendations
      </h2>
      <p className="setup-recommendations__lede">
        Turn off anything you don't want. Nothing is added until you apply.
      </p>
      <ul className="setup-recommendations__list">
        {recommendations.map((item) => (
          <li key={item.id} className="setup-recommendations__item">
            <Checkbox
              checked={isOn(item.id)}
              disabled={pending || applied[item.id] === true}
              onChange={(checked) =>
                setEnabled((current) => ({ ...current, [item.id]: checked }))
              }
            >
              <span className="setup-recommendations__toggle-text">
                <strong>
                  {item.kind === 'task'
                    ? `New Task: ${item.label}`
                    : item.label}
                </strong>
                {item.kind === 'task' && <small>{item.detail}</small>}
              </span>
            </Checkbox>
            {item.kind === 'brief' && isOn(item.id) && (
              <>
                <label
                  className="setup-recommendations__brief-label"
                  htmlFor={briefId}
                >
                  Brief for {project.name}
                </label>
                <textarea
                  id={briefId}
                  className="setup-recommendations__brief"
                  rows={3}
                  value={brief}
                  disabled={pending || applied[item.id] === true}
                  onChange={(event) => setBrief(event.currentTarget.value)}
                />
              </>
            )}
          </li>
        ))}
      </ul>
      {failure && (
        <ErrorState
          variant="compact"
          title="Setup didn't finish"
          description={`${failure} What was added stays; Apply again adds the rest.`}
        />
      )}
      <ActionRow
        overflowLabel="More setup actions"
        primary={
          <Button
            variant="primary"
            disabled={pending || chosen.length === 0}
            onClick={() => void apply()}
          >
            {pending ? 'Applying…' : 'Apply'}
          </Button>
        }
        secondary={
          <Button disabled={pending} onClick={() => onSettled('dismissed')}>
            Not now
          </Button>
        }
      />
    </section>
  );
}
