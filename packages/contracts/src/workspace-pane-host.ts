// The pane LAYOUT document — splits, tab groups, host scope. Not to be
// confused with `./workspace-pane-host-contract.ts`, which despite the
// near-identical name is the shell CAPABILITY interface a pane calls.
import {
  parseWorkspacePaneInstance,
  type WorkspacePaneInstance,
  type WorkspacePaneInstanceId,
  type WorkspacePaneSuppliableContexts,
} from './workspace-pane.js';
import { MAX_WORKSPACE_PANE_IDENTITY_SEGMENT_LENGTH } from './workspace-pane-layout-adapter-types.js';

/** Serial host state is intentionally separate from descriptor maturity and renderer lifecycle. */
/** v1.1 discards hosts persisted before stable pane layout bindings existed. */
export const WORKSPACE_PANE_HOST_DOCUMENT_VERSION = '1.1' as const;
export const MAX_WORKSPACE_PANE_HOST_PANES = 24;
export const MAX_WORKSPACE_PANE_HOST_TREE_DEPTH = 6;
const MAX_WORKSPACE_PANE_HOST_BOUND_CONTEXT_FIELDS = 7;
const MAX_WORKSPACE_PANE_HOST_DOCUMENT_PROPERTIES = 7;
const MAX_WORKSPACE_PANE_HOST_TASK_SCOPE_PROPERTIES = 4;
const MAX_WORKSPACE_PANE_HOST_INSTANCE_PROPERTIES = 5;
const MAX_WORKSPACE_PANE_HOST_TAB_GROUP_PROPERTIES = 4;
const MAX_WORKSPACE_PANE_HOST_SPLIT_PROPERTIES = 7;
const MAX_WORKSPACE_PANE_HOST_TAB_GROUPS = MAX_WORKSPACE_PANE_HOST_PANES;
const MAX_WORKSPACE_PANE_HOST_SPLITS = MAX_WORKSPACE_PANE_HOST_TAB_GROUPS - 1;
/**
 * Maximum object/property work of an accepted document:
 * document (8) + Task scope (5) + instances array (25) + 24 full instances
 * (24 * (instance 6 + bound context 7)) + 24 tab groups/ID arrays (168) +
 * 23 collapsed splits (184) = 702. A 24-leaf tree can still reach depth six.
 */
export const MAX_WORKSPACE_PANE_HOST_RECOVERY_INPUT_ITEMS =
  1 +
  MAX_WORKSPACE_PANE_HOST_DOCUMENT_PROPERTIES +
  1 +
  MAX_WORKSPACE_PANE_HOST_TASK_SCOPE_PROPERTIES +
  1 +
  MAX_WORKSPACE_PANE_HOST_PANES +
  MAX_WORKSPACE_PANE_HOST_PANES *
    (1 +
      MAX_WORKSPACE_PANE_HOST_INSTANCE_PROPERTIES +
      1 +
      MAX_WORKSPACE_PANE_HOST_BOUND_CONTEXT_FIELDS) +
  MAX_WORKSPACE_PANE_HOST_TAB_GROUPS *
    (1 + MAX_WORKSPACE_PANE_HOST_TAB_GROUP_PROPERTIES) +
  MAX_WORKSPACE_PANE_HOST_TAB_GROUPS +
  MAX_WORKSPACE_PANE_HOST_PANES +
  MAX_WORKSPACE_PANE_HOST_SPLITS *
    (1 + MAX_WORKSPACE_PANE_HOST_SPLIT_PROPERTIES);
export const MIN_WORKSPACE_PANE_SPLIT_RATIO = 0.2;
export const MAX_WORKSPACE_PANE_SPLIT_RATIO = 0.8;

export type WorkspacePaneHostSplitOrientation = 'horizontal' | 'vertical';
export type WorkspacePaneHostCollapsedSide = 'first' | 'second';

/** Exact host scope. Task identity is deliberately not inferred from a route or pane. */
interface WorkspacePaneHostScopeBase {
  projectId: string;
  layoutId: string;
}

export interface ProjectWorkspacePaneHostScope
  extends WorkspacePaneHostScopeBase {
  kind: 'project';
}

