import type { WorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import { useCallback } from 'react';
import { regionSurfaceOfPane } from '../regions/region-surface-panes';
import {
  type OpenInRegionOptions,
  type OpenInRegionOutcome,
  useRegionModel,
} from './RegionModelContext';

/** The model half `openInRegion` composes: `RegionModelContext.openSurfaceInRegion`. */
export interface OpenSurfaceInRegionModel {
  openSurfaceInRegion(
    surfaceId: string,
    options?: OpenInRegionOptions,
  ): OpenInRegionOutcome;
}

/**
 * Open a pane instance in a dock region (#2048): the one producer callers
 * use for a cross-region open, generalising `showSurface(id, intent)` to an
 * instance. Resolves the instance to its surface through the pane inventory
 * (`regionSurfaceOfPane` — the canonical-occurrence fold, so an impostor
 * under a surface's descriptor is `no-surface`, not the surface) and hands
 * the surface to the model, which resolves the region, reveals it and
 * places or selects. Everything the model refuses comes back typed; nothing
 * navigates, nothing is written for a refusal.
 *
 * In this batch the fold reaches surface-backed instances only (Chat,
 * Activity, the coding singletons). An instance-keyed pane — a preview of
 * one file, a second terminal — has no surface yet and is `no-surface`;
 * batch B (#2049) extends the fold with instance ids in `RegionState.panes`.
 *
 * A sibling of `useShowSurface`, not a method of the provider, on purpose:
 * the provider is in the entry chunk and the inventory's contracts are not
 * (measured +1,820 B gzip against a 527 B headroom, #2047). Every caller of
 * this hook — the region catalog, a pane's own link handler — already lives
 * behind a lazy boundary, so importing it costs the entry nothing.
 */
export function openInRegion(
  model: OpenSurfaceInRegionModel,
  instance: WorkspacePaneInstance,
  options?: OpenInRegionOptions,
): OpenInRegionOutcome {
  const surfaceId = regionSurfaceOfPane(instance);
  if (surfaceId === null) return { ok: false, reason: 'no-surface' };
  return model.openSurfaceInRegion(surfaceId, options);
}

/** `openInRegion` bound to the mounted region model. */
export function useOpenInRegion(): (
  instance: WorkspacePaneInstance,
  options?: OpenInRegionOptions,
) => OpenInRegionOutcome {
  const model = useRegionModel();
  return useCallback(
    (instance: WorkspacePaneInstance, options?: OpenInRegionOptions) =>
      openInRegion(model, instance, options),
    [model],
  );
}
