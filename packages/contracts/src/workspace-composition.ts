import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_REGIONS,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
  type WorkspacePaneRegion,
} from './workspace-pane.js';
import {
  parseWorkspacePaneHostDocument,
  WORKSPACE_PANE_HOST_DOCUMENT_VERSION,
  type WorkspacePaneHostDocumentV1,
  type WorkspacePaneHostNode,
  type WorkspacePaneHostScope,
} from './workspace-pane-host.js';

export const WORKSPACE_COMPOSITION_SPEC_VERSION = '1.0' as const;
export const MAX_WORKSPACE_COMPOSITION_PANES = 24;
export const MAX_WORKSPACE_COMPOSITION_CAPABILITIES = 32;
const MAX_ID_LENGTH = 96;
const MAX_NAME_LENGTH = 160;
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

export type WorkspaceCompositionPaneRole =
  | 'navigation'
  | 'content'
  | 'auxiliary'
  | 'inspector';

const ROLES: readonly WorkspaceCompositionPaneRole[] = [
  'navigation',
  'content',
  'auxiliary',
  'inspector',
];

/**
 * A pane inside a pane host is never docked, so this is the region vocabulary
 * minus the shell-region word rather than a second list that could drift.
 */
export type WorkspacePaneHostRegion = Exclude<WorkspacePaneRegion, 'docked'>;

const PANE_HOST_REGIONS: readonly WorkspacePaneHostRegion[] =
  WORKSPACE_PANE_REGIONS.filter(
    (region): region is WorkspacePaneHostRegion => region !== 'docked',
  );

export interface WorkspaceCompositionCapabilityRequirement {
  id: string;
  context: 'project' | 'task' | 'session' | 'workspace';
  grant: 'required';
}

export interface WorkspaceCompositionPaneSpec {
  role: WorkspaceCompositionPaneRole;
  instance: WorkspacePaneInstance;
  requiredCapabilities: string[];
  optionalCapabilities: string[];
  placement: {
    region: WorkspacePaneHostRegion;
    order: number;
    splitOrientation: 'horizontal' | 'vertical';
  };
}

export interface WorkspaceCompositionSpec {
  version: typeof WORKSPACE_COMPOSITION_SPEC_VERSION;
  id: string;
  name: string;
  requiredCapabilities: WorkspaceCompositionCapabilityRequirement[];
  optionalCapabilities: WorkspaceCompositionCapabilityRequirement[];
  panes: WorkspaceCompositionPaneSpec[];
}

export interface WorkspaceCompositionCapabilityState {
  id: string;
  context: WorkspaceCompositionCapabilityRequirement['context'];
  available: boolean;
  granted: boolean;
}

export type WorkspaceCompositionInstantiationFailure =
  | { code: 'invalid-spec' }
  | { code: 'invalid-scope' }
  | { code: 'missing-descriptor'; descriptorId: string }
  | { code: 'required-capability-unavailable'; capabilityId: string };

export interface WorkspaceCompositionInstantiationResult {
  document: WorkspacePaneHostDocumentV1 | null;
  degradedCapabilities: string[];
  omittedInstanceIds: string[];
  failure?: WorkspaceCompositionInstantiationFailure;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (descriptor) =>
        descriptor.get === undefined && descriptor.set === undefined,
    );
  } catch {
    return false;
  }
}

function boundedId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    ID_PATTERN.test(value)
  );
}

function parseRequirement(
  value: unknown,
): WorkspaceCompositionCapabilityRequirement | null {
  if (!plainRecord(value) || !boundedId(value.id)) return null;
  if (
    value.context !== 'project' &&
    value.context !== 'task' &&
    value.context !== 'session' &&
    value.context !== 'workspace'
  ) {
    return null;
  }
  if (value.grant !== 'required') return null;
  return { id: value.id, context: value.context, grant: 'required' };
}

function parseRequirements(
  value: unknown,
): WorkspaceCompositionCapabilityRequirement[] | null {
  if (
    !Array.isArray(value) ||
    value.length > MAX_WORKSPACE_COMPOSITION_CAPABILITIES
  ) {
    return null;
  }
  const parsed = value.map(parseRequirement);
  if (parsed.some((entry) => entry === null)) return null;
  const requirements = parsed as WorkspaceCompositionCapabilityRequirement[];
  if (
    new Set(requirements.map((entry) => entry.id)).size !== requirements.length
  ) {
    return null;
  }
  return requirements;
}

