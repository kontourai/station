import type { PersonalBoardDefinition } from '@kontourai/station-contracts/personal-board';
import { Button } from '../../components/Button';
import { BoardSectionEditor } from './BoardSectionEditor';
import { newBoardSection, SECTION_KINDS } from './board-templates';

export function BoardEditor({
  definition,
  update,
  pending,
  projects,
  validationError,
}: {
  definition: PersonalBoardDefinition;
  update: (definition: PersonalBoardDefinition) => void;
  pending: boolean;
  projects: { slug: string; name: string }[];
  validationError?: string;
}) {
  return (
    <section className="personal-board__editor" aria-label="Edit Board">
      <fieldset disabled={pending}>
        <div className="personal-board__identity-fields">
          <label>
            Board name
            <input
              value={definition.name}
              maxLength={120}
              onChange={(event) =>
                update({ ...definition, name: event.target.value })
              }
            />
          </label>
          <label>
            Description
            <textarea
              rows={2}
              maxLength={1000}
              value={definition.description}
              onChange={(event) =>
                update({
                  ...definition,
                  description: event.target.value,
                })
              }
            />
          </label>
        </div>
        {definition.sections.map((section, index) => (
          <BoardSectionEditor
            key={section.id}
            section={section}
            first={index === 0}
            last={index === definition.sections.length - 1}
            projects={projects}
            onChange={(next) =>
              update({
                ...definition,
                sections: definition.sections.map((item) =>
                  item.id === next.id ? next : item,
                ),
              })
            }
            onRemove={() =>
              update({
                ...definition,
                sections: definition.sections.filter(
                  (item) => item.id !== section.id,
                ),
              })
            }
            onMove={(direction) => {
              const sections = [...definition.sections];
              [sections[index], sections[index + direction]] = [
                sections[index + direction],
                sections[index],
              ];
              update({ ...definition, sections });
            }}
          />
        ))}
        <div className="personal-board__add">
          <h2>Add a section</h2>
          <div>
            {SECTION_KINDS.map((entry) => (
              <Button
                key={entry.kind}
                disabled={definition.sections.length >= 24}
                title={entry.description}
                onClick={() =>
                  update({
                    ...definition,
                    sections: [
                      ...definition.sections,
                      newBoardSection(entry.kind),
                    ],
                  })
                }
              >
                {entry.label}
              </Button>
            ))}
          </div>
        </div>
        {validationError && <p role="alert">{validationError}</p>}
      </fieldset>
    </section>
  );
}
