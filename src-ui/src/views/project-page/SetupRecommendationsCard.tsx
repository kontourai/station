import {
  useCreateTaskMutation,
  useCreateTaskReferenceMutation,
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
  clearProjectContinuation,
  readProjectContinuation,
} from '../../lib/continue-in-project';
import {
  type ProjectRecoveryScope,
  projectCreationRecoveryIdentity,
} from '../../lib/project-onboarding-recovery';
import { errorText } from '../../utils/errorText';
import {
  type SetupRecommendation,
  settleSetupRecommendations,
  setupRecommendations,
  setupRecommendationsSettled,
} from './setup-recommendations';
import './SetupRecommendationsCard.css';

type SetupRequestScope = ProjectRecoveryScope & { isCurrent: () => boolean };

/** Setup recommendations start on an empty Project and stay available while its setup is in progress. */
export function SetupRecommendationsCard(props: {
  project: { id: string; slug: string; name: string; description?: string };
  hasRepository: boolean;
  requestScope: SetupRequestScope;
}) {
  const enabled = useSurfaceVisibilityFlags().has('continue-in-project');
  const { requestScope } = props;
  return enabled && requestScope.isCurrent() ? (
    <SetupRecommendations
      key={JSON.stringify([
        projectCreationRecoveryIdentity(requestScope),
        requestScope.authorityKey,
        props.project.id,
      ])}
      {...props}
    />
  ) : null;
}

function SetupRecommendations({
  project,
  hasRepository,
  requestScope,
}: Parameters<typeof SetupRecommendationsCard>[0]) {
  const tasks = useTasksQuery(project.slug, { requestScope });
  const [startedRecommendations, setStartedRecommendations] =
    useState<SetupRecommendation[]>();
  const [settled, setSettled] = useState(() =>
    setupRecommendationsSettled(project.id),
  );
  const [continuation] = useState(() =>
    readProjectContinuation(requestScope, project.id),
  );
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
    (!startedRecommendations &&
      (!tasks.isSuccess ||
        tasks.data?.length !== 0 ||
        recommendations.length === 0))
  )
    return null;
  return (
    <SetupRecommendationsForm
      project={project}
      recommendations={startedRecommendations ?? recommendations}
      requestScope={requestScope}
      onStarted={() =>
        setStartedRecommendations((started) => started ?? recommendations)
      }
      onSettled={(outcome) => {
        if (!requestScope.isCurrent()) return;
        settleSetupRecommendations(project.id, outcome);
        if (continuation) clearProjectContinuation(requestScope, project.id);
        setSettled(true);
      }}
    />
  );
}

function SetupRecommendationsForm({
  project,
  recommendations,
  requestScope,
  onStarted,
  onSettled,
}: {
  project: { id: string; slug: string; name: string };
  recommendations: SetupRecommendation[];
  requestScope: SetupRequestScope;
  onStarted(): void;
  onSettled(outcome: 'applied' | 'dismissed'): void;
}) {
  const headingId = useId();
  const briefId = useId();
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
    if (!requestScope.isCurrent()) return;
    onStarted();
    setPending(true);
    setFailure(undefined);
    const done = { ...applied };
    const created = { ...createdTasks };
    try {
      for (const item of chosen) {
        if (!requestScope.isCurrent()) return;
        if (done[item.id]) continue;
        if (item.kind === 'brief') {
          if (brief.trim())
            await updateProject.mutateAsync({
              slug: project.slug,
              description: brief.trim(),
              requestScope,
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
                requestScope,
              })
            ).id;
          if (!requestScope.isCurrent()) return;
          created[item.id] = taskId;
          setCreatedTasks({ ...created });
          if (item.task.reference)
            await createReference.mutateAsync({
              taskId,
              kind: 'turn',
              sessionId: item.task.reference.sessionId,
              turnId: item.task.reference.turnId,
              sourceSurface: 'chat',
              requestScope,
            });
        }
        done[item.id] = true;
        setApplied({ ...done });
      }
      onSettled('applied');
    } catch (error) {
      if (requestScope.isCurrent()) setFailure(errorText(error));
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
