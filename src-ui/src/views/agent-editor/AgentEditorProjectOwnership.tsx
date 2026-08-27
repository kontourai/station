import { agentOwnershipFinding } from '@kontourai/station-contracts/project-reference-integrity';
import type { AgentEditorFormProps } from './types';

export function AgentEditorProjectOwnership({
  form,
  setForm,
  locked,
  projects,
}: Pick<AgentEditorFormProps, 'form' | 'setForm' | 'locked'> & {
  projects: Array<{ slug: string; name: string }>;
}) {
  const isOrphan =
    !!form.project &&
    !projects.some((project) => project.slug === form.project);
  const ownershipFinding = form.project
    ? agentOwnershipFinding(
        form.project,
        new Set(projects.map((project) => project.slug)),
      )
    : undefined;

  return (
    <>
      <div className="editor-field">
        <label className="editor-label" htmlFor="ae-project">
          Project
        </label>
        <select
          id="ae-project"
          className="editor-select"
          value={form.project}
          disabled={locked}
          onChange={(event) => {
            const project = event.target.value;
            setForm((current) => ({ ...current, project }));
          }}
        >
          <option value="">Global (available to every project)</option>
          {projects.map((project) => (
            <option key={project.slug} value={project.slug}>
              {project.name}
            </option>
          ))}
          {isOrphan && (
            <option value={form.project}>{`${form.project} (missing)`}</option>
          )}
        </select>
        <span className="editor-hint">
          A project-owned agent is available only inside its project.
        </span>
      </div>
      {ownershipFinding && (
        <div className="agent-editor__capability-banner" role="status">
          {ownershipFinding.message} Assign it to an existing project or make it
          global.
        </div>
      )}
    </>
  );
}
