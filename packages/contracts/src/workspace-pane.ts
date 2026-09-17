import { agentId } from './agent-identity.js';
import {
  isLayoutComponentRef,
  type LayoutAction,
  type LayoutCatalogContribution,
  type LayoutComponentRef,
  type LayoutMetadata,
  type LayoutRendererCapability,
  type MCPToolUILayoutComponentRef,
  parseMcpToolRef,
} from './layout.js';

/**
 * Station#1369 Wave 1 — the versioned Workspace Pane descriptor/instance
 * contract. Data-only: no renderer execution, installation, authorization, or
 * availability claims. See docs/contexts/workspace-surfaces/CONTEXT.md for
 * the vocabulary and the baseline `LayoutComponentRef` adapter boundary
 * this reuses rather than replaces.
 */
export const WORKSPACE_PANE_CONTRACT_VERSION = '1.0' as const;
export type WorkspacePaneContractVersion =
  typeof WORKSPACE_PANE_CONTRACT_VERSION;

declare const WORKSPACE_PANE_DESCRIPTOR_ID_BRAND: unique symbol;
declare const WORKSPACE_PANE_INSTANCE_ID_BRAND: unique symbol;
declare const WORKSPACE_PANE_STATE_KEY_BRAND: unique symbol;
declare const WORKSPACE_PANE_RENDERER_ID_BRAND: unique symbol;

/** Identifies one WorkspacePane descriptor. Not interchangeable with an instance ID or state key. */
export type WorkspacePaneDescriptorId = string & {
  readonly [WORKSPACE_PANE_DESCRIPTOR_ID_BRAND]: true;
};
/** Identifies one placed occurrence of a descriptor. Not interchangeable with a descriptor ID or state key. */
export type WorkspacePaneInstanceId = string & {
  readonly [WORKSPACE_PANE_INSTANCE_ID_BRAND]: true;
};
/** Identifies where an instance's own persisted state lives. Not interchangeable with a descriptor or instance ID. */
export type WorkspacePaneStateKey = string & {
  readonly [WORKSPACE_PANE_STATE_KEY_BRAND]: true;
};
/**
 * Identifies the renderer a descriptor is bound to. Independent of the
 * descriptor/instance/state-key identity space and of the renderer ref's own
 * `name`/`ref` field: two descriptors can share a renderer ref shape while
 * declaring distinct renderer identities.
 */
export type WorkspacePaneRendererId = string & {
  readonly [WORKSPACE_PANE_RENDERER_ID_BRAND]: true;
};

function isNonEmptyTrimmedString(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value === value.trim()
  );
}

/**
 * Bytes an inline `data:` preview may occupy — roughly 64 KB of image after
 * base64 expansion. A thumbnail exceeding this is a payload, not a preview.
 */
const PREVIEW_IMAGE_MAX_DATA_URI_LENGTH = 96_000;

/**
 * Characters an asset PATH may occupy. Generous next to any real path, and
 * still a bound: the alphabet alone would accept a megabyte of slashes, and
 * an unbounded descriptor field is a memory cost per catalog render.
 */
const PREVIEW_IMAGE_MAX_PATH_LENGTH = 2_048;

const PREVIEW_IMAGE_DATA_URI =
  /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Any `scheme:` prefix, per RFC 3986's scheme grammar. */
const URI_SCHEME_PREFIX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * The alphabet a same-origin asset path may use. Deliberately narrow: no `:`
 * (schemes), no backslash (browsers normalize it to `/` in some positions),
 * no `%` (percent escapes can reintroduce either), and no whitespace or
 * control characters (a browser strips some before resolving, so a newline
 * spliced into "ht tps://x" still reaches the network as an absolute URL).
 * A filename needing a space or a non-ASCII letter is out of scope.
 */
const PREVIEW_IMAGE_ASSET_PATH = /^[A-Za-z0-9._~\-/]+$/;

/**
 * The bound on {@link WorkspacePaneDescriptor.previewImage} — a same-origin
 * asset path, or a small inline `data:image/...;base64` payload.
 *
 * A descriptor is plugin-controlled and its preview lands in `img src` on
 * every catalog render, so an off-origin reference is an unconsented beacon
 * (viewer IP, user agent, and the time they opened the picker) rather than a
 * picture. Neither runtime constrains it above this: the Tauri CSP admits
 * `http:`/`https:`/`data:`, and the browser-served UI has no CSP.
 */
export function isBoundedWorkspacePanePreviewImage(
  value: unknown,
): value is string {
  if (!isNonEmptyTrimmedString(value)) return false;
  if (value.startsWith('data:')) {
    return (
      value.length <= PREVIEW_IMAGE_MAX_DATA_URI_LENGTH &&
      PREVIEW_IMAGE_DATA_URI.test(value)
    );
  }
  // Allowlist rather than blocklist: everything a scheme, an authority, a
  // percent escape, or a stripped control character would need is simply not
  // in the alphabet. Protocol-relative `//host/x.png` and `..` traversal
  // survive that alphabet, so they are named.
  if (value.length > PREVIEW_IMAGE_MAX_PATH_LENGTH) return false;
  if (!PREVIEW_IMAGE_ASSET_PATH.test(value)) return false;
  if (value.startsWith('//')) return false;
  if (URI_SCHEME_PREFIX.test(value)) return false;
  if (value.split('/').includes('..')) return false;
  return true;
}

