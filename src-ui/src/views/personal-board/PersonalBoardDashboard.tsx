import type { PersonalBoardDefinition } from '@kontourai/station-contracts/personal-board';
import { PageFrame } from '../../components/page-frame';
import { Empty } from '../../components/state';
import { PersonalBoardSectionContent } from './PersonalBoardSections';
import './PersonalBoard.css';

export function PersonalBoardDashboard({
  definition,
  boardSlug,
  showHeader = true,
}: {
  definition: PersonalBoardDefinition;
  boardSlug: string;
  showHeader?: boolean;
}) {
  const body = (
    <section className="personal-board" aria-label={definition.name}>
      <div className="personal-board__grid">
        {definition.sections.map((section) => (
          <section
            key={section.id}
            className={`personal-board__card personal-board__card--${section.width}`}
            aria-label={section.title}
          >
            <div className="personal-board__card-heading">
              <h2>{section.title}</h2>
              {!['note', 'links'].includes(section.kind) && (
                <span className="personal-board__source">Live</span>
              )}
            </div>
            <PersonalBoardSectionContent section={section} />
          </section>
        ))}
      </div>
      {!definition.sections.length && (
        <Empty
          label={
            showHeader
              ? 'This Board has no sections yet.'
              : 'Add your first section with Edit Board.'
          }
        />
      )}
    </section>
  );
  return showHeader ? (
    <PageFrame
      routeIdentity={`board:${boardSlug}`}
      spec={{
        title: definition.name,
        eyebrow: 'Personal Board',
        subtitle: definition.description,
        flush: true,
      }}
    >
      {body}
    </PageFrame>
  ) : (
    body
  );
}
