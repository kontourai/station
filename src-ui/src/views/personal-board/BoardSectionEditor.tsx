import type { PersonalBoardSection } from '@kontourai/station-contracts/personal-board';
import { Button } from '../../components/Button';

export function BoardSectionEditor({
  section,
  onChange,
  onMove,
  onRemove,
  first,
  last,
  projects,
}: {
  section: PersonalBoardSection;
  onChange: (section: PersonalBoardSection) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  first: boolean;
  last: boolean;
  projects: { slug: string; name: string }[];
}) {
  return (
    <fieldset className="personal-board__section-editor">
      <legend>{section.title}</legend>
      <label>
        Section title
        <input
          value={section.title}
          maxLength={120}
          onChange={(event) =>
            onChange({ ...section, title: event.target.value })
          }
        />
      </label>
      <label>
        Width
        <select
          value={section.width}
          onChange={(event) =>
            onChange({
              ...section,
              width: event.target.value === 'full' ? 'full' : 'half',
            })
          }
        >
          <option value="half">Half width</option>
          <option value="full">Full width</option>
        </select>
      </label>
      {'projectSlug' in section ||
      ['tasks', 'attention', 'recent-work'].includes(section.kind) ? (
        <label>
          Project
          <select
            value={'projectSlug' in section ? (section.projectSlug ?? '') : ''}
            onChange={(event) => {
              if (
                section.kind === 'tasks' ||
                section.kind === 'attention' ||
                section.kind === 'recent-work'
              )
                onChange({
                  ...section,
                  projectSlug: event.target.value || undefined,
                });
            }}
          >
            <option value="">All available Projects</option>
            {'projectSlug' in section &&
              section.projectSlug &&
              !projects.some(
                (project) => project.slug === section.projectSlug,
              ) && (
                <option value={section.projectSlug}>
                  Selected Project unavailable
                </option>
              )}
            {projects.map((project) => (
              <option key={project.slug} value={project.slug}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {'limit' in section && (
        <label>
          Items to show
          <input
            type="number"
            min={1}
            max={30}
            value={section.limit}
            onChange={(event) =>
              onChange({ ...section, limit: Number(event.target.value) })
            }
          />
        </label>
      )}
      {section.kind === 'tasks' && (
        <label className="personal-board__check">
          <input
            type="checkbox"
            checked={section.includeCompleted ?? false}
            onChange={(event) =>
              onChange({ ...section, includeCompleted: event.target.checked })
            }
          />
          Include completed tasks
        </label>
      )}
      {section.kind === 'note' && (
        <label>
          Note
          <textarea
            rows={5}
            maxLength={12000}
            value={section.body}
            onChange={(event) =>
              onChange({ ...section, body: event.target.value })
            }
          />
        </label>
      )}
      {section.kind === 'links' && (
        <div className="personal-board__link-editor">
          {section.links.map((link, index) => (
            <div key={index}>
              <label>
                Link label
                <input
                  maxLength={120}
                  value={link.label}
                  onChange={(event) =>
                    onChange({
                      ...section,
                      links: section.links.map((item, i) =>
                        i === index
                          ? { ...item, label: event.target.value }
                          : item,
                      ),
                    })
                  }
                />
              </label>
              <label>
                Link address
                <input
                  value={link.href}
                  maxLength={2048}
                  placeholder="https://… or /projects/…"
                  onChange={(event) =>
                    onChange({
                      ...section,
                      links: section.links.map((item, i) =>
                        i === index
                          ? { ...item, href: event.target.value }
                          : item,
                      ),
                    })
                  }
                />
              </label>
              <Button
                size="sm"
                aria-label={`Remove link ${index + 1}`}
                onClick={() =>
                  onChange({
                    ...section,
                    links: section.links.filter((_, i) => i !== index),
                  })
                }
              >
                Remove link
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            disabled={section.links.length >= 30}
            onClick={() =>
              onChange({
                ...section,
                links: [...section.links, { label: '', href: '' }],
              })
            }
          >
            Add link
          </Button>
        </div>
      )}
      <div className="personal-board__section-actions">
        <div>
          <Button
            size="sm"
            disabled={first}
            aria-label={`Move ${section.title} up`}
            onClick={() => onMove(-1)}
          >
            Move up
          </Button>
          <Button
            size="sm"
            disabled={last}
            aria-label={`Move ${section.title} down`}
            onClick={() => onMove(1)}
          >
            Move down
          </Button>
        </div>
        <Button size="sm" onClick={onRemove}>
          Remove section
        </Button>
      </div>
    </fieldset>
  );
}