/** Rejects empty/whitespace-padded values so identities stay unambiguous. */
export function toWorkspacePaneDescriptorId(
  value: string,
): WorkspacePaneDescriptorId {
  if (!isNonEmptyTrimmedString(value)) {
    throw new TypeError(
      'WorkspacePane descriptor id must be a non-empty, trimmed string',
    );
  }
  return value as WorkspacePaneDescriptorId;
}

export function toWorkspacePaneInstanceId(
  value: string,
): WorkspacePaneInstanceId {
  if (!isNonEmptyTrimmedString(value)) {
    throw new TypeError(
      'WorkspacePane instance id must be a non-empty, trimmed string',
    );
  }
  return value as WorkspacePaneInstanceId;
}

export function toWorkspacePaneStateKey(value: string): WorkspacePaneStateKey {
  if (!isNonEmptyTrimmedString(value)) {
    throw new TypeError(
      'WorkspacePane state key must be a non-empty, trimmed string',
    );
  }
  return value as WorkspacePaneStateKey;
}

/** Rejects empty/whitespace-padded values so renderer identity stays unambiguous. */
export function toWorkspacePaneRendererId(
  value: string,
): WorkspacePaneRendererId {
  if (!isNonEmptyTrimmedString(value)) {
    throw new TypeError(
      'WorkspacePane renderer id must be a non-empty, trimmed string',
    );
  }
  return value as WorkspacePaneRendererId;
}

/**
 * A WorkspacePane's renderer reference reuses the current layout component
 * vocabulary so built-in components, trusted plugin components, and
 * sandboxed MCP Apps stay the same distinct security classes everywhere.
 */
/**
 * A host-neutral, inert presentation of one declared standard-data view. The
 * contribution snapshot is intentionally carried here as well as on the
 * placed instance: a renderer cannot be retargeted to a different package,
 * version, source, or attribution after selection.
 */
export interface WorkspacePaneStandardDataRendererRef {
  kind: 'standard-data';
  view: {
    id: string;
    projection: string;
    schemaRef: string;
    readOnly: true;
    contribution: LayoutCatalogContribution;
    incarnation: number;
  };
}

export type WorkspacePaneRendererRef =
  | LayoutComponentRef
  | WorkspacePaneStandardDataRendererRef;

/** Host rendering capabilities a contribution may declare for a renderer. */
export type WorkspacePaneRendererCapability = LayoutRendererCapability;

const MCP_DISPLAY_MODES: readonly NonNullable<
  MCPToolUILayoutComponentRef['displayMode']
>[] = ['inline', 'fullscreen', 'pip'];
const MCP_APPROVAL_POLICIES: readonly NonNullable<
  MCPToolUILayoutComponentRef['approvalPolicy']
>[] = ['inherit', 'require', 'read-only'];

/**
 * Maximum nested container depth for JSON-compatible Workspace Pane payloads.
 * The root object is depth zero, so a payload may contain 32 nested object or
 * array edges beneath it; depth 33 is rejected.
 */
export const MAX_WORKSPACE_PANE_JSON_DEPTH = 32;
const DANGEROUS_OBJECT_KEYS = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);

/**
 * Produces a detached snapshot of already-deserialized plain data before a
 * public Workspace Pane parser reads it. Property descriptors reject accessors
 * without evaluating them. Portable JavaScript cannot detect every Proxy
 * without invoking its meta traps, so Proxy rejection belongs to a Node host
 * ingestion boundary before values reach this browser-bundleable contract.
 */
function snapshotWorkspacePaneValue(value: unknown): unknown | null {
  if (!hasPlainWorkspacePaneDataGraph(value)) return null;
  try {
    return structuredClone(value);
  } catch {
    return null;
  }
}

function hasPlainWorkspacePaneDataGraph(
  value: unknown,
  seen = new Set<object>(),
): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (seen.has(value)) return false;
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
        hasPlainWorkspacePaneDataGraph(descriptor.value, seen),
    );
  } catch {
    return false;
  } finally {
    seen.delete(value);
  }
}

/**
 * Recursively validates and clones an untrusted value into a JSON-compatible
 * structure (null/boolean/string/finite number, or arrays/plain objects of
 * the same), or returns `null`. Fails closed rather than rewriting: dates,
 * class instances, and any object whose prototype is not `Object.prototype`
 * or `null` are rejected outright rather than coerced, as are cycles,
 * excessive nesting, and the dangerous keys `__proto__`/`prototype`/
 * `constructor` that could otherwise pollute a clone's prototype chain.
 * Objects are cloned with `Object.create(null)` plus `defineProperty` so the
 * clone can never inherit or later gain a prototype.
 */
