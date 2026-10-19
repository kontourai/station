import { type ReactNode, useMemo } from 'react';
import { usePaneRelations } from '../contexts/PaneRelationsContext';
import { SuspendRegionSurfaces } from '../contexts/RegionModelContext';
import {
  CENTER_OWNED_SURFACES,
  useLayoutChatPlacement,
} from './chat-placement';

const NO_SURFACES: readonly string[] = [];

/**
 * What the region shells and the toolbar's region toggles both read the
 * arrangement without — ONE derivation, so the toggles report what the
 * shells render: Chat while the Coding centre owns it, and the transient
 * previews a source hid because their opener now shows another selection
 * (`PaneRelationsProvider`). Always rendered, so a change of what is
 * suspended re-derives the hosts instead of remounting them.
 */
export function useShellSuspendedSurfaces(): readonly string[] {
  const centerOwnsChat = useLayoutChatPlacement() === 'center';
  const { hiddenSurfaces } = usePaneRelations();
  return useMemo(() => {
    if (!centerOwnsChat) return hiddenSurfaces;
    if (hiddenSurfaces.length === 0) return CENTER_OWNED_SURFACES;
    return [...CENTER_OWNED_SURFACES, ...hiddenSurfaces];
  }, [centerOwnsChat, hiddenSurfaces]);
}

export function ShellSurfaceSuspension({ children }: { children: ReactNode }) {
  const surfaces = useShellSuspendedSurfaces();
  return (
    <SuspendRegionSurfaces
      surfaces={surfaces.length === 0 ? NO_SURFACES : surfaces}
    >
      {children}
    </SuspendRegionSurfaces>
  );
}
