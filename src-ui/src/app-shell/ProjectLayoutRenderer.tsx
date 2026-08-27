import {
  isCanonicalBasisWorkspacePaneInstance,
  WORKSPACE_BASIS_PANE_DESCRIPTOR,
  WORKSPACE_BASIS_PANE_DESCRIPTOR_ID,
} from '@kontourai/station-basis-pane/workspace-basis-pane';
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
import { telemetry, useProjectLayoutQuery } from '@kontourai/station-sdk';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LazyBoundary } from '../components/LazyBoundary';
import { Empty, ErrorState, SkeletonList } from '../components/state';
import { useNavigation } from '../contexts/NavigationContext';
import { useIsMobile } from '../hooks/useIsMobile';
import { LayoutRenderer } from '../layouts';
import {
  type NativePlatformAdapter,
  nativePlatformPromise,
} from '../platform/native';
import { LayoutView } from '../views/LayoutView';
import {
  admitRestoredBrowserPreviewPaneInstance,
  browserPreviewPanePresentationLabel,
  removeRemovedBrowserPreviewPaneState,
} from '../workspace-panes/browserPreviewPaneInstance';
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
import {
  admitRestoredFilePreviewPaneInstance,
  filePreviewPanePresentationLabel,
  removeRemovedFilePreviewPaneState,
} from '../workspace-panes/filePreviewPaneInstance';
import { trackMcpAppDisplayModeDecision } from '../workspace-panes/mcpAppDisplayModeTelemetry';
import { ProjectWorkspacePaneModal } from '../workspace-panes/ProjectWorkspacePaneCatalog';
import { useResolvedWorkspacePaneCatalog } from '../workspace-panes/resolvedWorkspacePaneCatalog';
import { WorkspacePaneHost } from '../workspace-panes/WorkspacePaneHost';
import type {
  WorkspacePaneHostCatalogRequest,
  WorkspacePaneHostPopOut,
  WorkspacePaneHostPopOutAvailability,
  WorkspacePaneHostPopOutRequestResult,
} from '../workspace-panes/WorkspacePaneHostCommands';
import type { WorkspacePaneHostOpenAction } from '../workspace-panes/WorkspacePaneHostOpenContext';
import type { WorkspacePaneAvailabilityCatalogEntry } from '../workspace-panes/workspacePaneAvailabilityPresentation';
import { presentWorkspacePaneAvailability } from '../workspace-panes/workspacePaneAvailabilityPresentation';
import { isWorkspacePaneInstanceOwnedByProject } from '../workspace-panes/workspacePaneHostAdmission';
import { WorkspacePaneHostRuntime } from '../workspace-panes/workspacePaneHostRuntime';
import { createWorkspacePaneOperationalEventContext } from '../workspace-panes/workspacePaneOperationalEvents';
import { trackCodingDiffCompositionReceipt } from './codingDiffCompositionTelemetry';
import { trackCodingEvidenceCompositionReceipt } from './codingEvidenceCompositionTelemetry';
import { codingEvidenceUnavailableCopy } from './codingEvidenceUnavailableCopy';
import { trackCodingFileCompositionReceipt } from './codingFileCompositionTelemetry';
import { layoutTypeRegistry } from './layoutRegistry';

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

