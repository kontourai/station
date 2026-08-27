import type { AgentId } from './agent-identity.js';

/**
 * Stable, data-only identity of the source that supplied a catalog
 * contribution. It identifies an installed contribution without implying
 * that its renderer is available or authorized.
 */
export interface LayoutContributionSourceIdentity {
  id: string;
  kind: 'builtin' | 'local' | 'remote';
  source?: string;
}

/** Attribution of a catalog contribution, distinct from a pane renderer. */
export interface LayoutContributionProvenance {
  origin: 'builtin' | 'plugin' | 'mcp';
  pluginId?: string;
  mcpServerId?: string;
}

/**
 * Exact catalog contribution selected when a project layout is applied.
 * The snapshot deliberately carries source, version, and attribution so a
 * later pane host never reconstructs them from a layout slug or tab string.
 */
export interface LayoutCatalogContribution {
  id: string;
  version: string;
  sourceIdentity: LayoutContributionSourceIdentity;
  provenance: LayoutContributionProvenance;
}

export interface LayoutConfig {
  id: string;
  projectSlug: string;
  type: string;
  name: string;
  slug: string;
  icon?: string;
  description?: string;
  /** Present only for a layout created from a catalog contribution. */
  catalogContribution?: LayoutCatalogContribution;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LayoutMetadata {
  id: string;
  slug: string;
  projectSlug: string;
  type: string;
  name: string;
  icon?: string;
  description?: string;
  plugin?: string;
  tabCount?: number;
}

export interface AvailableProjectLayout {
  source: 'builtin' | 'plugin';
  plugin?: string;
  name: string;
  slug: string;
  icon?: string;
  description?: string;
  type: string;
}

/**
 * The safe starter that every Station installation can create without a
 * registry, plugin, or network dependency.
 */
export const BUILTIN_CODING_LAYOUT: AvailableProjectLayout = Object.freeze({
  source: 'builtin',
  name: 'Coding',
  slug: 'coding',
  icon: '🔧',
  description: 'Files, changes, terminal, and chat',
  type: 'coding',
});

/** Dependency-free task starter backed by Station's existing task service. */
export const BUILTIN_TASKS_LAYOUT: AvailableProjectLayout = Object.freeze({
  source: 'builtin',
  name: 'Tasks',
  slug: 'tasks',
  icon: '✓',
  description: 'Project tasks and workflow status',
  type: 'tasks',
});

/**
 * Dependency-free session board starter. Backed by the existing session
 * board service/UI (issue #586 will swap the renderer for the Console board
 * component; this catalog entry and its `session-board` type are the stable
 * swap point).
 */
export const BUILTIN_SESSION_BOARD_LAYOUT: AvailableProjectLayout =
  Object.freeze({
    source: 'builtin',
    name: 'Session Board',
    slug: 'session-board',
    icon: '📋',
    description: 'Live board of sessions across this project',
    type: 'session-board',
  });

/** The server owns this list so callers never inject a starter independently. */
export const BUILTIN_PROJECT_LAYOUTS: readonly AvailableProjectLayout[] =
  Object.freeze([
    BUILTIN_CODING_LAYOUT,
    BUILTIN_TASKS_LAYOUT,
    BUILTIN_SESSION_BOARD_LAYOUT,
  ]);

export interface LayoutAction {
  type: 'prompt' | 'inline-prompt' | 'external' | 'internal';
  label: string;
  icon?: string;
  agent?: AgentId;
  data: string;
}

export interface PluginLayoutComponentRef {
  kind: 'plugin-component';
  name: string;
}

export interface BuiltinLayoutComponentRef {
  kind: 'builtin-component';
  name: string;
}

export interface MCPToolUILayoutComponentRef {
  kind: 'mcp-tool-ui';
  ref: string;
  resourceUri?: string;
  displayMode?: 'inline' | 'fullscreen' | 'pip';
  fallbackComponent?: string;
  initialArguments?: Record<string, unknown>;
  approvalPolicy?: 'inherit' | 'require' | 'read-only';
}

export type LayoutComponentRef =
  | PluginLayoutComponentRef
  | BuiltinLayoutComponentRef
  | MCPToolUILayoutComponentRef;

/**
 * Capabilities that a layout renderer may require from its host. These describe
 * a rendering boundary only; they do not authorize a plugin or an MCP tool.
 */
export type LayoutRendererCapability =
  | 'trusted-plugin-react'
  | 'sandboxed-mcp-app'
  | 'sandboxed-plugin-frame';

/** A declared alternative renderer, selected only when its requirements hold. */
export interface LayoutAlternativeRenderer {
  /** Optional independently-addressable identity retained with this declaration. */
  rendererId?: string;
  component: LayoutComponentRef;
  /** Optional independent attribution retained with this declaration. */
  provenance?: LayoutContributionProvenance;
  requiredCapabilities?: LayoutRendererCapability[];
  reason?: string;
}

export interface LayoutTab {
  id: string;
  label: string;
  component: string | LayoutComponentRef;
  /** Capabilities required by this tab's primary renderer. */
  requiredRendererCapabilities?: LayoutRendererCapability[];
  /** A separately declared renderer the host may select when appropriate. */
  alternativeRenderer?: LayoutAlternativeRenderer;
  icon?: string;
  description?: string;
  actions?: LayoutAction[];
  skills?: LayoutAction[];
}

export interface LayoutSkill {
  id: string;
  label: string;
  prompt: string;
  agent?: AgentId;
}

export interface LayoutTemplate {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  type: string;
  config: Record<string, unknown>;
  createdAt: string;
}

export interface LayoutDefinition {
  name: string;
  slug: string;
  icon?: string;
  description?: string;
  plugin?: string;
  requiredProviders?: string[];
  availableAgents?: AgentId[];
  defaultAgent?: AgentId;
  tabs: LayoutTab[];
  actions?: LayoutAction[];
  /** Global skills surfaced in the layout header. */
  globalSkills?: LayoutSkill[];
}

export interface LayoutDefinitionMetadata {
  slug: string;
  name: string;
  icon?: string;
  description?: string;
  plugin?: string;
  tabCount: number;
}

export interface MCPToolRefParts {
  serverId: string;
  toolName: string;
}

const MCP_TOOL_REF_PART_PATTERN = /^[^\s/]+$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidMcpToolRefPart(value: string): boolean {
  return MCP_TOOL_REF_PART_PATTERN.test(value);
}

export function parseMcpToolRef(ref: string): MCPToolRefParts | null {
  if (!isNonEmptyString(ref) || ref !== ref.trim()) {
    return null;
  }

  const parts = ref.split('/');
  if (parts.length !== 2) {
    return null;
  }

  const [serverId, toolName] = parts;
  if (
    !isNonEmptyString(serverId) ||
    !isNonEmptyString(toolName) ||
    !isValidMcpToolRefPart(serverId) ||
    !isValidMcpToolRefPart(toolName)
  ) {
    return null;
  }

  return { serverId, toolName };
}

export function isValidMcpToolRef(ref: string): boolean {
  return parseMcpToolRef(ref) !== null;
}

export function formatMcpToolRef(serverId: string, toolName: string): string {
  if (
    !isNonEmptyString(serverId) ||
    !isNonEmptyString(toolName) ||
    serverId !== serverId.trim() ||
    toolName !== toolName.trim() ||
    !isValidMcpToolRefPart(serverId) ||
    !isValidMcpToolRefPart(toolName)
  ) {
    throw new TypeError(
      'MCP tool UI refs require non-empty serverId and toolName without whitespace or slashes',
    );
  }

  return `${serverId}/${toolName}`;
}

export function isLayoutComponentRef(
  component: unknown,
): component is LayoutComponentRef {
  if (!component || typeof component !== 'object' || Array.isArray(component)) {
    return false;
  }

  const candidate = component as Partial<LayoutComponentRef>;
  if (
    candidate.kind === 'plugin-component' ||
    candidate.kind === 'builtin-component'
  ) {
    return isNonEmptyString(candidate.name);
  }

  if (candidate.kind === 'mcp-tool-ui') {
    return isNonEmptyString(candidate.ref) && isValidMcpToolRef(candidate.ref);
  }

  return false;
}

export function normalizeLayoutComponentRef(
  component: string | LayoutComponentRef,
): LayoutComponentRef {
  if (typeof component === 'string') {
    return { kind: 'plugin-component', name: component };
  }

  if (!isLayoutComponentRef(component)) {
    throw new TypeError('Invalid layout component reference');
  }

  return component;
}

/**
 * Keys the Playbooks→Skills merge retired, paired with what replaced them.
 *
 * Station is pre-release and takes no alias window (ADR-0016), so a stored or
 * plugin-authored layout still on one of these is REFUSED by name. The
 * alternative a parser reaches for by default — read the new key, find
 * nothing, carry on — turns a rename into silently missing quick actions on a
 * layout that looks like it loaded fine (review M1).
 */
const RETIRED_LAYOUT_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['globalPrompts', 'globalSkills'],
  ['prompts', 'skills'],
];

