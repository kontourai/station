import {
  taskQueries,
  useCreateTaskMutation,
  useCreateTaskReferenceMutation,
  useQueryClient,
} from '@kontourai/station-sdk';
import { Select } from '@kontourai/ui/react';
import { useId, useState } from 'react';
import { useNavigation } from '../../contexts/NavigationContext';
import { useProjects } from '../../contexts/ProjectsContext';
import {
  type ContinuedConversation,
  draftProjectFromConversation,
  draftTaskFromConversation,
  rememberPendingContinuation,
} from '../../lib/continue-in-project';
import { errorText } from '../../utils/errorText';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { ErrorState } from '../state';
import './ContinueInProjectDialog.css';

type Destination = 'new' | 'existing';

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
  const [createdTaskId, setCreatedTaskId] = useState<string>();
  const pending = createTask.isPending || createReference.isPending;
  const groupName = useId();
  const projectId = useId();
  const titleId = useId();
  const descriptionId = useId();

  function continueInNewProject() {
    const at = now();
    const draft = draftProjectFromConversation(conversation, at);
    rememberPendingContinuation({
      sessionId: conversation.sessionId,
      ...(conversation.latestTurnId
        ? { turnId: conversation.latestTurnId }
        : {}),
      title: taskDraft.title,
      description: taskDraft.description,
      savedAt: at.toISOString(),
    });
    onClose();
    navigate('/projects/new', {
      name: draft.name,
      description: draft.description,
      ...(draft.directory ? { directory: draft.directory } : {}),
    });
  }

  async function continueInExistingProject() {
    if (!projectSlug || !title.trim()) return;
    setFailure(undefined);
    try {
      // A retry after a failed reference reuses the Task already created.
      const taskId =
        createdTaskId ??
        (
          await createTask.mutateAsync({
            projectId: projectSlug,
            title: title.trim(),
            description: description.trim(),
            createdBy: 'user',
          })
        ).id;
      setCreatedTaskId(taskId);
      if (conversation.latestTurnId)
        await createReference.mutateAsync({
          taskId,
          kind: 'turn',
          sessionId: conversation.sessionId,
          turnId: conversation.latestTurnId,
          sourceSurface: 'chat',
        });
      await queryClient.invalidateQueries({
        queryKey: taskQueries.list(projectSlug).queryKey,
      });
      onClose();
      navigate(`/tasks/${encodeURIComponent(taskId)}`);
    } catch (error) {
      setFailure(errorText(error));
    }
  }

  return (
    <Dialog
      title="Continue in Project"
      subtitle="This chat stays as it is."
      closeLabel="Close Continue in Project"
      onClose={onClose}
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
              {pending ? 'Creating…' : 'Create Task'}
            </Button>
          )}
        </>
      }
    >
      <fieldset className="continue-in-project">
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
            maxLength={240}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
          <label htmlFor={descriptionId}>Brief</label>
          <textarea
            id={descriptionId}
            className="continue-in-project__input"
            rows={5}
            value={description}
            onChange={(event) => setDescription(event.currentTarget.value)}
          />
        </div>
      )}
      {failure && (
        <ErrorState
          variant="compact"
          title={
            createdTaskId
              ? 'The Task was created but doesn’t cite this chat yet'
              : "Couldn't create the Task"
          }
          description={`${failure} Try Create Task again.`}
        />
      )}
    </Dialog>
  );
}
