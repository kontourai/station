import { type SurfaceIntent, useRegionModel } from './RegionModelContext';

/**
 * The state-free command half of the region model, for renderers that must not
 * read region state (`region-surface-boundary.test.ts` permits this hook by
 * name for exactly that). `RegionModelProvider` wraps `<App/>` unconditionally
 * (`main.tsx`, pinned by `main-provider-order.test.ts`) and every call site is
 * inside App, so a provider-less path here would be dead code: `useRegionModel`
 * throws instead of silently degrading.
 */
export function useShowSurface(): (
  surfaceId: string,
  intent?: SurfaceIntent,
) => void {
  return useRegionModel().showSurface;
}