// station#3969: "occurrence" is our word for one open copy of a pane; the
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
 * a change the layout never made (station#3781).
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
 * station#3794: `createWorkspacePaneHostBaselineDocument` is a pure function
 * of (id, scope, instances), and the instances are re-minted by
 * `withWorkspacePaneInstanceLayoutBinding` on every render, so the host was
 * handed a new document object for an unchanged workspace. The host keys its
 * tree on strings and so does not remount, but the document is re-fingerprinted
 * and re-reduced per render. Serialising the whole document — not just the
 * authority fields — is what makes "unchanged" honest here: a document that
 * differs anywhere is published, and only a byte-identical one keeps its
 * identity.
 */
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
  const { navigate } = useNavigation();
  const projectId = catalog.projectId;
  const compact = useIsMobile();
  const popOut = useBuiltinCodingPanePopOut({
    entries: catalog.entries,
    projectId,
    projectSlug,
    layoutSlug: layout.id,
  });
  const hostOpen = useRef<WorkspacePaneHostOpenAction | null>(null);
  const [catalogRequest, setCatalogRequest] =
    useState<WorkspacePaneHostCatalogRequest | null>(null);
  const [hostInstanceIds, setHostInstanceIds] = useState<ReadonlySet<string>>();
  /**
   * Stable sink, and a set identity that moves only when its membership does.
   * Both halves matter: an inline handler made the host re-announce on every
   * render, and a freshly built `Set` made every announcement — including the
   * ones carrying an unchanged list — a committed state change, which rendered
   * the host again. See the notification effect in `workspacePaneHostController`.
   */
  const handleHostDocumentChange = useCallback(
    (next: WorkspacePaneHostDocumentV1) => {
      setHostInstanceIds((current) => {
        const ids = new Set(
          next.instances.map((instance) => instance.instanceId),
        );
        return sameWorkspacePaneInstanceIds(current, ids) ? current : ids;
      });
    },
    [],
  );
  /**
   * station#3794: these five are host-effect dependencies
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
    [projectId, projectSlug],
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
            : null))
        : null,
    [projectId, projectSlug],
  );
  /** The document already published, kept while its content is unchanged. */
  const publishedDocument = useRef<{
    content: string;
    document: WorkspacePaneHostDocumentV1;
  } | null>(null);
  const captureHostOpen = useCallback(
    (action: WorkspacePaneHostOpenAction | null) => {
      hostOpen.current = action;
    },
    [],
  );
  const openCatalogEntry = useCallback(
    (entry: WorkspacePaneAvailabilityCatalogEntry) => {
      if (
        !catalogRequest ||
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
      if (
        !resolved?.instance ||
        resolved.availability.state !== 'available' ||
        !getBuiltinWorkspacePaneRenderer(resolved.descriptor, resolved.instance)
      ) {
        return;
      }
      if (
        hostOpen.current?.open(resolved.instance, undefined, catalogRequest)
      ) {
        setCatalogRequest(null);
      }
    },
    [catalog.entries, catalogRequest],
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
  const browserPreviewEntry = catalog.entries.find(
    (candidate) =>
      !candidate.instance &&
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

  if (catalog.isLoading) {
    return <SkeletonList count={1} label="Loading coding workspace panes" />;
  }
  if (catalog.isError) {
    return (
      <ErrorState
        title="Could not load coding workspace"
        description="Station could not read this Project’s pane catalog."
        action={
          <button type="button" onClick={() => void catalog.refetch()}>
            Retry
          </button>
        }
      />
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
        )
      : undefined;
    return (
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
      />
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
    return (
      <ErrorState
        title="Coding workspace unavailable"
        description="Station could not bind its pane occurrences to this layout."
      />
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
    return (
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
      </>
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
    return (
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
      </>
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
    return (
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
      </>
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
  const document = retainWorkspacePaneHostDocument(
    publishedDocument,
    createWorkspacePaneHostBaselineDocument(
      `builtin-coding-${layoutSlug}`,
      { kind: 'project', projectId, layoutId: layout.id },
      [
        codingInstance,
        ...(selectedFileBrowserInstance ? [selectedFileBrowserInstance] : []),
        ...(selectedDiffInstance ? [selectedDiffInstance] : []),
        ...(terminalInstance ? [terminalInstance] : []),
        ...(selectedPlanInstance ? [selectedPlanInstance] : []),
        ...(selectedReadinessInstance ? [selectedReadinessInstance] : []),
        ...(selectedTrustInstance ? [selectedTrustInstance] : []),
      ],
    ),
  );
  if (!document) {
    return (
      <ErrorState
        title="Coding workspace cannot mount"
        description="Station could not create the required workspace pane host."
      />
    );
  }
  return (
    <>
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
      <WorkspacePaneHost
        document={document}
        runtime={workspacePaneRuntime.current}
        compact={compact}
        onDocumentChange={handleHostDocumentChange}
        onOpenCatalog={setCatalogRequest}
        onOpenActionChange={captureHostOpen}
        popOut={popOut}
        operationalEventContext={operationalEventContext}
        operationalAvailability={operationalAvailability}
        admitRestoredInstance={admitRestoredInstance}
        onInstanceRemoved={onInstanceRemoved}
        presentationLabel={presentationLabel}
        renderPane={(instance, presentation) => {
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
                        : instance.descriptorId ===
                            readinessEntry?.descriptor.id
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
              instance.descriptorId === entry.descriptor.id
                ? instance
                : undefined,
            );
          if (paneEntry && paneEntry.availability.state !== 'available') {
            const presentation = presentWorkspacePaneAvailability(
              paneEntry.availability,
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
                mcpUiHostAvailableDisplayModes={
                  presentation.availableDisplayModes
                }
                onMcpUiRequestDisplayMode={presentation.requestDisplayMode}
                onMcpUiDisplayModeDecision={trackMcpAppDisplayModeDecision}
              />
            );
          }
          return Pane ? (
            <Pane
              descriptor={descriptor}
              instance={instance}
              browserPreviewAvailability={browserPreviewEntry?.availability}
            />
          ) : null;
        }}
      />
      <ProjectWorkspacePaneModal
        show={catalogRequest !== null}
        onClose={() => setCatalogRequest(null)}
        entries={catalog.entries}
        loading={catalog.isLoading}
        error={catalog.isError}
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
                document.instances.some(
                  (instance) =>
                    instance.instanceId === candidate.instance?.instanceId,
                )),
          )
        }
      />
    </>
  );
}

export function ProjectLayoutRenderer({
  projectSlug,
  layoutSlug,
}: {
  projectSlug: string;
  layoutSlug: string;
}) {
  const { data: layoutConfig } = useProjectLayoutQuery(projectSlug, layoutSlug);

  if (!layoutConfig) {
    return <LayoutView projectSlug={projectSlug} layoutSlug={layoutSlug} />;
  }

  const config = layoutConfig.config ?? {};
  const declaredPlugin =
    typeof config.plugin === 'string' && config.plugin.length > 0;
  const contributionOrigin =
    layoutConfig.catalogContribution?.provenance.origin;
  const isContributedLayout =
    contributionOrigin === 'plugin' || contributionOrigin === 'mcp';

  // A contributed layout's free-form `type` may intentionally match one of
  // Station's built-in layout types. Its declared tabs/components remain the
  // rendering authority. `config.plugin` covers persisted layouts created
  // before catalog attribution was stored. Layout tabs alone are not
  // attribution: Station-owned legacy chat layouts also declare them.
  if (isContributedLayout || declaredPlugin) {
    return <LayoutView projectSlug={projectSlug} layoutSlug={layoutSlug} />;
  }

  if (layoutConfig.type === 'coding') {
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

  const Renderer = layoutConfig.type
    ? layoutTypeRegistry[layoutConfig.type]
    : undefined;
  if (Renderer) {
    return (
      <Renderer
        projectSlug={projectSlug}
        layoutSlug={layoutSlug}
        config={layoutConfig.config ?? {}}
      />
    );
  }

  return <LayoutView projectSlug={projectSlug} layoutSlug={layoutSlug} />;
}
