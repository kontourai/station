import {
  type ComponentType,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
} from 'react';
import { ChatDock } from '../components/chat-dock/ChatDock';
import { LazyBoundary } from '../components/LazyBoundary';
import { SkeletonBlock } from '../components/Skeleton';
import { useRegionModelOptional } from '../contexts/RegionModelContext';
import { availablePlacements, useDockSlotDevice } from '../hooks/useIsMobile';
import {
  DOCK_REGION_IDS,
  foldedDockRegion,
  isDockRegion,
  type RegionId,
} from '../regions/region-model';

function ChatSurfaceShell({ regionId }: { regionId: RegionId }) {
  // Chat declares no `main` placement (`REGION_SURFACE_REGISTRY`), so
  // `placeSurface` never puts it there; the guard narrows the type for the
  // dock, it is not a branch anything reaches.
  if (!isDockRegion(regionId)) return null;
  return <ChatDock regionId={regionId} />;
}

const loadActivityRegionShell = () =>
  import('./ActivityRegionShell').then(({ ActivityRegionShell }) => ({
    default: ActivityRegionShell,
  }));

function ActivitySurfaceShell({ regionId }: { regionId: RegionId }) {
  return (
    <LazyBoundary
      load={loadActivityRegionShell}
      componentProps={{ regionId }}
      pending={<SkeletonBlock count={3} label="Loading Activity" />}
    />
  );
}

/**
 * What `App.tsx` renders at `/` for Home. Home's only placement is `main`,
 * and `main` at `/` is App's route outlet: the pending skeleton, the
 * host-unavailable and error states and the resolved `HomeView` all read
 * App-owned state (the resolved home surface, the retry, the connection
 * names), so App supplies the render and this shell is where the outlet
 * calls it from. It is `null` outside `MainRegionSurface`: nothing else may
 * mount Home.
 */
const HomeShellContext = createContext<(() => ReactNode) | null>(null);

function HomeSurfaceShell(_props: { regionId: RegionId }) {
  const renderHome = useContext(HomeShellContext);
  return renderHome ? renderHome() : null;
}

export const REGION_SURFACE_SHELLS: ReadonlyMap<
  string,
  ComponentType<{ regionId: RegionId }>
> = new Map<string, ComponentType<{ regionId: RegionId }>>([
  ['chat', ChatSurfaceShell],
  ['activity', ActivitySurfaceShell],
  ['home', HomeSurfaceShell],
]);

/**
 * The `main` region's occupant, rendered by the route outlet at `/` (#928
 * C2a). A null occupant is Home: the default arrangement names Home, and a
 * surface leaving `main` for a dock region leaves nothing behind, which the
 * outlet must not render as an empty page. An occupant with no shell (a
 * stale id) also falls back to Home rather than to a blank outlet.
 *
 * `RegionShells` below iterates the dock regions only, so a `main` occupant
 * never gets a `DockShell`; this is its one renderer.
 */
export function MainRegionSurface({
  occupant,
  renderHome,
}: {
  occupant: string | null;
  renderHome: () => ReactNode;
}) {
  const Shell =
    REGION_SURFACE_SHELLS.get(occupant ?? 'home') ?? HomeSurfaceShell;
  return (
    <HomeShellContext.Provider value={renderHome}>
      <Shell regionId="main" />
    </HomeShellContext.Provider>
  );
}

/**
 * One `DockShell` per occupied dock region (#928). A surface occupies at most
 * one region (`placeSurface`, region-model.ts), which is what keeps
 * `#chat-dock` unique and `dock.maximize` singly registered, and is why the
 * shell is keyed by its OCCUPANT: moving a surface re-props the same
 * instance instead of tearing the pane down, exactly as the single ambient
 * `ChatDock` behaved before this file existed. A source scan in
 * `main-provider-order.test.ts` pins the provider's tag order, and the
 * no-provider branch keeps App-level tests on the legacy mount.
 */
export function RegionShells() {
  const model = useRegionModelOptional();
  const bottomOnly = availablePlacements(useDockSlotDevice()).length === 1;
  // This component IS "a region surface can render right now": App mounts it
  // only while `showAmbientChatDock` holds, and a Chat workspace layout owns
  // the whole view instead. Registering from here — rather than handing the
  // model a copy of App's predicate — is what keeps the two from drifting;
  // the deleted navigation fallback this restores was guarded on a condition
  // that could never fire (#928). `useShowSurface` navigates while nothing is
  // registered, so a commanded reveal is never dropped on the floor.
  const registerRegionSurfaceHost = model?.registerRegionSurfaceHost;
  useEffect(() => registerRegionSurfaceHost?.(), [registerRegionSurfaceHost]);
  if (!model) return <ChatDock />;
  return (
    <>
      {DOCK_REGION_IDS.filter((id) => {
        if (!bottomOnly) return true;
        return id === foldedDockRegion(model.regions, model.lastShownRegion);
      }).map((id) => {
        const occupant = model.regions[id].occupant;
        const SurfaceShell = occupant
          ? REGION_SURFACE_SHELLS.get(occupant)
          : undefined;
        return SurfaceShell ? (
          <SurfaceShell key={occupant} regionId={id} />
        ) : null;
      })}
    </>
  );
}