function parseCapabilityIds(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > MAX_WORKSPACE_COMPOSITION_CAPABILITIES
  ) {
    return null;
  }
  if (!value.every(boundedId) || new Set(value).size !== value.length)
    return null;
  return [...value];
}

function parsePane(value: unknown): WorkspaceCompositionPaneSpec | null {
  if (
    !plainRecord(value) ||
    !ROLES.includes(value.role as WorkspaceCompositionPaneRole)
  ) {
    return null;
  }
  const instance = parseWorkspacePaneInstance(value.instance);
  const requiredCapabilities = parseCapabilityIds(value.requiredCapabilities);
  const optionalCapabilities = parseCapabilityIds(value.optionalCapabilities);
  const placement = value.placement;
  if (
    !instance ||
    !requiredCapabilities ||
    !optionalCapabilities ||
    requiredCapabilities.some((id) => optionalCapabilities.includes(id)) ||
    !plainRecord(placement) ||
    !PANE_HOST_REGIONS.includes(placement.region as WorkspacePaneHostRegion) ||
    !Number.isSafeInteger(placement.order) ||
    (placement.order as number) < 0 ||
    (placement.order as number) > MAX_WORKSPACE_COMPOSITION_PANES ||
    (placement.splitOrientation !== 'horizontal' &&
      placement.splitOrientation !== 'vertical')
  ) {
    return null;
  }
  return {
    role: value.role as WorkspaceCompositionPaneRole,
    instance,
    requiredCapabilities,
    optionalCapabilities,
    placement: {
      region: placement.region as WorkspacePaneHostRegion,
      order: placement.order as number,
      splitOrientation: placement.splitOrientation,
    },
  };
}

export function parseWorkspaceCompositionSpec(
  value: unknown,
): WorkspaceCompositionSpec | null {
  if (
    !plainRecord(value) ||
    value.version !== WORKSPACE_COMPOSITION_SPEC_VERSION
  ) {
    return null;
  }
  if (
    !boundedId(value.id) ||
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    value.name !== value.name.trim() ||
    value.name.length > MAX_NAME_LENGTH
  ) {
    return null;
  }
  const requiredCapabilities = parseRequirements(value.requiredCapabilities);
  const optionalCapabilities = parseRequirements(value.optionalCapabilities);
  if (
    !requiredCapabilities ||
    !optionalCapabilities ||
    requiredCapabilities.some((entry) =>
      optionalCapabilities.some((optional) => optional.id === entry.id),
    ) ||
    !Array.isArray(value.panes) ||
    value.panes.length === 0 ||
    value.panes.length > MAX_WORKSPACE_COMPOSITION_PANES
  ) {
    return null;
  }
  const panes = value.panes.map(parsePane);
  if (panes.some((pane) => pane === null)) return null;
  const normalizedPanes = panes as WorkspaceCompositionPaneSpec[];
  const declaredCapabilityIds = new Set([
    ...requiredCapabilities.map((entry) => entry.id),
    ...optionalCapabilities.map((entry) => entry.id),
  ]);
  if (
    normalizedPanes.some((pane) =>
      [...pane.requiredCapabilities, ...pane.optionalCapabilities].some(
        (id) => !declaredCapabilityIds.has(id),
      ),
    )
  ) {
    return null;
  }
  const instances = normalizedPanes.map((pane) => pane.instance);
  if (
    new Set(instances.map((entry) => entry.instanceId)).size !==
      instances.length ||
    new Set(instances.map((entry) => entry.stateKey)).size !== instances.length
  ) {
    return null;
  }
  return {
    version: WORKSPACE_COMPOSITION_SPEC_VERSION,
    id: value.id,
    name: value.name,
    requiredCapabilities,
    optionalCapabilities,
    panes: normalizedPanes,
  };
}

function capabilityUsable(
  requirement: WorkspaceCompositionCapabilityRequirement,
  states: ReadonlyMap<string, WorkspaceCompositionCapabilityState>,
): boolean {
  const state = states.get(requirement.id);
  return (
    state?.context === requirement.context &&
    state.available === true &&
    state.granted === true
  );
}

