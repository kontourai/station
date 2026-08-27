import { agentId } from './agent-identity.js';
import type { LayoutCatalogContribution } from './layout.js';
import {
  type LayoutAction,
  type LayoutAlternativeRenderer,
  type LayoutComponentRef,
  type LayoutRendererCapability,
  type LayoutTab,
  type MCPToolUILayoutComponentRef,
  parseMcpToolRef,
} from './layout.js';
import {
  cloneWorkspacePaneInitialArguments,
  parseWorkspacePaneBoundContext,
  parseWorkspacePaneContextRequirement,
  WORKSPACE_PANE_REGIONS,
  type WorkspacePaneBoundContext,
  WorkspacePaneContextRequirement,
  WorkspacePaneLifecycle,
  WorkspacePaneProvenance,
  WorkspacePaneRegion,
  type WorkspacePaneRendererRef,
} from './workspace-pane.js';
import { MAX_WORKSPACE_PANE_IDENTITY_SEGMENT_LENGTH } from './workspace-pane-layout-adapter-types.js';

export const DESCRIPTOR_ID_PREFIX = 'pane';
export const RENDERER_ID_PREFIX = 'renderer';
export const INSTANCE_ID_PREFIX = 'instance';
export const STATE_KEY_PREFIX = 'state';

const DEFAULT_REGION: WorkspacePaneRegion = 'primary';
const DEFAULT_LIFECYCLE: WorkspacePaneLifecycle = { stage: 'stable' };
const DANGEROUS_CLONE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_CLONE_DEPTH = 32;

/**
 * Verifies an already-deserialized plain-data value can be inspected without
 * evaluating a property accessor. Portable code cannot safely identify every
 * Proxy; Node catalog ingestion rejects them before the adapter sees data.
 * `structuredClone` then makes the successful snapshot detached.
 */
function hasSafeDataGraph(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (seen.has(value)) return true;
  seen.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    if (
      (Array.isArray(value) && prototype !== Array.prototype) ||
      (!Array.isArray(value) &&
        prototype !== Object.prototype &&
        prototype !== null)
    ) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Object.values(descriptors).every(
      (descriptor) =>
        descriptor.get === undefined &&
        descriptor.set === undefined &&
        hasSafeDataGraph(descriptor.value, seen),
    );
  } catch {
    return false;
  } finally {
    seen.delete(value);
  }
}

function isSafeDataValue(value: unknown): boolean {
  if (!hasSafeDataGraph(value)) return false;
  try {
    // Do not substitute this with JSON serialization: it would coerce or drop
    // values rather than rejecting them, and does not reject all Proxy shapes.
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

function isSafeDataArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && isSafeDataValue(value);
}

export function isNonEmptyTrimmedString(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value === value.trim()
  );
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    isSafeDataValue(value)
  );
}

export function cloneData<T>(value: T): T {
  if (!isSafeDataValue(value))
    throw new TypeError('Refusing to clone an unsafe data value');
  return cloneDataInner(value, 0, new Set()) as T;
}

function cloneDataInner(
  value: unknown,
  depth: number,
  seen: Set<unknown>,
): unknown {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'boolean' || type === 'string') return value;
  if (type === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('Refusing to clone a non-finite number');
    return value;
  }
  if (
    type === 'undefined' ||
    type === 'function' ||
    type === 'symbol' ||
    type === 'bigint'
  ) {
    throw new TypeError(`Refusing to clone a value of type ${type}`);
  }
  if (depth > MAX_CLONE_DEPTH)
    throw new TypeError('Refusing to clone data past the maximum depth');
  if (seen.has(value))
    throw new TypeError('Refusing to clone a cyclic structure');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
        string,
        PropertyDescriptor
      >;
      const length = descriptors.length?.value;
      if (typeof length !== 'number')
        throw new TypeError('Refusing to clone a malformed array');
      const clone: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor) continue;
        clone[index] = cloneDataInner(descriptor.value, depth + 1, seen);
      }
      return clone;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const clone: Record<string, unknown> = Object.create(null);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable) continue;
      if (DANGEROUS_CLONE_KEYS.has(key))
        throw new TypeError(`Refusing to clone dangerous key: ${key}`);
      Object.defineProperty(clone, key, {
        value: cloneDataInner(descriptor.value, depth + 1, seen),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return clone;
  } finally {
    seen.delete(value);
  }
}