export interface TaskWorkspacePaneHostScope extends WorkspacePaneHostScopeBase {
  kind: 'task';
  taskId: string;
}

/**
 * A host owned by the shell itself rather than by a Project or a Task: it has
 * no projectId and no layoutId because there is no such identity to name. Its
 * persistence is therefore per device, not per project — see
 * `workspacePaneHostStorageKey`. Instances placed in an ambient host still
 * carry their own bound context; the scope simply supplies none.
 */
export interface AmbientWorkspacePaneHostScope {
  kind: 'ambient';
}

export type WorkspacePaneHostScope =
  | ProjectWorkspacePaneHostScope
  | TaskWorkspacePaneHostScope
  | AmbientWorkspacePaneHostScope;

/**
 * Context identities each host scope owns and can hand to an occupant. Ambient
 * has no identity; a Project scope binds only its `projectId`; a Task scope
 * additionally binds its exact `taskId`. `layoutId` is host geometry identity,
 * not a pane context, and source/workspace/session/run are occurrence-bound
 * facts rather than fields on these scope types.
 */
export function workspacePaneHostSuppliableContexts(
  scope: WorkspacePaneHostScope,
): WorkspacePaneSuppliableContexts {
  switch (scope.kind) {
    case 'ambient':
      return new Set();
    case 'project':
      return new Set(['project']);
    case 'task':
      return new Set(['project', 'task']);
  }
}

/**
 * The Project a host scope names, or `undefined` when it names none. Every
 * consumer that needs a scope's projectId reads this one derivation rather
 * than reaching for a field two of the three kinds happen to carry.
 */
export function workspacePaneHostScopeProjectId(
  scope: WorkspacePaneHostScope,
): string | undefined {
  return scope.kind === 'ambient' ? undefined : scope.projectId;
}

/** Total scope equality. Every consumer that compares scopes reads this one derivation. */
export function workspacePaneHostScopeMatches(
  left: WorkspacePaneHostScope,
  right: WorkspacePaneHostScope,
): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'ambient':
      return true;
    case 'project':
      return (
        right.kind === 'project' &&
        left.projectId === right.projectId &&
        left.layoutId === right.layoutId
      );
    case 'task':
      return (
        right.kind === 'task' &&
        left.projectId === right.projectId &&
        left.taskId === right.taskId &&
        left.layoutId === right.layoutId
      );
    default: {
      const unreachable: never = left;
      return unreachable;
    }
  }
}

export interface WorkspacePaneHostTabGroup {
  type: 'tabs';
  id: string;
  instanceIds: WorkspacePaneInstanceId[];
  /** Persisted tab selection is group-local; activeInstanceId remains navigation focus. */
  selectedInstanceId?: WorkspacePaneInstanceId;
}

export interface WorkspacePaneHostSplit {
  type: 'split';
  id: string;
  orientation: WorkspacePaneHostSplitOrientation;
  ratio: number;
  collapsed?: WorkspacePaneHostCollapsedSide;
  first: WorkspacePaneHostNode;
  second: WorkspacePaneHostNode;
}

export type WorkspacePaneHostNode =
  | WorkspacePaneHostTabGroup
  | WorkspacePaneHostSplit;

/** A portable, data-only host shell. It never includes native handles or renderer callbacks. */
export interface WorkspacePaneHostDocumentV1 {
  version: typeof WORKSPACE_PANE_HOST_DOCUMENT_VERSION;
  id: string;
  scope: WorkspacePaneHostScope;
  instances: WorkspacePaneInstance[];
  root: WorkspacePaneHostNode;
  activeInstanceId: WorkspacePaneInstanceId;
  maximizedInstanceId?: WorkspacePaneInstanceId;
}

