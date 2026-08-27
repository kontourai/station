import {
  instantiateWorkspaceComposition,
  WORKSPACE_COMPOSITION_SPEC_VERSION,
} from './workspace-composition.js';
import {
  WORKSPACE_PLAN_PANE_DESCRIPTOR_ID,
  WORKSPACE_READINESS_PANE_DESCRIPTOR_ID,
  WORKSPACE_TRUST_PANE_DESCRIPTOR_ID,
} from './workspace-evidence-panels.js';
import {
  parseWorkspacePaneInstance,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
} from './workspace-pane.js';
import type { WorkspacePaneHostDocumentV1 } from './workspace-pane-host.js';

export type CodingEvidenceCompositionControl =
  | 'legacy'
  | 'compare'
  | 'composition';
export type CodingEvidencePaneCategory = 'plan' | 'readiness' | 'trust';

export interface CodingEvidencePaneInput {
  category: CodingEvidencePaneCategory;
  descriptor: WorkspacePaneDescriptor;
  catalogInstance: WorkspacePaneInstance;
  grant: 'granted' | 'denied';
  availability: 'available' | 'unavailable';
}

/**
 * Why one evidence pane was left out while its siblings mounted. `availability`
 * and `grant` arrive as separate inputs and stay separate here: they are
 * different problems for whoever reads the result — a capability this Station
 * cannot reach at all versus a pane that is not granted one it can (#3158).
 */
export type CodingEvidencePaneUnavailableReason =
  | 'capability-unavailable'
  | 'grant-denied'
  | 'capability-unavailable-and-grant-denied';

export interface CodingEvidencePaneUnavailability {
  category: CodingEvidencePaneCategory;
  reason: CodingEvidencePaneUnavailableReason;
}

export interface CodingEvidenceCompositionReceipt {
  category: 'evidence' | CodingEvidencePaneCategory;
  control: CodingEvidenceCompositionControl;
  outcome: 'legacy-selected' | 'composition-selected' | 'unavailable';
  restorationIdentityMatched: boolean;
  fallbackUsed: false;
  reason?:
    | 'invalid-admission'
    | CodingEvidencePaneUnavailableReason
    | 'descriptor-incompatible'
    | 'comparison-mismatch';
}

export interface CodingEvidenceCompositionSelection {
  document: WorkspacePaneHostDocumentV1 | null;
  instances: readonly WorkspacePaneInstance[];
  receipts: readonly CodingEvidenceCompositionReceipt[];
  unavailablePanes: readonly CodingEvidencePaneUnavailability[];
}

const CAPABILITY = {
  plan: 'workspace.flow.plan.read',
  readiness: 'workspace.veritas.readiness.read',
  trust: 'workspace.surface.trust.read',
} as const;
const DESCRIPTOR = {
  plan: WORKSPACE_PLAN_PANE_DESCRIPTOR_ID,
  readiness: WORKSPACE_READINESS_PANE_DESCRIPTOR_ID,
  trust: WORKSPACE_TRUST_PANE_DESCRIPTOR_ID,
} as const;

