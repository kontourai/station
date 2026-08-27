import { WORKSPACE_BASIS_PANE_DESCRIPTOR } from '@kontourai/station-basis-pane/workspace-basis-pane';
import { WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-browser-preview';
import {
  createWorkspaceChatPaneInstance,
  WORKSPACE_CHAT_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-chat-pane';
import {
  createWorkspaceCodingDiffPaneInstance,
  createWorkspaceCodingFileBrowserPaneInstance,
  createWorkspaceCodingTerminalPaneInstance,
  WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
  WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
  WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-coding-panels';
import {
  createWorkspacePlanPaneInstance,
  createWorkspaceReadinessPaneInstance,
  createWorkspaceTrustPaneInstance,
  WORKSPACE_PLAN_PANE_DESCRIPTOR,
  WORKSPACE_READINESS_PANE_DESCRIPTOR,
  WORKSPACE_TRUST_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-evidence-panels';
import { WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-file-preview';
import {
  parseWorkspacePaneDescriptor,
  WORKSPACE_PANE_CONTRACT_VERSION,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import type { WorkspacePaneAvailabilityInput } from '@kontourai/station-contracts/workspace-pane-availability';
import {
  createWorkspacePaneCatalog,
  type WorkspacePaneCatalog,
} from '@kontourai/station-contracts/workspace-pane-layout-adapter';
import {
  createWorkspaceSpatialBoardPaneInstance,
  WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-spatial-board';

/**
 * A known declaration describes an addressable pane even before a host has
 * placed an occurrence. Preview panes deliberately have no instances here:
 * an instance is a real placement, not a synonym for a descriptor.
 */
export interface KnownWorkspacePaneDeclaration {
  descriptor: WorkspacePaneDescriptor;
  /** Server-authoritative facts that must not be inferred from a renderer ref. */
  availabilityInput: WorkspacePaneAvailabilityInput;
  /** Fixed built-ins can issue one exact Project-bound occurrence. */
  createInstance?(projectId: string): WorkspacePaneInstance | null;
}

function declaration(
  value: unknown,
  availabilityInput: WorkspacePaneAvailabilityInput,
  createInstance?: (projectId: string) => WorkspacePaneInstance | null,
): KnownWorkspacePaneDeclaration {
  const descriptor = parseWorkspacePaneDescriptor(value);
  if (!descriptor) {
    throw new Error('Invalid built-in Workspace Pane declaration');
  }
  return Object.freeze({ descriptor, availabilityInput, createInstance });
}

/**
 * Built-ins that Station can name before a host-placement owner wires their
 * arguments and occurrence lifecycle. `coming-soon` is intentionally the
 * only availability fact: it does not imply distribution, host, renderer,
 * configuration, health, or execution readiness.
 */
export const KNOWN_WORKSPACE_PANE_DECLARATIONS = Object.freeze([
  declaration(WORKSPACE_BASIS_PANE_DESCRIPTOR, {
    rollout: 'available',
    distribution: 'enabled',
    context: { project: 'present' },
  }),
  declaration(
    WORKSPACE_CHAT_PANE_DESCRIPTOR,
    {
      rollout: 'available',
      distribution: 'enabled',
      context: { project: 'present' },
    },
    createWorkspaceChatPaneInstance,
  ),
  declaration(WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR, {
    rollout: 'available',
    distribution: 'enabled',
    context: { project: 'present' },
  }),
  declaration(WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR, {
    rollout: 'available',
    distribution: 'enabled',
    context: { project: 'present' },
    requirements: {
      hostCapabilities: ['local-browser-preview'],
      configuration: true,
    },
  }),
  declaration(
    WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
    {
      rollout: 'available',
      distribution: 'enabled',
      context: { project: 'present' },
    },
    createWorkspaceCodingFileBrowserPaneInstance,
  ),
  declaration(
    WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
    {
      rollout: 'available',
      distribution: 'enabled',
      context: { project: 'present' },
      requirements: { gitRepository: true },
    },
    createWorkspaceCodingDiffPaneInstance,
  ),
  declaration(
    WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
    {
      rollout: 'available',
      distribution: 'enabled',
      context: { project: 'present' },
    },
    createWorkspaceCodingTerminalPaneInstance,
  ),
  declaration(
    WORKSPACE_PLAN_PANE_DESCRIPTOR,
    {
      rollout: 'available',
      distribution: 'enabled',
      context: { project: 'present' },
    },
    createWorkspacePlanPaneInstance,
  ),
  declaration(
    WORKSPACE_READINESS_PANE_DESCRIPTOR,
    {
      rollout: 'available',
      distribution: 'enabled',
      context: { project: 'present' },
    },
    createWorkspaceReadinessPaneInstance,
  ),
  declaration(
    WORKSPACE_TRUST_PANE_DESCRIPTOR,
    {
      rollout: 'available',
      distribution: 'enabled',
      context: { project: 'present' },
    },
    createWorkspaceTrustPaneInstance,
  ),
  declaration(
    WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR,
    {
      rollout: 'available',
      distribution: 'enabled',
      context: { project: 'present' },
    },
    createWorkspaceSpatialBoardPaneInstance,
  ),
  declaration(
    {
      version: WORKSPACE_PANE_CONTRACT_VERSION,
      id: 'pane:builtin:workspace-preview:flow-run-console',
      name: 'Flow Run Console',
      description: 'Inspect Flow run, gate, and evidence state for a Project.',
      rendererId: 'renderer:builtin:builtin-component:flow-run-console',
      renderer: { kind: 'builtin-component', name: 'flow-run-console' },
      placement: {
        supportedRegions: ['primary', 'secondary', 'standalone'],
        preferredRegion: 'secondary',
      },
      modes: [{ id: 'default', contextRequirement: { project: true } }],
      provenance: { origin: 'builtin' },
      lifecycle: { stage: 'preview' },
    },
    { rollout: 'coming-soon' },
  ),
]);

/**
 * Fixed product panes receive one code-owned occurrence per Project. Dynamic
 * preview descriptors deliberately remain instance-free until a caller has
 * supplied their bounded state and the host has accepted placement.
 *
 * Chat appears here AND in the shell's ambient dock (station#3970): a Project
 * layout places the Project-bound occurrence, the dock places the projectless
 * one, and both are canonical. Removing it from this catalog would have taken
 * Chat out of every Project layout to give the dock one.
 */
export function knownWorkspacePaneInstances(
  projectId: string,
  knownDeclarations: readonly KnownWorkspacePaneDeclaration[] = KNOWN_WORKSPACE_PANE_DECLARATIONS,
): WorkspacePaneInstance[] {
  return knownDeclarations.flatMap((declaration) => {
    const instance = declaration.createInstance?.(projectId);
    return instance ? [instance] : [];
  });
}

/**
 * Only these fixed product-owned identifiers may appear in metric labels.
 * Every other descriptor is contributor-controlled and is reported as the
 * single bounded `contributed` category.
 */
export function workspacePaneAvailabilityMetricDescriptor(
  descriptorId: string,
): string {
  return KNOWN_WORKSPACE_PANE_DECLARATIONS.some(
    (declaration) => declaration.descriptor.id === descriptorId,
  )
    ? descriptorId
    : 'contributed';
}

/**
 * Catalog construction is the single structural identity gate. Equal
 * declarations are deduplicated, while a reused ID with any divergent
 * renderer, provenance, or requirement fails loudly.
 */
export function mergeKnownWorkspacePaneDescriptors(
  layoutDescriptors: Iterable<WorkspacePaneDescriptor>,
  knownDeclarations: readonly KnownWorkspacePaneDeclaration[] = KNOWN_WORKSPACE_PANE_DECLARATIONS,
): WorkspacePaneCatalog {
  return createWorkspacePaneCatalog({
    descriptors: [
      ...layoutDescriptors,
      ...knownDeclarations.map((declaration) => declaration.descriptor),
    ],
  });
}