function cloneJsonCompatible(
  value: unknown,
  depth: number,
  seen: Set<object>,
): unknown {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'boolean' || type === 'string') return value;
  if (type === 'number') return Number.isFinite(value) ? value : undefined;
  if (type !== 'object') return undefined; // undefined, function, symbol, bigint

  if (depth > MAX_WORKSPACE_PANE_JSON_DEPTH) return undefined;
  const obj = value as object;
  if (seen.has(obj)) return undefined;

  if (Array.isArray(value)) {
    seen.add(obj);
    const clone: unknown[] = [];
    for (const entry of value) {
      const clonedEntry = cloneJsonCompatible(entry, depth + 1, seen);
      if (clonedEntry === undefined) return undefined;
      clone.push(clonedEntry);
    }
    seen.delete(obj);
    return clone;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return undefined;

  seen.add(obj);
  const clone: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (DANGEROUS_OBJECT_KEYS.has(key)) return undefined;
    const clonedEntry = cloneJsonCompatible(
      (value as Record<string, unknown>)[key],
      depth + 1,
      seen,
    );
    if (clonedEntry === undefined) return undefined;
    Object.defineProperty(clone, key, {
      value: clonedEntry,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  seen.delete(obj);
  return clone;
}

/**
 * Validates and deep-clones an untrusted `initialArguments` candidate into a
 * JSON-compatible plain object, or returns `null`. Only the top-level shape
 * (a plain object) is required by the caller; every nested value must itself
 * be JSON-compatible.
 */
/**
 * Validates and clones MCP initial arguments relative to their own root.
 * Layout and adaptation wrappers deliberately do not consume this depth budget.
 */
export function cloneWorkspacePaneInitialArguments(
  value: unknown,
): Record<string, unknown> | null {
  const snapshot = snapshotWorkspacePaneValue(value);
  if (!isPlainObject(snapshot)) return null;
  const proto = Object.getPrototypeOf(snapshot);
  if (proto !== Object.prototype && proto !== null) return null;
  const cloned = cloneJsonCompatible(snapshot, 0, new Set());
  if (cloned === undefined) return null;
  return cloned as Record<string, unknown>;
}

/**
 * Parses and normalizes an untrusted candidate into a `WorkspacePaneRendererRef`
 * carrying only known fields, or returns `null`. Additive unknown fields are
 * dropped rather than kept; malformed optional MCP fields fail closed rather
 * than being silently dropped, since a dropped-but-malformed field could
 * change dispatch/approval behavior at the host.
 */
function parseWorkspacePaneRendererRef(
  value: unknown,
): WorkspacePaneRendererRef | null {
  if (!isPlainObject(value)) return null;
  const kind = value.kind;

  if (kind === 'builtin-component' || kind === 'plugin-component') {
    if (!isNonEmptyTrimmedString(value.name)) return null;
    return { kind, name: value.name };
  }

  if (kind === 'mcp-tool-ui') {
    if (!isLayoutComponentRef(value)) return null;
    const renderer: MCPToolUILayoutComponentRef = {
      kind: 'mcp-tool-ui',
      ref: value.ref as string,
    };
    if (value.resourceUri !== undefined) {
      if (!isNonEmptyTrimmedString(value.resourceUri)) return null;
      renderer.resourceUri = value.resourceUri;
    }
    if (value.fallbackComponent !== undefined) {
      if (!isNonEmptyTrimmedString(value.fallbackComponent)) return null;
      renderer.fallbackComponent = value.fallbackComponent;
    }
    if (value.displayMode !== undefined) {
      if (
        typeof value.displayMode !== 'string' ||
        !MCP_DISPLAY_MODES.includes(
          value.displayMode as MCPToolUILayoutComponentRef['displayMode'] &
            string,
        )
      ) {
        return null;
      }
      renderer.displayMode =
        value.displayMode as MCPToolUILayoutComponentRef['displayMode'];
    }
    if (value.approvalPolicy !== undefined) {
      if (
        typeof value.approvalPolicy !== 'string' ||
        !MCP_APPROVAL_POLICIES.includes(
          value.approvalPolicy as MCPToolUILayoutComponentRef['approvalPolicy'] &
            string,
        )
      ) {
        return null;
      }
      renderer.approvalPolicy =
        value.approvalPolicy as MCPToolUILayoutComponentRef['approvalPolicy'];
    }
    if (value.initialArguments !== undefined) {
      const initialArguments = cloneWorkspacePaneInitialArguments(
        value.initialArguments,
      );
      if (!initialArguments) return null;
      renderer.initialArguments = initialArguments;
    }
    return renderer;
  }

  if (kind === 'standard-data') {
    if (!isPlainObject(value.view)) return null;
    const view = value.view;
    const incarnation = view.incarnation;
    if (
      !isNonEmptyTrimmedString(view.id) ||
      !isNonEmptyTrimmedString(view.projection) ||
      !isNonEmptyTrimmedString(view.schemaRef) ||
      view.readOnly !== true ||
      typeof incarnation !== 'number' ||
      !Number.isSafeInteger(incarnation) ||
      incarnation < 1
    ) {
      return null;
    }
    const contribution = parseLayoutCatalogContribution(view.contribution);
    if (!contribution) return null;
    return {
      kind: 'standard-data',
      view: {
        id: view.id,
        projection: view.projection,
        schemaRef: view.schemaRef,
        readOnly: true,
        contribution,
        incarnation,
      },
    };
  }

  return null;
}

/**
 * The one region vocabulary. Every acceptance check reads this list or a
 * value derived from it (`WorkspacePaneRegion`, the pane-host subset in
 * `workspace-composition.ts`), never a hand-written copy — so a region can
 * only be added in one place and no consumer can be left checking a stale set.
 *
 * What each word means, and who reads it:
 *
 * - `primary` / `secondary`: a position inside a pane host's composition.
 *   Read by `instantiateWorkspaceComposition`, which refuses a composition
 *   pane whose descriptor does not support the region it is placed in.
 * - `standalone`: the pane may be a route of its own. Read by the Home-role
 *   eligibility gate (`workspace-home-role.ts`), and — because a composition
 *   may also author a `standalone` slot — by `instantiateWorkspaceComposition`
 *   like the two words above.
 * - `docked`: the pane may occupy a shell region as a registered surface.
 *   Placement itself — which region, visibility, size — is decided by the
 *   shell's region registry (`src-ui/src/regions/region-model.ts`), not by
 *   this declaration. The word is a capability claim, pinned to that registry
 *   in both directions over the built-in descriptor constants
 *   (`src-ui/src/__tests__/docked-capability-derivation.test.ts`) and over the
 *   server's known declarations
 *   (`src-server/services/projects/__tests__/workspace-pane-known-declarations.test.ts`):
 *   every registered or ambient-dockable built-in declares it, and no other
 *   built-in in either set does (station#928). Descriptors that arrive through
 *   a plugin manifest, a portable kit, or a layout-tab adaptation are outside
 *   both pins; the parser accepts the word from them unchecked.
 */
export const WORKSPACE_PANE_REGIONS = [
  'primary',
  'secondary',
  'standalone',
  'docked',
] as const;
export type WorkspacePaneRegion = (typeof WORKSPACE_PANE_REGIONS)[number];

/** Bounded placement: which region a WorkspacePane may occupy, not pane/split/restoration behavior (#1371). */
export interface WorkspacePanePlacement {
  /** Every host region this descriptor supports. This is a capability set, not current host geometry. */
  supportedRegions: readonly WorkspacePaneRegion[];
  /** A portable preference when more than one supported region is available. */
  preferredRegion?: WorkspacePaneRegion;
  order?: number;
}

/** The exact Station identities a descriptor needs before a host may bind an instance. */
export interface WorkspacePaneContextRequirement {
  project?: true;
  task?: true;
  session?: true;
  run?: true;
  workspace?: true;
  source?: true;
  requiredProviders?: readonly string[];
  requiredAgents?: readonly string[];
}

/** One declared operating shape for a Workspace Pane. */
export interface WorkspacePaneMode {
  id: string;
  /** Omitted when this mode needs no host context. */
  contextRequirement?: WorkspacePaneContextRequirement;
}

/** Context kinds a host can supply to an occupant. */
export type WorkspacePaneSuppliableContexts = ReadonlySet<
  'project' | 'source' | 'workspace' | 'task' | 'session' | 'run'
>;

const WORKSPACE_PANE_SUPPLIABLE_CONTEXT_KEYS = [
  'project',
  'source',
  'workspace',
  'task',
  'session',
  'run',
] as const;

/**
 * Exact, host-neutral identity values captured by one placed instance. These
 * are deliberately separate from a descriptor's requirements: declaring that
 * a pane needs a Task never invents or authorizes a Task binding.
 */
export interface WorkspacePaneBoundContext {
  projectId?: string;
  /** Stable layout identity captured by this placed occurrence. */
  layoutId?: string;
  taskId?: string;
  sessionId?: string;
  /** Exact answer scope; never folded into stateKey/sourceId. */
  turnId?: string;
  /** Exact Task reference scope; never folded into stateKey/sourceId. */
  answerReferenceId?: string;
  runId?: string;
  workspaceId?: string;
  sourceId?: string;
  /** Exact catalog contribution for a layout-derived pane occurrence. */
  contribution?: LayoutCatalogContribution;
}

/** Bounded context declarations a host may use to decide what to hand a WorkspacePane; never an availability result. */

/** A user-visible action attached to a WorkspacePane. Reuses `LayoutAction`'s shape. */
export type WorkspacePaneAction = LayoutAction;

export type WorkspacePaneProvenanceOrigin = 'builtin' | 'plugin' | 'mcp';
const WORKSPACE_PANE_PROVENANCE_ORIGINS: readonly WorkspacePaneProvenanceOrigin[] =
  ['builtin', 'plugin', 'mcp'];

/**
 * Records who contributed a descriptor, separately from the renderer's
 * security kind. A plugin may contribute a sandboxed MCP App, so an
 * `origin: 'plugin'` record may also name the MCP server that owns its
 * renderer. The renderer ref remains the security boundary.
 */
export interface WorkspacePaneProvenance {
  origin: WorkspacePaneProvenanceOrigin;
  pluginId?: string;
  mcpServerId?: string;
}

export type WorkspacePaneLifecycleStage = 'stable' | 'preview' | 'deprecated';
const WORKSPACE_PANE_LIFECYCLE_STAGES: readonly WorkspacePaneLifecycleStage[] =
  ['stable', 'preview', 'deprecated'];

/** Bounded lifecycle declaration. Data-only: no mount/unmount hooks or renderer execution. */
export interface WorkspacePaneLifecycle {
  stage: WorkspacePaneLifecycleStage;
  since?: string;
  deprecationNotice?: string;
}

/** A bounded alternative renderer for when a descriptor's primary renderer is unavailable. */
export interface WorkspacePaneAlternativeRenderer {
  /** Optional independently-addressable alternative renderer identity. */
  rendererId?: WorkspacePaneRendererId;
  renderer: WorkspacePaneRendererRef;
  requiredCapabilities?: WorkspacePaneRendererCapability[];
  /** Optional independent attribution for the alternative renderer. */
  provenance?: WorkspacePaneProvenance;
  reason?: string;
}

/** The version `1.0` WorkspacePane descriptor shape. */
export interface WorkspacePaneDescriptor {
  version: WorkspacePaneContractVersion;
  id: WorkspacePaneDescriptorId;
  name: string;
  description?: string;
  icon?: string;
  /**
   * Optional catalog preview image reference. Presentation-only: pickers
   * render it as the card thumbnail and fall back to a generated placeholder
   * when absent. Never a capability fact.
   *
   * Bounded at the parse boundary to a SAME-ORIGIN asset — a relative or
   * root-relative path with no scheme, no protocol-relative `//` prefix, no
   * `..` traversal and no whitespace — or a small inline
   * `data:image/<png|jpeg|gif|webp|avif>;base64,…` payload. An absolute
   * `http(s)://` reference is rejected: this string is plugin-controlled and
   * a picker renders it into `img src` for every card, so an off-origin URL
   * would beacon each viewer's IP, user agent and browsing time to whoever
   * authored the descriptor. The Tauri CSP admits `http:`/`https:`/`data:`
   * and the browser-served UI ships no CSP at all, so the bound is here and
   * not in a header. `svg+xml` is excluded because an SVG payload carries
   * markup, and the placeholder is a better default than a format needing its
   * own sanitizer.
   *
   * See {@link isBoundedWorkspacePanePreviewImage}.
   */
  previewImage?: string;
  rendererId: WorkspacePaneRendererId;
  renderer: WorkspacePaneRendererRef;
  requiredRendererCapabilities?: WorkspacePaneRendererCapability[];
  placement: WorkspacePanePlacement;
  /** At least one declared mode. Hosts derive suitability from these requirements. */
  modes: [WorkspacePaneMode, ...WorkspacePaneMode[]];
  actions?: WorkspacePaneAction[];
  provenance: WorkspacePaneProvenance;
  lifecycle: WorkspacePaneLifecycle;
  alternativeRenderer?: WorkspacePaneAlternativeRenderer;
}

/**
 * One placed occurrence of a descriptor, persisted independently of it. Two
 * instances of the same descriptor carry independent `instanceId` and
 * `stateKey` identities: an instance is never inferred from its descriptor.
 */
export interface WorkspacePaneInstance {
  version: WorkspacePaneContractVersion;
  descriptorId: WorkspacePaneDescriptorId;
  instanceId: WorkspacePaneInstanceId;
  stateKey: WorkspacePaneStateKey;
  /** Exact context captured for this occurrence, never inferred from the descriptor. */
  boundContext?: WorkspacePaneBoundContext;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwnDataField(
  record: Record<string, unknown>,
  key: string,
): boolean {
  return Object.getOwnPropertyDescriptor(record, key) !== undefined;
}

function parsePlacement(value: unknown): WorkspacePanePlacement | null {
  if (!isPlainObject(value)) return null;
  // `region` was the pre-audit single-placement spelling. Keep it as a
  // lossless read-compat input while serializing only the capability set.
  const rawRegions =
    value.supportedRegions ??
    (value.region === undefined ? undefined : [value.region]);
  if (!Array.isArray(rawRegions) || rawRegions.length === 0) return null;
  if (
    !rawRegions.every(
      (region) =>
        typeof region === 'string' &&
        WORKSPACE_PANE_REGIONS.includes(region as WorkspacePaneRegion),
    )
  ) {
    return null;
  }
  const supportedRegions = [...rawRegions] as WorkspacePaneRegion[];
  if (new Set(supportedRegions).size !== supportedRegions.length) return null;
  const placement: WorkspacePanePlacement = { supportedRegions };
  if (value.preferredRegion !== undefined) {
    if (
      typeof value.preferredRegion !== 'string' ||
      !supportedRegions.includes(value.preferredRegion as WorkspacePaneRegion)
    ) {
      return null;
    }
    placement.preferredRegion = value.preferredRegion as WorkspacePaneRegion;
  } else if (value.region !== undefined) {
    placement.preferredRegion = value.region as WorkspacePaneRegion;
  }
  if (value.order !== undefined) {
    if (typeof value.order !== 'number' || !Number.isFinite(value.order)) {
      return null;
    }
    placement.order = value.order;
  }
  return placement;
}

export function parseWorkspacePaneContextRequirement(
  value: unknown,
): WorkspacePaneContextRequirement | null | undefined {
  if (value === undefined) return undefined;
  const snapshot = snapshotWorkspacePaneValue(value);
  if (!isPlainObject(snapshot)) return null;
  const requirementInput = snapshot;

  const requirement: WorkspacePaneContextRequirement = {};
  const legacyProject = requirementInput.requiresProject;
  if (legacyProject !== undefined && typeof legacyProject !== 'boolean')
    return null;
  for (const key of [
    'project',
    'task',
    'session',
    'run',
    'workspace',
    'source',
  ] as const) {
    const requirementValue = requirementInput[key];
    if (requirementValue !== undefined && requirementValue !== true)
      return null;
    if (requirementValue === true) requirement[key] = true;
  }
  if (legacyProject === true) {
    if (requirement.project === undefined) requirement.project = true;
  }
  if (requirementInput.requiredProviders !== undefined) {
    if (
      !Array.isArray(requirementInput.requiredProviders) ||
      !requirementInput.requiredProviders.every(isNonEmptyTrimmedString)
    ) {
      return null;
    }
    requirement.requiredProviders = [...requirementInput.requiredProviders];
  }
  if (requirementInput.requiredAgents !== undefined) {
    if (
      !Array.isArray(requirementInput.requiredAgents) ||
      !requirementInput.requiredAgents.every(isNonEmptyTrimmedString)
    ) {
      return null;
    }
    requirement.requiredAgents = [...requirementInput.requiredAgents];
  }
  return requirement;
}

function parseWorkspacePaneModes(
  value: unknown,
): [WorkspacePaneMode, ...WorkspacePaneMode[]] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const ids = new Set<string>();
  const modes: WorkspacePaneMode[] = [];
  for (const candidate of value) {
    if (!isPlainObject(candidate) || !isNonEmptyTrimmedString(candidate.id)) {
      return null;
    }
    if (ids.has(candidate.id)) return null;
    const contextRequirement = parseWorkspacePaneContextRequirement(
      candidate.contextRequirement,
    );
    if (contextRequirement === null) return null;
    ids.add(candidate.id);
    modes.push({
      id: candidate.id,
      ...(contextRequirement === undefined ? {} : { contextRequirement }),
    });
  }
  return modes as [WorkspacePaneMode, ...WorkspacePaneMode[]];
}

/**
 * The pane modes whose identity requirements `suppliable` satisfies, in
 * declaration order. Provider and agent requirements remain availability
 * inputs: they are not identities a host scope can supply.
 */
export function workspacePaneModesSatisfiableBy(
  descriptor: WorkspacePaneDescriptor,
  suppliable: WorkspacePaneSuppliableContexts,
): WorkspacePaneMode[] {
  return descriptor.modes.filter((mode) =>
    WORKSPACE_PANE_SUPPLIABLE_CONTEXT_KEYS.every(
      (key) => mode.contextRequirement?.[key] !== true || suppliable.has(key),
    ),
  );
}

/** Parses known exact context bindings and safely drops additive future fields. */
export function parseWorkspacePaneBoundContext(
  value: unknown,
): WorkspacePaneBoundContext | null | undefined {
  if (value === undefined) return undefined;
  const snapshot = snapshotWorkspacePaneValue(value);
  if (!isPlainObject(snapshot)) return null;
  const boundContextInput = snapshot;
  const boundContext: WorkspacePaneBoundContext = {};
  const keys = [
    'projectId',
    'layoutId',
    'taskId',
    'sessionId',
    'turnId',
    'answerReferenceId',
    'runId',
    'workspaceId',
    'sourceId',
  ] as const;
  for (const key of keys) {
    if (boundContextInput[key] === undefined) continue;
    if (
      !isNonEmptyTrimmedString(boundContextInput[key]) ||
      ((key === 'turnId' || key === 'answerReferenceId') &&
        !isBoundedBasisContextId(boundContextInput[key]))
    )
      return null;
    boundContext[key] = boundContextInput[key];
  }
  if (boundContextInput.contribution !== undefined) {
    const contribution = parseLayoutCatalogContribution(
      boundContextInput.contribution,
    );
    if (!contribution) return null;
    boundContext.contribution = contribution;
  }
  return boundContext;
}

/** Exact Basis anchors are untrusted transport values, never unbounded pane state. */
function isBoundedBasisContextId(value: string): boolean {
  if (value.length > 1_024) return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return new TextEncoder().encode(value).byteLength <= 1_024;
}

/**
 * Returns a parsed copy with the exact owning layout bound to it. Catalog
 * instances are immutable inputs: callers must retain the returned instance.
 */
export function withWorkspacePaneInstanceLayoutBinding(
  instance: WorkspacePaneInstance,
  layout: LayoutMetadata,
): WorkspacePaneInstance | null {
  // Accept the resolved layout record, not a caller-provided string: layout
  // slugs are display/routing values while this binding must capture its ID.
  if (!layout || !isNonEmptyTrimmedString(layout.id)) return null;
  return parseWorkspacePaneInstance({
    ...instance,
    boundContext: { ...instance.boundContext, layoutId: layout.id },
  });
}

/** Parses the exact catalog snapshot bound to a layout-derived pane. */
function parseLayoutCatalogContribution(
  value: unknown,
): LayoutCatalogContribution | null {
  if (!isPlainObject(value)) return null;
  if (
    !isNonEmptyTrimmedString(value.id) ||
    !isNonEmptyTrimmedString(value.version) ||
    !isPlainObject(value.sourceIdentity) ||
    !isPlainObject(value.provenance)
  ) {
    return null;
  }
  const sourceIdentity = value.sourceIdentity;
  if (
    !isNonEmptyTrimmedString(sourceIdentity.id) ||
    !['builtin', 'local', 'remote'].includes(sourceIdentity.kind as string)
  ) {
    return null;
  }
  if (
    sourceIdentity.source !== undefined &&
    !isNonEmptyTrimmedString(sourceIdentity.source)
  ) {
    return null;
  }
  const provenance = value.provenance;
  if (!['builtin', 'plugin', 'mcp'].includes(provenance.origin as string)) {
    return null;
  }
  if (
    provenance.pluginId !== undefined &&
    !isNonEmptyTrimmedString(provenance.pluginId)
  ) {
    return null;
  }
  if (
    provenance.mcpServerId !== undefined &&
    !isNonEmptyTrimmedString(provenance.mcpServerId)
  ) {
    return null;
  }
  if (
    (provenance.origin === 'builtin' &&
      (provenance.pluginId !== undefined ||
        provenance.mcpServerId !== undefined)) ||
    (provenance.origin === 'plugin' &&
      (provenance.pluginId === undefined ||
        provenance.mcpServerId !== undefined)) ||
    (provenance.origin === 'mcp' &&
      (provenance.pluginId !== undefined ||
        provenance.mcpServerId === undefined))
  ) {
    return null;
  }
  return {
    id: value.id,
    version: value.version,
    sourceIdentity: {
      id: sourceIdentity.id,
      kind: sourceIdentity.kind as LayoutCatalogContribution['sourceIdentity']['kind'],
      ...(sourceIdentity.source === undefined
        ? {}
        : { source: sourceIdentity.source }),
    },
    provenance: {
      origin:
        provenance.origin as LayoutCatalogContribution['provenance']['origin'],
      ...(provenance.pluginId === undefined
        ? {}
        : { pluginId: provenance.pluginId }),
      ...(provenance.mcpServerId === undefined
        ? {}
        : { mcpServerId: provenance.mcpServerId }),
    },
  };
}

function parseActions(
  value: unknown,
): WorkspacePaneAction[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;

  const actions: WorkspacePaneAction[] = [];
  for (const entry of value) {
    if (
      !isPlainObject(entry) ||
      !isNonEmptyTrimmedString(entry.label) ||
      typeof entry.data !== 'string' ||
      !['prompt', 'inline-prompt', 'external', 'internal'].includes(
        entry.type as string,
      )
    ) {
      return null;
    }
    const action: WorkspacePaneAction = {
      type: entry.type as WorkspacePaneAction['type'],
      label: entry.label,
      data: entry.data,
    };
    if (entry.icon !== undefined) {
      if (typeof entry.icon !== 'string') return null;
      action.icon = entry.icon;
    }
    if (entry.agent !== undefined) {
      if (typeof entry.agent !== 'string') return null;
      try {
        action.agent = agentId(entry.agent);
      } catch {
        return null;
      }
    }
    actions.push(action);
  }
  return actions;
}

function parseProvenance(
  value: unknown,
  renderer: WorkspacePaneRendererRef,
): WorkspacePaneProvenance | null {
  if (!isPlainObject(value)) return null;
  const origin = value.origin;
  if (
    typeof origin !== 'string' ||
    !WORKSPACE_PANE_PROVENANCE_ORIGINS.includes(
      origin as WorkspacePaneProvenanceOrigin,
    )
  ) {
    return null;
  }
  const provenance: WorkspacePaneProvenance = {
    origin: origin as WorkspacePaneProvenanceOrigin,
  };
  if (value.pluginId !== undefined) {
    if (!isNonEmptyTrimmedString(value.pluginId)) return null;
    provenance.pluginId = value.pluginId;
  }
  if (value.mcpServerId !== undefined) {
    if (!isNonEmptyTrimmedString(value.mcpServerId)) return null;
    provenance.mcpServerId = value.mcpServerId;
  }

  switch (provenance.origin) {
    case 'builtin':
      if (
        provenance.pluginId !== undefined ||
        provenance.mcpServerId !== undefined ||
        renderer.kind !== 'builtin-component'
      ) {
        return null;
      }
      break;
    case 'plugin':
      if (provenance.pluginId === undefined) {
        return null;
      }
      if (
        renderer.kind === 'builtin-component' ||
        renderer.kind === 'plugin-component' ||
        renderer.kind === 'standard-data'
      ) {
        if (provenance.mcpServerId !== undefined) return null;
        break;
      }
      if (renderer.kind !== 'mcp-tool-ui') return null;
      if (provenance.mcpServerId === undefined) return null;
      if (parseMcpToolRef(renderer.ref)?.serverId !== provenance.mcpServerId)
        return null;
      break;
    case 'mcp': {
      if (
        provenance.mcpServerId === undefined ||
        provenance.pluginId !== undefined
      ) {
        return null;
      }
      if (renderer.kind !== 'mcp-tool-ui') return null;
      const parts = parseMcpToolRef(renderer.ref);
      if (!parts) return null;
      if (provenance.mcpServerId !== parts.serverId) return null;
      break;
    }
  }

  return provenance;
}

function parseLifecycle(value: unknown): WorkspacePaneLifecycle | null {
  if (!isPlainObject(value)) return null;
  const stage = value.stage;
  if (
    typeof stage !== 'string' ||
    !WORKSPACE_PANE_LIFECYCLE_STAGES.includes(
      stage as WorkspacePaneLifecycleStage,
    )
  ) {
    return null;
  }
  const lifecycle: WorkspacePaneLifecycle = {
    stage: stage as WorkspacePaneLifecycleStage,
  };
  if (value.since !== undefined) {
    if (!isNonEmptyTrimmedString(value.since)) return null;
    lifecycle.since = value.since;
  }
  if (value.deprecationNotice !== undefined) {
    if (!isNonEmptyTrimmedString(value.deprecationNotice)) return null;
    lifecycle.deprecationNotice = value.deprecationNotice;
  }
  if (lifecycle.stage !== 'deprecated' && lifecycle.deprecationNotice) {
    return null;
  }
  return lifecycle;
}

const WORKSPACE_PANE_RENDERER_CAPABILITIES: readonly WorkspacePaneRendererCapability[] =
  ['trusted-plugin-react', 'sandboxed-mcp-app', 'sandboxed-plugin-frame'];

function parseRendererCapabilities(
  value: unknown,
): WorkspacePaneRendererCapability[] | null | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    !value.every(
      (capability) =>
        typeof capability === 'string' &&
        WORKSPACE_PANE_RENDERER_CAPABILITIES.includes(
          capability as WorkspacePaneRendererCapability,
        ),
    ) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  return [...value] as WorkspacePaneRendererCapability[];
}

function parseAlternativeRenderer(
  value: unknown,
): WorkspacePaneAlternativeRenderer | null | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) return null;
  const renderer = parseWorkspacePaneRendererRef(value.renderer);
  if (!renderer) return null;

  const alternativeRenderer: WorkspacePaneAlternativeRenderer = { renderer };
  if (value.rendererId !== undefined) {
    if (!isNonEmptyTrimmedString(value.rendererId)) return null;
    alternativeRenderer.rendererId = toWorkspacePaneRendererId(
      value.rendererId,
    );
  }
  if (value.provenance !== undefined) {
    const provenance = parseProvenance(value.provenance, renderer);
    if (!provenance) return null;
    alternativeRenderer.provenance = provenance;
  }
  const requiredCapabilities = parseRendererCapabilities(
    value.requiredCapabilities,
  );
  if (requiredCapabilities === null) return null;
  if (requiredCapabilities !== undefined) {
    alternativeRenderer.requiredCapabilities = requiredCapabilities;
  }
  if (value.reason !== undefined) {
    if (!isNonEmptyTrimmedString(value.reason)) return null;
    alternativeRenderer.reason = value.reason;
  }
  return alternativeRenderer;
}

