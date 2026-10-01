import type {
  TaskRecord,
  TaskStatus,
} from '@kontourai/station-contracts/task-graph';
import './ProjectTaskBoard.css';

const COLUMNS: readonly { label: string; statuses: readonly TaskStatus[] }[] = [
  { label: 'Backlog', statuses: ['todo', 'ready', 'triage'] },
  { label: 'In progress', statuses: ['in_progress'] },
  { label: 'Blocked', statuses: ['blocked'] },
  { label: 'Review', statuses: ['review', 'verification'] },
  { label: 'Done', statuses: ['done'] },
  { label: 'Canceled', statuses: ['canceled'] },
];

export function ProjectTaskBoard({
  tasks,
  selectedTaskId,
  onSelect,
}: {
  tasks: readonly TaskRecord[];
  selectedTaskId: string;
  onSelect(taskId: string): void;
}) {
  return (
    <section className="project-task-board" aria-label="Project task board">
      {COLUMNS.map((column) => {
        const items = tasks.filter((task) =>
          column.statuses.includes(task.status),
        );
        return (
          <section
            className="project-task-board__column"
            key={column.label}
            aria-label={column.label}
          >
            <h3>
              {column.label} <span>{items.length}</span>
            </h3>
            <ul>
              {items.map((task) => (
                <li key={task.id}>
                  <button
                    type="button"
                    className="project-task-board__card"
                    aria-label={`${task.title}, ${task.status.replaceAll('_', ' ')}`}
                    aria-pressed={selectedTaskId === task.id}
                    onClick={() => onSelect(task.id)}
                  >
                    <strong>{task.title}</strong>
                    {task.description ? (
                      <span className="project-task-board__brief">
                        {task.description}
                      </span>
                    ) : null}
                    <span>
                      {task.status.replaceAll('_', ' ')} · {task.priority}
                    </span>
                    <span>
                      {task.agentId
                        ? `Assigned to ${task.agentId}`
                        : 'No agent assigned'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </section>
  );
}
