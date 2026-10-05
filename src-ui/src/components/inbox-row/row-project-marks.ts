import type { HomeWorkItem } from '../../views/home/home-view-model';

/** What a work row shows of its project: the sidebar's colour and icon. */
export interface RowProjectMarks {
  projectAccent?: string;
  projectIcon?: string;
}

/**
 * The project colour and icon a work row wears, resolved once for the dock
 * and Home so the two marks cannot disagree. Both come from this Station's
 * project list by slug. A remote row (`environmentId` set) names a project
 * on another Station, whose slug may collide with a local one, so it takes
 * neither mark.
 */
export function rowProjectMarks(
  item: Pick<HomeWorkItem, 'projectSlug' | 'environmentId'>,
  accentBySlug: ReadonlyMap<string, string> | undefined,
  iconBySlug: ReadonlyMap<string, string> | undefined,
): RowProjectMarks {
  const slug = item.environmentId ? undefined : item.projectSlug;
  if (!slug) return {};
  return {
    projectAccent: accentBySlug?.get(slug),
    projectIcon: iconBySlug?.get(slug),
  };
}
