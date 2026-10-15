import {
  taskQueries,
  useCreateTaskMutation,
  useQueryClient,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import { useNavigation } from '../../contexts/NavigationContext';
import { useProjects } from '../../contexts/ProjectsContext';
import { type TaskProposal, taskProposalBrief } from '../../lib/task-shaping';
import { Button } from '../Button';
import './TaskShaping.css';

export function TaskProposalCard({
  proposal,
  sessionId,
  turnId,
  projectId,
  agentId,
}: {
  proposal: TaskProposal;
  sessionId: string;
  turnId: string;
  projectId?: string;
  agentId?: string;
}) {
  const create = useCreateTaskMutation();
  const queryClient = useQueryClient();
  const { navigate } = useNavigation();
  const { projects } = useProjects();
  const [selectedProject, setSelectedProject] = useState(projectId ?? '');
  const [acceptedId, setAcceptedId] = useState<string>();
  const [failed, setFailed] = useState(false);
  async function accept() {
    if (!selectedProject || create.isPending) return;
    if (acceptedId) {
      navigate(`/tasks/${encodeURIComponent(acceptedId)}`);
      return;
    }
    setFailed(false);
    try {
      const task = await create.mutateAsync({
        projectId: selectedProject,
        title: proposal.title,
        description: proposal.goal,
        proposalBrief: taskProposalBrief(proposal),
        agentId,
        createdBy: 'user',
        shapingSource: { sessionId, turnId },
      });
      setAcceptedId(task.id);
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
        Task proposal · Review before creating
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
        disabled={!selectedProject}
        pending={create.isPending}
        pendingLabel="Creating Task…"
        onClick={() => void accept()}
      >
        {acceptedId ? 'Open Task' : 'Create Task'}
      </Button>
    </section>
  );
}
