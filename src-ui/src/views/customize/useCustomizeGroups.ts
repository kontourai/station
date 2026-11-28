import { useAgentsQuery, useSkillsQuery } from '@kontourai/station-sdk';
import type { ReactNode } from 'react';
import {
  APP_DESTINATION_REGISTRY,
  CUSTOMIZE_NAV_GROUP_ORDER,
  type CustomizeNavGroupId,
} from '../../app-shell/destination-registry';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import { useConnectionSectionSignals } from '../connections-hub/connection-section-signals';
import {
  CONNECTION_SECTIONS,
  type ConnectionSectionId,
} from '../connections-hub/connection-sections';
import { CUSTOMIZE_ITEM_GLYPHS } from './customize-glyphs';

/** What each group is called, and the line that says what it holds. */
const GROUP_WORDS: Readonly<
  Record<CustomizeNavGroupId, { label: string; description: string }>
> = {
  'your-agents': { label: 'Your agents', description: 'Who does the work' },
  'run-on': {
    label: 'What they run on',
    description: 'Engines and the providers you sign in to or pay',
  },
  'can-reach': {
    label: 'What they can reach',
    description: 'Tool servers and the files agents can search',
  },
};

export interface CustomizeItem {
  id: string;
  label: string;
  route: string;
  icon?: ReactNode;
  /** Null while the item's list has not loaded, or where no number fits. */
  count: number | null;
  needsAttention: boolean;
}

export interface CustomizeGroup {
  id: CustomizeNavGroupId;
  label: string;
  description: string;
  items: CustomizeItem[];
}

function isConnectionSection(id: string): id is ConnectionSectionId {
  return CONNECTION_SECTIONS.some((section) => section.id === id);
}

/**
 * The Customize page's groups and items, with each item's count and
 * attention, read from the same registry and signals the rest of the shell
 * uses. Agents and Skills carry counts only: nothing records a readiness
 * failure for them.
 */
export function useCustomizeGroups(): CustomizeGroup[] {
  const entries = APP_DESTINATION_REGISTRY.getCustomizeNav(
    useSurfaceVisibilityFlags(),
  );
  const signals = useConnectionSectionSignals();
  const { data: agents } = useAgentsQuery();
  const { data: skills } = useSkillsQuery();
  const item = (entry: (typeof entries)[number]): CustomizeItem => {
    const connection = isConnectionSection(entry.id) ? entry.id : null;
    const count = connection
      ? signals.count(connection)
      : entry.id === 'agents'
        ? (agents?.length ?? null)
        : entry.id === 'guidance'
          ? Array.isArray(skills)
            ? skills.length
            : null
          : null;
    return {
      id: entry.id,
      label: entry.label,
      route: entry.route,
      icon: CUSTOMIZE_ITEM_GLYPHS[entry.id],
      count,
      needsAttention: connection ? signals.needsAttention(connection) : false,
    };
  };
  return CUSTOMIZE_NAV_GROUP_ORDER.map((id) => ({
    id,
    ...GROUP_WORDS[id],
    items: entries.filter((entry) => entry.group === id).map(item),
  })).filter((group) => group.items.length > 0);
}
