import {
  isCanonicalWorkspaceActivityPaneInstance,
  WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
  WORKSPACE_ACTIVITY_PANE_INSTANCE,
} from '@kontourai/station-contracts/workspace-activity-pane';
import {
  createWorkspaceChatPaneInstance,
  isCanonicalWorkspaceChatPaneInstance,
  WORKSPACE_CHAT_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-chat-pane';
import {
  isCanonicalWorkspaceHomePaneInstance,
  WORKSPACE_HOME_PANE_DESCRIPTOR,
  WORKSPACE_HOME_PANE_INSTANCE,
} from '@kontourai/station-contracts/workspace-home-pane';
import type {
  WorkspacePaneDescriptor,
  WorkspacePaneInstance,
  WorkspacePaneSuppliableContexts,
} from '@kontourai/station-contracts/workspace-pane';
import {
  createWorkspacePaneHostBaselineDocument,
  type WorkspacePaneHostDocumentV1,
  workspacePaneHostSuppliableContexts,
} from '@kontourai/station-contracts/workspace-pane-host';
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useState,
} from 'react';
import { ChatDockHeader } from '../components/chat-dock/ChatDockHeader';
import { DockShell } from '../components/chat-dock/DockShell';
import { SkeletonBlock } from '../components/state';
import { useApiBase } from '../contexts/ApiBaseContext';
import type { DockSlotGeometry } from '../hooks/dock-slot-geometry';
import type { DockShellChrome } from '../hooks/useDockShellChrome';
import type { NavigationView } from '../types';
import { ActivityWorkspacePaneBindingProvider } from '../views/activity/ActivityWorkspacePaneBinding';
import {
  HomeWorkspacePane,
  HomeWorkspacePaneBindingProvider,
} from '../views/home/HomeWorkspacePane';
import {
  type HomeViewNavigation,
  useHomeViewModel,
} from '../views/home/useHomeViewModel';
import { ambientDockDescriptorFor } from './ambientDockOccupants';
import { DockOccupantPicker } from './DockOccupantPicker';
import { WorkspacePaneDockContext } from './WorkspacePaneDockContext';
import { WorkspacePaneHost } from './WorkspacePaneHost';

const AMBIENT_CHAT_DOCK_DOCUMENT_ID = 'chat-dock';

/**
 * The shell has one projectless chat occurrence. Its placement capability is
 * declared by the descriptor; this document supplies the distinct ambient
 * host identity that persists it per device.
 *
 * Throws rather than returning null, the same way the Chat descriptor itself
 * refuses to parse: both inputs are code-owned constants, so a failure here is
 * a build that shipped an invalid built-in, not a runtime condition. Returning
 * null would make the dock silently absent — and an absent affordance is
 * indistinguishable from one Station never had.
 */
export function createAmbientChatDockPaneDocument(): WorkspacePaneHostDocumentV1 {
  const chat = createWorkspaceChatPaneInstance();
  if (!chat) throw new Error('Invalid built-in ambient Chat dock occurrence');
  const document = createWorkspacePaneHostBaselineDocument(
    AMBIENT_CHAT_DOCK_DOCUMENT_ID,
    { kind: 'ambient' },
    [chat],
  );
  if (!document)
    throw new Error('Invalid built-in ambient Chat dock host document');
  return document;
}

const ambientChatDockPaneDocument = createAmbientChatDockPaneDocument();

/**
 * The dock action the ambient host publishes. The action trusts the reported
 * `suppliable` blindly — by design, so a second host with a different scope
 * works through the same context — which makes THIS the seam where the trust
 * has to be honest: the set is the scope derivation, never a hand-written
 * one. Exported for the test that pins exactly that (an injection replacing
 * it with `new Set(['project'])` passed every other test).
 *
 * `occupantInstanceId` is the host's own document state (its
 * `activeInstanceId`), republished on every occupant change so route
 * placements can derive "my pane is away" from the one source of truth
 * (archive#4090). `undockOccupant` restores the slot's baseline occupant.
 */
export function ambientWorkspacePaneDockAction(
  dockPane: (
    descriptor: WorkspacePaneDescriptor,
    instance: WorkspacePaneInstance,
  ) => void,
  occupantInstanceId: string,
  undockOccupant: () => void,
) {
  return {
    suppliable: workspacePaneHostSuppliableContexts({ kind: 'ambient' }),
    dockPane,
    occupantInstanceId,
    undockOccupant,
  };
}

