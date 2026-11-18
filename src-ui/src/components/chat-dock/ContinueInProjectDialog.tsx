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

type Destination = 'new' | 'existing';
const STATION_CHANGED =
  'Station access changed. Return to the original Station to continue.';

/**
 * #5071: Continue in Project… from the chat's More menu. A new Project opens
 * the New project form with a name, folder and brief drafted from the chat;
 * an existing Project gets a Task that cites the chat's latest answer. The
 * chat is left exactly as it was.
 */
export function ContinueInProjectDialog({
  conversation,
  onClose,
  now = () => new Date(),
}: {
  conversation: ContinuedConversation;
  onClose: () => void;
  now?: () => Date;
}) {
  const { navigate } = useNavigation();
  const authority = useHostRequestAuthorityScope();
  const [ownerKey] = useState(() =>
    authority ? projectCreationRecoveryIdentity(authority) : undefined,
  );
  const { projects } = useProjects();
  const queryClient = useQueryClient();
  const createTask = useCreateTaskMutation();
  const createReference = useCreateTaskReferenceMutation();
  const [destination, setDestination] = useState<Destination>('new');
  const [taskDraft] = useState(() =>
    draftTaskFromConversation(conversation, now()),
  );
  const [projectSlug, setProjectSlug] = useState('');
  const [title, setTitle] = useState(taskDraft.title);
  const [description, setDescription] = useState(taskDraft.description);
  const [failure, setFailure] = useState<string>();
  const [createdTask, setCreatedTask] = useState<{
    id: string;
    projectSlug: string;
    citationAdded: boolean;
  }>();
  const [pending, setPending] = useState(false);
  const draftLocked = pending || Boolean(createdTask);
  const needsCitation = Boolean(
    createdTask && conversation.latestTurnId && !createdTask.citationAdded,
  );
  const groupName = useId();
  const projectId = useId();
  const titleId = useId();
  const descriptionId = useId();

  function captureOwner() {
    if (
      !authority?.isCurrent() ||
      projectCreationRecoveryIdentity(authority) !== ownerKey
    )
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
    navigate('/projects/new', { [PROJECT_CONTINUATION_PARAM]: continuationId });
  }

  async function continueInExistingProject() {
    if (pending || !projectSlug || !title.trim()) return;
    setFailure(undefined);
    setPending(true);
    try {
      const owner = captureOwner();
      const requireCurrentOwner = () => {
        if (!owner.isCurrent()) throw new StationUiError(STATION_CHANGED);
      };
      const task = createdTask ?? {
        id: (
          await createTask.mutateAsync({
            requestScope: owner,
            projectId: projectSlug,
            title: title.trim(),
            description: description.trim(),
            createdBy: 'user',
          })
        ).id,
        projectSlug,
        citationAdded: false,
      };
      setCreatedTask(task);
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
      title="Continue in Project"
      subtitle="This chat stays as it is."
      closeLabel="Close Continue in Project"
      onClose={() => {
        if (!pending) onClose();
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          {destination === 'new' ? (
            <Button variant="primary" onClick={continueInNewProject}>
              Review new Project
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={pending || !projectSlug || !title.trim()}
              onClick={() => void continueInExistingProject()}
            >
              {needsCitation
                ? pending
                  ? 'Adding citation…'
                  : 'Retry citation'
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
      <fieldset className="continue-in-project" disabled={draftLocked}>
        <legend className="continue-in-project__legend">Continue in</legend>
        <label className="continue-in-project__choice">
          <input
            type="radio"
            name={groupName}
            checked={destination === 'new'}
            onChange={() => setDestination('new')}
          />
          <span>
            <strong>A new Project</strong>
            <small>Name, folder and brief are drafted from this chat.</small>
          </span>
        </label>
        <label className="continue-in-project__choice">
          <input
            type="radio"
            name={groupName}
            checked={destination === 'existing'}
            disabled={projects.length === 0}
            onChange={() => setDestination('existing')}
          />
          <span>
            <strong>An existing Project</strong>
            <small>Adds a Task that cites this chat.</small>
          </span>
        </label>
      </fieldset>
      {destination === 'existing' && (
        <div className="continue-in-project__fields">
          <label htmlFor={projectId}>Project</label>
          <Select
            id={projectId}
            value={projectSlug}
            disabled={draftLocked}
            onChange={(event) => setProjectSlug(event.currentTarget.value)}
          >
            <option value="">Choose a Project</option>
            {projects.map((project) => (
              <option key={project.slug} value={project.slug}>
                {project.name || project.slug}
              </option>
            ))}
          </Select>
          <label htmlFor={titleId}>Task</label>
          <input
            id={titleId}
            className="continue-in-project__input"
            value={title}
            disabled={draftLocked}
            maxLength={240}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
          <label htmlFor={descriptionId}>Brief</label>
          <textarea
            id={descriptionId}
            className="continue-in-project__input"
            rows={5}
            value={description}
            disabled={draftLocked}
            onChange={(event) => setDescription(event.currentTarget.value)}
          />
        </div>
      )}
      {failure && (
        <ErrorState
          variant="compact"
          title={
            needsCitation
              ? 'The Task was created but doesn’t cite this chat yet'
              : createdTask
                ? 'The Task was created'
                : destination === 'new'
                  ? "Couldn't open the Project draft"
                  : "Couldn't create the Task"
          }
          description={failure}
        />
      )}
    </Dialog>
  );
}