/**
 * Parses and validates an untrusted candidate into a normalized
 * `WorkspacePaneDescriptor`, or returns `null`. Additive unknown fields on the
 * candidate (or its nested objects) are dropped rather than rejected;
 * malformed renderer, rendererId, context, provenance, lifecycle, or
 * identity fields fail closed. `rendererId` is validated and normalized
 * independently of `id`/`renderer` — it is never derived from either.
 */
export function parseWorkspacePaneDescriptor(
  input: unknown,
): WorkspacePaneDescriptor | null {
  const snapshot = snapshotWorkspacePaneValue(input);
  if (!isPlainObject(snapshot)) return null;
  const descriptorInput = snapshot;
  // Reject the removed descriptor key explicitly instead of silently omitting
  // its renderer from the normalized projection.
  if (hasOwnDataField(descriptorInput, 'fallback')) return null;
  if (descriptorInput.version !== WORKSPACE_PANE_CONTRACT_VERSION) return null;
  if (!isNonEmptyTrimmedString(descriptorInput.id)) return null;
  if (!isNonEmptyTrimmedString(descriptorInput.name)) return null;
  if (!isNonEmptyTrimmedString(descriptorInput.rendererId)) return null;
  const renderer = parseWorkspacePaneRendererRef(descriptorInput.renderer);
  if (!renderer) return null;
  const requiredRendererCapabilities = parseRendererCapabilities(
    descriptorInput.requiredRendererCapabilities,
  );
  if (requiredRendererCapabilities === null) return null;

  const placement = parsePlacement(descriptorInput.placement);
  if (!placement) return null;

  if (hasOwnDataField(descriptorInput, 'dockability')) return null;
  if (hasOwnDataField(descriptorInput, 'contextRequirement')) return null;
  const modes = parseWorkspacePaneModes(descriptorInput.modes);
  if (!modes) return null;

  const actions = parseActions(descriptorInput.actions);
  if (actions === null) return null;

  const provenance = parseProvenance(descriptorInput.provenance, renderer);
  if (!provenance) return null;
  if (
    renderer.kind === 'standard-data' &&
    JSON.stringify(renderer.view.contribution.provenance) !==
      JSON.stringify(provenance)
  ) {
    return null;
  }

  const lifecycle = parseLifecycle(descriptorInput.lifecycle);
  if (!lifecycle) return null;

  const alternativeRenderer = parseAlternativeRenderer(
    descriptorInput.alternativeRenderer,
  );
  if (alternativeRenderer === null) return null;

  const descriptor: WorkspacePaneDescriptor = {
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    id: toWorkspacePaneDescriptorId(descriptorInput.id),
    name: descriptorInput.name,
    rendererId: toWorkspacePaneRendererId(descriptorInput.rendererId),
    renderer,
    placement,
    modes,
    provenance,
    lifecycle,
  };
  if (requiredRendererCapabilities !== undefined) {
    descriptor.requiredRendererCapabilities = requiredRendererCapabilities;
  }
  if (descriptorInput.description !== undefined) {
    if (!isNonEmptyTrimmedString(descriptorInput.description)) return null;
    descriptor.description = descriptorInput.description;
  }
  if (descriptorInput.icon !== undefined) {
    if (!isNonEmptyTrimmedString(descriptorInput.icon)) return null;
    descriptor.icon = descriptorInput.icon;
  }
  if (descriptorInput.previewImage !== undefined) {
    if (!isBoundedWorkspacePanePreviewImage(descriptorInput.previewImage)) {
      return null;
    }
    descriptor.previewImage = descriptorInput.previewImage;
  }
  if (actions !== undefined) {
    descriptor.actions = actions;
  }
  if (alternativeRenderer !== undefined) {
    descriptor.alternativeRenderer = alternativeRenderer;
  }
  return descriptor;
}