/**
 * The ambient host is the sole writer of the shell geometry variables
 * (archive#3902/archive#3929 pin exactly one writer). `DockShell` is now the SINGLE
 * geometry authority regardless of occupant (archive#4460) — it reports its
 * live geometry through `onGeometryChange`; this host's only remaining job is
 * applying that report to the CSS variables the rest of the shell reads. No
 * dual chat-vs-derived path anymore: there is nothing left to derive, because
 * every occupant now shares the one instance that tracks live drag/snap/
 * maximize state.
 */
function useAmbientDockSlotGeometryWriter() {
  return useCallback((geometry: DockSlotGeometry | null) => {
    const root = document.documentElement;
    if (!geometry) {
      root.style.removeProperty('--chat-dock-width');
      root.style.removeProperty('--dock-slot-size');
      return;
    }
    if (geometry.width === null) {
      root.style.removeProperty('--chat-dock-width');
    } else {
      root.style.setProperty('--chat-dock-width', `${geometry.width}px`);
    }
    root.style.setProperty('--dock-slot-size', `${geometry.size}px`);
  }, []);
}

function admitsAmbientDockInstance(
  candidate: unknown,
): WorkspacePaneInstance | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const instance = candidate as WorkspacePaneInstance;
  return ambientDockDescriptorFor(instance) ? instance : null;
}

// Lazy on purpose, unlike Home's occupant: providing the Activity BINDING
// is a small context module, but the renderer's import graph is the whole
// sessions surface. This host's chunk is requested at entry time (ChatDock
// pre-warms it), so a static import here would ship that surface with the
// shell for a pane most devices never dock.
const LazyActivityWorkspacePane = lazy(() =>
  import('../views/activity/ActivityWorkspacePane').then(
    ({ ActivityWorkspacePane }) => ({ default: ActivityWorkspacePane }),
  ),
);

/**
 * The dock-placement control every non-Chat occupant shares — factored out
 * so Home and Activity, which have no other header content, don't each
 * hand-roll the same `ChatDockHeader` call (archive#4460). `occupantPicker`
 * is NOT included: it is occupant-specific (a different `current` per
 * occupant) and already lives, pre-rendered, on `shellChrome.occupantPicker`
* see `AmbientDockShellApi`.
 */
function ambientNonChatHeaderProps(shellChrome: AmbientDockShellApi) {
  return {
    isDragging: shellChrome.isDragging,
    onDockSnap: shellChrome.applyDockSnap,
    availableDockSlotPlacements: shellChrome.availableDockSlotPlacements,
    effectiveDockSlotPlacement: shellChrome.effectiveDockSlotPlacement,
    onDockPlacementChange: shellChrome.commitDockPlacement,
    occupantPicker: shellChrome.occupantPicker,
  };
}

function AmbientActivityDock({
  shellChrome,
}: {
  shellChrome: AmbientDockShellApi;
}) {
// The same occurrence the `/activity` route places; only the placement
// differs. While Activity occupies the dock, the `/activity` route renders
 // its away state instead of a second co-mounted copy (archive#4090).
  const { apiBase } = useApiBase();
  return (
    <>
{/* archive#4460: the SAME shared header Chat renders through — resize,
          maximize/collapse, placement and the occupant picker all come from
          it, not a second hand-rolled copy. */}
      <ChatDockHeader {...ambientNonChatHeaderProps(shellChrome)} />
{/* No routed sessionId: a deep-linked selection belongs to the route
          placement, and the dock occupant starts at the list. */}
      <div className="dock-slot__body">
        <ActivityWorkspacePaneBindingProvider binding={{ apiBase }}>
{/* Activity is already the ambient occupant. Only the header's
              picker may replace it, so the occupant itself does not offer a
              meaningless second "Dock this pane" control. */}
          <WorkspacePaneDockContext.Provider value={null}>
            <Suspense
              fallback={<SkeletonBlock count={3} label="Loading Activity" />}
            >
              <LazyActivityWorkspacePane
                descriptor={WORKSPACE_ACTIVITY_PANE_DESCRIPTOR}
                instance={WORKSPACE_ACTIVITY_PANE_INSTANCE}
              />
            </Suspense>
          </WorkspacePaneDockContext.Provider>
        </ActivityWorkspacePaneBindingProvider>
      </div>
    </>
  );
}

