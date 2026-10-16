import type { PersonalBoardDefinition } from '@kontourai/station-contracts/personal-board';
import { PersonalBoardSectionContent } from './PersonalBoardSections';
import './PersonalBoard.css';

export function PersonalBoardDashboard({
  definition,
}: {
  definition: PersonalBoardDefinition;
}) {
  return (
    <section className="personal-board" aria-label={definition.name}>
      <header className="personal-board__heading">
        <span className="personal-board__eyebrow">Personal Board</span>
        <h1>{definition.name}</h1>
        {definition.description && <p>{definition.description}</p>}
      </header>
      <div className="personal-board__grid">
        {definition.sections.map((section) => (
          <section
            key={section.id}
            className={`personal-board__card personal-board__card--${section.width}`}
            aria-label={section.title}
          >
            <header>
              <h2>{section.title}</h2>
              {!['note', 'links'].includes(section.kind) && (
                <span className="personal-board__source">Live</span>
              )}
            </header>
            <PersonalBoardSectionContent section={section} />
          </section>
        ))}
      </div>
      {!definition.sections.length && (
        <p className="personal-board__empty">
          Add your first section with Edit Board.
        </p>
      )}
    </section>
  );
}