/**
 * Parses and validates an untrusted candidate into a normalized
 * `WorkspacePaneInstance`, or returns `null`. A persisted instance requires a
 * supported `version` in addition to its three independently validated
 * identity fields; none may be derived from another.
 */
export function parseWorkspacePaneInstance(
  input: unknown,
): WorkspacePaneInstance | null {
  const snapshot = snapshotWorkspacePaneValue(input);
  if (!isPlainObject(snapshot)) return null;
  const instanceInput = snapshot;
  if (instanceInput.version !== WORKSPACE_PANE_CONTRACT_VERSION) return null;
  if (
    !isNonEmptyTrimmedString(instanceInput.descriptorId) ||
    !isNonEmptyTrimmedString(instanceInput.instanceId) ||
    !isNonEmptyTrimmedString(instanceInput.stateKey)
  ) {
    return null;
  }
  const boundContext = parseWorkspacePaneBoundContext(
    instanceInput.boundContext,
  );
  if (boundContext === null) return null;
  const instance: WorkspacePaneInstance = {
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    descriptorId: toWorkspacePaneDescriptorId(instanceInput.descriptorId),
    instanceId: toWorkspacePaneInstanceId(instanceInput.instanceId),
    stateKey: toWorkspacePaneStateKey(instanceInput.stateKey),
  };
  if (boundContext !== undefined) instance.boundContext = boundContext;
  return instance;
}
