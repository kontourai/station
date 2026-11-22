import { useAgentsQuery, useSkillsQuery } from '@kontourai/station-sdk';
import {
  APP_DESTINATION_REGISTRY,
  CUSTOMIZE_NAV_GROUPS,
  type CustomizeNavGroupId,
  type DestinationIconId,
} from '../../app-shell/destination-registry';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import { useConnectionSectionSignals } from '../connections-hub/connection-section-signals';
import {
  CONNECTION_SECTIONS,
  type ConnectionSectionId,
} from '../connections-hub/connection-sections';

export interface CustomizeItem {
  id: string;
  label: string;
  route: string;
  icon?: DestinationIconId;
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
      icon: APP_DESTINATION_REGISTRY.get(entry.id)?.icon,
      count,
      needsAttention: connection ? signals.needsAttention(connection) : false,
    };
  };
  return CUSTOMIZE_NAV_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    description: group.description,
    items: entries.filter((entry) => entry.group === group.id).map(item),
  })).filter((group) => group.items.length > 0);
}