export type WorkspacePaneHostAction =
  | {
      type: 'add-existing-instance';
      instance: WorkspacePaneInstance;
      /** The command surface names the persisted tab group; omission selects the active group. */
      targetGroupId?: string;
    }
  | { type: 'close'; instanceId: WorkspacePaneInstanceId }
  | {
      type: 'reorder';
      instanceId: WorkspacePaneInstanceId;
      toIndex: number;
    }
  | {
      type: 'move';
      instanceId: WorkspacePaneInstanceId;
      targetGroupId: string;
      index?: number;
    }
  | {
      type: 'split';
      instance: WorkspacePaneInstance;
      targetGroupId: string;
      orientation: WorkspacePaneHostSplitOrientation;
      placement: 'before' | 'after';
    }
  | { type: 'resize'; splitId: string; ratio: number }
  | {
      type: 'collapse';
      splitId: string;
      collapsed: WorkspacePaneHostCollapsedSide | undefined;
    }
  | { type: 'select'; instanceId: WorkspacePaneInstanceId }
  | { type: 'maximize'; instanceId: WorkspacePaneInstanceId | undefined }
  | {
      type: 'renderer-failed';
      instanceId: WorkspacePaneInstanceId;
      code: string;
    }
  | { type: 'renderer-retry'; instanceId: WorkspacePaneInstanceId }
  | { type: 'restore'; document: WorkspacePaneHostDocumentV1 };

export interface WorkspacePaneHostRestorationFailure {
  code:
    | 'invalid-document'
    | 'invalid-instance'
    | 'unknown-instance'
    | 'invalid-node'
    | 'orphan-placement'
    | 'empty-group'
    | 'invalid-selection';
  nodeId?: string;
  instanceId?: string;
}

export interface WorkspacePaneHostRestorationResult {
  document: WorkspacePaneHostDocumentV1 | null;
  failures: WorkspacePaneHostRestorationFailure[];
}

function isString(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value === value.trim()
  );
}

export function isWorkspacePaneHostIdentitySegment(
  value: unknown,
): value is string {
  return (
    isString(value) &&
    value.length <= MAX_WORKSPACE_PANE_IDENTITY_SEGMENT_LENGTH
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
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

/** Walk descriptors, rather than values, so an untrusted accessor is never invoked. */
function hasSafeDataGraph(
  value: unknown,
  seen = new Set<object>(),
  budget = { work: 0 },
): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (budget.work >= MAX_WORKSPACE_PANE_HOST_RECOVERY_INPUT_ITEMS)
      return false;
    budget.work += 1;
    if (
      Array.isArray(value) &&
      value.length > MAX_WORKSPACE_PANE_HOST_RECOVERY_INPUT_ITEMS
    )
      return false;
    const prototype = Object.getPrototypeOf(value);
    if (
      (Array.isArray(value) && prototype !== Array.prototype) ||
      (!Array.isArray(value) &&
        prototype !== Object.prototype &&
        prototype !== null)
    )
      return false;
    // Array length is structural metadata rather than a serialized input item.
    // Count every other own key before inspecting any descriptor values.
    const keys = Reflect.ownKeys(value).filter(
      (key) => !Array.isArray(value) || key !== 'length',
    );
    if (
      keys.length > MAX_WORKSPACE_PANE_HOST_RECOVERY_INPUT_ITEMS ||
      budget.work + keys.length > MAX_WORKSPACE_PANE_HOST_RECOVERY_INPUT_ITEMS
    )
      return false;
    budget.work += keys.length;
    return Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (descriptor) =>
        descriptor.get === undefined &&
        descriptor.set === undefined &&
        hasSafeDataGraph(descriptor.value, seen, budget),
    );
  } catch {
    return false;
  } finally {
    seen.delete(value);
  }
}

function parseScope(value: unknown): WorkspacePaneHostScope | null {
  if (!isPlainRecord(value)) return null;
  // An ambient host names no project and no layout, so persistence that
  // carries either is not an ambient document however it labels itself.
  if (value.kind === 'ambient')
    return value.projectId === undefined &&
      value.layoutId === undefined &&
      value.taskId === undefined
      ? { kind: 'ambient' }
      : null;
  if (
    !isWorkspacePaneHostIdentitySegment(value.projectId) ||
    !isWorkspacePaneHostIdentitySegment(value.layoutId)
  ) {
    return null;
  }
  if (value.kind === 'project' && value.taskId === undefined)
    return {
      kind: 'project',
      projectId: value.projectId,
      layoutId: value.layoutId,
    };
  if (value.kind === 'task' && isWorkspacePaneHostIdentitySegment(value.taskId))
    return {
      kind: 'task',
      projectId: value.projectId,
      taskId: value.taskId,
      layoutId: value.layoutId,
    };
  return null;
}

