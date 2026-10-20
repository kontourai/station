import type { PersonalBoardDefinition } from '@kontourai/station-contracts/personal-board';
import { useState } from 'react';
import { BOARD_TEMPLATES, boardFromTemplate } from './board-templates';
export function BoardSetup({
  name,
  projects,
  onChoose,
}: {
  name: string;
  projects: { slug: string; name: string }[];
  onChoose: (definition: PersonalBoardDefinition) => void;
}) {
  const [projectSlug, setProjectSlug] = useState('');
  return (
    <section className="personal-board__setup">
      <label>
        Project for a Project watch
        <select
          value={projectSlug}
          onChange={(event) => setProjectSlug(event.target.value)}
        >
          <option value="">Choose a Project</option>
          {projects.map((project) => (
            <option key={project.slug} value={project.slug}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <div className="personal-board__templates">
        {BOARD_TEMPLATES.map((template) => (
          <button
            key={template.id}
            type="button"
            disabled={template.id === 'project' && !projectSlug}
            onClick={() =>
              onChoose(
                boardFromTemplate(
                  template.id,
                  name === 'Untitled Board' ? template.name : name,
                  template.id === 'project' ? projectSlug : undefined,
                ),
              )
            }
          >
            <strong>{template.name}</strong>
            <span>{template.description}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