function AmbientHomeDock({
  continuation,
  onNavigate,
  shellChrome,
}: {
  continuation: HomeViewNavigation | null;
  onNavigate: (view: NavigationView) => void;
  shellChrome: AmbientDockShellApi;
}) {
// This renderer remains behind the ambient host's lazy boundary. While Home
// occupies the dock, `/` renders its away state instead of a second
// co-mounted copy — archive#4090's open question, answered by.
  const model = useHomeViewModel(onNavigate);
  return (
    <>
      <ChatDockHeader {...ambientNonChatHeaderProps(shellChrome)} />
      <div className="dock-slot__body">
        <HomeWorkspacePaneBindingProvider
          binding={{ model, continuation, onNavigate }}
        >
{/* Home is already the ambient occupant. Only the header's picker
              may replace it, so the occupant itself does not offer a
              meaningless second "Dock this pane" control. */}
          <WorkspacePaneDockContext.Provider value={null}>
            <HomeWorkspacePane
              descriptor={WORKSPACE_HOME_PANE_DESCRIPTOR}
              instance={WORKSPACE_HOME_PANE_INSTANCE}
            />
          </WorkspacePaneDockContext.Provider>
        </HomeWorkspacePaneBindingProvider>
      </div>
    </>
  );
}

/**
 * The full dock-chrome surface (`DockShellChrome`) plus the two things it
 * cannot itself derive: `dockPane`, the ambient host's own admission-checked
 * replace action, and `occupantPicker`, a pre-rendered `DockOccupantPicker`
 * naming THIS occupant (a different node per occupant — Chat's names "Chat",
 * Home's names "Home"). Every occupant (Chat, Home, Activity) receives
 * exactly this shape (archive#4460) — one contract, not three per-occupant
 * ones.
 *
 * `occupantPicker` is pre-rendered, not `{current, onChoose}` data (
 * round): `DockOccupantPicker` pulls in `ambientDockOccupants.ts` and all
 * three pane-descriptor contracts modules, and this host is the one place
 * that chunk stays LAZY — passing the raw data through would let a consumer
 * (`ChatDockHeader`, which the EAGER `ChatDock.tsx` imports) reconstruct the
 * element itself and drag that whole import graph into the entry bundle,
 * which is exactly the defect this fixes (measured: +2554B gzip before the
 * fix; see the ceiling commit history).
 */
export type AmbientDockShellApi = DockShellChrome & {
  dockPane: (
    descriptor: WorkspacePaneDescriptor,
    instance: WorkspacePaneInstance,
  ) => void;
  occupantPicker: ReactNode;
};

