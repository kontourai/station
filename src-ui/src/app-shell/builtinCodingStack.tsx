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
import { telemetry } from '@kontourai/station-sdk';
import { useEffect } from 'react';
import { StationExtensionsAccess } from '../components/registry/StationExtensionsAccess';
import { Empty, ErrorState } from '../components/state';
import {
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
import type { ResolvedWorkspacePaneCatalogEntry } from '../workspace-panes/resolvedWorkspacePaneCatalog';
import { presentWorkspacePaneAvailability } from '../workspace-panes/workspacePaneAvailabilityPresentation';
import { isWorkspacePaneInstanceOwnedByProject } from '../workspace-panes/workspacePaneHostAdmission';
import { trackCodingDiffCompositionReceipt } from './codingDiffCompositionTelemetry';
import { trackCodingEvidenceCompositionReceipt } from './codingEvidenceCompositionTelemetry';
import { codingEvidenceUnavailableCopy } from './codingEvidenceUnavailableCopy';
import { trackCodingFileCompositionReceipt } from './codingFileCompositionTelemetry';
import type { LayoutStackDrillInOutcome } from './layoutStackDrillIns';

/**
 * Built-in Coding's own composition inside the generic stack host (#2995):
 * the Coding occurrence that gates it, Files, Diff, the Terminal and the
 * evidence panes, each through its Workspace Composition control. This is
 * the part of the old `BuiltinCodingLayoutHost` that is Coding's, not the
 * stack's; `ProjectLayoutRenderer` grants it only to the built-in record
 * (`isBuiltinCodingLayout`). It moves out with Coding in slice j (#3009).
 */
export interface BuiltinCodingStackControls {
  file: CodingFileCompositionControl;
  diff: CodingDiffCompositionControl;
  evidence: CodingEvidenceCompositionControl;
}

/** The record's three Workspace Composition controls, `legacy` by default. */
export function builtinCodingStackControls(
  config: Record<string, unknown>,
): BuiltinCodingStackControls {
  const control = (value: unknown) =>
    value === 'composition' || value === 'compare' ? value : 'legacy';
  return {
    file: control(config.workspaceCompositionFilePane),
    diff: control(config.workspaceCompositionDiffPane),
    evidence: control(config.workspaceCompositionEvidencePanes),
  };
}

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

/**
 * Built-in Coding's drill-ins, or why the host cannot mount. Every refusal
 * and receipt is the one the Coding host gave before it became generic.
 */
export function resolveBuiltinCodingStack({
  entries,
  registeredEntries,
  projectId,
  bind,
  layoutId,
  controls,
  developerFeatures,
  onRetry,
}: {
  entries: readonly ResolvedWorkspacePaneCatalogEntry[];
  registeredEntries: readonly ResolvedWorkspacePaneCatalogEntry[];
  projectId: string | undefined;
  bind(instance: WorkspacePaneInstance): WorkspacePaneInstance | null;
  layoutId: string;
  controls: BuiltinCodingStackControls;
  developerFeatures: { flow: boolean; readiness: boolean; trust: boolean };
  onRetry(): void;
}): LayoutStackDrillInOutcome {
  const {
    file: fileCompositionControl,
    diff: diffCompositionControl,
    evidence: evidenceCompositionControl,
  } = controls;
  const codingOccurrence = entries.find(
    (candidate) =>
      candidate.instance &&
      isWorkspacePaneInstanceOwnedByProject(candidate.instance, projectId) &&
      isCanonicalBuiltinCodingOccurrence(
        candidate.instance,
        candidate.descriptor,
      ),
  );
  const entry = entries.find(
    (candidate) =>
      candidate.instance &&
      candidate.availability.state === 'available' &&
      isWorkspacePaneInstanceOwnedByProject(candidate.instance, projectId) &&
      isCanonicalBuiltinCodingOccurrence(
        candidate.instance,
        candidate.descriptor,
      ),
  );
  const filePreviewEntry = entries.find(
    (candidate) =>
      candidate.descriptor.id === WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR_ID &&
      candidate.availability.state === 'available' &&
      isCanonicalBuiltinFilePreviewDescriptor(candidate.descriptor),
  );
  // The Browser pane's catalogue entry, whether or not the server issued
  // its per-Project occurrence (#90 wave 2 issues one for the Add-pane grid).
  const browserPreviewEntry = entries.find(
    (candidate) =>
      candidate.descriptor.id ===
        WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR_ID &&
      isCanonicalBuiltinBrowserPreviewDescriptor(candidate.descriptor),
  );
  const fileBrowserEntry = entries.find(
    (candidate) =>
      candidate.instance &&
      candidate.descriptor.id ===
        WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR_ID &&
      candidate.instance.boundContext?.projectId === projectId &&
      isCanonicalWorkspaceCodingFileBrowserPaneInstance(candidate.instance) &&
      isCanonicalBuiltinCodingFileBrowserDescriptor(candidate.descriptor),
  );
  const diffEntry = entries.find(
    (candidate) =>
      candidate.instance &&
      candidate.descriptor.id === WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR_ID &&
      candidate.instance.boundContext?.projectId === projectId &&
      isCanonicalWorkspaceCodingDiffPaneInstance(candidate.instance) &&
      isCanonicalBuiltinCodingDiffDescriptor(candidate.descriptor),
  );
  const terminalEntry = entries.find(
    (candidate) =>
      candidate.instance &&
      candidate.descriptor.id ===
        WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR_ID &&
      candidate.instance.boundContext?.projectId === projectId &&
      isCanonicalWorkspaceCodingTerminalPaneInstance(candidate.instance) &&
      isCanonicalBuiltinCodingTerminalDescriptor(candidate.descriptor),
  );
  const planEntry = registeredEntries.find(
    (candidate) =>
      candidate.instance &&
      candidate.descriptor.id === WORKSPACE_PLAN_PANE_DESCRIPTOR_ID &&
      candidate.instance.boundContext?.projectId === projectId &&
      isCanonicalWorkspacePlanPaneInstance(candidate.instance) &&
      isCanonicalBuiltinPlanDescriptor(candidate.descriptor),
  );
  const readinessEntry = registeredEntries.find(
    (candidate) =>
      candidate.instance &&
      candidate.descriptor.id === WORKSPACE_READINESS_PANE_DESCRIPTOR_ID &&
      candidate.instance.boundContext?.projectId === projectId &&
      isCanonicalWorkspaceReadinessPaneInstance(candidate.instance) &&
      isCanonicalBuiltinReadinessDescriptor(candidate.descriptor),
  );
  const trustEntry = registeredEntries.find(
    (candidate) =>
      candidate.instance &&
      candidate.descriptor.id === WORKSPACE_TRUST_PANE_DESCRIPTOR_ID &&
      candidate.instance.boundContext?.projectId === projectId &&
      isCanonicalWorkspaceTrustPaneInstance(candidate.instance) &&
      isCanonicalBuiltinTrustDescriptor(candidate.descriptor),
  );

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
    return {
      state: 'blocked',
      notice: (
        <ErrorState
          title="Coding workspace unavailable"
          description={
            unavailablePresentation?.reasonLabel ??
            'Station could not find an available Coding pane for this Project.'
          }
          action={
            unavailablePresentation?.reviewExtensions ? (
              <StationExtensionsAccess onlyWhenOff />
            ) : (
              <button type="button" onClick={onRetry}>
                Retry
              </button>
            )
          }
        />
      ),
    };
  }
  const codingInstance = bind(entry.instance);
  const fileBrowserInstance = fileBrowserEntry?.instance
    ? bind(fileBrowserEntry.instance)
    : undefined;
  const diffInstance = diffEntry?.instance
    ? bind(diffEntry.instance)
    : undefined;
  const terminalInstance = terminalEntry?.instance
    ? bind(terminalEntry.instance)
    : undefined;
  const planInstance = planEntry?.instance
    ? bind(planEntry.instance)
    : undefined;
  const readinessInstance = readinessEntry?.instance
    ? bind(readinessEntry.instance)
    : undefined;
  const trustInstance = trustEntry?.instance
    ? bind(trustEntry.instance)
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
    return {
      state: 'blocked',
      notice: (
        <ErrorState
          title="Coding workspace unavailable"
          description="Station could not bind its pane occurrences to this layout."
        />
      ),
    };
  }
  const fileComposition =
    fileBrowserEntry &&
    fileBrowserInstance &&
    fileCompositionControl !== 'legacy'
      ? selectCodingFileComposition({
          control: fileCompositionControl,
          projectId,
          layoutId,
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
    return {
      state: 'blocked',
      notice: (
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
      ),
    };
  }
  const selectedFileBrowserInstance =
    fileComposition?.instance ?? fileBrowserInstance;
  const diffComposition =
    diffEntry && diffInstance && diffCompositionControl !== 'legacy'
      ? selectCodingDiffComposition({
          control: diffCompositionControl,
          projectId,
          layoutId,
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
    return {
      state: 'blocked',
      notice: (
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
      ),
    };
  }
  const selectedDiffInstance = diffComposition?.instance ?? diffInstance;
  const evidenceEntries = [
    ['plan', planEntry, developerFeatures.flow],
    ['readiness', readinessEntry, developerFeatures.readiness],
    ['trust', trustEntry, developerFeatures.trust],
  ] as const;
  const enabledEvidenceEntries = evidenceEntries.filter(
    ([, , enabled]) => enabled,
  );
  const admittedEvidenceEntries = enabledEvidenceEntries.filter(
    ([, candidate]) => candidate?.instance,
  );
  const evidenceCompositionActive =
    evidenceCompositionControl !== 'legacy' &&
    enabledEvidenceEntries.length > 0;
  const evidenceComposition =
    evidenceCompositionActive && admittedEvidenceEntries.length > 0
      ? selectCodingEvidenceComposition({
          control: evidenceCompositionControl,
          projectId,
          layoutId,
          panes: admittedEvidenceEntries.map(([category, candidate]) => ({
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
  const evidenceCompositionReceipts = [
    ...(evidenceComposition?.receipts ?? []),
    ...(evidenceCompositionActive
      ? enabledEvidenceEntries
          .filter(([, candidate]) => !candidate?.instance)
          .map(([category]) => ({
            category,
            control: evidenceCompositionControl,
            outcome: 'unavailable' as const,
            restorationIdentityMatched: false,
            fallbackUsed: false as const,
            reason: 'descriptor-incompatible' as const,
          }))
      : []),
  ];
  const evidenceCompositionUnavailable =
    evidenceCompositionActive &&
    (!evidenceComposition?.document ||
      admittedEvidenceEntries.length !== enabledEvidenceEntries.length);
  const selectedEvidence = (descriptorId: string) =>
    evidenceComposition?.instances.find(
      (instance) => instance.descriptorId === descriptorId,
    );
  const selectedPlanInstance = !developerFeatures.flow
    ? undefined
    : evidenceCompositionControl === 'legacy'
      ? planInstance
      : selectedEvidence(WORKSPACE_PLAN_PANE_DESCRIPTOR_ID);
  const selectedReadinessInstance = !developerFeatures.readiness
    ? undefined
    : evidenceCompositionControl === 'legacy'
      ? readinessInstance
      : selectedEvidence(WORKSPACE_READINESS_PANE_DESCRIPTOR_ID);
  const selectedTrustInstance = !developerFeatures.trust
    ? undefined
    : evidenceCompositionControl === 'legacy'
      ? trustInstance
      : selectedEvidence(WORKSPACE_TRUST_PANE_DESCRIPTOR_ID);
  // The Coding occurrence gates the host (above) but is not one of its panes:
  // the layout's Chat position is the stack's Chat page (`CodingWorkbench`).
  // A document persisted before the stack still lists it; the host's restore
  // drops an occurrence its catalog no longer issues and prunes the group it
  // leaves empty, keeping every other pane and its state
  // (`restoreWorkspacePaneHostDocument`), so the stored id is reused as is.
  const instances = [
    ...(selectedFileBrowserInstance ? [selectedFileBrowserInstance] : []),
    ...(selectedDiffInstance ? [selectedDiffInstance] : []),
    ...(terminalInstance ? [terminalInstance] : []),
    ...(selectedPlanInstance ? [selectedPlanInstance] : []),
    ...(selectedReadinessInstance ? [selectedReadinessInstance] : []),
    ...(selectedTrustInstance ? [selectedTrustInstance] : []),
  ];
  // A pane whose occurrence the catalog lookup misses (a composition's own
  // instance) still draws with its entry's descriptor.
  const descriptorEntries = [
    entry,
    fileBrowserEntry,
    diffEntry,
    terminalEntry,
    planEntry,
    readinessEntry,
    trustEntry,
    filePreviewEntry,
    browserPreviewEntry,
  ];
  return {
    state: 'ready',
    drillIns: {
      instances,
      ...(terminalInstance ? { terminal: terminalInstance } : {}),
      descriptorFor: (descriptorId) =>
        descriptorEntries.find(
          (candidate) => candidate?.descriptor.id === descriptorId,
        )?.descriptor ?? null,
      occurrenceDescriptorId: entry.descriptor.id,
      ...(browserPreviewEntry
        ? { browserPreviewAvailability: browserPreviewEntry.availability }
        : {}),
      notices: (
        <>
          {fileCompositionReceipt ? (
            <CodingFileCompositionReceiptTracker
              receipt={fileCompositionReceipt}
            />
          ) : null}
          {diffCompositionReceipt ? (
            <CodingDiffCompositionReceiptTracker
              receipt={diffCompositionReceipt}
            />
          ) : null}
          {evidenceCompositionUnavailable && (
            <ErrorState
              title="Experimental evidence panes unavailable"
              description="Some opted-in tools could not be admitted. Your Coding workspace remains available."
            />
          )}
          {evidenceCompositionReceipts.map((receipt) => (
            <CodingEvidenceCompositionReceiptTracker
              key={`${receipt.category}:${receipt.outcome}:${receipt.reason ?? 'none'}`}
              receipt={receipt}
            />
          ))}
          {(evidenceComposition?.unavailablePanes ?? [])
            .filter((unavailable) =>
              unavailable.category === 'plan'
                ? developerFeatures.flow
                : unavailable.category === 'readiness'
                  ? developerFeatures.readiness
                  : developerFeatures.trust,
            )
            .map((unavailable) => (
              <Empty
                key={unavailable.category}
                {...codingEvidenceUnavailableCopy(unavailable)}
              />
            ))}
        </>
      ),
    },
  };
}
