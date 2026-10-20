import { useProjectLayoutsQuery } from '@kontourai/station-sdk';
import { type ReactNode, useCallback, useMemo, useRef } from 'react';
import { useLayoutChatPlacement } from '../app-shell/chat-placement';
import { Button } from '../components/Button';
import { Empty } from '../components/state';
import { useNavigationActions } from '../contexts/NavigationContext';
import { navigationStore } from '../contexts/navigation-store';
import { describeRelatedOpenRefusal } from '../contexts/openRelatedFilePreview';
import { usePaneRelations } from '../contexts/PaneRelationsContext';
import { useRegionModelOptional } from '../contexts/RegionModelContext';
import { toastStore } from '../contexts/ToastContext';
import { useShowSurface } from '../contexts/useShowSurface';
import { paneFenceAdmission, readPaneFence } from '../regions/pane-fence';
import type { PaneOpener, PaneRelation } from '../regions/pane-relations';
import {
  occupiedRegion,
  type RegionArrangement,
  resolveRegionSurface,
  revealSurface,
} from '../regions/region-model';
import { useDockProject } from './useDockProject';
import './RelatedPaneStrip.css';

function GatePlaceholder({
  label,
  description,
}: {
  label: string;
  description: string;
}) {
  return (
    <div className="dock-slot__body">
      <Empty variant="compact" label={label} description={description} />
    </div>
  );
}

/**
 * The reader gate of a related occurrence (`pane-fence.ts`), rendered OUTSIDE
 * the pane so nothing the pane reads — its identity, its Project, its data —
 * runs before the gate admits it. A fenced occurrence renders only while the
 * verified Station is exactly its own; while the Station is unknown it says
 * so and reads nothing, and a fence this build cannot read stays closed. An
 * occurrence with no fence predates relationships and renders as before.
 */
export function FencedRelatedPane({
  instanceId,
  children,
}: {
  instanceId: string;
  children: ReactNode;
}) {
  const relations = usePaneRelations();
  const fence = useMemo(
    () => readPaneFence(window.localStorage, instanceId),
    [instanceId],
  );
  switch (paneFenceAdmission(fence, relations.stationId)) {
    case 'legacy':
    case 'admitted':
      return <>{children}</>;
    case 'checking':
      return (
        <GatePlaceholder
          label="Checking which Station this is"
          description="This pane belongs to one Station. It shows once Station confirms it is connected to that Station, and reads nothing until then."
        />
      );
    case 'wrong-station': {
      const label = relations.relationOf(instanceId)?.opener.label ?? 'a pane';
      return (
        <GatePlaceholder
          label="Opened on another Station"
          description={`This pane was opened from ${label} on a different Station, so Station does not read it here. Switch back to that Station to see it, or close the tab.`}
        />
      );
    }
    case 'unknown-fence':
      return (
        <GatePlaceholder
          label="This pane cannot be shown here"
          description="A newer Station build saved this pane, and this build cannot tell which Station it belongs to. It shows again in that build; you can close the tab."
        />
      );
  }
}

function onScreen(arrangement: RegionArrangement, surfaceId: string) {
  const region = occupiedRegion(arrangement, surfaceId);
  return (
    region !== undefined &&
    arrangement[region].visible &&
    arrangement[region].occupant === surfaceId
  );
}

/** Whether revealing `surfaceId` (Up's own reveal) takes `paneId` off screen. */
function revealHides(
  arrangement: RegionArrangement,
  surfaceId: string,
  paneId: string,
): boolean {
  if (!onScreen(arrangement, paneId)) return false;
  const surface = resolveRegionSurface(surfaceId);
  if (!surface) return false;
  const after = revealSurface(
    arrangement,
    surfaceId,
    occupiedRegion(arrangement, surfaceId) ?? surface.defaultRegion,
  ).arrangement;
  return !onScreen(after, paneId);
}

