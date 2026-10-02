import { surfaceDeepLink } from '@kontourai/station-contracts/surface-deep-link';
import { useCallback } from 'react';
import {
  requestCenterChatPage,
  useLayoutChatPlacement,
} from '../app-shell/chat-placement';
import { surfaceMayOccupy } from '../regions/region-model';
import { navigationStore } from './navigation-store';
import { type SurfaceIntent, useRegionModel } from './RegionModelContext';

/**
 * "Reveal this surface" for renderers that must not read region state
 * (`region-surface-boundary.test.ts` permits this hook by name for exactly
 * that). `RegionModelProvider` wraps `<App/>` unconditionally (`main.tsx`,
 * pinned by `main-provider-order.test.ts`) and every call site is inside App,
 * so a provider-less path here would be dead code: `useRegionModel` throws
 * instead of silently degrading.
 *
 * Commanding the model is only half of it. `App.tsx` mounts `RegionShells`
 * only while `showAmbientChatDock` holds, so while a Chat workspace layout is
 * the current view NO region shell is mounted and a `showSurface` call mutates
 * state nothing renders — the click does nothing at all. This hook had a
 * navigation fallback once, guarded on "there is no `RegionModelProvider`",
 * which could never fire; the fallback was right and its condition was wrong.
 * The condition that actually occurs is "no region surface host is
 * registered", and the remedy is the canonical deep link: it leaves the chat
 * layout for `/`, where the provider's adoption effect reveals the surface and
 * delivers the intent (`RegionModelContext-deep-link.test.tsx`).
 */
export function useShowSurface(): (
  surfaceId: string,
  intent?: SurfaceIntent,
) => void {
  const { canRenderRegionSurfaces, showSurface, deliverSurfaceIntent } =
    useRegionModel();
  const centerOwnsChat = useLayoutChatPlacement() === 'center';
  return useCallback(
    (surfaceId: string, intent?: SurfaceIntent) => {
      // While the Coding layout's centre owns Chat, "show Chat" is its Chat
      // page: revealing Chat's dock region would reveal a region the shells
      // render without Chat. The intent (a session to open) still goes
      // through the outbox, which the centre's Chat consumes like any other
      // Chat placement.
      if (surfaceId === 'chat' && centerOwnsChat) {
        // Never a reveal of Chat's (suspended) dock region, even before the
        // workbench mounts to answer the request.
        requestCenterChatPage();
        if (intent) deliverSurfaceIntent(surfaceId, intent);
        return;
      }
      if (canRenderRegionSurfaces) {
        showSurface(surfaceId, intent);
        return;
      }
      navigationStore.navigate(
        surfaceDeepLink({
          surfaceId,
          sessionId: intent?.session,
          focus: intent?.focus,
        }),
      );
    },
    [
      canRenderRegionSurfaces,
      centerOwnsChat,
      deliverSurfaceIntent,
      showSurface,
    ],
  );
}

/**
 * "Go to this surface's page" — what a PLACE row means: the sidebar's
 * Activity row, the palette's Activity entry and Home's "View Activity". A
 * surface that declares `main` is put there (Home, the previous occupant,
 * is unplaced and comes back through its own row) and the model navigates
 * to `/`, so the row can be the current page (`aria-current`) the way Home
 * is. Every OTHER producer keeps `useShowSurface`'s contextual reveal: a
 * notification or evidence link, a session intent and the surface's chord
 * still open it where the reader already is, in its dock region, which is
 * why this is a second verb rather than a change to `defaultRegion`.
 *
 * No deep-link fallback: `main` is the route outlet `App.tsx` renders at `/`
 * whether or not a region host is mounted, and the navigation to `/` is what
 * leaves a full-screen Chat layout. A surface that cannot occupy `main` is
 * revealed the ordinary way instead.
 */
export function useShowSurfacePage(): (surfaceId: string) => void {
  const { showSurface } = useRegionModel();
  const reveal = useShowSurface();
  return useCallback(
    (surfaceId: string) => {
      if (surfaceMayOccupy(surfaceId, 'main'))
        showSurface(surfaceId, undefined, { region: 'main' });
      else reveal(surfaceId);
    },
    [reveal, showSurface],
  );
}
