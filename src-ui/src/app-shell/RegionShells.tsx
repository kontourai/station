import type { WorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import {
  type ComponentType,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
} from 'react';
import {
  ChatDock,
  renderAmbientChatPane,
} from '../components/chat-dock/ChatDock';
import { LazyBoundary } from '../components/LazyBoundary';
import { SkeletonBlock } from '../components/Skeleton';
import { useRegionModelOptional } from '../contexts/RegionModelContext';
import type { DockShellChrome } from '../hooks/useDockShellChrome';
import { availablePlacements, useDockSlotDevice } from '../hooks/useIsMobile';
import {
  DOCK_REGION_IDS,
  type DockRegionId,
  foldedDockRegion,
  resolveRegionSurface,
} from '../regions/region-model';

const loadActivityRegionShell = () =>
  import('./ActivityRegionShell').then(({ ActivityRegionShell }) => ({
    default: ActivityRegionShell,
  }));

function ActivitySurfaceShell({ regionId }: { regionId: 'main' }) {
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

function HomeSurfaceShell(_props: { regionId: 'main' }) {
  const renderHome = useContext(HomeShellContext);
  return renderHome ? renderHome() : null;
}

/**
 * The `main` region's renderers, one per surface that declares `main`
 * (`region-surface-boundary.test.ts` pins the keys to exactly those). Dock
 * regions are not rendered from here since #2045: a dock region renders its
 * occupant as a pane of the region's host (`RegionPaneHost`), and which
 * surfaces have such a pane is `REGION_SURFACE_PANES`. Chat declares no
 * `main` placement, so it has no entry.
 */
export const REGION_SURFACE_SHELLS: ReadonlyMap<
  string,
  ComponentType<{ regionId: 'main' }>
> = new Map<string, ComponentType<{ regionId: 'main' }>>([
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
 * Every call returns a NEW promise; the module registry makes the repeat
 * `import()` free. Memoizing it froze the tab on the dock's second mount
 * (kontourai/station#1301: React's `lazy` livelocks on a promise it has
 * already settled), and App.tsx's `showAmbientChatDock` remounts the host on
 * ordinary navigation. `ChatDock.tsx` pre-warms the same chunk at module
 * load, so the boundary here resolves without a visible gap.
 */
const loadRegionPaneHost = () =>
  import('../workspace-panes/RegionPaneHost').then((module) => ({
    default: module.RegionPaneHost,
  }));

const loadActivityDockPane = () =>
  import('./ActivityRegionShell').then(({ ActivityDockPane }) => ({
    default: ActivityDockPane,
  }));

/**
 * Activity as a region pane: the pane (body, sessions surface) stays behind
 * its own lazy boundary so the sessions import graph is not in the host's
 * chunk. The region's chrome is the host's bar (#2046 2b), so the pane takes
 * none of it.
 */
function renderActivityDockPane(
  _instance: WorkspacePaneInstance,
  _chrome: DockShellChrome,
) {
  return (
    <LazyBoundary
      load={loadActivityDockPane}
      componentProps={{}}
      pending={<SkeletonBlock count={3} label="Loading Activity" />}
    />
  );
}

/**
 * One region's host (#2045): `RegionPaneHost` in its own chunk, given Chat's
 * renderer (from `ChatDock.tsx`, where the chat stack lives) and Activity's.
 * `pending={null}`: the dock is a persistent shell affordance and the chunk
 * is pre-warmed, so the boundary resolves without blinking a placeholder in
 * and out.
 */
function DockRegionHost({ regionId }: { regionId: DockRegionId }) {
  return (
    <LazyBoundary
      load={loadRegionPaneHost}
      componentProps={{
        regionId,
        renderChatPane: renderAmbientChatPane,
        renderActivityPane: renderActivityDockPane,
      }}
      pending={null}
    />
  );
}

/**
 * One `RegionPaneHost` — a `DockShell` around the region's pane-host
 * document — per dock region that has something to show: one holding a pane,
 * or (since #2153) a VISIBLE empty one, which renders its bar over a
 * placeholder and no host document at all (#928, #2045). The host is keyed by
 * its REGION: the document is the region's (`ambient:<region>`), so a
 * surface moving between regions leaves one host and joins another rather
 * than carrying a host with it. A surface occupies at most one region
 * (`placeSurface`, region-model.ts), which is what keeps `#chat-dock` unique
 * and `dock.maximize` singly registered. A source scan in
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
        const { occupant, visible } = model.regions[id];
        // An EMPTY region gets a host while it is VISIBLE (#2153): the
        // region's chrome bar over a placeholder that names it ("Nothing in
        // the Right region yet"), so a region the user opened — or emptied
        // by closing its last tab — is somewhere they can see rather than a
        // thing that exists only while something occupies it. A hidden empty
        // region is nothing at all and mounts nothing.
        //
        // Visibility gates ONLY the empty case. A region that holds a pane
        // mounts its host whether or not it is visible, because hidden IS
        // the collapsed bar for an occupied region (D1: `is-collapsed`,
        // `useDockShellChrome`'s `isDockOpen` reads this region's `visible`)
        // — unmounting there would take the bar the chevron collapses to off
        // screen with it.
        //
        // A resolvable occupant gets a host; an id neither the registry nor
        // an instance FAMILY'S SHAPE knows (a fixture, a surface a later
        // slice places at runtime, an id a rolled-back build minted) mounts
        // nothing — the rule the per-occupant shell table applied before
        // #2045. Decided from `resolveRegionSurface` rather than the pane
        // inventory, so the pane contracts stay in the host's chunk;
        // `region-surface-panes.test.ts` pins that every registered surface
        // declaring a dock region HAS a pane, and
        // `region-instance-panes.test.ts` pins that the resolver and the
        // occurrence minter admit exactly the same instance ids, which is
        // what makes "resolvable" sufficient here.
        return (
          occupant === null
            ? visible
            : Boolean(resolveRegionSurface(occupant))
        ) ? (
          <DockRegionHost key={id} regionId={id} />
        ) : null;
      })}
    </>
  );
}
