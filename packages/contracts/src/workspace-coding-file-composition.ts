import { WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR_ID } from './workspace-coding-panels.js';
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

export type CodingFileCompositionControl = 'legacy' | 'compare' | 'composition';

export interface CodingFileCompositionReceipt {
  control: CodingFileCompositionControl;
  outcome: 'legacy-selected' | 'composition-selected' | 'unavailable';
  restorationIdentityMatched: boolean;
  fallbackUsed: false;
  reason?:
    | 'invalid-admission'
    | 'capability-unavailable'
    | 'descriptor-incompatible';
}

export interface CodingFileCompositionSelection {
  document: WorkspacePaneHostDocumentV1 | null;
  instance: WorkspacePaneInstance | null;
  receipt: CodingFileCompositionReceipt;
}

export function selectCodingFileComposition(input: {
  control: CodingFileCompositionControl;
  projectId: string;
  layoutId: string;
  descriptor: WorkspacePaneDescriptor;
  catalogInstance: WorkspacePaneInstance;
  fileReadGrant: 'granted' | 'denied';
  fileReadAvailability: 'available' | 'unavailable';
}): CodingFileCompositionSelection {
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
  if (!admitted || !declared) {
    return unavailable(input.control, 'invalid-admission');
  }
  const result = instantiateWorkspaceComposition({
    spec: {
      version: WORKSPACE_COMPOSITION_SPEC_VERSION,
      id: 'coding-file-browser',
      name: 'Coding file browser composition',
      requiredCapabilities: [
        { id: 'workspace.files.read', context: 'workspace', grant: 'required' },
      ],
      optionalCapabilities: [],
      panes: [
        {
          role: 'navigation',
          instance: declared,
          requiredCapabilities: ['workspace.files.read'],
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
        id: 'workspace.files.read',
        context: 'workspace',
        available: input.fileReadAvailability === 'available',
        granted: input.fileReadGrant === 'granted',
      },
    ],
    admittedInstances: [admitted],
  });
  const instance = result.document?.instances[0];
  if (!instance) {
    return unavailable(
      input.control,
      result.failure?.code === 'required-capability-unavailable'
        ? 'capability-unavailable'
        : 'descriptor-incompatible',
    );
  }
  return {
    document: result.document,
    instance,
    receipt: {
      control: input.control,
      outcome: 'composition-selected',
      restorationIdentityMatched:
        instance.instanceId === input.catalogInstance.instanceId &&
        instance.stateKey === input.catalogInstance.stateKey,
      fallbackUsed: false,
    },
  };
}

function unavailable(
  control: Exclude<CodingFileCompositionControl, 'legacy'>,
  reason: NonNullable<CodingFileCompositionReceipt['reason']>,
): CodingFileCompositionSelection {
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

export function isCodingFileBrowserDescriptor(
  descriptor: WorkspacePaneDescriptor,
): boolean {
  return descriptor.id === WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR_ID;
}

export function resolveBuiltinCodingFileReadGrant(
  descriptor: WorkspacePaneDescriptor,
): 'granted' | 'denied' {
  return descriptor.id === WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR_ID &&
    descriptor.provenance.origin === 'builtin'
    ? 'granted'
    : 'denied';
}