/** The ambient shell mounts Chat through the same host/frame lifecycle as every pane. */
export function AmbientChatDockPaneHost({
  onRequestAuth,
  renderChatPane,
  homeContinuation = null,
  onNavigate = () => undefined,
  onDockActionChange,
}: {
  onRequestAuth?: () => Promise<boolean> | undefined;
  renderChatPane(
    instance: WorkspacePaneInstance,
    onRequestAuth: (() => Promise<boolean> | undefined) | undefined,
    shellChrome: AmbientDockShellApi,
  ): ReactNode;
  homeContinuation?: HomeViewNavigation | null;
  onNavigate?: (view: NavigationView) => void;
  onDockActionChange?(
    action: {
      suppliable: WorkspacePaneSuppliableContexts;
      dockPane(
        descriptor: WorkspacePaneDescriptor,
        instance: WorkspacePaneInstance,
      ): void;
    } | null,
  ): void;
}) {
  const [replace, setReplace] = useState<
    ((instance: WorkspacePaneInstance) => boolean) | null
  >(null);
  const [activeInstanceId, setActiveInstanceId] = useState(
    ambientChatDockPaneDocument.activeInstanceId,
  );
  const writeDockSlotGeometry = useAmbientDockSlotGeometryWriter();
  const dockPane = useCallback(
    (descriptor: WorkspacePaneDescriptor, instance: WorkspacePaneInstance) => {
// `ambientDockDescriptorFor` already folds in the modes-satisfiability
// derivation, so the request is refused unless the occurrence is the
// canonical one of an ambient-satisfiable pane this host renders AND
// the caller's descriptor is that exact declaration.
      if (ambientDockDescriptorFor(instance) !== descriptor || !replace) return;
      replace(instance);
    },
    [replace],
  );
// "Remove from the dock" = restore the slot's baseline occupant, which is
// Chat — the same occurrence the baseline document places. Owned by the
// host so a route's away state never imports Chat's machinery to offer it.
  const undockOccupant = useCallback(() => {
    dockPane(
      WORKSPACE_CHAT_PANE_DESCRIPTOR,
      createWorkspaceChatPaneInstance()!,
    );
  }, [dockPane]);
  useEffect(() => {
    if (!replace) {
      onDockActionChange?.(null);
      return;
    }
// Republished on every occupant change: `activeInstanceId` in the
// published action is how route placements learn their pane is away
// (and, just as load-bearing, when it no longer is).
    onDockActionChange?.(
      ambientWorkspacePaneDockAction(
        dockPane,
        activeInstanceId,
        undockOccupant,
      ),
    );
    return () => onDockActionChange?.(null);
  }, [activeInstanceId, dockPane, onDockActionChange, replace, undockOccupant]);
  const host = (
// DockShell wraps every occupant (Chat, Home, Activity) — the one dock
// chrome shell (archive#4460): root box, resize handle, geometry/snap/
// drag state, `dock.toggle`/`dock.maximize`. Its `onGeometryChange` is
// the ambient host's only remaining geometry job — apply the shell's
 // single live report to the CSS variables (archive#3902/archive#3929: exactly
// one writer).
    <DockShell onGeometryChange={writeDockSlotGeometry}>
      {(shellChrome) => {
// `occupantPicker` is built PER OCCUPANT below, not once here: each
 // one names a different `current` descriptor — see
// `AmbientDockShellApi`'s doc for why it is pre-rendered at all.
        const shellApiFor = (
          current: WorkspacePaneDescriptor,
        ): AmbientDockShellApi => ({
          ...shellChrome,
          dockPane,
          occupantPicker: (
            <DockOccupantPicker current={current} onChoose={dockPane} />
          ),
        });
        return (
          <WorkspacePaneHost
            document={ambientChatDockPaneDocument}
            presentation="chromeless"
            admitRestoredInstance={admitsAmbientDockInstance}
// Wrapped in an updater on purpose: the payload IS a function, and a
// bare `setReplace` would make React call it as an updater —
// `controller.replace(previousState)` — leaving `replace` a boolean and
// the published dock action permanently null. That exact miswiring
// shipped and kept "Dock this pane" off every route (archive#4090).
            onDockSlotActionChange={(action) => setReplace(() => action)}
            onDocumentChange={(document) =>
              setActiveInstanceId(document.activeInstanceId)
            }
            renderPane={(instance) =>
              instance.descriptorId === WORKSPACE_CHAT_PANE_DESCRIPTOR.id &&
              isCanonicalWorkspaceChatPaneInstance(instance) ? (
                renderChatPane(
                  instance,
                  onRequestAuth,
                  shellApiFor(WORKSPACE_CHAT_PANE_DESCRIPTOR),
                )
              ) : instance.descriptorId === WORKSPACE_HOME_PANE_DESCRIPTOR.id &&
                isCanonicalWorkspaceHomePaneInstance(instance) ? (
                <AmbientHomeDock
                  continuation={homeContinuation}
                  onNavigate={onNavigate}
                  shellChrome={shellApiFor(WORKSPACE_HOME_PANE_DESCRIPTOR)}
                />
              ) : instance.descriptorId ===
                  WORKSPACE_ACTIVITY_PANE_DESCRIPTOR.id &&
                isCanonicalWorkspaceActivityPaneInstance(instance) ? (
                <AmbientActivityDock
                  shellChrome={shellApiFor(WORKSPACE_ACTIVITY_PANE_DESCRIPTOR)}
                />
              ) : null
            }
          />
        );
      }}
    </DockShell>
  );
  return host;
}
