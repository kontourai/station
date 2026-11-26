import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';

/** The Station-wide Feature Preview behind the Project Overview (#5064, #5072). */
export const PROJECT_OVERVIEW_PREVIEW_ID = 'project-overview';

/**
 * Whether the Project Overview preview is on. Absent preview data (loading,
 * or a failed read with nothing cached) reads as off.
 */
export function useProjectOverviewPreview(): boolean {
  return useSurfaceVisibilityFlags().has(PROJECT_OVERVIEW_PREVIEW_ID);
}