/**
 * Up changes local selection (Chat's conversation, a revealed surface) that
 * no route navigation guards. When that reveal takes THIS pane off screen —
 * the phone layer it is shown in, or the region tab it holds — this pane's own
 * unsaved-changes guard is asked once, before anything changes, and Cancel
 * changes nothing. Otherwise nothing is asked: the pane stays where it is. A
 * route navigation is not wrapped here; navigation already asks its guards.
 */
function useLeaveFor(instanceId: string) {
  const model = useRegionModelOptional();
  const modelRef = useRef(model);
  modelRef.current = model;
  const centerOwnsChat = useLayoutChatPlacement() === 'center';
  return useCallback(
    (reveals: string, leave: () => void) => {
      const current = modelRef.current;
      if (!current) {
        leave();
        return;
      }
      if (current.phoneLayer?.surfaceId === instanceId) {
        // Chat is under the layer: leave it the way "‹ Chat" does, whose
        // guarded close is the one question asked.
        if (reveals === 'chat') current.closePhoneLayer(leave);
        // Anything else replaces the layer's pane.
        else
          navigationStore.runNavigationGuards(leave, undefined, {
            owner: instanceId,
          });
        return;
      }
      const hides =
        !(reveals === 'chat' && centerOwnsChat) &&
        revealHides(current.regions, reveals, instanceId);
      if (!hides) {
        leave();
        return;
      }
      navigationStore.runNavigationGuards(leave, undefined, {
        owner: instanceId,
      });
    },
    [centerOwnsChat, instanceId],
  );
}

/** Up for a conversation opener: the canonical chat selection. */
function useConversationUp(
  instanceId: string,
  source: Extract<PaneOpener['source'], { kind: 'conversation' }>,
) {
  const { setActiveChat } = useNavigationActions();
  const showSurface = useShowSurface();
  const leaveFor = useLeaveFor(instanceId);
  return () =>
    leaveFor('chat', () => {
      if (source.conversationId !== null) {
        // The navigation `chat` selection is Chat's own route to a
        // conversation: it selects an open one and cold-opens a closed one.
        // Then Chat is shown — its dock tab, or the Coding centre's Chat page.
        setActiveChat(source.conversationId);
        showSurface('chat');
        return;
      }
      if (source.threadId !== null)
        showSurface('chat', { session: source.threadId });
    });
}

/**
 * Up for a Files opener: its OWN Project's Files, never the dock's current
 * one. The dock's Files pane when the dock is bound to that Project, else
 * that Project's Coding layout (where its Files live), else the Project.
 */
function useFilesUp(
  instanceId: string,
  source: Extract<PaneOpener['source'], { kind: 'files' }>,
) {
  const dock = useDockProject();
  const showSurface = useShowSurface();
  const leaveFor = useLeaveFor(instanceId);
  const { setLayout, setProject } = useNavigationActions();
  const sameProject = dock.projectSlug === source.projectSlug;
  const { data: layouts } = useProjectLayoutsQuery(source.projectSlug, {
    enabled: !sameProject,
  });
  return () => {
    if (sameProject) {
      leaveFor('coding:file-browser', () => showSurface('coding:file-browser'));
      return;
    }
    const coding = (
      layouts as { slug: string; type?: string }[] | undefined
    )?.find((layout) => layout.type === 'coding');
    if (coding) setLayout(source.projectSlug, coding.slug);
    else setProject(source.projectSlug);
  };
}

function useRouteUp(source: Extract<PaneOpener['source'], { kind: 'route' }>) {
  const { navigate } = useNavigationActions();
  // The canonical, guarded navigation to the opener's validated app route.
  return () => navigate(`${source.pathname}${source.search}`);
}

/**
 * Up for a plugin pane opener: that exact occurrence while a region holds
 * it (revealed; this pane's guard is asked only when the reveal hides it),
 * else its Project layout through canonical `setLayout`, else its Project.
 */