/** The repo's server tsconfig lib predates `Object.hasOwn`. */
function declaresKey(value: Record<string, unknown>, key: string): boolean {
  // biome-ignore lint/suspicious/noPrototypeBuiltins: Object.hasOwn is not in this project's lib target
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * A layout author's mistake, not a storage failure — its own type so a caller
 * reports it as the 400 it is instead of laundering it into whatever its
 * generic catch says (station's `GET /:slug/layouts/:layoutSlug` reported it as
 * "Layout storage is unavailable", which is a label nothing derived).
 */
export class RetiredLayoutKeyError extends Error {
  readonly code = 'RETIRED_LAYOUT_KEY';

  constructor(
    readonly path: string,
    readonly retiredKey: string,
    readonly replacementKey: string,
  ) {
    super(
      `${path} uses the retired layout key '${retiredKey}'; rename it to '${replacementKey}' (ADR-0016: Playbooks are Skills, and there is no alias)`,
    );
    this.name = 'RetiredLayoutKeyError';
  }
}

/**
 * Refuse a raw layout definition that still names a retired key, at the top
 * level and on each tab.
 *
 * Called by every parser that turns stored or plugin-authored JSON into a
 * `LayoutDefinition`, so the refusal is one derivation rather than one per
 * reader — which is exactly how the tab-level rename got missed three times.
 *
 * `label` names the source in the message (a plugin name, a file path), so the
 * author is told WHICH layout to fix rather than only that one is wrong.
 */
export function assertNoRetiredLayoutKeys(
  value: unknown,
  label = 'Layout',
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const layout = value as Record<string, unknown>;

  for (const [retired, replacement] of RETIRED_LAYOUT_KEYS) {
    // `prompts` is only retired as a TAB key; a top-level `prompts` never
    // existed on a layout, so claiming one is retired would be a lie.
    if (retired === 'prompts') continue;
    if (declaresKey(layout, retired)) {
      throw new RetiredLayoutKeyError(label, retired, replacement);
    }
  }

  if (!Array.isArray(layout.tabs)) return;
  layout.tabs.forEach((tab, index) => {
    if (!tab || typeof tab !== 'object' || Array.isArray(tab)) return;
    for (const [retired, replacement] of RETIRED_LAYOUT_KEYS) {
      if (declaresKey(tab as Record<string, unknown>, retired)) {
        throw new RetiredLayoutKeyError(
          `${label} tab[${index}]`,
          retired,
          replacement,
        );
      }
    }
  });
}
