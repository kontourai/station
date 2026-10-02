import {
  isCanonicalBasisWorkspacePaneInstance,
  WORKSPACE_BASIS_PANE_DESCRIPTOR,
  WORKSPACE_BASIS_PANE_DESCRIPTOR_ID,
} from '@kontourai/station-basis-pane/workspace-basis-pane';
import { BUILTIN_REVIEW_LAYOUT } from '@kontourai/station-contracts/layout';
import { WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR_ID } from '@kontourai/station-contracts/workspace-browser-preview';
import {
  type CodingDiffCompositionControl,
  resolveBuiltinCodingGitDiffGrant,
  selectCodingDiffComposition,
} from '@kontourai/station-contracts/workspace-coding-diff-composition';
import {
  type CodingEvidenceCompositionControl,
  resolveBuiltinCodingEvidenceGrant,
  selectCodingEvidenceComposition,
} from '@kontourai/station-contracts/workspace-coding-evidence-composition';
import {
  type CodingFileCompositionControl,
  resolveBuiltinCodingFileReadGrant,
  selectCodingFileComposition,
} from '@kontourai/station-contracts/workspace-coding-file-composition';
import {
  isCanonicalWorkspaceCodingDiffPaneInstance,
  isCanonicalWorkspaceCodingFileBrowserPaneInstance,
  isCanonicalWorkspaceCodingTerminalPaneInstance,
  WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR_ID,
  WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR_ID,
  WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR_ID,
} from '@kontourai/station-contracts/workspace-coding-panels';
import {
  isCanonicalWorkspacePlanPaneInstance,
  isCanonicalWorkspaceReadinessPaneInstance,
  isCanonicalWorkspaceTrustPaneInstance,
  WORKSPACE_PLAN_PANE_DESCRIPTOR_ID,
  WORKSPACE_READINESS_PANE_DESCRIPTOR_ID,
  WORKSPACE_TRUST_PANE_DESCRIPTOR_ID,
} from '@kontourai/station-contracts/workspace-evidence-panels';
import { WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR_ID } from '@kontourai/station-contracts/workspace-file-preview';
import type { WorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import {
  parseWorkspacePaneInstance,
  withWorkspacePaneInstanceLayoutBinding,
} from '@kontourai/station-contracts/workspace-pane';
import type { WorkspacePaneHostDocumentV1 } from '@kontourai/station-contracts/workspace-pane-host';
import { createWorkspacePaneHostBaselineDocument } from '@kontourai/station-contracts/workspace-pane-host';
import {
  telemetry,
  useGitStatusQuery,
  useProjectLayoutQuery,
} from '@kontourai/station-sdk';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { CodingWorkbench } from '../components/coding-layout/CodingWorkbench';
import {
  hostRendersCodingPane,
  useCodingWide,
} from '../components/coding-layout/codingPanels';
import {
  resolveCodingStackLocation,
  useCodingStackSelection,
} from '../components/coding-layout/codingStackPage';
import { LazyBoundary } from '../components/LazyBoundary';
import { Empty, ErrorState, SkeletonList } from '../components/state';
import { useNavigationActions } from '../contexts/NavigationContext';
import { useDockFoldsToOneRegion, useIsMobile } from '../hooks/useIsMobile';
import { LayoutRenderer } from '../layouts';
import {
  type NativePlatformAdapter,
  nativePlatformPromise,
} from '../platform/native';
import { LayoutView } from '../views/LayoutView';
import {
  admitRestoredBrowserPreviewPaneInstance,
  browserPreviewPaneOrdinal,
  browserPreviewPanePresentationLabel,
  removeRemovedBrowserPreviewPaneState,
} from '../workspace-panes/browserPreviewPaneInstance';
import { builtinWorkspacePaneName } from '../workspace-panes/builtinWorkspacePaneCanonical';
import {
  getBuiltinWorkspacePaneRenderer,
  isCanonicalBuiltinBrowserPreviewDescriptor,
  isCanonicalBuiltinCodingDiffDescriptor,
  isCanonicalBuiltinCodingFileBrowserDescriptor,
  isCanonicalBuiltinCodingOccurrence,
  isCanonicalBuiltinCodingTerminalDescriptor,
  isCanonicalBuiltinFilePreviewDescriptor,
  isCanonicalBuiltinPlanDescriptor,
  isCanonicalBuiltinReadinessDescriptor,
  isCanonicalBuiltinTrustDescriptor,
} from '../workspace-panes/builtinWorkspacePaneRegistry';
import { DockOnlyWorkspacePaneNotice } from '../workspace-panes/DockOnlyWorkspacePaneNotice';
import {
  admitRestoredFilePreviewPaneInstance,
  filePreviewPanePresentationLabel,
  filePreviewPanePresentationPath,
  removeRemovedFilePreviewPaneState,
} from '../workspace-panes/filePreviewPaneInstance';
import { trackMcpAppDisplayModeDecision } from '../workspace-panes/mcpAppDisplayModeTelemetry';
import { PluginWorkspacePaneSDKBoundary } from '../workspace-panes/PluginWorkspacePaneSDKBoundary';
import { ProjectWorkspacePaneModal } from '../workspace-panes/ProjectWorkspacePaneCatalog';
import { useResolvedWorkspacePaneCatalog } from '../workspace-panes/resolvedWorkspacePaneCatalog';
import { WorkspacePaneFrame } from '../workspace-panes/WorkspacePaneFrame';
import { WorkspacePaneHost } from '../workspace-panes/WorkspacePaneHost';
import type {
  WorkspacePaneHostCatalogRequest,
  WorkspacePaneHostPopOut,
  WorkspacePaneHostPopOutAvailability,
  WorkspacePaneHostPopOutRequestResult,
} from '../workspace-panes/WorkspacePaneHostCommands';
import type { WorkspacePaneHostOpenAction } from '../workspace-panes/WorkspacePaneHostOpenContext';
import type { WorkspacePaneHostPanePresentation } from '../workspace-panes/WorkspacePaneHostTabs';
import type { WorkspacePaneAvailabilityCatalogEntry } from '../workspace-panes/workspacePaneAvailabilityPresentation';
import { presentWorkspacePaneAvailability } from '../workspace-panes/workspacePaneAvailabilityPresentation';
import {
  isProjectPlaceableWorkspacePane,
  isWorkspacePaneInstanceOwnedByProject,
} from '../workspace-panes/workspacePaneHostAdmission';
import {
  describeWorkspacePaneOpenRefusal,
  type WorkspacePaneHostOpenRefusal,
} from '../workspace-panes/workspacePaneHostOpenOutcome';
import { WorkspacePaneHostRuntime } from '../workspace-panes/workspacePaneHostRuntime';
import { createWorkspacePaneOperationalEventContext } from '../workspace-panes/workspacePaneOperationalEvents';
import { resolveClientTrustedPluginLayout } from '../workspace-panes/workspacePaneRendererSelection';
import { trackCodingDiffCompositionReceipt } from './codingDiffCompositionTelemetry';
import { trackCodingEvidenceCompositionReceipt } from './codingEvidenceCompositionTelemetry';
import { codingEvidenceUnavailableCopy } from './codingEvidenceUnavailableCopy';
import { trackCodingFileCompositionReceipt } from './codingFileCompositionTelemetry';
import { isUnplacedLayoutRecord } from './layout-record-absent';
import { layoutTypeRegistry } from './layoutRegistry';
import {
  resolveLayoutChatPlacement,
  resolveProjectLayoutRendererKind,
} from './project-layout-kind';

const loadProjectBasisMcpWorkspacePane = () =>
  import('../workspace-panes/BasisMcpWorkspacePane').then(
    ({ BasisMcpWorkspacePane }) => ({ default: BasisMcpWorkspacePane }),
  );

function isCanonicalBasisMcpWorkspacePaneInstance(
  instance: WorkspacePaneInstance,
): boolean {
  if (!instance.instanceId.startsWith('mcp:')) return false;
  const nativeId = instance.instanceId.slice(4);
  return (
    (instance.stateKey as string) === (instance.instanceId as string) &&
    (instance.descriptorId as string) === `pane:mcp:basis:${nativeId}` &&
    isCanonicalBasisWorkspacePaneInstance({
      ...instance,
      descriptorId: WORKSPACE_BASIS_PANE_DESCRIPTOR_ID,
      instanceId: nativeId,
      stateKey: nativeId,
    } as WorkspacePaneInstance)
  );
}

type WorkspacePanePopOutCatalogEntry = Pick<
  WorkspacePaneAvailabilityCatalogEntry,
  'availability' | 'descriptor' | 'instance'
>;

function CodingFileCompositionReceiptTracker({
  receipt,
}: {
  receipt: Parameters<typeof trackCodingFileCompositionReceipt>[0];
}) {
  const { control, outcome, restorationIdentityMatched, fallbackUsed, reason } =
    receipt;
  useEffect(() => {
    trackCodingFileCompositionReceipt(
      {
        control,
        outcome,
        restorationIdentityMatched,
        fallbackUsed,
        ...(reason ? { reason } : {}),
      },
      telemetry.track,
    );
  }, [control, fallbackUsed, outcome, reason, restorationIdentityMatched]);
  return null;
}

function CodingDiffCompositionReceiptTracker({
  receipt,
}: {
  receipt: Parameters<typeof trackCodingDiffCompositionReceipt>[0];
}) {
  const { control, outcome, restorationIdentityMatched, fallbackUsed, reason } =
    receipt;
  useEffect(() => {
    trackCodingDiffCompositionReceipt(
      {
        control,
        outcome,
        restorationIdentityMatched,
        fallbackUsed,
        ...(reason ? { reason } : {}),
      },
      telemetry.track,
    );
  }, [control, fallbackUsed, outcome, reason, restorationIdentityMatched]);
  return null;
}

function CodingEvidenceCompositionReceiptTracker({
  receipt,
}: {
  receipt: Parameters<typeof trackCodingEvidenceCompositionReceipt>[0];
}) {
  const {
    category,
    control,
    outcome,
    restorationIdentityMatched,
    fallbackUsed,
    reason,
  } = receipt;
  useEffect(() => {
    trackCodingEvidenceCompositionReceipt(
      {
        category,
        control,
        outcome,
        restorationIdentityMatched,
        fallbackUsed,
        ...(reason ? { reason } : {}),
      },
      telemetry.track,
    );
  }, [
    category,
    control,
    fallbackUsed,
    outcome,
    reason,
    restorationIdentityMatched,
  ]);
  return null;
}

// archive#3969: "occurrence" is our word for one open copy of a pane; the
// reader just has this pane, here.
const LOCAL_OCCURRENCE_POPOUT_REASON =
  'This pane lives in this workspace only, so it can’t be opened in its own window.';

export function resolveBuiltinCodingPanePopOut({
  entries,
  native,
  projectId,
  projectSlug,
  layoutSlug,
  instance,
}: {
  entries: readonly WorkspacePanePopOutCatalogEntry[];
  native?: Pick<
    NativePlatformAdapter,
    'capability' | 'openWorkspacePanePopOut'
  >;
  projectId?: string;
  projectSlug: string;
  layoutSlug: string;
  instance: Parameters<
    Extract<
      WorkspacePaneHostPopOutAvailability,
      { state: 'supported' }
    >['request']
  >[0];
}): WorkspacePaneHostPopOutAvailability {
  const capability = native?.capability('workspace-pane-pop-out');
  if (!native || !projectId || capability?.state !== 'enabled') {
    return {
      state: 'unsupported',
      reason:
        capability?.reason ??
        'Station is checking whether this host supports pane pop-out.',
    };
  }
  const resolved = entries.find(
    (entry) =>
      entry.descriptor.id === instance.descriptorId &&
      entry.instance?.instanceId === instance.instanceId,
  );
  if (!resolved?.instance || resolved.availability.state !== 'available') {
    return {
      state: 'unsupported',
      reason: LOCAL_OCCURRENCE_POPOUT_REASON,
    };
  }
  return {
    state: 'supported',
    async request(): Promise<WorkspacePaneHostPopOutRequestResult> {
      try {
        const result = await native.openWorkspacePanePopOut({
          projectId,
          projectSlug,
          layoutId: layoutSlug,
          descriptorId: instance.descriptorId,
          instanceId: instance.instanceId,
        });
        if (result.status === 'ok') return { status: 'opened' };
        return {
          status: result.status === 'unsupported' ? 'unavailable' : 'failed',
        };
      } catch {
        return { status: 'failed' };
      }
    },
  };
}

function useBuiltinCodingPanePopOut({
  entries,
  projectId,
  projectSlug,
  layoutSlug,
}: {
  entries: readonly WorkspacePanePopOutCatalogEntry[];
  projectId?: string;
  projectSlug: string;
  layoutSlug: string;
}): WorkspacePaneHostPopOut {
  const [native, setNative] = useState<NativePlatformAdapter>();
  useEffect(() => {
    let active = true;
    void nativePlatformPromise
      .then((adapter) => {
        if (active) setNative(adapter);
      })
      .catch(() => {
        if (active) setNative(undefined);
      });
    return () => {
      active = false;
    };
  }, []);

  return useMemo(() => {
    return {
      availability(instance) {
        return resolveBuiltinCodingPanePopOut({
          entries,
          native,
          projectId,
          projectSlug,
          layoutSlug,
          instance,
        });
      },
    };
  }, [entries, layoutSlug, native, projectId, projectSlug]);
}

/**
 * Membership equality for the host's open-instance set. `isOpen` below asks
 * one question of this set — "is this instance mounted?" — so two sets with
 * the same members are the same answer, and republishing one as new state is
 * a change the layout never made (archive#3781).
 */
function sameWorkspacePaneInstanceIds(
  current: ReadonlySet<string> | undefined,
  next: ReadonlySet<string>,
): boolean {
  if (!current || current.size !== next.size) return false;
  for (const instanceId of next) if (!current.has(instanceId)) return false;
  return true;
}

/**
 * The document already published, unless its CONTENT changed.
 *
 * archive#3794: `createWorkspacePaneHostBaselineDocument` is a pure function
 * of (id, scope, instances), and the instances are re-minted by
 * `withWorkspacePaneInstanceLayoutBinding` on every render, so the host was
 * handed a new document object for an unchanged workspace. The host keys its
 * tree on strings and so does not remount, but the document is re-fingerprinted
 * and re-reduced per render. Serialising the whole document — not just the
 * authority fields — is what makes "unchanged" honest here: a document that
 * differs anywhere is published, and only a byte-identical one keeps its
 * identity.
 */
const CHAT_PAGE = { page: 'chat', paneId: null } as const;

/**
 * Whether a `?paneScope=` names a Project host of this layout, before the
 * Project's id is known (`workspacePaneHostScopeKey`'s project shape).
 */
function paneScopeNamesLayout(
  paneScope: string | null,
  layoutId: string,
): boolean {
  if (!paneScope) return false;
  try {
    const parsed: unknown = JSON.parse(paneScope);
    return (
      Array.isArray(parsed) && parsed[0] === 'project' && parsed[2] === layoutId
    );
  } catch {
    return false;
  }
}
const NO_INSTANCES: readonly WorkspacePaneInstance[] = [];

function retainWorkspacePaneHostDocument(
  published: {
    current: { content: string; document: WorkspacePaneHostDocumentV1 } | null;
  },
  next: WorkspacePaneHostDocumentV1 | null,
): WorkspacePaneHostDocumentV1 | null {
  if (!next) return next;
  const content = JSON.stringify(next);
  if (published.current?.content === content) return published.current.document;
  published.current = { content, document: next };
  return next;
}

/** The one admitted current-layout bridge: exact builtin catalog identity only. */
/**
 * The lower panel is one occupant with no tabs and no geometry of its own,
 * the same standing the chromeless host gives a pane: inline is the only
 * display mode, and the pane is told so.
 */
const LOWER_PANE_PRESENTATION: WorkspacePaneHostPanePresentation = {
  displayMode: 'inline',
  availableDisplayModes: ['inline'],
  requestDisplayMode: (mode) => mode === 'inline',
};

function BuiltinCodingLayoutHost({
  projectSlug,
  layoutSlug,
  layout,
  fileCompositionControl,
  diffCompositionControl,
  evidenceCompositionControl,
}: {
  projectSlug: string;
  layoutSlug: string;
  layout: Parameters<typeof withWorkspacePaneInstanceLayoutBinding>[1];
  fileCompositionControl: CodingFileCompositionControl;
  diffCompositionControl: CodingDiffCompositionControl;
  evidenceCompositionControl: CodingEvidenceCompositionControl;
}) {
  /** One UI-local runtime owns renderer callback results for this mounted host. */
  const workspacePaneRuntime = useRef<WorkspacePaneHostRuntime | null>(null);
  if (!workspacePaneRuntime.current)
    workspacePaneRuntime.current = new WorkspacePaneHostRuntime();
  const catalog = useResolvedWorkspacePaneCatalog(projectSlug);
  const { navigate } = useNavigationActions();
  const projectId = catalog.projectId;
  const compact = useIsMobile();
  const popOut = useBuiltinCodingPanePopOut({
    entries: catalog.entries,
    projectId,
    projectSlug,
    layoutSlug: layout.id,
  });
  /**
   * State, not a ref (#1596): the pane picker is a control that belongs to the
   * host, so whether a host is mounted has to be renderable. As a ref its
   * nullness was invisible, and `hostOpen.current?.open(...)` completed the
   * picker's Open click with no modal closed and nothing said.
   */
  const [hostOpen, setHostOpen] = useState<WorkspacePaneHostOpenAction | null>(
    null,
  );
  const [catalogRequest, setCatalogRequest] =
    useState<WorkspacePaneHostCatalogRequest | null>(null);
  /** The reason the last picker selection did not open, or null. */
  const [openRefusal, setOpenRefusal] =
    useState<WorkspacePaneHostOpenRefusal | null>(null);
  const [hostInstanceIds, setHostInstanceIds] = useState<ReadonlySet<string>>();
  /**
   * The host's live panes, in document order: what the Coding stack's Views
   * menu lists and what a `?pane=` must name to be a drill-in. Moves with
   * `hostInstanceIds` (membership), not with every document change.
   */
  const [hostInstances, setHostInstances] =
    useState<readonly WorkspacePaneInstance[]>();
  /** The host's latest document, read when the catalog needs a target group. */
  const liveHostDocument = useRef<WorkspacePaneHostDocumentV1 | null>(null);
  /** The pane the host is showing, for a URL that names one it lacks. */
  const [hostActiveId, setHostActiveId] = useState<string | null>(null);
  const announcedInstanceIds = useRef<ReadonlySet<string> | undefined>(
    undefined,
  );
  /**
   * Stable sink, and a set identity that moves only when its membership does.
   * Both halves matter: an inline handler made the host re-announce on every
   * render, and a freshly built `Set` made every announcement — including the
   * ones carrying an unchanged list — a committed state change, which rendered
   * the host again. See the notification effect in `workspacePaneHostController`.
   */
  const handleHostDocumentChange = useCallback(
    (next: WorkspacePaneHostDocumentV1) => {
      liveHostDocument.current = next;
      setHostActiveId(next.activeInstanceId);
      const ids = new Set(
        next.instances.map((instance) => instance.instanceId),
      );
      if (sameWorkspacePaneInstanceIds(announcedInstanceIds.current, ids))
        return;
      announcedInstanceIds.current = ids;
      setHostInstanceIds(ids);
      setHostInstances(next.instances);
    },
    [],
  );
  // The Coding stack (#928): which page the URL names, and whether the
  // centre shows Chat — the same derivation App suspends the dock's Chat by.
  const stackSelection = useCodingStackSelection();
  const bottomOnly = useDockFoldsToOneRegion();
  const centerChat =
    resolveLayoutChatPlacement({ type: 'coding' }, { bottomOnly }) === 'center';
  // Past the wide fold a pane opens beside the centre's Chat (#3040) — only
  // where the centre HAS Chat; a bottom-only device keeps the drill-in.
  const wide = useCodingWide() && centerChat;
  /**
   * The host's panes render once the reader has drilled in during this mount,
   * and stay mounted (hidden) after, so a pane keeps its state across the
   * round trip. Before that nothing renders behind the Chat page: the host's
   * remembered selection — Files on a fresh layout — would otherwise fetch
   * on every visit to a page that never shows it, which the Coding tab this
   * page replaced never did.
   */
  const [drillInVisited, setDrillInVisited] = useState(false);
  const [hostPersistence, setHostPersistence] = useState<
    'owned' | 'contended' | 'unavailable'
  >('owned');
  /**
   * The Diff rail icon's changed-file count, when the layout already knows
   * it: the git status the Coding panes (the branch toolbar, the Diff) read
   * and cache. Read passively — the rail never adds a git read of its own.
   */
  const layoutWorkingDirectory = (
    layout as { config?: Record<string, unknown> | null }
  ).config?.workingDirectory;
  const gitStatus = useGitStatusQuery(
    typeof layoutWorkingDirectory === 'string' && layoutWorkingDirectory.trim()
      ? { projectSlug, workingDir: layoutWorkingDirectory.trim() }
      : null,
    { enabled: false },
  ).data as
    | { isRepo?: boolean; changes?: readonly string[] }
    | null
    | undefined;
  const railBadges = useMemo(
    () =>
      gitStatus?.isRepo && Array.isArray(gitStatus.changes)
        ? {
            [WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR_ID]:
              gitStatus.changes.length,
          }
        : undefined,
    [gitStatus],
  );
  /**
   * archive#3794: these five are host-effect dependencies
   * (`workspacePaneHostController.ts` — the availability sweep, the
   * lifecycle-context capture, and the authoritative-catalog replacement all
   * name them), so an inline arrow re-ran each of those effects on every
   * render of this host, doing O(instances x entries) catalog work and
   * per-tab `localStorage` reads for a render that changed nothing. They are
   * declared here, ABOVE the guards below, because a hook cannot live after
   * an early return — and they only need identity from `catalog.entries`,
   * `projectId` and `projectSlug`, all of which exist at this point.
   *
   * `window.localStorage` stays INSIDE the bodies on purpose: the controller
   * calls these at effect/hydration time and must read the store as it is
   * then, not as it was at render.
   */
  const operationalEventContext = useCallback(
    (
      instance: WorkspacePaneInstance,
      hostDocument: WorkspacePaneHostDocumentV1,
    ) => {
      const pane = catalog.entries.find(
        (candidate) =>
          candidate.instance?.instanceId === instance.instanceId &&
          candidate.descriptor.id === instance.descriptorId,
      );
      return pane?.selectedRenderer
        ? createWorkspacePaneOperationalEventContext(
            hostDocument,
            pane.descriptor,
            instance,
            pane.selectedRenderer,
          )
        : null;
    },
    [catalog.entries],
  );
  const operationalAvailability = useCallback(
    (instance: WorkspacePaneInstance) =>
      catalog.entries.find(
        (candidate) => candidate.instance?.instanceId === instance.instanceId,
      )?.availability,
    [catalog.entries],
  );
  // The catalog answers `projectId` asynchronously, and these three are
  // project-scoped by definition: with no project identity there is no
  // project-scoped state to admit, forget, or name. The host only mounts
  // after the guard below, so this branch is unreachable in practice — it is
  // here because the callbacks must be declared before that guard, and
  // inventing an id would be worse than declining.
  const admitRestoredInstance = useCallback(
    (candidate: unknown) => {
      if (!projectId) return null;
      const parsedCandidate = parseWorkspacePaneInstance(candidate);
      const basisCandidate =
        parsedCandidate?.boundContext?.projectId === projectId &&
        isCanonicalBasisWorkspacePaneInstance(parsedCandidate)
          ? parsedCandidate
          : null;
      const basisMcpCandidate =
        parsedCandidate &&
        isCanonicalBasisMcpWorkspacePaneInstance(parsedCandidate)
          ? parsedCandidate
          : null;
      return (
        basisCandidate ??
        basisMcpCandidate ??
        (() => {
          if (!parsedCandidate) return null;
          const current = catalog.entries.find(
            (entry) =>
              entry.instance?.instanceId === parsedCandidate.instanceId &&
              entry.descriptor.id === parsedCandidate.descriptorId,
          );
          return current?.instance &&
            current.availability.state === 'available' &&
            current.selectedRenderer?.renderer.kind === 'plugin-component' &&
            isWorkspacePaneInstanceOwnedByProject(
              current.instance,
              projectId,
            ) &&
            resolveClientTrustedPluginLayout(
              current.descriptor,
              current.selectedRenderer,
              current.instance,
            )
            ? current.instance
            : null;
        })() ??
        admitRestoredFilePreviewPaneInstance(
          projectId,
          projectSlug,
          candidate,
          window.localStorage,
        ) ??
        admitRestoredBrowserPreviewPaneInstance(
          projectId,
          candidate,
          window.localStorage,
        )
      );
    },
    [catalog.entries, projectId, projectSlug],
  );
  const onInstanceRemoved = useCallback(
    (instance: WorkspacePaneInstance) => {
      if (!projectId) return;
      removeRemovedFilePreviewPaneState(
        projectId,
        projectSlug,
        instance,
        window.localStorage,
      ) ||
        removeRemovedBrowserPreviewPaneState(
          projectId,
          instance,
          window.localStorage,
        );
    },
    [projectId, projectSlug],
  );
  const presentationLabel = useCallback(
    (instance: WorkspacePaneInstance) =>
      projectId
        ? (filePreviewPanePresentationLabel(
            projectId,
            projectSlug,
            instance,
            window.localStorage,
          ) ??
          browserPreviewPanePresentationLabel(
            projectId,
            instance,
            window.localStorage,
          ) ??
          (isCanonicalBasisMcpWorkspacePaneInstance(instance)
            ? 'Basis App'
            : null) ??
          (isWorkspacePaneInstanceOwnedByProject(instance, projectId)
            ? (catalog.entries.find(
                (entry) =>
                  entry.instance?.instanceId === instance.instanceId &&
                  entry.descriptor.id === instance.descriptorId,
              )?.descriptor.name ?? null)
            : null))
        : null,
    [catalog.entries, projectId, projectSlug],
  );
  /** The document already published, kept while its content is unchanged. */
  const publishedDocument = useRef<{
    content: string;
    document: WorkspacePaneHostDocumentV1;
  } | null>(null);
  const captureHostOpen = useCallback(
    (action: WorkspacePaneHostOpenAction | null) => setHostOpen(action),
    [],
  );
  /**
   * The picker cannot outlive the host it was opened from: its only entry point
   * is that host's command menu, and the host publishes `null` from the same
   * effect cleanup that runs when it unmounts. Withdrawing the picker is the
   * honest answer, rather than reporting a refusal for a click with nowhere to
   * land.
   *
   * WHY THE `show` PROP DERIVES IT and this effect does not. An effect runs
   * AFTER the render that observed `hostOpen === null`, so on its own it would
   * leave the picker painted for one frame with no host behind it — one frame
   * is enough to click, and that click would take the silent early return in
   * `openCatalogEntry`, which is the exact defect this change removes. The
   * modal's `show` therefore reads both facts during render; this effect only
   * clears the state that render already stopped honouring, so a later host
   * does not resurrect a stale request.
   */
  useEffect(() => {
    if (hostOpen) return;
    setCatalogRequest(null);
    setOpenRefusal(null);
  }, [hostOpen]);
  /** A fresh request is a fresh attempt; it does not inherit the last refusal. */
  const requestCatalog = useCallback(
    (request: WorkspacePaneHostCatalogRequest) => {
      setOpenRefusal(null);
      setCatalogRequest(request);
    },
    [],
  );
  const openCatalogEntry = useCallback(
    (entry: WorkspacePaneAvailabilityCatalogEntry) => {
      // None of these can be true while a card's Open button is on screen: the
      // picker renders only with BOTH a request and a host (see the modal's
      // `show`), and only an available entry that carries an instance renders
      // Open at all.
      if (
        !catalogRequest ||
        !hostOpen ||
        !entry.instance ||
        entry.availability.state !== 'available'
      ) {
        return;
      }
      const resolved = catalog.entries.find(
        (candidate) =>
          candidate.descriptor.id === entry.descriptor.id &&
          candidate.instance?.instanceId === entry.instance?.instanceId,
      );
      const trustedPluginLayout =
        resolved?.instance &&
        resolved.selectedRenderer?.renderer.kind === 'plugin-component'
          ? resolveClientTrustedPluginLayout(
              resolved.descriptor,
              resolved.selectedRenderer,
              resolved.instance,
            )
          : null;
      if (
        !resolved?.instance ||
        resolved.availability.state !== 'available' ||
        (!getBuiltinWorkspacePaneRenderer(
          resolved.descriptor,
          resolved.instance,
        ) &&
          (!trustedPluginLayout || !catalog.projectSlug))
      ) {
        // This build has no renderer for the selection the catalog offered.
        // Reported as a refusal because the card said "available" and the
        // click was real, even though the card's own availability normally
        // withholds Open first.
        setOpenRefusal('refused');
        return;
      }
      const outcome = hostOpen.open(
        resolved.instance,
        undefined,
        catalogRequest,
      );
      if (outcome.ok) {
        setOpenRefusal(null);
        setCatalogRequest(null);
        return;
      }
      setOpenRefusal(outcome.reason);
    },
    [catalog.entries, catalog.projectSlug, catalogRequest, hostOpen],
  );
  /**
   * The Coding occurrence is the layout's Chat position, which is the stack's
   * Chat page now — never a drill-in. Refused at the host's open seam, and
   * left out of the picker below, so it cannot come back as a pane.
   */
  const admitOpenInstance = useCallback(
    (instance: WorkspacePaneInstance) =>
      !catalog.entries.some(
        (candidate) =>
          candidate.descriptor.id === instance.descriptorId &&
          isCanonicalBuiltinCodingOccurrence(instance, candidate.descriptor),
      ),
    [catalog.entries],
  );
  const pickerEntries = useMemo(
    () =>
      catalog.entries.filter(
        (candidate) =>
          !(
            candidate.instance &&
            isCanonicalBuiltinCodingOccurrence(
              candidate.instance,
              candidate.descriptor,
            )
          ),
      ),
    [catalog.entries],
  );
  const codingOccurrence = catalog.entries.find(
    (candidate) =>
      candidate.instance &&
      isWorkspacePaneInstanceOwnedByProject(candidate.instance, projectId) &&
      isCanonicalBuiltinCodingOccurrence(
        candidate.instance,
        candidate.descriptor,
      ),
  );
  const entry = catalog.entries.find(
    (candidate) =>
      candidate.instance &&
      candidate.availability.state === 'available' &&
      isWorkspacePaneInstanceOwnedByProject(candidate.instance, projectId) &&
      isCanonicalBuiltinCodingOccurrence(
        candidate.instance,
        candidate.descriptor,
      ),
  );
  const filePreviewEntry = catalog.entries.find(
    (candidate) =>
      candidate.descriptor.id === WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR_ID &&
      candidate.availability.state === 'available' &&
      isCanonicalBuiltinFilePreviewDescriptor(candidate.descriptor),
  );
  // The Browser pane's catalogue entry, whether or not the server issued
  // its per-Project occurrence (#90 wave 2 issues one for the Add-pane grid).
  const browserPreviewEntry = catalog.entries.find(
    (candidate) =>
      candidate.descriptor.id ===
        WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR_ID &&
      isCanonicalBuiltinBrowserPreviewDescriptor(candidate.descriptor),
  );
  const fileBrowserEntry = catalog.entries.find(
    (candidate) =>
      candidate.instance &&
      candidate.descriptor.id ===
        WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR_ID &&
      candidate.instance.boundContext?.projectId === projectId &&
      isCanonicalWorkspaceCodingFileBrowserPaneInstance(candidate.instance) &&
      isCanonicalBuiltinCodingFileBrowserDescriptor(candidate.descriptor),
  );
  const diffEntry = catalog.entries.find(
    (candidate) =>
      candidate.instance &&
      candidate.descriptor.id === WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR_ID &&
      candidate.instance.boundContext?.projectId === projectId &&
      isCanonicalWorkspaceCodingDiffPaneInstance(candidate.instance) &&
      isCanonicalBuiltinCodingDiffDescriptor(candidate.descriptor),
  );
  const terminalEntry = catalog.entries.find(
    (candidate) =>
      candidate.instance &&
      candidate.descriptor.id ===
        WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR_ID &&
      candidate.instance.boundContext?.projectId === projectId &&
      isCanonicalWorkspaceCodingTerminalPaneInstance(candidate.instance) &&
      isCanonicalBuiltinCodingTerminalDescriptor(candidate.descriptor),
  );
  const planEntry = catalog.entries.find(
    (candidate) =>
      candidate.instance &&
      candidate.descriptor.id === WORKSPACE_PLAN_PANE_DESCRIPTOR_ID &&
      candidate.instance.boundContext?.projectId === projectId &&
      isCanonicalWorkspacePlanPaneInstance(candidate.instance) &&
      isCanonicalBuiltinPlanDescriptor(candidate.descriptor),
  );
  const readinessEntry = catalog.entries.find(
    (candidate) =>
      candidate.instance &&
      candidate.descriptor.id === WORKSPACE_READINESS_PANE_DESCRIPTOR_ID &&
      candidate.instance.boundContext?.projectId === projectId &&
      isCanonicalWorkspaceReadinessPaneInstance(candidate.instance) &&
      isCanonicalBuiltinReadinessDescriptor(candidate.descriptor),
  );
  const trustEntry = catalog.entries.find(
    (candidate) =>
      candidate.instance &&
      candidate.descriptor.id === WORKSPACE_TRUST_PANE_DESCRIPTOR_ID &&
      candidate.instance.boundContext?.projectId === projectId &&
      isCanonicalWorkspaceTrustPaneInstance(candidate.instance) &&
      isCanonicalBuiltinTrustDescriptor(candidate.descriptor),
  );

  /**
   * Every state before the host can mount — the catalog loading or failing,
   * an unavailable Coding occurrence, a composition or document that cannot
   * be admitted — still renders the Chat page, with the state as a notice
   * above it. App suspends the dock's Chat as soon as it knows the layout is
   * the built-in Coding one, so a state that rendered only its message would
   * leave the route with no Chat at all.
   */
  const chatOnly = (notice: ReactNode, provisional = false) => (
    <CodingWorkbench
      projectId={projectId ?? ''}
      projectSlug={projectSlug}
      centerChat={centerChat}
      wide={wide}
      // While the catalog loads, a deep link's drill-in is the page it names
      // (the pane arrives with the host); a state with no host to come is the
      // Chat page.
      location={
        provisional &&
        stackSelection.pane &&
        paneScopeNamesLayout(stackSelection.paneScope, layout.id)
          ? { page: 'drill-in', paneId: stackSelection.pane }
          : CHAT_PAGE
      }
      provisional={provisional}
      scope={{
        kind: 'project',
        projectId: projectId ?? 'pending',
        layoutId: layout.id,
      }}
      instances={NO_INSTANCES}
      hostDocument={() => null}
      paneLabel={() => 'Pane'}
      hostOpen={null}
      onOpenCatalog={() => undefined}
      notice={notice}
    >
      {null}
    </CodingWorkbench>
  );
  if (catalog.isLoading) {
    return chatOnly(
      <SkeletonList count={1} label="Loading coding workspace panes" />,
      true,
    );
  }
  // #2319: a failed background revalidation keeps the answer it had; only a
  // catalog that never loaded is an error screen.
  if (catalog.isError && catalog.data === undefined) {
    return chatOnly(
      <ErrorState
        title="Could not load coding workspace"
        description="Station could not read this Project’s pane catalog."
        action={
          <button type="button" onClick={() => void catalog.refetch()}>
            Retry
          </button>
        }
      />,
    );
  }

  // The Coding occurrence is the host's only structural dependency: the
  // baseline document needs one available catalog-issued instance. Other
  // issued occurrences keep their slots so an unavailable pane can explain
  // itself in place; absent occurrences have no slot to render.
  if (!projectId || !entry?.instance) {
    const unavailablePresentation = codingOccurrence
      ? presentWorkspacePaneAvailability(
          codingOccurrence.availability,
          codingOccurrence.rendererGate,
          codingOccurrence.rendererResolution,
        )
      : undefined;
    return chatOnly(
      <ErrorState
        title="Coding workspace unavailable"
        description={
          unavailablePresentation?.reasonLabel ??
          'Station could not find an available Coding pane for this Project.'
        }
        action={
          unavailablePresentation?.reviewInRegistry ? (
            <button type="button" onClick={() => navigate('/registry')}>
              Review in Registry
            </button>
          ) : (
            <button type="button" onClick={() => void catalog.refetch()}>
              Retry
            </button>
          )
        }
      />,
    );
  }
  // Layout slugs address routes; the host and its pane occurrences persist the
  // resolved LayoutConfig ID. This is deliberately at the host seam, where the
  // catalog instance becomes an admitted renderer-facing occurrence.
  const bindToLayout = (instance: typeof entry.instance) =>
    withWorkspacePaneInstanceLayoutBinding(instance, layout);
  const codingInstance = bindToLayout(entry.instance);
  const fileBrowserInstance = fileBrowserEntry?.instance
    ? bindToLayout(fileBrowserEntry.instance)
    : undefined;
  const diffInstance = diffEntry?.instance
    ? bindToLayout(diffEntry.instance)
    : undefined;
  const terminalInstance = terminalEntry?.instance
    ? bindToLayout(terminalEntry.instance)
    : undefined;
  const planInstance = planEntry?.instance
    ? bindToLayout(planEntry.instance)
    : undefined;
  const readinessInstance = readinessEntry?.instance
    ? bindToLayout(readinessEntry.instance)
    : undefined;
  const trustInstance = trustEntry?.instance
    ? bindToLayout(trustEntry.instance)
    : undefined;
  if (
    !codingInstance ||
    (fileBrowserEntry?.instance && !fileBrowserInstance) ||
    (diffEntry?.instance && !diffInstance) ||
    (terminalEntry?.instance && !terminalInstance) ||
    (planEntry?.instance && !planInstance) ||
    (readinessEntry?.instance && !readinessInstance) ||
    (trustEntry?.instance && !trustInstance)
  ) {
    return chatOnly(
      <ErrorState
        title="Coding workspace unavailable"
        description="Station could not bind its pane occurrences to this layout."
      />,
    );
  }
  const fileComposition =
    fileBrowserEntry &&
    fileBrowserInstance &&
    fileCompositionControl !== 'legacy'
      ? selectCodingFileComposition({
          control: fileCompositionControl,
          projectId,
          layoutId: layout.id,
          descriptor: fileBrowserEntry.descriptor,
          catalogInstance: fileBrowserInstance,
          fileReadGrant: resolveBuiltinCodingFileReadGrant(
            fileBrowserEntry.descriptor,
          ),
          fileReadAvailability:
            fileBrowserEntry.availability.state === 'available'
              ? 'available'
              : 'unavailable',
        })
      : null;
  const fileCompositionReceipt =
    fileComposition?.receipt ??
    (fileCompositionControl !== 'legacy'
      ? {
          control: fileCompositionControl,
          outcome: 'unavailable' as const,
          restorationIdentityMatched: false,
          fallbackUsed: false as const,
          reason: 'descriptor-incompatible' as const,
        }
      : null);
  if (
    fileCompositionControl !== 'legacy' &&
    (!fileBrowserEntry?.instance || !fileComposition?.instance)
  ) {
    return chatOnly(
      <>
        {fileCompositionReceipt ? (
          <CodingFileCompositionReceiptTracker
            receipt={fileCompositionReceipt}
          />
        ) : null}
        <ErrorState
          title="Coding file workspace unavailable"
          description="The Workspace Composition file pane could not be admitted. Station did not fall back to the legacy Coding host."
        />
      </>,
    );
  }
  const selectedFileBrowserInstance =
    fileComposition?.instance ?? fileBrowserInstance;
  const diffComposition =
    diffEntry && diffInstance && diffCompositionControl !== 'legacy'
      ? selectCodingDiffComposition({
          control: diffCompositionControl,
          projectId,
          layoutId: layout.id,
          descriptor: diffEntry.descriptor,
          catalogInstance: diffInstance,
          gitDiffGrant: resolveBuiltinCodingGitDiffGrant(diffEntry.descriptor),
          gitDiffAvailability:
            diffEntry.availability.state === 'available'
              ? 'available'
              : 'unavailable',
        })
      : null;
  const diffCompositionReceipt =
    diffComposition?.receipt ??
    (diffCompositionControl !== 'legacy'
      ? {
          control: diffCompositionControl,
          outcome: 'unavailable' as const,
          restorationIdentityMatched: false,
          fallbackUsed: false as const,
          reason: 'descriptor-incompatible' as const,
        }
      : null);
  if (
    diffCompositionControl !== 'legacy' &&
    (!diffEntry?.instance || !diffComposition?.instance)
  ) {
    return chatOnly(
      <>
        {diffCompositionReceipt ? (
          <CodingDiffCompositionReceiptTracker
            receipt={diffCompositionReceipt}
          />
        ) : null}
        <ErrorState
          title="Coding Diff workspace unavailable"
          description="The Workspace Composition Diff pane could not be admitted. Station did not fall back to the legacy Coding host."
        />
      </>,
    );
  }
  const selectedDiffInstance = diffComposition?.instance ?? diffInstance;
  const evidenceEntries = [
    ['plan', planEntry],
    ['readiness', readinessEntry],
    ['trust', trustEntry],
  ] as const;
  const evidenceComposition =
    evidenceCompositionControl !== 'legacy' &&
    evidenceEntries.every(([, candidate]) => candidate?.instance)
      ? selectCodingEvidenceComposition({
          control: evidenceCompositionControl,
          projectId,
          layoutId: layout.id,
          panes: evidenceEntries.map(([category, candidate]) => ({
            category,
            descriptor: candidate!.descriptor,
            catalogInstance:
              category === 'plan'
                ? planInstance!
                : category === 'readiness'
                  ? readinessInstance!
                  : trustInstance!,
            grant: resolveBuiltinCodingEvidenceGrant(
              category,
              candidate!.descriptor,
            ),
            availability:
              candidate!.availability.state === 'available'
                ? 'available'
                : 'unavailable',
          })),
        })
      : null;
  const evidenceCompositionReceipts =
    evidenceComposition?.receipts ??
    (evidenceCompositionControl !== 'legacy'
      ? [
          {
            category: 'evidence' as const,
            control: evidenceCompositionControl,
            outcome: 'unavailable' as const,
            restorationIdentityMatched: false,
            fallbackUsed: false as const,
            reason: 'descriptor-incompatible' as const,
          },
        ]
      : []);
  if (
    evidenceCompositionControl !== 'legacy' &&
    !evidenceComposition?.document
  ) {
    return chatOnly(
      <>
        {evidenceCompositionReceipts.map((receipt) => (
          <CodingEvidenceCompositionReceiptTracker
            key={`${receipt.category}:${receipt.outcome}:${receipt.reason ?? 'none'}`}
            receipt={receipt}
          />
        ))}
        <ErrorState
          title="Coding evidence workspace unavailable"
          description="The Workspace Composition evidence panes could not be admitted. Station did not fall back to the legacy Coding host."
        />
      </>,
    );
  }
  const selectedEvidence = (descriptorId: string) =>
    evidenceComposition?.instances.find(
      (instance) => instance.descriptorId === descriptorId,
    );
  const selectedPlanInstance =
    evidenceCompositionControl === 'legacy'
      ? planInstance
      : selectedEvidence(WORKSPACE_PLAN_PANE_DESCRIPTOR_ID);
  const selectedReadinessInstance =
    evidenceCompositionControl === 'legacy'
      ? readinessInstance
      : selectedEvidence(WORKSPACE_READINESS_PANE_DESCRIPTOR_ID);
  const selectedTrustInstance =
    evidenceCompositionControl === 'legacy'
      ? trustInstance
      : selectedEvidence(WORKSPACE_TRUST_PANE_DESCRIPTOR_ID);
  // The Coding occurrence gates the host (above) but is not one of its panes:
  // the layout's Chat position is the stack's Chat page (`CodingWorkbench`).
  // A document persisted before the stack still lists it; the host's restore
  // drops an occurrence its catalog no longer issues and prunes the group it
  // leaves empty, keeping every other pane and its state
  // (`restoreWorkspacePaneHostDocument`), so the stored id is reused as is.
  const drillInInstances = [
    ...(selectedFileBrowserInstance ? [selectedFileBrowserInstance] : []),
    ...(selectedDiffInstance ? [selectedDiffInstance] : []),
    ...(terminalInstance ? [terminalInstance] : []),
    ...(selectedPlanInstance ? [selectedPlanInstance] : []),
    ...(selectedReadinessInstance ? [selectedReadinessInstance] : []),
    ...(selectedTrustInstance ? [selectedTrustInstance] : []),
  ];
  const hostScope = {
    kind: 'project' as const,
    projectId,
    layoutId: layout.id,
  };
  const document =
    drillInInstances.length > 0
      ? retainWorkspacePaneHostDocument(
          publishedDocument,
          createWorkspacePaneHostBaselineDocument(
            `builtin-coding-${layoutSlug}`,
            hostScope,
            drillInInstances,
          ),
        )
      : null;
  if (drillInInstances.length > 0 && !document) {
    return chatOnly(
      <ErrorState
        title="Coding workspace cannot mount"
        description="Station could not create the required workspace pane host."
      />,
    );
  }
  const location = resolveCodingStackLocation(
    hostScope,
    // Unknown until the host reports its live set: trust the URL meanwhile.
    hostInstances ?? (document ? undefined : []),
    stackSelection.pane,
    stackSelection.paneScope,
    hostActiveId,
  );
  if (location.page === 'drill-in' && !drillInVisited) setDrillInVisited(true);
  const renderPanes = drillInVisited || location.page === 'drill-in';
  /**
   * One pane, drawn: the renderer the catalog resolves for its descriptor
   * (built-in, plugin or MCP), or the state that stands in for one. The
   * pane host draws every pane with it; past the wide fold the Terminal is
   * drawn with it by the workbench's lower panel instead (`terminal`), and
   * the host is handed nothing for that instance, so one terminal is never
   * mounted twice.
   */
  const renderCodingPane = (
    instance: WorkspacePaneInstance,
    presentation: WorkspacePaneHostPanePresentation,
  ): ReactNode => {
    // #2465: a dock-only pane (the host-global Device pane) is not
    // another Project's — it is no Project's. Say where it lives. The
    // same predicate keeps the picker from offering it.
    const dockOnly = catalog.entries.find(
      (candidate) =>
        candidate.descriptor.id === instance.descriptorId &&
        !isProjectPlaceableWorkspacePane(candidate.descriptor),
    )?.descriptor;
    if (dockOnly) {
      const remove =
        hostOpen?.close && (hostInstanceIds?.size ?? 0) > 1
          ? hostOpen.close
          : undefined;
      return (
        <DockOnlyWorkspacePaneNotice
          descriptor={dockOnly}
          {...(remove
            ? { onRemove: () => void remove(instance.instanceId) }
            : {})}
        />
      );
    }
    if (!isWorkspacePaneInstanceOwnedByProject(instance, projectId)) {
      return (
        <Empty
          label="Workspace pane unavailable"
          description="This pane belongs to a different Project."
        />
      );
    }
    const paneEntry = catalog.entries.find(
      (candidate) =>
        candidate.instance?.instanceId === instance.instanceId &&
        candidate.descriptor.id === instance.descriptorId,
    );
    const codeIssuedBasisMcp =
      isCanonicalBasisMcpWorkspacePaneInstance(instance);
    const descriptor =
      paneEntry?.descriptor ??
      (instance.descriptorId === WORKSPACE_BASIS_PANE_DESCRIPTOR.id
        ? WORKSPACE_BASIS_PANE_DESCRIPTOR
        : instance.descriptorId === entry.descriptor.id
          ? entry.descriptor
          : instance.descriptorId === fileBrowserEntry?.descriptor.id
            ? fileBrowserEntry?.descriptor
            : instance.descriptorId === diffEntry?.descriptor.id
              ? diffEntry?.descriptor
              : instance.descriptorId === terminalEntry?.descriptor.id
                ? terminalEntry?.descriptor
                : instance.descriptorId === planEntry?.descriptor.id
                  ? planEntry?.descriptor
                  : instance.descriptorId === readinessEntry?.descriptor.id
                    ? readinessEntry?.descriptor
                    : instance.descriptorId === trustEntry?.descriptor.id
                      ? trustEntry?.descriptor
                      : instance.descriptorId ===
                          filePreviewEntry?.descriptor.id
                        ? filePreviewEntry?.descriptor
                        : instance.descriptorId ===
                            browserPreviewEntry?.descriptor.id
                          ? browserPreviewEntry.descriptor
                          : null);
    const Pane =
      descriptor &&
      getBuiltinWorkspacePaneRenderer(
        descriptor,
        instance.descriptorId === entry.descriptor.id ? instance : undefined,
      );
    if (paneEntry && paneEntry.availability.state !== 'available') {
      const presentation = presentWorkspacePaneAvailability(
        paneEntry.availability,
        paneEntry.rendererGate,
        paneEntry.rendererResolution,
      );
      return (
        <Empty
          label={`${paneEntry.descriptor.name} unavailable`}
          description={`${presentation.reasonLabel}${presentation.actionLabel ? ` Next: ${presentation.actionLabel}.` : ''}`}
        />
      );
    }
    const mcpRenderer =
      paneEntry?.selectedRenderer?.renderer.kind === 'mcp-tool-ui'
        ? paneEntry.selectedRenderer.renderer
        : null;
    const pluginRenderer =
      paneEntry?.selectedRenderer?.renderer.kind === 'plugin-component'
        ? paneEntry.selectedRenderer
        : null;
    const pluginComponent =
      pluginRenderer?.renderer.kind === 'plugin-component'
        ? pluginRenderer.renderer
        : null;
    const trustedPluginLayout =
      pluginRenderer && pluginComponent && descriptor
        ? resolveClientTrustedPluginLayout(descriptor, pluginRenderer, instance)
        : null;
    if (codeIssuedBasisMcp) {
      return (
        <LazyBoundary
          load={loadProjectBasisMcpWorkspacePane}
          componentProps={{ instance, presentation }}
          pending={<SkeletonList count={1} label="Loading Basis App" />}
        />
      );
    }
    if (mcpRenderer && descriptor) {
      const selectedTab = {
        id: instance.instanceId,
        label: descriptor.name,
        description: descriptor.description,
        component: mcpRenderer,
        actions: descriptor.actions,
      };
      return (
        <LayoutRenderer
          componentId={mcpRenderer}
          layout={{
            name: descriptor.name,
            slug: instance.instanceId,
            tabs: [selectedTab],
          }}
          activeTab={selectedTab}
          activeTabId={selectedTab.id}
          mcpUiPaneIdentity={{
            descriptorId: instance.descriptorId,
            instanceId: instance.instanceId,
            stateKey: instance.stateKey,
          }}
          mcpUiDisplayMode={presentation.displayMode}
          mcpUiHostAvailableDisplayModes={presentation.availableDisplayModes}
          onMcpUiRequestDisplayMode={presentation.requestDisplayMode}
          onMcpUiDisplayModeDecision={trackMcpAppDisplayModeDecision}
        />
      );
    }
    if (
      trustedPluginLayout &&
      pluginRenderer &&
      pluginComponent &&
      descriptor
    ) {
      const pluginName =
        instance.boundContext?.contribution?.provenance.origin === 'plugin'
          ? instance.boundContext.contribution.provenance.pluginId
          : undefined;
      if (!pluginName || !catalog.projectSlug) {
        return (
          <Empty
            label="Workspace pane unavailable"
            description="Station could not bind this plugin pane to its owning Project and plugin."
          />
        );
      }
      const selectedTab = {
        id: instance.instanceId,
        label: descriptor.name,
        description: descriptor.description,
        component: pluginComponent,
        actions: descriptor.actions,
      };
      const paneLayout = {
        name: descriptor.name,
        slug: instance.instanceId,
        tabs: [selectedTab],
      };
      return (
        <PluginWorkspacePaneSDKBoundary
          layout={paneLayout}
          projectSlug={catalog.projectSlug}
          pluginName={pluginName}
        >
          <LayoutRenderer
            componentId={pluginComponent}
            trustedPluginLayout={trustedPluginLayout}
            layout={paneLayout}
            activeTab={selectedTab}
            activeTabId={selectedTab.id}
          />
        </PluginWorkspacePaneSDKBoundary>
      );
    }
    return Pane ? (
      <Pane
        descriptor={descriptor}
        instance={instance}
        browserPreviewAvailability={browserPreviewEntry?.availability}
      />
    ) : null;
  };
  // A File Preview is named by its file (#3047): the rail item says the
  // name, its tooltip and the panel head's title the whole path.
  const stackPaneDetail = (instance: WorkspacePaneInstance) =>
    projectId
      ? filePreviewPanePresentationPath(
          projectId,
          projectSlug,
          instance,
          window.localStorage,
        )
      : null;
  const stackPaneLabel = (instance: WorkspacePaneInstance) => {
    const path = stackPaneDetail(instance);
    if (path) return path.slice(path.lastIndexOf('/') + 1) || path;
    const name =
      presentationLabel(instance) ??
      builtinWorkspacePaneName(instance.descriptorId) ??
      'Pane';
    // A second Browser is "Browser 2": two identical globes on the rail
    // told the reader nothing (design audit D8).
    const ordinal = browserPreviewPaneOrdinal(
      hostInstances ?? document?.instances ?? [],
      instance,
    );
    return ordinal === null ? name : `${name} ${ordinal}`;
  };
  return (
    <CodingWorkbench
      projectId={projectId}
      projectSlug={projectSlug}
      centerChat={centerChat}
      wide={wide}
      location={location}
      scope={hostScope}
      instances={hostInstances ?? document?.instances ?? []}
      hostDocument={() => liveHostDocument.current ?? document!}
      terminal={
        terminalInstance
          ? {
              instance: terminalInstance,
              render: () => (
                <WorkspacePaneFrame
                  instanceId={terminalInstance.instanceId}
                  paneName={stackPaneLabel(terminalInstance)}
                  onRetry={() => true}
                >
                  {renderCodingPane(terminalInstance, LOWER_PANE_PRESENTATION)}
                </WorkspacePaneFrame>
              ),
            }
          : undefined
      }
      paneLabel={stackPaneLabel}
      paneDetail={stackPaneDetail}
      hostOpen={hostOpen}
      onOpenCatalog={requestCatalog}
      browserPreviewAvailability={browserPreviewEntry?.availability}
      badges={railBadges}
      popOut={popOut}
      persistence={document ? hostPersistence : 'owned'}
      closable={(instance) =>
        !drillInInstances.some(
          (builtIn) => builtIn.instanceId === instance.instanceId,
        )
      }
    >
      {fileCompositionReceipt ? (
        <CodingFileCompositionReceiptTracker receipt={fileCompositionReceipt} />
      ) : null}
      {diffCompositionReceipt ? (
        <CodingDiffCompositionReceiptTracker receipt={diffCompositionReceipt} />
      ) : null}
      {evidenceCompositionReceipts.map((receipt) => (
        <CodingEvidenceCompositionReceiptTracker
          key={`${receipt.category}:${receipt.outcome}:${receipt.reason ?? 'none'}`}
          receipt={receipt}
        />
      ))}
      {(evidenceComposition?.unavailablePanes ?? []).map((entry) => (
        <Empty key={entry.category} {...codingEvidenceUnavailableCopy(entry)} />
      ))}
      {document ? (
        <WorkspacePaneHost
          document={document}
          runtime={workspacePaneRuntime.current}
          compact={compact}
          // Past the wide fold a pane the host opens itself (a File Preview
          // from Files) lands beside Chat like a rail pick: the entry is
          // corrected in place, never pushed (#3040).
          navigationSelection={wide ? 'replace' : 'explicit'}
          // A drill-in is its page: the pane and nothing else. No tab strip, no
          // save notice, no pane-actions chrome — the stack's breadcrumb, rail
          // and ⋯ carry what the reader needs (`CodingWorkbench`).
          presentation="chromeless"
          onPersistenceStatusChange={setHostPersistence}
          onDocumentChange={handleHostDocumentChange}
          onOpenCatalog={requestCatalog}
          onOpenActionChange={captureHostOpen}
          popOut={popOut}
          operationalEventContext={operationalEventContext}
          operationalAvailability={operationalAvailability}
          admitRestoredInstance={admitRestoredInstance}
          admitOpenInstance={admitOpenInstance}
          onInstanceRemoved={onInstanceRemoved}
          presentationLabel={presentationLabel}
          renderPane={(instance, presentation) =>
            hostRendersCodingPane(
              wide,
              renderPanes,
              instance.instanceId,
              terminalInstance?.instanceId ?? null,
            )
              ? renderCodingPane(instance, presentation)
              : null
          }
        />
      ) : null}
      <ProjectWorkspacePaneModal
        show={catalogRequest !== null && hostOpen !== null}
        notice={
          openRefusal ? describeWorkspacePaneOpenRefusal(openRefusal) : null
        }
        onClose={() => {
          setCatalogRequest(null);
          setOpenRefusal(null);
        }}
        entries={pickerEntries}
        loading={catalog.isLoading}
        error={catalog.isError}
        hasData={catalog.data !== undefined}
        retrying={catalog.isFetching}
        onRetry={() => void catalog.refetch()}
        onSelect={openCatalogEntry}
        onAction={(_entry, action) => {
          if (action.code === 'retry-availability-check') {
            void catalog.refetch();
            return 'Checking the current pane availability.';
          }
          return 'This layout can explain the requirement but cannot complete that step from its pane catalog.';
        }}
        canExecuteAction={(_entry, action) =>
          action.code === 'retry-availability-check'
        }
        isOpen={(candidate) =>
          Boolean(
            candidate.instance &&
              (hostInstanceIds?.has(candidate.instance.instanceId) ??
                document?.instances.some(
                  (instance) =>
                    instance.instanceId === candidate.instance?.instanceId,
                )),
          )
        }
      />
    </CodingWorkbench>
  );
}

export function ProjectLayoutRenderer({
  projectSlug,
  layoutSlug,
}: {
  projectSlug: string;
  layoutSlug: string;
}) {
  const {
    data: persistedLayout,
    isLoading: layoutLoading,
    error: layoutQueryError,
  } = useProjectLayoutQuery(projectSlug, layoutSlug);

  /**
   * #2065: a builtin layout kind whose configuration is empty needs no
   * persisted record to render.
   *
   * Nothing materializes the builtins — a project only gains
   * `layouts/review.json` after someone runs Add layout — so a fresh project
   * has `coding.json` and nothing else. Without this, every link the inbox,
   * Starter work and the retired `/review-queue` redirect mint into Review
   * would land on `LayoutView`'s "Layout not found", for a route the global
   * queue served on every project. Resolving the definition here is what
   * keeps that promise WITHOUT writing a file: nothing is placed, so the
   * project's layout chips still list only what someone actually added.
   *
   * Deliberately `review` alone rather than every builtin. `coding` and
   * `tasks` read persisted configuration (composition controls, filters), so
   * for them an absent record is not the same thing as an empty one and
   * substituting a default would answer a question the project never
   * answered; `session-board` is reached by its own route. Review reads no
   * persisted configuration at all and takes its owner from the route, so
   * there is no question an absent record leaves unanswered.
   *
   * Gated on `isUnplacedLayoutRecord` and not merely on `!persistedLayout`:
   * while the request is in flight, or when it failed for any other reason,
   * this must not run — a placed plugin layout that happens to be called
   * `review` still owns its own rendering, and flashing the builtin over it
   * is exactly the hijack `project-layout-kind.ts` exists to prevent. That
   * predicate also excludes the 404 that means the PROJECT is missing, which
   * would otherwise render an empty Review workbench for a Project that does
   * not exist.
   *
   * The empty `config` is not read off `BUILTIN_REVIEW_LAYOUT` — that
   * descriptor declares no `config` field. `{}` is what the apply path
   * persists for a non-plugin builtin (`projects.ts`, the
   * `resolved.pluginName ? {...} : {}` branch), so the `config` this
   * synthesizes is the value that path would have written, without writing
   * it. Only `config` matches: the apply path persists eleven fields and
   * this record carries two, which is enough because the only readers are
   * the dispatch (`type`, `config`, `catalogContribution`) and the review
   * renderer (`projectSlug`, `layoutSlug`, `config`). A consumer that starts
   * reading `id` or `name` off a layout record needs more than this.
   */
  const unplacedBuiltinReview =
    layoutSlug === BUILTIN_REVIEW_LAYOUT.slug &&
    isUnplacedLayoutRecord(layoutQueryError, layoutLoading);
  const layoutConfig =
    persistedLayout ??
    (unplacedBuiltinReview
      ? ({ type: BUILTIN_REVIEW_LAYOUT.type, config: {} } as const)
      : undefined);

  if (!layoutConfig) {
    return <LayoutView projectSlug={projectSlug} layoutSlug={layoutSlug} />;
  }

  const config = layoutConfig.config ?? {};
  // A contributed layout's free-form `type` may intentionally match one of
  // Station's built-in layout types. Its declared tabs/components remain the
  // rendering authority. `config.plugin` covers persisted layouts created
  // before catalog attribution was stored. Layout tabs alone are not
  // attribution: Station-owned legacy chat layouts also declare them.
  // The decision lives in `project-layout-kind.ts` so App's "does this layout
  // own the whole viewport?" reads the same derivation (#1446).
  const rendererKind = resolveProjectLayoutRendererKind(layoutConfig);

  if (rendererKind === 'layout-view') {
    return <LayoutView projectSlug={projectSlug} layoutSlug={layoutSlug} />;
  }

  if (rendererKind === 'coding') {
    const fileCompositionControl =
      config.workspaceCompositionFilePane === 'composition' ||
      config.workspaceCompositionFilePane === 'compare'
        ? config.workspaceCompositionFilePane
        : 'legacy';
    const diffCompositionControl =
      config.workspaceCompositionDiffPane === 'composition' ||
      config.workspaceCompositionDiffPane === 'compare'
        ? config.workspaceCompositionDiffPane
        : 'legacy';
    const evidenceCompositionControl =
      config.workspaceCompositionEvidencePanes === 'composition' ||
      config.workspaceCompositionEvidencePanes === 'compare'
        ? config.workspaceCompositionEvidencePanes
        : 'legacy';
    return (
      <BuiltinCodingLayoutHost
        projectSlug={projectSlug}
        layoutSlug={layoutSlug}
        layout={layoutConfig}
        fileCompositionControl={fileCompositionControl}
        diffCompositionControl={diffCompositionControl}
        evidenceCompositionControl={evidenceCompositionControl}
      />
    );
  }

  const Renderer = layoutTypeRegistry[rendererKind];
  return (
    <Renderer
      projectSlug={projectSlug}
      layoutSlug={layoutSlug}
      config={config}
    />
  );
}
