import { WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR_ID } from './workspace-coding-panels.js';
import {
  instantiateWorkspaceComposition,
  WORKSPACE_COMPOSITION_SPEC_VERSION,
} from './workspace-composition.js';
import {
  parseWorkspacePaneInstance,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
} from './workspace-pane.js';
import type { WorkspacePaneHostDocumentV1 } from './workspace-pane-host.js';

export type CodingDiffCompositionControl = 'legacy' | 'compare' | 'composition';

export interface CodingDiffCompositionReceipt {
  control: CodingDiffCompositionControl;
  outcome: 'legacy-selected' | 'composition-selected' | 'unavailable';
  restorationIdentityMatched: boolean;
  fallbackUsed: false;
  reason?:
    | 'invalid-admission'
    | 'capability-unavailable'
    | 'descriptor-incompatible'
    | 'comparison-mismatch';
}

export interface CodingDiffCompositionSelection {
  document: WorkspacePaneHostDocumentV1 | null;
  instance: WorkspacePaneInstance | null;
  receipt: CodingDiffCompositionReceipt;
}

export function selectCodingDiffComposition(input: {
  control: CodingDiffCompositionControl;
  projectId: string;
  layoutId: string;
  descriptor: WorkspacePaneDescriptor;
  catalogInstance: WorkspacePaneInstance;
  gitDiffGrant: 'granted' | 'denied';
  gitDiffAvailability: 'available' | 'unavailable';
  comparisonBaseline?: WorkspacePaneInstance;
}): CodingDiffCompositionSelection {
  if (input.control === 'legacy') {
    return {
      document: null,
      instance: input.catalogInstance,
      receipt: {
        control: 'legacy',
        outcome: 'legacy-selected',
        restorationIdentityMatched: true,
        fallbackUsed: false,
      },
    };
  }
  const admitted = parseWorkspacePaneInstance(input.catalogInstance);
  const declared = parseWorkspacePaneInstance({
    version: input.catalogInstance.version,
    descriptorId: input.catalogInstance.descriptorId,
    instanceId: input.catalogInstance.instanceId,
    stateKey: input.catalogInstance.stateKey,
    boundContext: input.catalogInstance.boundContext,
  });
  if (!admitted || !declared)
    return unavailable(input.control, 'invalid-admission');
  const result = instantiateWorkspaceComposition({
    spec: {
      version: WORKSPACE_COMPOSITION_SPEC_VERSION,
      id: 'coding-diff',
      name: 'Coding Diff composition',
      requiredCapabilities: [
        {
          id: 'workspace.git.diff.read',
          context: 'workspace',
          grant: 'required',
        },
      ],
      optionalCapabilities: [],
      panes: [
        {
          role: 'content',
          instance: declared,
          requiredCapabilities: ['workspace.git.diff.read'],
          optionalCapabilities: [],
          placement: {
            region: 'primary',
            order: 0,
            splitOrientation: 'horizontal',
          },
        },
      ],
    },
    scope: {
      kind: 'project',
      projectId: input.projectId,
      layoutId: input.layoutId,
    },
    descriptors: [input.descriptor],
    capabilityStates: [
      {
        id: 'workspace.git.diff.read',
        context: 'workspace',
        available: input.gitDiffAvailability === 'available',
        granted: input.gitDiffGrant === 'granted',
      },
    ],
    admittedInstances: [admitted],
  });
  const instance = result.document?.instances[0];
  if (!instance)
    return unavailable(
      input.control,
      result.failure?.code === 'required-capability-unavailable'
        ? 'capability-unavailable'
        : 'descriptor-incompatible',
    );
  const comparisonBaseline = input.comparisonBaseline ?? input.catalogInstance;
  const restorationIdentityMatched =
    instance.instanceId === comparisonBaseline.instanceId &&
    instance.stateKey === comparisonBaseline.stateKey &&
    instance.descriptorId === comparisonBaseline.descriptorId &&
    JSON.stringify(instance.boundContext) ===
      JSON.stringify(comparisonBaseline.boundContext);
  if (input.control === 'compare' && !restorationIdentityMatched)
    return unavailable('compare', 'comparison-mismatch');
  return {
    document: result.document,
    instance,
    receipt: {
      control: input.control,
      outcome: 'composition-selected',
      restorationIdentityMatched,
      fallbackUsed: false,
    },
  };
}

function unavailable(
  control: Exclude<CodingDiffCompositionControl, 'legacy'>,
  reason: NonNullable<CodingDiffCompositionReceipt['reason']>,
): CodingDiffCompositionSelection {
  return {
    document: null,
    instance: null,
    receipt: {
      control,
      outcome: 'unavailable',
      restorationIdentityMatched: false,
      fallbackUsed: false,
      reason,
    },
  };
}

export function resolveBuiltinCodingGitDiffGrant(
  descriptor: WorkspacePaneDescriptor,
): 'granted' | 'denied' {
  return descriptor.id === WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR_ID &&
    descriptor.provenance.origin === 'builtin'
    ? 'granted'
    : 'denied';
}
