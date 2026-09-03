import { type ComponentType, createContext, useContext } from 'react';
import { ChatDock } from '../components/chat-dock/ChatDock';
import { useRegionModelOptional } from '../contexts/RegionModelContext';
import { DOCK_REGION_IDS, type DockRegionId } from '../regions/region-model';
import type { NavigationView } from '../types';
import type { HomeViewNavigation } from '../views/home/useHomeViewModel';
import type { WorkspacePaneDockAction } from '../workspace-panes/WorkspacePaneDockContext';

interface ChatShellProps {
  homeContinuation: HomeViewNavigation | null;
  onNavigate: (view: NavigationView) => void;
  onDockActionChange: (action: WorkspacePaneDockAction | null) => void;
}

const ChatShellContext = createContext<ChatShellProps | null>(null);

function ChatSurfaceShell({ regionId }: { regionId: DockRegionId }) {
  const props = useContext(ChatShellContext);
  if (!props) return null;
  return <ChatDock regionId={regionId} {...props} />;
}

export const REGION_SURFACE_SHELLS: ReadonlyMap<
  string,
  ComponentType<{ regionId: DockRegionId }>
> = new Map([['chat', ChatSurfaceShell]]);

/**
 * One `DockShell` per occupied dock region (#928). A surface occupies at most
 * one region (`placeSurface`, region-model.ts), which is what keeps
 * `#chat-dock` unique and `dock.maximize` singly registered, and is why the
 * shell is keyed by its OCCUPANT: moving a surface re-props the same
 * instance instead of tearing the pane down, exactly as the single ambient
 * `ChatDock` behaved before this file existed. Chat is the only registered
 * surface in this slice; a source scan in `main-provider-order.test.ts` pins
 * the provider's tag order, and the no-provider branch keeps App-level tests
 * on the legacy mount.
 */
export function RegionShells({
  homeContinuation,
  onNavigate,
  onDockActionChange,
}: {
  homeContinuation: HomeViewNavigation | null;
  onNavigate: (view: NavigationView) => void;
  onDockActionChange: (action: WorkspacePaneDockAction | null) => void;
}) {
  const model = useRegionModelOptional();
  if (!model)
    return (
      <ChatDock
        homeContinuation={homeContinuation}
        onNavigate={onNavigate}
        onDockActionChange={onDockActionChange}
      />
    );
  return (
    <ChatShellContext.Provider
      value={{ homeContinuation, onNavigate, onDockActionChange }}
    >
      {DOCK_REGION_IDS.map((id) => {
        const occupant = model.regions[id].occupant;
        const SurfaceShell = occupant
          ? REGION_SURFACE_SHELLS.get(occupant)
          : undefined;
        return SurfaceShell ? (
          <SurfaceShell key={occupant} regionId={id} />
        ) : null;
      })}
    </ChatShellContext.Provider>
  );
}
