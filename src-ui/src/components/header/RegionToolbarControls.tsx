import { useCallback } from 'react';
import { useNavigation } from '../../contexts/NavigationContext';
import {
  useRegionModel,
  useRegionModelOptional,
} from '../../contexts/RegionModelContext';
import { useDockSlotPlacement, useIsMobile } from '../../hooks/useIsMobile';
import { useKeyboardShortcut } from '../../hooks/useKeyboardShortcut';
import {
  DOCK_REGION_IDS,
  isRegionAvailable,
  type RegionId,
  type RegisteredSurface,
  regionLabel,
} from '../../regions/region-model';
import type { DockMode } from '../../types';

const DOCK_WHEN = { not: 'composerFocused' } as const;

function RegionGlyph({ id }: { id: RegionId }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 16">
      <rect x="1" y="1" width="18" height="14" rx="2" />
      {id === 'left' ? (
        <path d="M6 1v14" />
      ) : id === 'right' ? (
        <path d="M14 1v14" />
      ) : (
        <path d="M1 10h18" />
      )}
    </svg>
  );
}

function RegionShortcut({
  surface,
  onToggle,
}: {
  surface: RegisteredSurface;
  onToggle: () => void;
}) {
  useKeyboardShortcut(
    surface.shortcut.id,
    surface.shortcut.key,
    [...surface.shortcut.modifiers],
    `Toggle ${surface.title} region`,
    onToggle,
    true,
    0,
    DOCK_WHEN,
  );
  return null;
}

/**
 * Global region commands. A registered surface supplies content and shortcut
 * metadata only; this shell component decides which region is available,
 * visible, or empty and performs every placement mutation.
 */
function ConnectedRegionToolbarControls() {
  const {
    regions,
    surfaces,
    setRegion,
    placeSurface: placeSurfaceInModel,
  } = useRegionModel();
  const { dockMode } = useNavigation();
  const isMobile = useIsMobile();
  const { available } = useDockSlotPlacement(dockMode);
  const breakpoint = isMobile ? 'phone' : 'desktop';
  const firstSurface = surfaces.values().next().value as
    | RegisteredSurface
    | undefined;
  const availableRegions = DOCK_REGION_IDS.filter(
    (id) => isRegionAvailable(id, breakpoint) && available.includes(id),
  );

  const toggleSurface = useCallback(
    (surfaceId: string) => {
      const occupied = availableRegions.find(
        (id) => regions[id].occupant === surfaceId,
      );
      if (!occupied) return;
      const visible = regions[occupied].visible;
      setRegion(occupied, { visible: !visible });
    },
    [availableRegions, regions, setRegion],
  );

  const placeSurface = useCallback(
    (surfaceId: string, id: RegionId) => {
      if (!availableRegions.includes(id as DockMode)) return;
      const surface = surfaces.get(surfaceId);
      if (!surface) return;
      placeSurfaceInModel(surfaceId, id);
    },
    [availableRegions, placeSurfaceInModel, surfaces],
  );

  return (
    <fieldset className="app-toolbar__regions">
      <legend>Regions</legend>
      {[...surfaces.values()].map((surface) => (
        <RegionShortcut
          key={surface.id}
          surface={surface}
          onToggle={() => toggleSurface(surface.id)}
        />
      ))}
      {availableRegions.map((id) => {
        const occupant = regions[id].occupant;
        const surface = occupant ? surfaces.get(occupant) : undefined;
        const label = regionLabel(id);
        const isCurrent = Boolean(regions[id].occupant === 'chat');
        const pressed = Boolean(surface && regions[id].visible && isCurrent);
        const actionLabel = surface
          ? `${pressed ? 'Hide' : 'Show'} ${surface.title} ${label} region`
          : firstSurface
            ? `Place ${firstSurface.title} in ${label} region`
            : `${label} region is empty`;
        return (
          <button
            key={id}
            type="button"
            className="app-toolbar__region-btn"
            aria-label={actionLabel}
            aria-pressed={pressed}
            title={actionLabel}
            disabled={!surface && !firstSurface}
            onClick={() => {
              if (surface) toggleSurface(surface.id);
              else if (firstSurface) placeSurface(firstSurface.id, id);
            }}
          >
            <RegionGlyph id={id} />
            {!surface && <span className="app-toolbar__region-add">+</span>}
          </button>
        );
      })}
    </fieldset>
  );
}

export function RegionToolbarControls() {
  return useRegionModelOptional() ? <ConnectedRegionToolbarControls /> : null;
}