function instanceMatchesScopeAndDescriptor(
  instance: WorkspacePaneInstance,
  scope: WorkspacePaneHostScope,
  descriptor: WorkspacePaneDescriptor,
): boolean {
  const context = instance.boundContext;
  // An ambient host supplies no Project identity, so it neither matches an
  // instance bound to one nor satisfies a descriptor that requires one.
  const scopeProjectId = scope.kind === 'ambient' ? undefined : scope.projectId;
  if (
    context?.projectId !== undefined &&
    context.projectId !== scopeProjectId
  ) {
    return false;
  }
  if (
    context?.taskId !== undefined &&
    (scope.kind !== 'task' || context.taskId !== scope.taskId)
  ) {
    return false;
  }
  // Every descriptor is mechanically single-mode in this slice. Per-mode
  // admission awaits an occurrence-level mode binding.
  const requirement = descriptor.modes[0].contextRequirement;
  if (!requirement) return true;
  if (
    requirement.project &&
    (scopeProjectId === undefined || context?.projectId !== scopeProjectId)
  )
    return false;
  if (
    requirement.task &&
    (scope.kind !== 'task' || context?.taskId !== scope.taskId)
  ) {
    return false;
  }
  if (requirement.session && context?.sessionId === undefined) return false;
  if (requirement.workspace && context?.workspaceId === undefined) return false;
  if (requirement.run && context?.runId === undefined) return false;
  if (requirement.source && context?.sourceId === undefined) return false;
  return true;
}

function sameAdmittedInstance(
  declared: WorkspacePaneInstance,
  admitted: WorkspacePaneInstance | undefined,
): boolean {
  if (!admitted) return false;
  return (
    declared.descriptorId === admitted.descriptorId &&
    declared.instanceId === admitted.instanceId &&
    declared.stateKey === admitted.stateKey &&
    JSON.stringify(declared.boundContext ?? null) ===
      JSON.stringify(admitted.boundContext ?? null)
  );
}

function invalidInstantiation(): WorkspaceCompositionInstantiationResult {
  return {
    document: null,
    degradedCapabilities: [],
    omittedInstanceIds: [],
    failure: { code: 'invalid-spec' },
  };
}