function usePluginOccurrenceUp(instanceId: string, opener: PaneOpener) {
  const model = useRegionModelOptional();
  const modelRef = useRef(model);
  modelRef.current = model;
  const leaveFor = useLeaveFor(instanceId);
  const { setLayout, setProject } = useNavigationActions();
  const source = opener.source as Extract<
    PaneOpener['source'],
    { kind: 'plugin-occurrence' }
  >;
  return () => {
    const occurrence = opener.occurrenceId;
    const current = modelRef.current;
    if (current && occupiedRegion(current.regions, occurrence) !== undefined) {
      leaveFor(occurrence, () =>
        modelRef.current?.openSurfaceInRegion(occurrence, {
          focusExisting: true,
        }),
      );
      return;
    }
    if (source.layoutSlug) setLayout(source.projectSlug, source.layoutSlug);
    else setProject(source.projectSlug);
  };
}

function UpButton({ label, onUp }: { label: string; onUp: () => void }) {
  return (
    <button
      type="button"
      className="related-pane-strip__up"
      onClick={onUp}
      title={`Up to ${label}`}
      aria-label={`Up to ${label}`}
    >
      <span aria-hidden="true">‹</span>
      <span className="related-pane-strip__label">{label}</span>
    </button>
  );
}

function ConversationUp({
  instanceId,
  opener,
}: {
  instanceId: string;
  opener: PaneOpener;
}) {
  const up = useConversationUp(
    instanceId,
    opener.source as Extract<PaneOpener['source'], { kind: 'conversation' }>,
  );
  return <UpButton label={opener.label} onUp={up} />;
}

function FilesUp({
  instanceId,
  opener,
}: {
  instanceId: string;
  opener: PaneOpener;
}) {
  const up = useFilesUp(
    instanceId,
    opener.source as Extract<PaneOpener['source'], { kind: 'files' }>,
  );
  return <UpButton label={opener.label} onUp={up} />;
}

function PluginOccurrenceUp({
  instanceId,
  opener,
}: {
  instanceId: string;
  opener: PaneOpener;
}) {
  const up = usePluginOccurrenceUp(instanceId, opener);
  return <UpButton label={opener.label} onUp={up} />;
}

function RouteUp({ opener }: { opener: PaneOpener }) {
  const up = useRouteUp(
    opener.source as Extract<PaneOpener['source'], { kind: 'route' }>,
  );
  return <UpButton label={opener.label} onUp={up} />;
}

function OpenerUp({
  instanceId,
  opener,
}: {
  instanceId: string;
  opener: PaneOpener;
}) {
  switch (opener.source.kind) {
    case 'conversation':
      return <ConversationUp instanceId={instanceId} opener={opener} />;
    case 'files':
      return <FilesUp instanceId={instanceId} opener={opener} />;
    case 'route':
      return <RouteUp opener={opener} />;
    case 'plugin-occurrence':
      return <PluginOccurrenceUp instanceId={instanceId} opener={opener} />;
  }
}

/**
 * The pane's relation as a reader sees it: Up returns to EXACTLY the opener
 * the pane was opened from — structural, not a history entry, and through the
 * shell's canonical navigation — and an unkept preview says so and offers
 * Keep open. Nothing for a pane with no relation, or one recorded against
 * another (or an unconfirmed) Station.
 */
export function RelatedPaneStrip({ instanceId }: { instanceId: string }) {
  const relations = usePaneRelations();
  const relation: PaneRelation | undefined = relations.relationOf(instanceId);
  if (!relation || relations.stationId !== relation.stationId) return null;
  const keep = () => {
    void relations.keep(instanceId).then((outcome) => {
      if (!outcome.ok)
        toastStore.show(describeRelatedOpenRefusal(outcome.reason));
    });
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group of two controls, not a form fieldset.
    <div
      className="related-pane-strip"
      role="group"
      aria-label={relation.kept ? 'Opened from' : 'Preview'}
    >
      <OpenerUp instanceId={instanceId} opener={relation.opener} />
      {!relation.kept && (
        <>
          <span className="related-pane-strip__state">Preview</span>
          <Button size="sm" variant="ghost" onClick={keep}>
            Keep open
          </Button>
        </>
      )}
    </div>
  );
}