export function selectCodingEvidenceComposition(input: {
  control: CodingEvidenceCompositionControl;
  projectId: string;
  layoutId: string;
  panes: readonly CodingEvidencePaneInput[];
  comparisonBaselines?: readonly WorkspacePaneInstance[];
}): CodingEvidenceCompositionSelection {
  if (input.control === 'legacy')
    return {
      document: null,
      instances: input.panes.map((pane) => pane.catalogInstance),
      receipts: [
        {
          category: 'evidence',
          control: 'legacy',
          outcome: 'legacy-selected',
          restorationIdentityMatched: true,
          fallbackUsed: false,
        },
      ],
      unavailablePanes: [],
    };
  if (
    input.panes.length !== 3 ||
    new Set(input.panes.map((pane) => pane.category)).size !== 3
  )
    return unavailable(input.control, 'invalid-admission');
  const declared = input.panes.map((pane) =>
    parseWorkspacePaneInstance(pane.catalogInstance),
  );
  if (declared.some((instance) => !instance))
    return unavailable(input.control, 'invalid-admission');
  const result = instantiateWorkspaceComposition({
    spec: {
      version: WORKSPACE_COMPOSITION_SPEC_VERSION,
      id: 'coding-evidence',
      name: 'Coding evidence composition',
      requiredCapabilities: [],
      optionalCapabilities: input.panes.map((pane) => ({
        id: CAPABILITY[pane.category],
        context: 'workspace' as const,
        grant: 'required' as const,
      })),
      panes: input.panes.map((pane, order) => ({
        role: 'inspector' as const,
        instance: declared[order]!,
        requiredCapabilities: [],
        optionalCapabilities: [CAPABILITY[pane.category]],
        placement: {
          region: 'secondary' as const,
          order,
          splitOrientation: 'vertical' as const,
        },
      })),
    },
    scope: {
      kind: 'project',
      projectId: input.projectId,
      layoutId: input.layoutId,
    },
    descriptors: input.panes.map((pane) => pane.descriptor),
    capabilityStates: input.panes.map((pane) => ({
      id: CAPABILITY[pane.category],
      context: 'workspace',
      available: pane.availability === 'available',
      granted: pane.grant === 'granted',
    })),
    admittedInstances: input.panes.map((pane) => pane.catalogInstance),
  });
  if (!result.document)
    return unavailable(
      input.control,
      result.failure?.code === 'required-capability-unavailable'
        ? 'capability-unavailable'
        : 'descriptor-incompatible',
    );
  // An instance is omitted exactly when its optional capability was not
  // usable, and `capabilityStates` above derives usability from these two
  // fields alone — so the cause is not merely guessable here, it is the
  // input. Report it instead of collapsing both into one word (#3158).
  const unavailablePanes: CodingEvidencePaneUnavailability[] = input.panes
    .filter((pane) =>
      result.omittedInstanceIds.includes(pane.catalogInstance.instanceId),
    )
    .map((pane) => ({
      category: pane.category,
      reason: unavailableReason(pane),
    }));
  const includedPanes = input.panes.filter(
    (pane) =>
      !unavailablePanes.some((entry) => entry.category === pane.category),
  );
  const restorationIdentityMatched = includedPanes.every((pane) => {
    const instance = result.document?.instances.find(
      (candidate) => candidate.instanceId === pane.catalogInstance.instanceId,
    );
    const baseline =
      input.comparisonBaselines?.find(
        (candidate) =>
          candidate.descriptorId === pane.catalogInstance.descriptorId,
      ) ?? pane.catalogInstance;
    return (
      instance?.descriptorId === baseline.descriptorId &&
      instance.stateKey === baseline.stateKey &&
      JSON.stringify(instance.boundContext) ===
        JSON.stringify(baseline.boundContext)
    );
  });
  if (input.control === 'compare' && !restorationIdentityMatched)
    return unavailable('compare', 'comparison-mismatch');
  return {
    document: result.document,
    instances: result.document.instances,
    receipts: [
      {
        category: 'evidence',
        control: input.control,
        outcome: 'composition-selected',
        restorationIdentityMatched,
        fallbackUsed: false,
      },
      ...unavailablePanes.map((entry) => ({
        category: entry.category,
        control: input.control,
        outcome: 'unavailable' as const,
        restorationIdentityMatched: false,
        fallbackUsed: false as const,
        reason: entry.reason,
      })),
    ],
    unavailablePanes,
  };
}

function unavailableReason(
  pane: CodingEvidencePaneInput,
): CodingEvidencePaneUnavailableReason {
  if (pane.availability === 'available') return 'grant-denied';
  return pane.grant === 'granted'
    ? 'capability-unavailable'
    : 'capability-unavailable-and-grant-denied';
}

function unavailable(
  control: Exclude<CodingEvidenceCompositionControl, 'legacy'>,
  reason: NonNullable<CodingEvidenceCompositionReceipt['reason']>,
): CodingEvidenceCompositionSelection {
  return {
    document: null,
    instances: [],
    receipts: [
      {
        category: 'evidence',
        control,
        outcome: 'unavailable',
        restorationIdentityMatched: false,
        fallbackUsed: false,
        reason,
      },
    ],
    unavailablePanes: [],
  };
}

export function resolveBuiltinCodingEvidenceGrant(
  category: CodingEvidencePaneCategory,
  descriptor: WorkspacePaneDescriptor,
): 'granted' | 'denied' {
  return descriptor.id === DESCRIPTOR[category] &&
    descriptor.provenance.origin === 'builtin'
    ? 'granted'
    : 'denied';
}