function clampRatio(ratio: number): number {
  return Math.min(
    MAX_WORKSPACE_PANE_SPLIT_RATIO,
    Math.max(MIN_WORKSPACE_PANE_SPLIT_RATIO, ratio),
  );
}

function parseNode(
  value: unknown,
  instanceIds: Set<string>,
  nodeIds: Set<string>,
  placed: Set<string>,
  depth: number,
): WorkspacePaneHostNode | null {
  if (
    depth > MAX_WORKSPACE_PANE_HOST_TREE_DEPTH ||
    !isPlainRecord(value) ||
    !isWorkspacePaneHostIdentitySegment(value.id)
  )
    return null;
  if (nodeIds.has(value.id)) return null;
  nodeIds.add(value.id);
  if (value.type === 'tabs') {
    if (!Array.isArray(value.instanceIds) || value.instanceIds.length === 0)
      return null;
    const ids: WorkspacePaneInstanceId[] = [];
    for (const candidate of value.instanceIds) {
      if (
        !isWorkspacePaneHostIdentitySegment(candidate) ||
        !instanceIds.has(candidate) ||
        placed.has(candidate)
      )
        return null;
      placed.add(candidate);
      ids.push(candidate as WorkspacePaneInstanceId);
    }
    // selectedInstanceId was added after host documents first shipped. Missing
    // values therefore recover to the first placed pane, while an explicitly
    // invalid value remains malformed and is handled by the local restorer.
    if (
      value.selectedInstanceId !== undefined &&
      (!isWorkspacePaneHostIdentitySegment(value.selectedInstanceId) ||
        !ids.includes(value.selectedInstanceId as WorkspacePaneInstanceId))
    )
      return null;
    return {
      type: 'tabs',
      id: value.id,
      instanceIds: ids,
      selectedInstanceId:
        (value.selectedInstanceId as WorkspacePaneInstanceId | undefined) ??
        ids[0],
    };
  }
  if (
    value.type !== 'split' ||
    (value.orientation !== 'horizontal' && value.orientation !== 'vertical') ||
    typeof value.ratio !== 'number' ||
    !Number.isFinite(value.ratio) ||
    value.ratio < MIN_WORKSPACE_PANE_SPLIT_RATIO ||
    value.ratio > MAX_WORKSPACE_PANE_SPLIT_RATIO ||
    (value.collapsed !== undefined &&
      value.collapsed !== 'first' &&
      value.collapsed !== 'second')
  )
    return null;
  const first = parseNode(value.first, instanceIds, nodeIds, placed, depth + 1);
  const second = parseNode(
    value.second,
    instanceIds,
    nodeIds,
    placed,
    depth + 1,
  );
  if (!first || !second) return null;
  return {
    type: 'split',
    id: value.id,
    orientation: value.orientation,
    ratio: value.ratio,
    ...(value.collapsed ? { collapsed: value.collapsed } : {}),
    first,
    second,
  };
}

/** Strict parser for already-deserialized plain data. It deliberately does not execute accessors. */
export function parseWorkspacePaneHostDocument(
  value: unknown,
): WorkspacePaneHostDocumentV1 | null {
  if (!hasSafeDataGraph(value)) return null;
  if (
    !isPlainRecord(value) ||
    value.version !== WORKSPACE_PANE_HOST_DOCUMENT_VERSION ||
    !isWorkspacePaneHostIdentitySegment(value.id)
  )
    return null;
  const scope = parseScope(value.scope);
  if (
    !scope ||
    !Array.isArray(value.instances) ||
    value.instances.length === 0 ||
    value.instances.length > MAX_WORKSPACE_PANE_HOST_PANES
  )
    return null;
  const instances: WorkspacePaneInstance[] = [];
  const instanceIds = new Set<string>();
  for (const input of value.instances) {
    const instance = parseWorkspacePaneInstance(input);
    if (
      !instance ||
      !isWorkspacePaneHostIdentitySegment(instance.instanceId) ||
      !isWorkspacePaneHostIdentitySegment(instance.descriptorId) ||
      !isBoundedWorkspacePaneInstance(instance) ||
      instanceIds.has(instance.instanceId)
    )
      return null;
    instanceIds.add(instance.instanceId);
    instances.push(instance);
  }
  const placed = new Set<string>();
  const root = parseNode(value.root, instanceIds, new Set(), placed, 0);
  if (
    !root ||
    placed.size !== instances.length ||
    !isWorkspacePaneHostIdentitySegment(value.activeInstanceId) ||
    !instanceIds.has(value.activeInstanceId)
  )
    return null;
  if (
    value.maximizedInstanceId !== undefined &&
    (!isWorkspacePaneHostIdentitySegment(value.maximizedInstanceId) ||
      !instanceIds.has(value.maximizedInstanceId))
  )
    return null;
  return {
    version: WORKSPACE_PANE_HOST_DOCUMENT_VERSION,
    id: value.id,
    scope,
    instances,
    root,
    activeInstanceId: value.activeInstanceId as WorkspacePaneInstanceId,
    ...(value.maximizedInstanceId
      ? {
          maximizedInstanceId:
            value.maximizedInstanceId as WorkspacePaneInstanceId,
        }
      : {}),
  };
}

