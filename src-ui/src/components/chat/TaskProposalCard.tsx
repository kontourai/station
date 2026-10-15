import {
  type TaskProposal,
  taskProposalBrief,
} from '@kontourai/station-contracts/task-graph';
import {
  taskQueries,
  useCreateTaskMutation,
  useQueryClient,
  useSessionRelationsQuery,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { useNavigation } from '../../contexts/NavigationContext';
import { useProjects } from '../../contexts/ProjectsContext';
import { Button } from '../Button';
import './TaskShaping.css';

export function TaskProposalCard({
  proposal,
  sessionId,
  turnId,
  projectId,
}: {
  proposal: TaskProposal;
  sessionId: string;
  turnId: string;
  projectId?: string;
}) {
  const create = useCreateTaskMutation();
  const queryClient = useQueryClient();
  const { navigate } = useNavigation();
  const { projects } = useProjects();
  const [selectedProject, setSelectedProject] = useState(projectId ?? '');
  const [acceptedId, setAcceptedId] = useState<string>();
  const relations = useSessionRelationsQuery(sessionId);
  const priorId = relations.data?.links.find(
    (link) =>
      link.sourceType === 'task' &&
      link.targetType === 'session' &&
      link.targetId === sessionId &&
      link.source === 'user' &&
      link.relationType === 'spawned_session' &&
      link.metadata?.shapingTurnId === turnId &&
      link.metadata?.proposalBriefSaved === true,
  )?.sourceId;
  const taskId = acceptedId ?? priorId;
  const [failed, setFailed] = useState(false);
  async function accept() {
    if (create.isPending) return;
    if (taskId) {
      navigate(`/tasks/${encodeURIComponent(taskId)}`);
      return;
    }
    if (!selectedProject) return;
    setFailed(false);
    try {
      const task = await create.mutateAsync({
        projectId: selectedProject,
        title: proposal.title,
        description: proposal.goal,
        proposalBrief: taskProposalBrief(proposal),
        createdBy: 'user',
        shapingSource: { sessionId, turnId },
      });
      setAcceptedId(task.id);
      for (const [key, chat] of Object.entries(
        activeChatsStore.getSnapshot(),
      )) {
        if (key === sessionId || chat.currentSessionId === sessionId)
          activeChatsStore.updateChat(key, { taskShaping: false });
      }
      await queryClient.invalidateQueries({
        queryKey: taskQueries.sessionRelations(sessionId).queryKey,
      });
      await queryClient.invalidateQueries({
        queryKey: taskQueries.list(selectedProject).queryKey,
        exact: true,
        refetchType: 'all',
      });
      navigate(`/tasks/${encodeURIComponent(task.id)}`);
    } catch {
      setFailed(true);
    }
  }
  return (
    <section className="task-proposal" aria-label="Task proposal">
      <span className="task-proposal__eyebrow">
        {taskId
          ? 'Task proposal · Accepted'
          : 'Task proposal · Review before creating'}
      </span>
      <h3>{proposal.title}</h3>
      <h4>Goal</h4>
      <p>{proposal.goal}</p>
      <h4>Done when</h4>
      <ul>
        {proposal.doneWhen.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
      <h4>Suggested first step</h4>
      <p>{proposal.firstStep}</p>
      {!projectId && (
        <label>
          Project
          <select
            aria-label="Task project"
            value={selectedProject}
            onChange={(event) => setSelectedProject(event.target.value)}
          >
            <option value="">Choose a project</option>
            {projects.map((project) => (
              <option key={project.slug} value={project.slug}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="task-proposal__note">
        Your chat stays as it is. Creating keeps this brief and links the
        conversation.
      </p>
      {failed && (
        <p role="alert">
          Task creation or brief saving did not finish. Your proposal is kept.
          Retry Create Task to finish saving; an existing Task will be reused.
        </p>
      )}
      <Button
        variant="primary"
        disabled={!selectedProject && !taskId}
        pending={create.isPending}
        pendingLabel="Creating Task…"
        onClick={() => void accept()}
      >
        {taskId ? 'Open Task' : 'Create Task'}
      </Button>
    </section>
  );
}
