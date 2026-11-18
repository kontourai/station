import {
  taskQueries,
  useCreateTaskMutation,
  useCreateTaskReferenceMutation,
  useQueryClient,
} from '@kontourai/station-sdk';
import { Select } from '@kontourai/ui/react';
import { useId, useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { useProjects } from '../../contexts/ProjectsContext';
import {
  type ContinuedConversation,
  draftProjectFromConversation,
  draftTaskFromConversation,
  PROJECT_CONTINUATION_PARAM,
  stageProjectContinuation,
} from '../../lib/continue-in-project';
import { projectCreationRecoveryIdentity } from '../../lib/project-onboarding-recovery';
import { errorText } from '../../utils/errorText';
import { StationUiError } from '../../utils/StationUiError';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { ErrorState } from '../state';
import './ContinueInProjectDialog.css';

const NEW_PROJECT = '/projects/new';
const STATION_CHANGED =
  'Station access changed. Return to the original Station to continue.';

export function ContinueInProjectDialog({
  conversation,
  sourceOwnerKey,
  sourceProjectSlug,
  onClose,
  now = () => new Date(),
}: {
  conversation: ContinuedConversation;
  sourceOwnerKey?: string;
  sourceProjectSlug?: string;
  onClose: () => void;
  now?: () => Date;
}) {
  const { navigate } = useNavigation();
  const authority = useHostRequestAuthorityScope();
  const [ownerKey] = useState(
    () =>
      sourceOwnerKey ??
      (authority ? projectCreationRecoveryIdentity(authority) : undefined),
  );
  const ownerMatches =
    authority !== undefined &&
    projectCreationRecoveryIdentity(authority) === ownerKey;
  const ownerCurrent = ownerMatches && authority.isCurrent();
  const { projects, isConfirmedLoaded, isLoading } = useProjects();
  const boundProjectSlug = conversation.latestTurnId
    ? sourceProjectSlug
    : undefined;
  const destinationProjects = boundProjectSlug
    ? projects.filter(({ slug }) => slug === boundProjectSlug)
    : projects;
  const queryClient = useQueryClient();
  const createTask = useCreateTaskMutation();
  const createReference = useCreateTaskReferenceMutation();
  const [chosenProject, setChosenProject] = useState<string>();
  const projectChoice =
    boundProjectSlug ??
    chosenProject ??
    (isConfirmedLoaded && projects.length === 0 ? NEW_PROJECT : '');
  const newProject = projectChoice === NEW_PROJECT;
  const selectedProject = destinationProjects.find(
    ({ slug }) => slug === projectChoice,
  );
  const projectSlug = selectedProject?.slug ?? '';
  const [taskDraft] = useState(() =>
    draftTaskFromConversation(conversation, now()),
  );
  const [title, setTitle] = useState(taskDraft.title);
  const [description, setDescription] = useState(taskDraft.description);
  const [failure, setFailure] = useState<string>();
  const [createdTask, setCreatedTask] = useState<{
    id: string;
    projectSlug: string;
    projectName: string;
    title: string;
    citationAdded: boolean;
  }>();
  const [pending, setPending] = useState(false);
  const needsCitation = Boolean(
    createdTask && conversation.latestTurnId && !createdTask.citationAdded,
  );
  const projectId = useId();
  const titleId = useId();
  const descriptionId = useId();

  function captureOwner() {
    if (!ownerMatches || !authority.isCurrent())
      throw new StationUiError(STATION_CHANGED);
    return authority;
  }

  function continueInNewProject() {
    let owner: ReturnType<typeof captureOwner>;
    try {
      owner = captureOwner();
    } catch (error) {
      setFailure(errorText(error));
      return;
    }
    const at = now();
    const draft = draftProjectFromConversation(conversation, at);
    const continuationId = stageProjectContinuation(owner, {
      projectDraft: draft,
      sessionId: conversation.sessionId,
      ...(conversation.latestTurnId
        ? { turnId: conversation.latestTurnId }
        : {}),
      title: taskDraft.title,
      description: taskDraft.description,
      savedAt: at.toISOString(),
    });
    if (!continuationId) {
      setFailure(
        'Couldn’t save the draft in this tab. Try again or choose an existing Project.',
      );
      return;
    }
    onClose();
    navigate(NEW_PROJECT, { [PROJECT_CONTINUATION_PARAM]: continuationId });
  }

  async function continueInExistingProject() {
    if (pending || (!createdTask && (!projectSlug || !title.trim()))) return;
    setFailure(undefined);
    setPending(true);
    try {
      const owner = captureOwner();
      const requireCurrentOwner = () => {
        if (!owner.isCurrent()) throw new StationUiError(STATION_CHANGED);
      };
      let task = createdTask;
      if (!task) {
        const projectName = selectedProject?.name || projectSlug;
        const record = await createTask.mutateAsync({
          requestScope: owner,
          projectId: projectSlug,
          title: title.trim(),
          description: description.trim(),
          createdBy: 'user',
        });
        task = {
          id: record.id,
          title: record.title,
          projectSlug,
          projectName,
          citationAdded: false,
        };
        setCreatedTask(task);
      }
      requireCurrentOwner();
      if (conversation.latestTurnId && !task.citationAdded) {
        await createReference.mutateAsync({
          requestScope: owner,
          taskId: task.id,
          kind: 'turn',
          sessionId: conversation.sessionId,
          turnId: conversation.latestTurnId,
          sourceSurface: 'chat',
        });
        setCreatedTask({ ...task, citationAdded: true });
      }
      requireCurrentOwner();
      await queryClient.invalidateQueries({
        queryKey: taskQueries.list(task.projectSlug, owner).queryKey,
      });
      requireCurrentOwner();
      onClose();
      navigate(`/tasks/${encodeURIComponent(task.id)}`);
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      title="Save to Project"
      subtitle="This chat stays as it is."
      closeLabel="Close Save to Project"
      onClose={() => {
        if (!pending) onClose();
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {createdTask || !ownerCurrent ? 'Close' : 'Cancel'}
          </Button>
          {ownerCurrent && (newProject || createdTask || selectedProject) && (
            <Button
              variant="primary"
              disabled={
                pending || (!newProject && !createdTask && !title.trim())
              }
              onClick={
                newProject
                  ? continueInNewProject
                  : () => void continueInExistingProject()
              }
            >
              {newProject
                ? 'Review new Project'
                : needsCitation
                  ? pending
                    ? 'Linking…'
                    : 'Link chat to Task'
                  : createdTask
                    ? 'Open Task'
                    : pending
                      ? 'Creating…'
                      : 'Create Task'}
            </Button>
          )}
        </>
      }
    >
      {!ownerCurrent ? (
        <ErrorState
          variant="compact"
          title="Station access changed"
          description="Return to the original Station to continue."
        />
      ) : createdTask ? (
        <div className="content-stack">
          <p className="continue-in-project__result" role="status">
            <strong>{createdTask.title}</strong> was created in{' '}
            <strong>{createdTask.projectName}</strong>.
          </p>
          {failure && (
            <ErrorState
              variant="compact"
              title={
                needsCitation
                  ? 'Chat link wasn’t added'
                  : 'Couldn’t open the Task'
              }
            />
          )}
        </div>
      ) : (
        <>
          <div className="continue-in-project__fields">
            <label htmlFor={projectId}>Project</label>
            <Select
              id={projectId}
              value={newProject ? NEW_PROJECT : projectSlug}
              disabled={pending}
              onChange={(event) => {
                setChosenProject(event.currentTarget.value);
                setFailure(undefined);
              }}
            >
              {(!boundProjectSlug || !selectedProject) && (
                <option value="" disabled>
                  {isLoading ? 'Loading Projects…' : 'Choose a Project'}
                </option>
              )}
              {destinationProjects.map((project) => (
                <option key={project.slug} value={project.slug}>
                  {project.name || project.slug}
                </option>
              ))}
              {!boundProjectSlug && (
                <option value={NEW_PROJECT}>New Project…</option>
              )}
            </Select>
            {boundProjectSlug && !selectedProject && !isLoading && (
              <ErrorState
                variant="compact"
                title="The Project that owns this answer is unavailable"
              />
            )}
            {newProject && (
              <small className="continue-in-project__description">
                The chat provides a draft Project name and brief.
              </small>
            )}
            {selectedProject && (
              <>
                {conversation.latestTurnId && (
                  <small className="continue-in-project__description">
                    The Task will link to the chat’s latest completed answer.
                  </small>
                )}
                <label htmlFor={titleId}>Task</label>
                <input
                  id={titleId}
                  className="continue-in-project__input"
                  value={title}
                  disabled={pending}
                  maxLength={240}
                  onChange={(event) => setTitle(event.currentTarget.value)}
                />
                <label htmlFor={descriptionId}>Brief</label>
                <textarea
                  id={descriptionId}
                  className="continue-in-project__input"
                  rows={5}
                  value={description}
                  disabled={pending}
                  onChange={(event) =>
                    setDescription(event.currentTarget.value)
                  }
                />
              </>
            )}
          </div>
          {failure && (
            <ErrorState
              variant="compact"
              title={
                newProject
                  ? "Couldn't open the Project draft"
                  : "Couldn't create the Task"
              }
              description={failure}
            />
          )}
        </>
      )}
    </Dialog>
  );
}