export function createWorkspacePaneHostBaselineDocument(
  id: string,
  scope: WorkspacePaneHostScope,
  instances: readonly WorkspacePaneInstance[],
): WorkspacePaneHostDocumentV1 | null {
  const accepted = instances.filter(isBoundedWorkspacePaneInstance);
  const first = accepted[0];
  if (!isWorkspacePaneHostIdentitySegment(id) || !first) return null;
  return {
    version: WORKSPACE_PANE_HOST_DOCUMENT_VERSION,
    id,
    scope,
    instances: accepted,
    root: {
      type: 'tabs',
      id: 'root',
      instanceIds: accepted.map((instance) => instance.instanceId),
      selectedInstanceId: first.instanceId,
    },
    activeInstanceId: first.instanceId,
  };
}

function knownInstanceMap(
  instances: readonly WorkspacePaneInstance[],
): Map<string, WorkspacePaneInstance> {
  return new Map(
    instances
      .filter((instance) => isBoundedWorkspacePaneInstance(instance))
      .map((instance) => [instance.instanceId, instance]),
  );
}

function isBoundedWorkspacePaneInstance(
  instance: WorkspacePaneInstance,
): boolean {
  if (
    !isWorkspacePaneHostIdentitySegment(instance.instanceId) ||
    !isWorkspacePaneHostIdentitySegment(instance.descriptorId) ||
    !isWorkspacePaneHostIdentitySegment(instance.stateKey)
  )
    return false;
  return Object.values(instance.boundContext ?? {}).every((value) =>
    isWorkspacePaneHostIdentitySegment(value),
  );
}

/**
 * Restores untrusted persistence without allowing one malformed child to erase valid siblings.
 * The optional catalog list is authoritative: matching IDs must retain the exact known record.
 */
