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
      <span className="personal-board__eyebrow">
        Make room for what matters
      </span>
      <h1>Build your Board</h1>
      <p>
        Start with a dashboard, or describe what you want in chat. Live sections
        stay connected to Station.
      </p>
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
