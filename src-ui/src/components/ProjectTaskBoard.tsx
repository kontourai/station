import {
  type TaskRecord,
  type TaskStatus,
  taskStatusLabel,
} from '@kontourai/station-contracts/task-graph';
import { Empty, StatusBadge } from '@kontourai/ui/react';
import './ProjectTaskBoard.css';

const COLUMNS: readonly { label: string; statuses: readonly TaskStatus[] }[] = [
  { label: taskStatusLabel('todo'), statuses: ['todo', 'ready', 'triage'] },
  { label: 'In progress', statuses: ['in_progress'] },
  { label: 'Blocked', statuses: ['blocked'] },
  { label: taskStatusLabel('review'), statuses: ['review', 'verification'] },
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
        if (column.label === 'Canceled' && !items.length)
          return (
            <details
              className="project-task-board__canceled-disclosure"
              key={column.label}
            >
              <summary>Canceled · 0</summary>
              <Empty label="Tasks you cancel appear here." />
            </details>
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
                    aria-label={`${task.title}, ${taskStatusLabel(task.status)}`}
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
                      <StatusBadge
                        tone={
                          task.status === 'done'
                            ? 'positive'
                            : task.status === 'blocked'
                              ? 'caution'
                              : 'neutral'
                        }
                        status={taskStatusLabel(task.status)}
                      />
                      {task.priority !== 'normal' && ` · ${task.priority}`}
                    </span>
                    {task.agentId && <span>Assigned to {task.agentId}</span>}
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