export function restoreWorkspacePaneHostDocument(
  value: unknown,
  knownInstances?: readonly WorkspacePaneInstance[],
): WorkspacePaneHostRestorationResult {
  const strict = parseWorkspacePaneHostDocument(value);
  // Restoration may repair malformed current-version documents, but a schema
  // mismatch is a deliberate discard boundary. Do not let catalog recovery
  // turn an old arrangement into a partial current document.
  if (
    hasSafeDataGraph(value) &&
    isPlainRecord(value) &&
    value.version !== WORKSPACE_PANE_HOST_DOCUMENT_VERSION
  )
    return { document: null, failures: [{ code: 'invalid-document' }] };
  // `undefined` is an omitted catalog. An explicit empty list is authoritative
  // and must reject every persisted occurrence rather than fail open.
  const catalogProvided = knownInstances !== undefined;
  const catalog = knownInstanceMap(knownInstances ?? []);
  if (catalogProvided && catalog.size === 0)
    return { document: null, failures: [{ code: 'invalid-instance' }] };
  if (strict && !catalogProvided) return { document: strict, failures: [] };
  if (strict) {
    const catalogMatches = strict.instances.every((item) => {
      const known = catalog.get(item.instanceId);
      return (
        known &&
        known.descriptorId === item.descriptorId &&
        known.stateKey === item.stateKey
      );
    });
    if (catalogMatches) {
      return {
        document: {
          ...strict,
          // Persisted context is never authoritative; retain the complete catalog record.
          instances: strict.instances.map(
            (item) => catalog.get(item.instanceId)!,
          ),
        },
        failures: [],
      };
    }
  }

  const input = hasSafeDataGraph(value) && isPlainRecord(value) ? value : null;
  const failures: WorkspacePaneHostRestorationFailure[] = [];
  const scope = input ? parseScope(input.scope) : null;
  const id =
    input && isWorkspacePaneHostIdentitySegment(input.id)
      ? input.id
      : 'workspace-pane-host-restored';
  const rawCandidates =
    input && Array.isArray(input.instances) ? input.instances : [];
  const candidates = rawCandidates.slice(0, MAX_WORKSPACE_PANE_HOST_PANES);
  if (rawCandidates.length > candidates.length)
    failures.push({ code: 'invalid-instance' });
  const validInstances: WorkspacePaneInstance[] = [];
  const validIds = new Set<string>();
  for (const candidate of candidates) {
    if (validInstances.length === MAX_WORKSPACE_PANE_HOST_PANES) {
      failures.push({ code: 'invalid-instance' });
      continue;
    }
    const parsed = parseWorkspacePaneInstance(candidate);
    if (
      !parsed ||
      !isWorkspacePaneHostIdentitySegment(parsed.instanceId) ||
      !isWorkspacePaneHostIdentitySegment(parsed.descriptorId) ||
      !isBoundedWorkspacePaneInstance(parsed) ||
      validIds.has(parsed.instanceId)
    ) {
      failures.push({ code: 'invalid-instance' });
      continue;
    }
    const known = catalog.get(parsed.instanceId);
    if (
      catalog.size > 0 &&
      (!known ||
        known.descriptorId !== parsed.descriptorId ||
        known.stateKey !== parsed.stateKey)
    ) {
      failures.push({
        code: 'unknown-instance',
        instanceId: parsed.instanceId,
      });
      continue;
    }
    validIds.add(parsed.instanceId);
    validInstances.push(known ?? parsed);
  }
  if (!scope || validInstances.length === 0) {
    failures.push({ code: 'invalid-document' });
    if (!scope) return { document: null, failures };
    const recoveryInstances =
      validInstances.length > 0 ? validInstances : [...catalog.values()];
    const recoveryDocument = createWorkspacePaneHostBaselineDocument(
      id,
      scope,
      recoveryInstances,
    );
    return {
      document: recoveryDocument
        ? parseWorkspacePaneHostDocument(recoveryDocument)
        : null,
      failures,
    };
  }

  const placed = new Set<string>();
  const nodeIds = new Set<string>();
  const node = (raw: unknown, depth: number): WorkspacePaneHostNode | null => {
    if (
      depth > MAX_WORKSPACE_PANE_HOST_TREE_DEPTH ||
      !isPlainRecord(raw) ||
      !isWorkspacePaneHostIdentitySegment(raw.id) ||
      nodeIds.has(raw.id)
    ) {
      failures.push({ code: 'invalid-node' });
      return null;
    }
    nodeIds.add(raw.id);
    if (raw.type === 'tabs') {
      const ids = Array.isArray(raw.instanceIds)
        ? raw.instanceIds.filter(
            (candidate): candidate is string =>
              isString(candidate) &&
              validIds.has(candidate) &&
              !placed.has(candidate),
          )
        : [];
      for (const candidate of ids) placed.add(candidate);
      if (ids.length === 0) {
        failures.push({ code: 'empty-group', nodeId: raw.id });
        return null;
      }
      const selectedInstanceId =
        isWorkspacePaneHostIdentitySegment(raw.selectedInstanceId) &&
        ids.includes(raw.selectedInstanceId as WorkspacePaneInstanceId)
          ? (raw.selectedInstanceId as WorkspacePaneInstanceId)
          : (ids[0] as WorkspacePaneInstanceId);
      if (
        raw.selectedInstanceId !== undefined &&
        raw.selectedInstanceId !== selectedInstanceId
      )
        failures.push({ code: 'invalid-selection', nodeId: raw.id });
      return {
        type: 'tabs',
        id: raw.id,
        instanceIds: ids as WorkspacePaneInstanceId[],
        selectedInstanceId,
      };
    }
    if (
      raw.type !== 'split' ||
      (raw.orientation !== 'horizontal' && raw.orientation !== 'vertical')
    ) {
      failures.push({ code: 'invalid-node', nodeId: raw.id });
      return null;
    }
    const first = node(raw.first, depth + 1);
    const second = node(raw.second, depth + 1);
    if (!first) return second;
    if (!second) return first;
    const rawRatio = raw.ratio;
    if (
      typeof rawRatio !== 'number' ||
      !Number.isFinite(rawRatio) ||
      rawRatio < MIN_WORKSPACE_PANE_SPLIT_RATIO ||
      rawRatio > MAX_WORKSPACE_PANE_SPLIT_RATIO
    )
      failures.push({ code: 'invalid-node', nodeId: raw.id });
    return {
      type: 'split',
      id: raw.id,
      orientation: raw.orientation,
      ratio: clampRatio(
        typeof rawRatio === 'number' && Number.isFinite(rawRatio)
          ? rawRatio
          : 0.5,
      ),
      ...(raw.collapsed === 'first' || raw.collapsed === 'second'
        ? { collapsed: raw.collapsed }
        : {}),
      first,
      second,
    };
  };
  const restoredRoot = input ? node(input.root, 0) : null;
  const unplaced = validInstances.filter(
    (instance) => !placed.has(instance.instanceId),
  );
  if (unplaced.length > 0)
    failures.push(
      ...unplaced.map((instance) => ({
        code: 'orphan-placement' as const,
        instanceId: instance.instanceId,
      })),
    );
  const root = restoredRoot ?? {
    type: 'tabs' as const,
    id: 'restored-root',
    instanceIds: (unplaced.length > 0 ? unplaced : [validInstances[0]]).map(
      (item) => item.instanceId,
    ),
    selectedInstanceId: (unplaced.length > 0
      ? unplaced
      : [validInstances[0]])[0].instanceId,
  };
  const retainedIds = new Set(flattenWorkspacePaneHost(root));
  const instances = validInstances.filter((item) =>
    retainedIds.has(item.instanceId),
  );
  if (instances.length === 0)
    return {
      document: null,
      failures: [...failures, { code: 'invalid-document' }],
    };
  const active =
    input &&
    isString(input.activeInstanceId) &&
    retainedIds.has(input.activeInstanceId as WorkspacePaneInstanceId)
      ? (input.activeInstanceId as WorkspacePaneInstanceId)
      : instances[0].instanceId;
  if (input?.activeInstanceId !== active)
    failures.push({ code: 'invalid-selection' });
  const maximized =
    input &&
    isString(input.maximizedInstanceId) &&
    retainedIds.has(input.maximizedInstanceId as WorkspacePaneInstanceId)
      ? (input.maximizedInstanceId as WorkspacePaneInstanceId)
      : undefined;
  const recovered = parseWorkspacePaneHostDocument({
    version: WORKSPACE_PANE_HOST_DOCUMENT_VERSION,
    id,
    scope,
    instances,
    root,
    activeInstanceId: active,
    ...(maximized ? { maximizedInstanceId: maximized } : {}),
  });
  return {
    document: recovered,
    failures: recovered
      ? failures
      : [...failures, { code: 'invalid-document' }],
  };
}

export function flattenWorkspacePaneHost(
  node: WorkspacePaneHostNode,
): WorkspacePaneInstanceId[] {
  return node.type === 'tabs'
    ? [...node.instanceIds]
    : [
        ...flattenWorkspacePaneHost(node.first),
        ...flattenWorkspacePaneHost(node.second),
      ];
}

export function findWorkspacePaneHostTabGroup(
  node: WorkspacePaneHostNode,
  id: string,
): WorkspacePaneHostTabGroup | undefined {
  if (node.type === 'tabs') return node.id === id ? node : undefined;
  return (
    findWorkspacePaneHostTabGroup(node.first, id) ??
    findWorkspacePaneHostTabGroup(node.second, id)
  );
}
