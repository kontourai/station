import type {
  PersonalBoardDefinition,
  PersonalBoardSection,
} from '@kontourai/station-contracts/personal-board';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';

export const SECTION_KINDS = [
  {
    kind: 'tasks',
    label: 'Tasks',
    description: 'Live tasks across Projects, or one Project.',
  },
  {
    kind: 'attention',
    label: 'Needs attention',
    description: 'Approvals, questions and other pending items.',
  },
  {
    kind: 'recent-work',
    label: 'Recent work',
    description: 'Recently updated Station conversations and runs.',
  },
  {
    kind: 'projects',
    label: 'Projects',
    description: 'Quick access to your available Projects.',
  },
  {
    kind: 'note',
    label: 'Note',
    description: 'Your own written context and instructions.',
  },
  {
    kind: 'links',
    label: 'Links',
    description: 'Useful Station pages and web links.',
  },
] as const;

export function newBoardSection(
  kind: PersonalBoardSection['kind'],
): PersonalBoardSection {
  const base = {
    id: randomCorrelationId(),
    title: SECTION_KINDS.find((entry) => entry.kind === kind)!.label,
    width: 'half' as const,
  };
  switch (kind) {
    case 'note':
      return { ...base, kind, body: '' };
    case 'links':
      return { ...base, kind, links: [] };
    default:
      return { ...base, kind, limit: 8 };
  }
}

export const BOARD_TEMPLATES = [
  {
    id: 'daily',
    name: 'Daily brief',
    description: 'What needs you, what is moving, and what happened recently.',
    kinds: ['attention', 'tasks', 'recent-work', 'note'],
  },
  {
    id: 'project',
    name: 'Project watch',
    description: 'Keep one Project’s tasks and recent work in view.',
    kinds: ['tasks', 'recent-work', 'links'],
  },
  {
    id: 'review',
    name: 'Review desk',
    description: 'Pending decisions, active tasks, and your review notes.',
    kinds: ['attention', 'tasks', 'note'],
  },
  {
    id: 'blank',
    name: 'Start blank',
    description: 'Choose each section yourself.',
    kinds: [],
  },
] as const;

export function boardFromTemplate(
  id: string,
  name: string,
  projectSlug?: string,
): PersonalBoardDefinition {
  const template =
    BOARD_TEMPLATES.find((entry) => entry.id === id) ?? BOARD_TEMPLATES[0];
  return {
    version: 1,
    name,
    description: template.id === 'blank' ? '' : template.description,
    sections: template.kinds.map((kind) => {
      const section = newBoardSection(kind);
      return projectSlug && 'limit' in section && section.kind !== 'projects'
        ? { ...section, projectSlug }
        : section;
    }),
  };
}
