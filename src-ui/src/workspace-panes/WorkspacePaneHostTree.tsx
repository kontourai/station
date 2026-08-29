import type { WorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import type { WorkspacePaneAvailability } from '@kontourai/station-contracts/workspace-pane-availability';
import type {
  WorkspacePaneHostDocumentV1,
  WorkspacePaneHostNode,
  WorkspacePaneHostSplit,
  WorkspacePaneHostTabGroup,
} from '@kontourai/station-contracts/workspace-pane-host';
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { ConfirmModal } from '../components/modals/ConfirmModal';
import { useMobileVisualViewport } from '../hooks/useMobileVisualViewport';
import { builtinWorkspacePaneName } from './builtinWorkspacePaneCanonical';
import { projectCompactWorkspacePaneHost } from './compactWorkspacePaneProjection';
import { WorkspacePaneFrame } from './WorkspacePaneFrame';
import type {
  WorkspacePaneHostCatalogRequest,
  WorkspacePaneHostPopOut,
} from './WorkspacePaneHostCommands';
import type { WorkspacePaneHostOpenAction } from './WorkspacePaneHostOpenContext';
import { WorkspacePaneHostOpenContext } from './WorkspacePaneHostOpenContext';
import type { WorkspacePaneHostPanePresentation } from './WorkspacePaneHostTabs';
import { WorkspacePaneHostTabs } from './WorkspacePaneHostTabs';
import { useWorkspacePaneHostController } from './workspacePaneHostController';
import { workspacePaneHostTupleId } from './workspacePaneHostIdentity';
import type { WorkspacePaneHostLockManager } from './workspacePaneHostLease';
import { workspacePaneHostGroupContaining } from './workspacePaneHostReducerTree';
import { WorkspacePaneHostRuntime } from './workspacePaneHostRuntime';
import type {
  WorkspacePaneHostRestoredInstanceAdmission,
  WorkspacePaneHostStorage,
} from './workspacePaneHostStorage';
import type {
  WorkspacePaneOperationalEventContext,
  WorkspacePaneOperationalEventSink,
} from './workspacePaneOperationalEvents';
import './WorkspacePaneHost.css';
import { paneCloseConfirmationProps } from './workspacePaneCloseConfirmation';

export type WorkspacePaneHostPresentation = 'tabbed' | 'chromeless';

export interface WorkspacePaneHostTreeProps {
  document: WorkspacePaneHostDocumentV1;
  renderPane(
    instance: WorkspacePaneInstance,
    presentation: WorkspacePaneHostPanePresentation,
  ): ReactNode;
  /** Compact projection is active-only and never leaves hidden pane DOM mounted. */
  compact?: boolean;
  /**
   * `tabbed` is the host as it has always rendered: a persistence status line,
   * a tablist and the pane command surface around the occupant.
   *
   * `chromeless` is the deliberately small host — the same idea
   * `WorkspacePaneFrame` already names, one step up: a single occupant with a
   * real lifecycle frame and no tabs, no persistence notice and no commands,
   * because the shell chrome that mounts it owns those affordances instead.
   * It is a presentation choice only: persistence, navigation authority and
   * the controller are unchanged.
   */
  presentation?: WorkspacePaneHostPresentation;
  runtime?: WorkspacePaneHostRuntime;
  storage?: WorkspacePaneHostStorage;
  /** Injectable only at the browser-lock boundary; production uses Web Locks. */
  lockManager?: WorkspacePaneHostLockManager | null;
  admitRestoredInstance?: WorkspacePaneHostRestoredInstanceAdmission;
  onInstanceRemoved?(instance: WorkspacePaneInstance): void;
  presentationLabel?(instance: WorkspacePaneInstance): string | null;
  onOpenCatalog?(request: WorkspacePaneHostCatalogRequest): void;
  /** Exposes the existing controller authority to the layout that owns its catalog. */
  onOpenActionChange?(action: WorkspacePaneHostOpenAction | null): void;
  /** Ambient-slot-only replacement authority; this host remains the persistence owner. */
  onDockSlotActionChange?(
    action: ((instance: WorkspacePaneInstance) => boolean) | null,
  ): void;
  popOut?: WorkspacePaneHostPopOut;
  onDocumentChange?(document: WorkspacePaneHostDocumentV1): void;
  operationalEventSink?: WorkspacePaneOperationalEventSink;
  operationalEventContext?(
    instance: WorkspacePaneInstance,
    document: WorkspacePaneHostDocumentV1,
  ): WorkspacePaneOperationalEventContext | null;
  operationalAvailability?(
    instance: WorkspacePaneInstance,
  ): WorkspacePaneAvailability | undefined;
}

const RESIZE_STEP = 0.05;
const MAX_WORKSPACE_PANE_PRESENTATION_LABEL_LENGTH = 160;

function validatedPresentationLabel(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_WORKSPACE_PANE_PRESENTATION_LABEL_LENGTH &&
    value === value.trim() &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
    ? value
    : null;
}

/**
 * A chromeless host has no maximise affordance and does not own the geometry
 * around its occupant, so `inline` is not merely the current mode — it is the
 * only mode this host can put a renderer in, and the pane is told exactly that.
 */
const CHROMELESS_PANE_PRESENTATION: WorkspacePaneHostPanePresentation = {
  displayMode: 'inline',
  availableDisplayModes: ['inline'],
  requestDisplayMode: (mode) => mode === 'inline',
};

/**
 * Serial host DOM for catalog-issued occurrences. It owns presentation only:
 * navigation focus remains document.activeInstanceId and lifecycle callbacks
 * remain in the optional UI-local runtime.
 */
/** Rendering tree; controller/state ownership stays outside this view module. */
export function WorkspacePaneHostTree({
  document,
  renderPane,
  compact = false,
  presentation = 'tabbed',
  runtime,
  storage,
  lockManager,
  admitRestoredInstance,
  onInstanceRemoved,
  presentationLabel,
  onOpenCatalog,
  onOpenActionChange,
  onDockSlotActionChange,
  popOut,
  onDocumentChange,
  operationalEventSink,
  operationalEventContext,
  operationalAvailability,
}: WorkspacePaneHostTreeProps) {
  const visualViewport = useMobileVisualViewport();
  const compactHostRef = useRef<HTMLElement | null>(null);
  const [compactHeight, setCompactHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!compact || !compactHostRef.current) {
      setCompactHeight(null);
      return;
    }
    const top = compactHostRef.current.getBoundingClientRect().top;
    const available = Math.max(
      0,
      visualViewport.offsetTop + visualViewport.height - top,
    );
    setCompactHeight((current) =>
      current === available ? current : available,
    );
  }, [compact, visualViewport.height, visualViewport.offsetTop]);
  const controller = useWorkspacePaneHostController({
    document,
    compact,
    runtime,
    storage,
    lockManager,
    admitRestoredInstance,
    onInstanceRemoved,
    onDocumentChange,
    operationalEventSink,
    operationalEventContext,
    operationalAvailability,
  });
  useEffect(() => {
    onOpenActionChange?.({
      open: controller.open,
      focusExisting: controller.focusExisting,
    });
    return () => onOpenActionChange?.(null);
  }, [controller.focusExisting, controller.open, onOpenActionChange]);
  useEffect(() => {
    onDockSlotActionChange?.(controller.replace);
    return () => onDockSlotActionChange?.(null);
  }, [controller.replace, onDockSlotActionChange]);
  const { state, closeConfirmation } = controller;
  const persistenceNotice =
    controller.persistenceStatus === 'owned'
      ? 'Workspace pane changes are saved in this tab.'
      : controller.persistenceStatus === 'contended'
        ? 'Workspace changes are open in another tab. This tab is read-only.'
        : 'Workspace changes cannot be saved right now. This tab is read-only.';
  const paneById = new Map(
    state.document.instances.map((pane) => [pane.instanceId, pane]),
  );
  /**
   * What a pane is called, in the order of who knows best: the host's richer
   * label for the pane's current content (the previewed file's name, the
   * browsed URL), then the pane's own declared name, and only then the
   * descriptor id.
   *
   * The id used to be the second step, so every pane without a bespoke label
   * printed its raw `pane:builtin:…` identifier at people while its descriptor
   * carried a readable name the whole time (archive#3971). The id survives as
   * the last resort for a pane this build has no declaration for at all —
   * showing something identifying beats showing nothing.
   */
  const paneLabel = (pane: WorkspacePaneInstance | undefined): string => {
    if (!pane) return 'Workspace pane';
    try {
      return (
        validatedPresentationLabel(presentationLabel?.(pane)) ??
        builtinWorkspacePaneName(pane.descriptorId) ??
        pane.descriptorId
      );
    } catch {
      return builtinWorkspacePaneName(pane.descriptorId) ?? pane.descriptorId;
    }
  };
  // ConfirmModal, not a hand-rolled section. This is an unsaved-changes
  // prompt, which the repo already has one answer for — and the bespoke
  // version carried a class with no CSS rule anywhere, so it rendered with
  // no dialog surface at all and its destructive button was visually
  // identical to Cancel (archive#3157). ConfirmModal brings the focus trap,
  // Escape handling, and the `danger` variant that marks the destructive
  // choice, none of which the hand-rolled markup had.
  const closeDialog = (
    <ConfirmModal
      isOpen={Boolean(closeConfirmation)}
      {...paneCloseConfirmationProps(closeConfirmation?.reason)}
      onConfirm={() => void controller.confirmClose()}
      onCancel={controller.cancelClose}
    />
  );
  const renderTabs = (
    group: WorkspacePaneHostTabGroup,
    parentSplit?: WorkspacePaneHostSplit,
  ) => (
    <WorkspacePaneHostTabs
      key={group.id}
      group={group}
      paneById={paneById}
      controller={controller}
      paneLabel={paneLabel}
      renderPane={renderPane}
      parentSplit={parentSplit}
      onOpenCatalog={onOpenCatalog}
      popOut={popOut}
      compact={compact}
      runtime={runtime}
    />
  );

  const renderSplit = (split: WorkspacePaneHostSplit) => {
    const renderNode = (node: WorkspacePaneHostNode): ReactNode =>
      node.type === 'tabs' ? renderTabs(node, split) : renderSplit(node);
    const hidden = split.collapsed;
    const keyboardResize = (event: KeyboardEvent<HTMLElement>) => {
      const horizontal = split.orientation === 'horizontal';
      const lower = horizontal ? 'ArrowLeft' : 'ArrowUp';
      const higher = horizontal ? 'ArrowRight' : 'ArrowDown';
      if (event.key !== lower && event.key !== higher) return;
      event.preventDefault();
      controller.resize(
        split.id,
        split.ratio + (event.key === higher ? RESIZE_STEP : -RESIZE_STEP),
      );
    };
    return (
      <div
        className={`workspace-pane-host__split workspace-pane-host__split--${split.orientation}${hidden ? ' workspace-pane-host__split--collapsed' : ''}`}
        key={split.id}
        style={
          {
            '--workspace-pane-split-ratio': `${split.ratio * 100}%`,
          } as CSSProperties
        }
      >
        {!hidden || hidden === 'second' ? (
          <div className="workspace-pane-host__branch">
            {renderNode(split.first)}
          </div>
        ) : null}
        {!hidden && (
          <hr
            className="workspace-pane-host__separator"
            tabIndex={controller.canPersist ? 0 : -1}
            aria-label="Resize workspace pane groups"
            aria-disabled={!controller.canPersist}
            aria-orientation={
              split.orientation === 'horizontal' ? 'vertical' : 'horizontal'
            }
            aria-valuemin={20}
            aria-valuemax={80}
            aria-valuenow={Math.round(split.ratio * 100)}
            onKeyDown={controller.canPersist ? keyboardResize : undefined}
            onPointerDown={
              controller.canPersist
                ? (event) =>
                    event.currentTarget.setPointerCapture(event.pointerId)
                : undefined
            }
            onPointerMove={(event) => {
              if (!controller.canPersist) return;
              if (!event.currentTarget.hasPointerCapture(event.pointerId))
                return;
              const bounds =
                event.currentTarget.parentElement?.getBoundingClientRect();
              if (!bounds) return;
              const ratio =
                split.orientation === 'horizontal'
                  ? (event.clientX - bounds.left) / bounds.width
                  : (event.clientY - bounds.top) / bounds.height;
              controller.resize(split.id, ratio);
            }}
          />
        )}
        {!hidden || hidden === 'first' ? (
          <div className="workspace-pane-host__branch">
            {renderNode(split.second)}
          </div>
        ) : null}
      </div>
    );
  };

  // Chromeless wins over `compact`: compact is a projection of the tab chrome,
  // and there is no tab chrome here to project.
  if (presentation === 'chromeless') {
    const occupant = paneById.get(state.document.activeInstanceId);
    const failed =
      occupant && controller.state.rendererFailures[occupant.instanceId];
    return (
      <WorkspacePaneHostOpenContext.Provider value={{ open: controller.open }}>
        {/* No chrome AND no element. `display: contents` was not enough: it
            removes a wrapper's box but not its place in the DOM, and the shell
            positions the dock with child combinators
            (`.app__main--dock-left > .chat-dock`, `:has(> .chat-dock)`) that
            stop matching the moment anything sits between them — the desktop
            dock measured x=0 instead of the sidebar's right edge. An occupant
            that owns its own placement needs this host to contribute nothing.

            So there is no labelled container here either. That label belongs
            to a tab strip's group of panes, and a host with one always-active
            occupant and no tabs has no group to name. */}
        {occupant && failed ? (
          // Not chrome: without it a failed renderer leaves the slot blank
          // with no way back. This branch DOES take an element, because an
          // unavailable pane is a message and a message needs a box.
          <section
            className="workspace-pane-host workspace-pane-host--chromeless-failure"
            aria-label={`${paneLabel(occupant)} unavailable`}
          >
            <p>{paneLabel(occupant)} could not open.</p>
            <button
              type="button"
              onClick={() => void controller.retry(occupant.instanceId)}
            >
              Retry pane
            </button>
          </section>
        ) : null}
        {occupant && !failed ? (
          <WorkspacePaneFrame
            elementless
            instanceId={occupant.instanceId}
            paneName={paneLabel(occupant)}
            runtime={runtime}
            onFailure={controller.fail}
            onRetry={controller.retry}
          >
            {renderPane(occupant, CHROMELESS_PANE_PRESENTATION)}
          </WorkspacePaneFrame>
        ) : null}
        {closeDialog}
      </WorkspacePaneHostOpenContext.Provider>
    );
  }
  if (compact) {
    const projection = projectCompactWorkspacePaneHost(state.document);
    const backingGroup = workspacePaneHostGroupContaining(
      state.document.root,
      projection.activeInstanceId,
    );
    return (
      <WorkspacePaneHostOpenContext.Provider value={{ open: controller.open }}>
        <section
          ref={compactHostRef}
          className="workspace-pane-host workspace-pane-host--compact"
          aria-label="Workspace panes"
          style={{
            ...visualViewport.style,
            ...(compactHeight === null
              ? {}
              : {
                  height: `${compactHeight}px`,
                  maxHeight: `${compactHeight}px`,
                }),
          }}
        >
          <p className="workspace-pane-host__persistence" role="status">
            {persistenceNotice}
          </p>
          <WorkspacePaneHostTabs
            group={{
              type: 'tabs',
              id: 'compact',
              instanceIds: projection.tabs.map((tab) => tab.instanceId),
              selectedInstanceId: projection.activeInstanceId,
            }}
            paneById={paneById}
            controller={controller}
            paneLabel={paneLabel}
            renderPane={renderPane}
            commandTargetGroupId={backingGroup?.id}
            projectedActions
            reorderAllowed={false}
            projectedActionNotice="Tab reordering is unavailable while panes are shown in the compact view."
            onOpenCatalog={onOpenCatalog}
            popOut={popOut}
            compact
            runtime={runtime}
          />
          <button
            type="button"
            className="workspace-pane-host__compact-back"
            onClick={() =>
              controller.focusTab('compact', projection.activeInstanceId)
            }
          >
            Back to pane tabs
          </button>
          {closeDialog}
        </section>
      </WorkspacePaneHostOpenContext.Provider>
    );
  }
  const maximizedBackingGroup = state.document.maximizedInstanceId
    ? workspacePaneHostGroupContaining(
        state.document.root,
        state.document.maximizedInstanceId,
      )
    : undefined;
  return (
    <WorkspacePaneHostOpenContext.Provider value={{ open: controller.open }}>
      <section className="workspace-pane-host" aria-label="Workspace panes">
        <p className="workspace-pane-host__persistence" role="status">
          {persistenceNotice}
        </p>
        {state.document.maximizedInstanceId ? (
          <WorkspacePaneHostTabs
            group={{
              type: 'tabs',
              id: workspacePaneHostTupleId(
                'maximized',
                state.document.maximizedInstanceId,
              ),
              instanceIds: [state.document.maximizedInstanceId],
              selectedInstanceId: state.document.maximizedInstanceId,
            }}
            paneById={paneById}
            controller={controller}
            paneLabel={paneLabel}
            renderPane={renderPane}
            commandTargetGroupId={maximizedBackingGroup?.id}
            projectedActions
            reorderAllowed={false}
            projectedActionNotice="Tab reordering is unavailable while this pane is maximized."
            onOpenCatalog={onOpenCatalog}
            popOut={popOut}
            runtime={runtime}
          />
        ) : state.document.root.type === 'tabs' ? (
          renderTabs(state.document.root)
        ) : (
          renderSplit(state.document.root)
        )}
        {closeDialog}
      </section>
    </WorkspacePaneHostOpenContext.Provider>
  );
}