export function deepFreeze<T>(value: T): T {
  if (isSafeDataArray(value)) {
    for (const entry of value) deepFreeze(entry);
    return Object.freeze(value);
  }
  if (isPlainObject(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    return Object.freeze(value) as T;
  }
  return value;
}

function cloneAction(value: unknown): LayoutAction | null {
  if (
    !isPlainObject(value) ||
    !isNonEmptyTrimmedString(value.label) ||
    typeof value.data !== 'string' ||
    !['prompt', 'inline-prompt', 'external', 'internal'].includes(
      value.type as string,
    )
  )
    return null;
  const action: LayoutAction = {
    type: value.type as LayoutAction['type'],
    label: value.label,
    data: value.data,
  };
  if (value.icon !== undefined) {
    if (typeof value.icon !== 'string') return null;
    action.icon = value.icon;
  }
  if (value.agent !== undefined) {
    if (typeof value.agent !== 'string') return null;
    try {
      action.agent = agentId(value.agent);
    } catch {
      return null;
    }
  }
  return action;
}

function cloneActions(value: unknown): LayoutAction[] | null {
  if (!isSafeDataArray(value)) return null;
  const actions: LayoutAction[] = [];
  for (const entry of value) {
    const action = cloneAction(entry);
    if (!action) return null;
    actions.push(action);
  }
  return actions;
}

function cloneRendererCapabilities(
  value: unknown,
): LayoutRendererCapability[] | null | undefined {
  if (value === undefined) return undefined;
  if (
    !isSafeDataArray(value) ||
    !value.every(
      (capability) =>
        capability === 'trusted-plugin-react' ||
        capability === 'sandboxed-mcp-app',
    ) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  return [...value] as LayoutRendererCapability[];
}

export function cloneLayoutComponentRef(
  value: unknown,
): LayoutComponentRef | null {
  if (!isPlainObject(value)) return null;
  if (value.kind === 'builtin-component' || value.kind === 'plugin-component') {
    return isNonEmptyTrimmedString(value.name)
      ? { kind: value.kind, name: value.name }
      : null;
  }
  if (value.kind !== 'mcp-tool-ui' || !isNonEmptyTrimmedString(value.ref))
    return null;
  if (!parseMcpToolRef(value.ref)) return null;
  const source = value as unknown as MCPToolUILayoutComponentRef;
  const ref: MCPToolUILayoutComponentRef = {
    kind: 'mcp-tool-ui',
    ref: source.ref,
  };
  if (source.resourceUri !== undefined) {
    if (!isNonEmptyTrimmedString(source.resourceUri)) return null;
    ref.resourceUri = source.resourceUri;
  }
  if (source.displayMode !== undefined) {
    if (!['inline', 'fullscreen', 'pip'].includes(source.displayMode))
      return null;
    ref.displayMode = source.displayMode;
  }
  if (source.fallbackComponent !== undefined) {
    if (!isNonEmptyTrimmedString(source.fallbackComponent)) return null;
    ref.fallbackComponent = source.fallbackComponent;
  }
  if (source.initialArguments !== undefined) {
    let initialArguments: Record<string, unknown> | null;
    try {
      initialArguments = cloneWorkspacePaneInitialArguments(
        cloneData(source.initialArguments),
      );
    } catch {
      return null;
    }
    if (!initialArguments) return null;
    ref.initialArguments = initialArguments;
  }
  if (source.approvalPolicy !== undefined) {
    if (!['inherit', 'require', 'read-only'].includes(source.approvalPolicy))
      return null;
    ref.approvalPolicy = source.approvalPolicy;
  }
  return ref;
}

export function cloneLayoutTab(value: unknown): LayoutTab | null {
  if (
    !isPlainObject(value) ||
    !isNonEmptyTrimmedString(value.id) ||
    !isNonEmptyTrimmedString(value.label)
  )
    return null;
  let component: string | LayoutComponentRef;
  if (typeof value.component === 'string') {
    if (!isNonEmptyTrimmedString(value.component)) return null;
    component = value.component;
  } else {
    const ref = cloneLayoutComponentRef(value.component);
    if (!ref) return null;
    component = ref;
  }
  const tab: LayoutTab = { id: value.id, label: value.label, component };
  const requiredRendererCapabilities = cloneRendererCapabilities(
    value.requiredRendererCapabilities,
  );
  if (requiredRendererCapabilities === null) return null;
  if (requiredRendererCapabilities !== undefined) {
    tab.requiredRendererCapabilities = requiredRendererCapabilities;
  }
  if (value.alternativeRenderer !== undefined) {
    if (!isPlainObject(value.alternativeRenderer)) return null;
    const alternativeComponent = cloneLayoutComponentRef(
      value.alternativeRenderer.component,
    );
    if (!alternativeComponent) return null;
    const alternativeCapabilities = cloneRendererCapabilities(
      value.alternativeRenderer.requiredCapabilities,
    );
    if (alternativeCapabilities === null) return null;
    const alternative: LayoutAlternativeRenderer = {
      component: alternativeComponent,
    };
    if (value.alternativeRenderer.rendererId !== undefined) {
      if (!isNonEmptyTrimmedString(value.alternativeRenderer.rendererId))
        return null;
      alternative.rendererId = value.alternativeRenderer.rendererId;
    }
    if (value.alternativeRenderer.provenance !== undefined) {
      if (!isPlainObject(value.alternativeRenderer.provenance)) return null;
      const provenance = value.alternativeRenderer.provenance;
      if (
        !['builtin', 'plugin', 'mcp'].includes(provenance.origin as string) ||
        (provenance.pluginId !== undefined &&
          !isNonEmptyTrimmedString(provenance.pluginId)) ||
        (provenance.mcpServerId !== undefined &&
          !isNonEmptyTrimmedString(provenance.mcpServerId))
      ) {
        return null;
      }
      alternative.provenance = {
        origin: provenance.origin as NonNullable<
          LayoutAlternativeRenderer['provenance']
        >['origin'],
        ...(provenance.pluginId === undefined
          ? {}
          : { pluginId: provenance.pluginId }),
        ...(provenance.mcpServerId === undefined
          ? {}
          : { mcpServerId: provenance.mcpServerId }),
      };
    }
    if (alternativeCapabilities !== undefined) {
      alternative.requiredCapabilities = alternativeCapabilities;
    }
    if (value.alternativeRenderer.reason !== undefined) {
      if (!isNonEmptyTrimmedString(value.alternativeRenderer.reason))
        return null;
      alternative.reason = value.alternativeRenderer.reason;
    }
    tab.alternativeRenderer = alternative;
  }
  if (value.icon !== undefined) {
    if (typeof value.icon !== 'string') return null;
    // Preserve the exact source spelling for lossless write-back. Descriptor
    // projection normalizes an empty decoration to absence separately.
    tab.icon = value.icon;
  }
  if (value.description !== undefined) {
    if (typeof value.description !== 'string') return null;
    tab.description = value.description;
  }
  if (value.actions !== undefined) {
    const actions = cloneActions(value.actions);
    if (!actions) return null;
    tab.actions = actions;
  }
  if (value.skills !== undefined) {
    const skills = cloneActions(value.skills);
    if (!skills) return null;
    tab.skills = skills;
  }
  return tab;
}

export interface NormalizedAdapterContext {
  layoutSlug: string;
  instanceScope: string;
  supportedRegions: readonly WorkspacePaneRegion[];
  preferredRegion: WorkspacePaneRegion;
  lifecycle: WorkspacePaneLifecycle;
  pluginId?: string;
  mcpServerId?: string;
  modeContextRequirement?: WorkspacePaneContextRequirement;
  boundContext?: WorkspacePaneBoundContext;
  contribution?: LayoutCatalogContribution;
  requiresProject?: boolean;
}

function normalizePlacementContext(
  context: Record<string, unknown>,
  normalized: NormalizedAdapterContext,
): boolean {
  if (context.region !== undefined) {
    if (
      typeof context.region !== 'string' ||
      !WORKSPACE_PANE_REGIONS.includes(context.region as WorkspacePaneRegion)
    )
      return false;
    normalized.supportedRegions = [context.region as WorkspacePaneRegion];
    normalized.preferredRegion = context.region as WorkspacePaneRegion;
  }
  if (context.supportedRegions !== undefined) {
    const regions = context.supportedRegions;
    if (
      !Array.isArray(regions) ||
      regions.length === 0 ||
      !regions.every(
        (region) =>
          typeof region === 'string' &&
          WORKSPACE_PANE_REGIONS.includes(region as WorkspacePaneRegion),
      ) ||
      new Set(regions).size !== regions.length
    )
      return false;
    normalized.supportedRegions = [...regions] as WorkspacePaneRegion[];
    normalized.preferredRegion = normalized.supportedRegions[0]!;
  }
  if (context.preferredRegion === undefined) return true;
  if (
    typeof context.preferredRegion !== 'string' ||
    !normalized.supportedRegions.includes(
      context.preferredRegion as WorkspacePaneRegion,
    )
  )
    return false;
  normalized.preferredRegion = context.preferredRegion as WorkspacePaneRegion;
  return true;
}

function normalizeContextIdentityAndLifecycle(
  context: Record<string, unknown>,
  normalized: NormalizedAdapterContext,
): boolean {
  if (context.instanceScope !== undefined) {
    if (!isNonEmptyTrimmedString(context.instanceScope)) return false;
    normalized.instanceScope = context.instanceScope;
  }
  if (context.lifecycle !== undefined) {
    if (!isPlainObject(context.lifecycle)) return false;
    try {
      normalized.lifecycle = cloneData(
        context.lifecycle,
      ) as unknown as WorkspacePaneLifecycle;
    } catch {
      return false;
    }
  }
  for (const key of ['pluginId', 'mcpServerId'] as const) {
    if (context[key] === undefined) continue;
    if (!isNonEmptyTrimmedString(context[key])) return false;
    normalized[key] = context[key];
  }
  if (context.requiresProject !== undefined) {
    if (typeof context.requiresProject !== 'boolean') return false;
    normalized.requiresProject = context.requiresProject;
  }
  return true;
}

function normalizeContextBindings(
  context: Record<string, unknown>,
  normalized: NormalizedAdapterContext,
): boolean {
  let modeContextRequirementInput = context.modeContextRequirement;
  let boundContextInput = context.boundContext;
  let contributionInput = context.contribution;
  try {
    if (modeContextRequirementInput !== undefined)
      modeContextRequirementInput = cloneData(modeContextRequirementInput);
    if (boundContextInput !== undefined)
      boundContextInput = cloneData(boundContextInput);
    if (contributionInput !== undefined)
      contributionInput = cloneData(contributionInput);
  } catch {
    return false;
  }
  const modeContextRequirement = parseWorkspacePaneContextRequirement(
    modeContextRequirementInput,
  );
  if (modeContextRequirement === null) return false;
  if (modeContextRequirement !== undefined)
    normalized.modeContextRequirement = modeContextRequirement;
  const boundContext = parseWorkspacePaneBoundContext(boundContextInput);
  if (boundContext === null) return false;
  if (boundContext !== undefined) normalized.boundContext = boundContext;
  if (contributionInput !== undefined) {
    const contribution = parseWorkspacePaneBoundContext({
      contribution: contributionInput,
    })?.contribution;
    if (!contribution) return false;
    normalized.contribution = contribution;
  }
  return true;
}

export function normalizeContext(
  context: unknown,
): NormalizedAdapterContext | null {
  if (!isPlainObject(context) || !isNonEmptyTrimmedString(context.layoutSlug))
    return null;
  const normalized: NormalizedAdapterContext = {
    layoutSlug: context.layoutSlug,
    instanceScope: context.layoutSlug,
    supportedRegions: [DEFAULT_REGION],
    preferredRegion: DEFAULT_REGION,
    lifecycle: { ...DEFAULT_LIFECYCLE },
  };
  if (
    !normalizePlacementContext(context, normalized) ||
    !normalizeContextIdentityAndLifecycle(context, normalized) ||
    !normalizeContextBindings(context, normalized)
  )
    return null;
  return normalized;
}

export function rendererRefFromComponent(
  component: string | LayoutComponentRef,
): WorkspacePaneRendererRef | null {
  if (typeof component === 'string') {
    return { kind: 'plugin-component', name: component };
  }
  return cloneLayoutComponentRef(component);
}

export function deriveProvenance(
  renderer: WorkspacePaneRendererRef,
  context: NormalizedAdapterContext,
): WorkspacePaneProvenance | null {
  // Attribution answers who supplied a declaration. Renderer kind answers how
  // the host may execute it. A plugin may deliberately reuse a Station-built
  // renderer, so contributor provenance must not be inferred from that
  // renderer's security class.
  if (context.pluginId !== undefined) {
    if (renderer.kind === 'mcp-tool-ui') {
      const parts = parseMcpToolRef(renderer.ref);
      if (
        !parts ||
        (context.mcpServerId !== undefined &&
          context.mcpServerId !== parts.serverId)
      )
        return null;
      return {
        origin: 'plugin',
        pluginId: context.pluginId,
        mcpServerId: parts.serverId,
      };
    }
    return { origin: 'plugin', pluginId: context.pluginId };
  }

  switch (renderer.kind) {
    case 'builtin-component':
      return { origin: 'builtin' };
    case 'plugin-component':
      return null;
    case 'mcp-tool-ui': {
      const parts = parseMcpToolRef(renderer.ref);
      if (
        !parts ||
        (context.mcpServerId !== undefined &&
          context.mcpServerId !== parts.serverId)
      )
        return null;
      return { origin: 'mcp', mcpServerId: parts.serverId };
    }
    case 'standard-data':
      return null;
  }
}

export function identitySegment(value: unknown): string | null {
  if (
    !isNonEmptyTrimmedString(value) ||
    value.length > MAX_WORKSPACE_PANE_IDENTITY_SEGMENT_LENGTH
  )
    return null;
  return encodeURIComponent(value);
}

export function contributorSegment(
  provenance: WorkspacePaneProvenance,
): string | null {
  switch (provenance.origin) {
    case 'builtin':
      return identitySegment('builtin');
    case 'plugin':
      return identitySegment(`plugin:${provenance.pluginId}`);
    case 'mcp':
      return identitySegment(`mcp:${provenance.mcpServerId}`);
  }
}

export interface MintedIdentities {
  descriptorId: string;
  rendererId: string;
  instanceId: string;
  stateKey: string;
}

export function mintIdentities(
  context: NormalizedAdapterContext,
  tabId: string,
  renderer: WorkspacePaneRendererRef,
  provenance: WorkspacePaneProvenance,
): MintedIdentities | null {
  if (renderer.kind === 'standard-data') return null;
  const layoutSegment = identitySegment(context.layoutSlug);
  const scopeSegment = instanceScopeSegment(context.instanceScope);
  const tabSegment = identitySegment(tabId);
  const rendererSegment = identitySegment(
    renderer.kind === 'mcp-tool-ui' ? renderer.ref : renderer.name,
  );
  const contributor = contributorSegment(provenance);
  if (
    !layoutSegment ||
    !scopeSegment ||
    !tabSegment ||
    !rendererSegment ||
    !contributor
  )
    return null;
  const descriptorId = `${DESCRIPTOR_ID_PREFIX}:${contributor}:${layoutSegment}:${tabSegment}`;
  return {
    descriptorId,
    rendererId: `${RENDERER_ID_PREFIX}:${contributor}:${renderer.kind}:${rendererSegment}`,
    instanceId: `${INSTANCE_ID_PREFIX}:${scopeSegment}:${descriptorId}`,
    stateKey: `${STATE_KEY_PREFIX}:${scopeSegment}:${descriptorId}`,
  };
}

/**
 * Instance/state scopes are composed by hosts from otherwise valid IDs (for
 * example project plus source). Preserve the familiar escaped form when it
 * fits, then use a deterministic bounded identity when composition exceeds
 * the descriptor segment limit. This is identity-only: the original values
 * remain in `boundContext`, not in the opaque long-scope marker.
 */
function instanceScopeSegment(value: unknown): string | null {
  if (!isNonEmptyTrimmedString(value)) return null;
  const direct = identitySegment(value);
  if (direct) return direct;
  return `scope-h1-${value.length.toString(36)}-${fnv1a64(value)}`;
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const codePoint of value) {
    hash ^= BigInt(codePoint.codePointAt(0)!);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

export function deriveModeContextRequirement(
  requiredProviders: readonly string[] | undefined,
  context: NormalizedAdapterContext,
): WorkspacePaneContextRequirement | undefined {
  const requirement: WorkspacePaneContextRequirement = {};
  if (context.requiresProject === true) requirement.project = true;
  if (requiredProviders !== undefined)
    requirement.requiredProviders = [...requiredProviders];
  if (context.modeContextRequirement !== undefined)
    Object.assign(requirement, context.modeContextRequirement);
  return Object.keys(requirement).length > 0 ? requirement : undefined;
}

export function structurallyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((entry, index) => structurallyEqual(entry, b[index]))
    );
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys)
      if (!structurallyEqual(a[key], b[key])) return false;
    return true;
  }
  return false;
}

export function extractIdentityScope(
  value: string,
  prefix: string,
  descriptorId: string,
): string | null {
  const start = `${prefix}:`;
  const end = `:${descriptorId}`;
  if (!value.startsWith(start) || !value.endsWith(end)) return null;
  const encoded = value.slice(start.length, value.length - end.length);
  if (encoded.length === 0) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  if (identitySegment(decoded) === encoded) return decoded;
  return /^scope-h1-[1-9a-z][0-9a-z]*-[0-9a-f]{16}$/.test(encoded)
    ? encoded
    : null;
}
