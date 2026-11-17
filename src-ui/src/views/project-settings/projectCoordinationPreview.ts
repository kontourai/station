import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';

/**
 * The `project-coordination` Feature Preview (#5062 brief, #5065 memory,
 * #5068 models and usage). A host offers it only when it serves the brief,
 * memory and Project usage, so it also stands for the capability.
 */
export const PROJECT_COORDINATION_PREVIEW_ID = 'project-coordination';

export function useProjectCoordinationPreview(): boolean {
  return useSurfaceVisibilityFlags().has(PROJECT_COORDINATION_PREVIEW_ID);
}
