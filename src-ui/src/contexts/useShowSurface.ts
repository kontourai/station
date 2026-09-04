import { surfaceDeepLink } from '@kontourai/station-contracts/surface-deep-link';
import { useCallback } from 'react';
import { navigationStore } from './navigation-store';
import {
  type SurfaceIntent,
  useRegionModelOptional,
} from './RegionModelContext';

export function useShowSurface(): (
  surfaceId: string,
  intent?: SurfaceIntent,
) => void {
  const model = useRegionModelOptional();
  return useCallback(
    (surfaceId: string, intent?: SurfaceIntent) => {
      if (model?.showSurface) return model.showSurface(surfaceId, intent);
      navigationStore.navigate(
        surfaceDeepLink({
          surfaceId,
          sessionId: intent?.session,
          focus: intent?.focus,
        }),
      );
    },
    [model?.showSurface],
  );
}
