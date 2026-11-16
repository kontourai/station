import {
  PROJECT_EFFORTS,
  type ProjectEffort,
} from '@kontourai/station-contracts/project';
import { useId } from 'react';
import { PageRow } from '../../components/PageRow';
import { PageSection } from '../../components/PageSection';
import type { ProjectForm } from './types';

type SetField = <K extends keyof ProjectForm>(
  key: K,
  value: ProjectForm[K],
) => void;

const EFFORT_LABELS: Record<ProjectEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

/** Engines whose Tasks can take a Project model and effort. */
const TASK_ENGINES = [
  ['', 'Any engine'],
  ['claude', 'Claude Code'],
  ['codex', 'Codex'],
  ['muse', 'Muse'],
] as const;

function EffortSelect({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: ProjectEffort | 'inherit';
  onChange: (value: ProjectEffort | 'inherit') => void;
}) {
  return (
    <select
      id={id}
      className="editor-input"
      aria-label={label}
      value={value}
      onChange={(event) =>
        onChange(event.target.value as ProjectEffort | 'inherit')
      }
    >
      <option value="inherit">Engine default</option>
      {PROJECT_EFFORTS.map((effort) => (
        <option key={effort} value={effort}>
          {EFFORT_LABELS[effort]}
        </option>
      ))}
    </select>
  );
}

/**
 * #5068: the model and effort for this Project's own conversations (its
 * coordinator) and for the Tasks it dispatches. Saved with the page's Save;
 * a change reaches the next Session or Task.
 */
export function ProjectModelsSection({
  form,
  setField,
}: {
  form: ProjectForm;
  setField: SetField;
}) {
  const coordinatorEffortId = useId();
  const taskEngineId = useId();
  const taskModelId = useId();
  const taskEffortId = useId();
  return (
    <PageSection
      id="section-models"
      className="project-settings__section"
      title="Models and effort"
      description="Each Task runs its own Session, so parallel Tasks multiply usage. Higher effort costs more on every turn."
    >
      <PageRow
        label={<label htmlFor={coordinatorEffortId}>Project chat effort</label>}
        description="For chats in this Project that are not Tasks. They use the Project's AI model."
        control={
          <EffortSelect
            id={coordinatorEffortId}
            label="Project chat effort"
            value={form.coordinatorEffort}
            onChange={(value) => setField('coordinatorEffort', value)}
          />
        }
      />
      <PageRow
        label={<label htmlFor={taskEngineId}>Task engine</label>}
        description="The Task model applies when a Task's Agent runs on this engine."
        control={
          <select
            id={taskEngineId}
            className="editor-input"
            aria-label="Task engine"
            value={form.taskProviderId}
            onChange={(event) => setField('taskProviderId', event.target.value)}
          >
            {TASK_ENGINES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        }
      />
      <PageRow
        label={<label htmlFor={taskModelId}>Task model</label>}
        description="Used by the next Task dispatched without its own model."
        control={
          <input
            id={taskModelId}
            className="editor-input"
            type="text"
            maxLength={256}
            value={form.taskModel}
            placeholder="Agent's own model"
            onChange={(event) => setField('taskModel', event.target.value)}
          />
        }
      />
      <PageRow
        label={<label htmlFor={taskEffortId}>Task effort</label>}
        description="Used by the next Task dispatched without its own effort."
        control={
          <EffortSelect
            id={taskEffortId}
            label="Task effort"
            value={form.taskEffort}
            onChange={(value) => setField('taskEffort', value)}
          />
        }
      />
    </PageSection>
  );
}