export function instantiateWorkspaceComposition(
  value: unknown,
): WorkspaceCompositionInstantiationResult {
  if (!plainRecord(value)) {
    return invalidInstantiation();
  }
  const input = value;
  if (
    !plainRecord(input.scope) ||
    (input.scope.kind !== 'project' && input.scope.kind !== 'task') ||
    typeof input.scope.projectId !== 'string' ||
    typeof input.scope.layoutId !== 'string' ||
    (input.scope.kind === 'task' && typeof input.scope.taskId !== 'string') ||
    !Array.isArray(input.descriptors) ||
    !Array.isArray(input.capabilityStates) ||
    !Array.isArray(input.admittedInstances)
  ) {
    return invalidInstantiation();
  }
  const scope = input.scope as unknown as WorkspacePaneHostScope;
  const spec = parseWorkspaceCompositionSpec(input.spec);
  if (!spec)
    return {
      document: null,
      degradedCapabilities: [],
      omittedInstanceIds: [],
      failure: { code: 'invalid-spec' },
    };
  const descriptors = new Map<string, WorkspacePaneDescriptor>();
  if (
    input.descriptors.length > MAX_WORKSPACE_COMPOSITION_PANES ||
    input.admittedInstances.length > MAX_WORKSPACE_COMPOSITION_PANES
  ) {
    return {
      document: null,
      degradedCapabilities: [],
      omittedInstanceIds: [],
      failure: { code: 'invalid-spec' },
    };
  }
  for (const candidate of input.descriptors) {
    const descriptor = parseWorkspacePaneDescriptor(candidate);
    if (!descriptor || descriptors.has(descriptor.id)) {
      return {
        document: null,
        degradedCapabilities: [],
        omittedInstanceIds: [],
        failure: {
          code: 'missing-descriptor',
          descriptorId:
            plainRecord(candidate) && typeof candidate.id === 'string'
              ? candidate.id
              : 'invalid',
        },
      };
    }
    descriptors.set(descriptor.id, descriptor);
  }
  const states = new Map<string, WorkspaceCompositionCapabilityState>();
  if (input.capabilityStates.length > MAX_WORKSPACE_COMPOSITION_CAPABILITIES) {
    return {
      document: null,
      degradedCapabilities: [],
      omittedInstanceIds: [],
      failure: { code: 'invalid-spec' },
    };
  }
  for (const state of input.capabilityStates) {
    if (
      !plainRecord(state) ||
      Object.keys(state).sort().join(',') !== 'available,context,granted,id' ||
      !boundedId(state.id) ||
      (state.context !== 'project' &&
        state.context !== 'task' &&
        state.context !== 'session' &&
        state.context !== 'workspace') ||
      typeof state.available !== 'boolean' ||
      typeof state.granted !== 'boolean' ||
      states.has(state.id)
    ) {
      return {
        document: null,
        degradedCapabilities: [],
        omittedInstanceIds: [],
        failure: { code: 'invalid-spec' },
      };
    }
    states.set(state.id, {
      id: state.id,
      context: state.context,
      available: state.available,
      granted: state.granted,
    } as WorkspaceCompositionCapabilityState);
  }
  const admittedInstances = new Map<string, WorkspacePaneInstance>();
  for (const candidate of input.admittedInstances) {
    const instance = parseWorkspacePaneInstance(candidate);
    if (!instance || admittedInstances.has(instance.instanceId)) {
      return invalidInstantiation();
    }
    admittedInstances.set(instance.instanceId, instance);
  }
  for (const requirement of spec.requiredCapabilities) {
    if (!capabilityUsable(requirement, states)) {
      return {
        document: null,
        degradedCapabilities: [],
        omittedInstanceIds: [],
        failure: {
          code: 'required-capability-unavailable',
          capabilityId: requirement.id,
        },
      };
    }
  }
  const degraded = spec.optionalCapabilities
    .filter((requirement) => !capabilityUsable(requirement, states))
    .map((requirement) => requirement.id);
  const included: WorkspaceCompositionPaneSpec[] = [];
  const omitted: string[] = [];
  const requirements = new Map(
    [...spec.requiredCapabilities, ...spec.optionalCapabilities].map(
      (requirement) => [requirement.id, requirement],
    ),
  );
  for (const pane of spec.panes) {
    const missingRequired = pane.requiredCapabilities.find((id) => {
      const requirement = requirements.get(id);
      return !requirement || !capabilityUsable(requirement, states);
    });
    if (missingRequired) {
      return {
        document: null,
        degradedCapabilities: degraded,
        omittedInstanceIds: omitted,
        failure: {
          code: 'required-capability-unavailable',
          capabilityId: missingRequired,
        },
      };
    }
    const missingOptional = pane.optionalCapabilities.filter((id) => {
      const requirement = requirements.get(id);
      return !requirement || !capabilityUsable(requirement, states);
    });
    if (missingOptional.length > 0) {
      degraded.push(...missingOptional);
      omitted.push(pane.instance.instanceId);
      continue;
    }
    const descriptor = descriptors.get(pane.instance.descriptorId);
    if (
      !descriptor?.placement.supportedRegions.includes(pane.placement.region) ||
      !instanceMatchesScopeAndDescriptor(pane.instance, scope, descriptor) ||
      !sameAdmittedInstance(
        pane.instance,
        admittedInstances.get(pane.instance.instanceId),
      )
    ) {
      return {
        document: null,
        degradedCapabilities: degraded,
        omittedInstanceIds: omitted,
        failure: {
          code: 'missing-descriptor',
          descriptorId: pane.instance.descriptorId,
        },
      };
    }
    included.push(pane);
  }
  if (included.length === 0) {
    return {
      document: null,
      degradedCapabilities: [...new Set(degraded)],
      omittedInstanceIds: omitted,
      failure: {
        code: 'required-capability-unavailable',
        capabilityId: 'composition.no-available-pane',
      },
    };
  }
  const groups = ROLES.map((role) => {
    const panes = included
      .filter((pane) => pane.role === role)
      .sort((a, b) => a.placement.order - b.placement.order);
    if (panes.length === 0) return null;
    return {
      role,
      orientation: panes[0].placement.splitOrientation,
      node: {
        type: 'tabs' as const,
        id: `${spec.id}.${role}`,
        instanceIds: panes.map((pane) => pane.instance.instanceId),
        selectedInstanceId: panes[0].instance.instanceId,
      },
    };
  }).filter((entry) => entry !== null);
  let root: WorkspacePaneHostNode = groups[0].node;
  for (let index = 1; index < groups.length; index += 1) {
    const group = groups[index];
    root = {
      type: 'split',
      id: `${spec.id}.split.${index}`,
      orientation: group.orientation,
      ratio: 0.5,
      first: root,
      second: group.node,
    };
  }
  const document = parseWorkspacePaneHostDocument({
    version: WORKSPACE_PANE_HOST_DOCUMENT_VERSION,
    id: `${spec.id}.host`,
    scope,
    instances: included.map((pane) => pane.instance),
    root,
    activeInstanceId: included[0].instance.instanceId,
  });
  if (!document) {
    return {
      document: null,
      degradedCapabilities: [...new Set(degraded)],
      omittedInstanceIds: omitted,
      failure: { code: 'invalid-scope' },
    };
  }
  return {
    document,
    degradedCapabilities: [...new Set(degraded)].sort(),
    omittedInstanceIds: omitted,
  };
}
