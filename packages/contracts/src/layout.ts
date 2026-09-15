import type { AgentId } from './agent-identity.js';
import { isPrincipalRef, type PrincipalRef } from './principal.js';

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

/**
 * Who a Layout belongs to (design: docs/design/shell-ownership-and-boards.md,
 * decision D1). Station stored Layouts under exactly one scope — a Project —
 * until Boards; a Board is a Layout whose owner is a principal rather than a
 * project, and an instance-owned Layout is the operator's "everyone on this
 * Station sees this" page.
 *
 * Shaped after {@link KnowledgeRootScope} (`knowledge-store.ts`), which is the
 * repo's existing answer to the same question for a different record, so the
 * two scope vocabularies read alike rather than diverging.
 */
export type LayoutOwner =
  | { kind: 'project'; projectSlug: string }
  | { kind: 'principal'; principal: PrincipalRef }
  | { kind: 'instance' };

/** The single instance owner value; there is exactly one Station instance. */
export const INSTANCE_LAYOUT_OWNER: LayoutOwner = Object.freeze({
  kind: 'instance',
});

/**
 * A stored Layout whose ownership fields contradict each other, or name no
 * owner at all. Its own type so a storage parser reports the author/record
 * fault it is rather than laundering it into a generic "storage is
 * unavailable" (the same reason {@link RetiredLayoutKeyError} exists).
 */
export class InvalidLayoutOwnerError extends TypeError {
  readonly code = 'INVALID_LAYOUT_OWNER';

  constructor(reason: string) {
    super(`Layout owner is invalid: ${reason}`);
    this.name = 'InvalidLayoutOwnerError';
  }
}

/** The ownership fields of a Layout record — the input `layoutOwner` reads. */
export interface LayoutOwnership {
  readonly projectSlug?: string;
  readonly owner?: LayoutOwner;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Derive a Layout's owner — the ONE place the ownership question is answered.
 *
 * Project-owned records carry `projectSlug` and no `owner`, exactly as every
 * record written before Boards existed, so nothing on disk changed and a
 * legacy record is project-owned by derivation rather than by a migration
 * that stamped a label on it. Principal- and instance-owned records carry
 * `owner` and no `projectSlug`.
 *
 * Throws {@link InvalidLayoutOwnerError} rather than preferring one field,
 * because a record naming two owners has no correct reading: picking either
 * one silently relocates somebody's Layout.
 */
export function layoutOwner(record: LayoutOwnership): LayoutOwner {
  const { owner, projectSlug } = record;

  if (owner === undefined) {
    if (!isNonBlankString(projectSlug)) {
      throw new InvalidLayoutOwnerError(
        'a record with no `owner` must carry a non-empty `projectSlug`',
      );
    }
    return { kind: 'project', projectSlug };
  }

  if (owner === null || typeof owner !== 'object' || Array.isArray(owner)) {
    throw new InvalidLayoutOwnerError('`owner` must be an owner object');
  }

  switch (owner.kind) {
    case 'project': {
      if (!isNonBlankString(owner.projectSlug)) {
        throw new InvalidLayoutOwnerError(
          'a project owner must name a non-empty `projectSlug`',
        );
      }
      if (projectSlug !== undefined && projectSlug !== owner.projectSlug) {
        throw new InvalidLayoutOwnerError(
          `\`projectSlug\` ${JSON.stringify(projectSlug)} contradicts owner.projectSlug ${JSON.stringify(owner.projectSlug)}`,
        );
      }
      return { kind: 'project', projectSlug: owner.projectSlug };
    }
    case 'principal': {
      if (projectSlug !== undefined) {
        throw new InvalidLayoutOwnerError(
          'a principal-owned layout cannot also carry `projectSlug` — it is owned by one or the other, never both',
        );
      }
      if (!isPrincipalRef(owner.principal)) {
        throw new InvalidLayoutOwnerError(
          'a principal owner must carry a well-formed PrincipalRef',
        );
      }
      return { kind: 'principal', principal: owner.principal };
    }
    case 'instance': {
      if (projectSlug !== undefined) {
        throw new InvalidLayoutOwnerError(
          'an instance-owned layout cannot also carry `projectSlug` — it is owned by one or the other, never both',
        );
      }
      return INSTANCE_LAYOUT_OWNER;
    }
    default:
      throw new InvalidLayoutOwnerError(
        `unknown owner kind ${JSON.stringify((owner as { kind?: unknown }).kind)}`,
      );
  }
}

/**
 * The owning project's slug, or `undefined` for a Layout no project owns.
 * Callers that route by project (every project layout route today) use this
 * rather than reading `projectSlug` directly, so a Board never falls through
 * a `=== undefined` branch that was written when every Layout had one.
 */
export function layoutOwnerProjectSlug(
  record: LayoutOwnership,
): string | undefined {
  const owner = layoutOwner(record);
  return owner.kind === 'project' ? owner.projectSlug : undefined;
}

export interface LayoutConfig {
  id: string;
  /**
   * Present on a project-owned Layout only, and still the ONLY ownership
   * field such a record persists — a pre-Boards record is byte-identical
   * under this contract. Read ownership through {@link layoutOwner}, never
   * this field directly.
   */
  projectSlug?: string;
  /**
   * Written only for a Layout no project owns. Absent means project-owned,
   * derived from `projectSlug` by {@link layoutOwner}.
   */
  owner?: LayoutOwner;
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

/**
 * Which of a layout's own tabs the CALLER reading it may not be shown
 * (#2090) — a RESPONSE-ONLY field, never persisted and never accepted from a
 * request body.
 *
 * ## It carries no reason on purpose
 *
 * A layout tab whose plugin the viewer cannot see is indistinguishable, to
 * the server, from a tab naming a plugin that was never installed: the
 * visibility predicate reads a grant list, not the install tree, so both
 * answer "cannot see". That indistinguishability is what stops the layout
 * read being an existence oracle (#2103), and a reason code, a source, or an
 * action would give it back. The one sentence a reader sees asserts no
 * cause and is client-side copy.
 *
 * This is deliberately NOT a `WorkspacePaneAvailability`: that vocabulary's
 * `pane-not-available-to-viewer` reason stamps `source: 'visibility'`, and
 * `workspace-pane-catalog.ts` already records the precedent that a pane
 * whose subject is not here gets no availability sentence at all.
 *
 * ## Its PRESENCE is also a signal
 *
 * A response carrying this field has had its plugin binding withheld —
 * `catalogContribution`, `config.plugin` and the plugin's global actions are
 * gone from it. `resolveProjectLayoutRendererKind` reads that presence,
 * because the fields it normally dispatches on are the ones removed.
 * `unavailableTabIds` may therefore be empty for a layout that stores no
 * tabs; absence of the whole field, not an empty array, is what means
 * "nothing was withheld".
 */
export interface LayoutPaneReferences {
  /** Ids of this layout's `config.tabs` entries that cannot be shown. */
  readonly unavailableTabIds: readonly string[];
}

export interface LayoutMetadata {
  id: string;
  slug: string;
  /** Project-owned listings only; see {@link LayoutConfig.projectSlug}. */
  projectSlug?: string;
  /** Non-project listings only; see {@link LayoutConfig.owner}. */
  owner?: LayoutOwner;
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

/**
 * Dependency-free review starter (#2065, `docs/design/shell-ownership-and-boards.md`
 * D4). Backed by the Survey review workbench Station already composes through
 * `SurveyFlowReviewService`, plus the project's pending proposed changes and
 * its independent-review receipts. It is the project-scoped successor to the
 * retired global `/review-queue` destination.
 *
 * Its `slug` equals its `type`, like every other starter here — the legacy
 * `/review-queue` redirect derives `/projects/<slug>/layouts/review` from that
 * equality, so the two must not drift apart.
 */
export const BUILTIN_REVIEW_LAYOUT: AvailableProjectLayout = Object.freeze({
  source: 'builtin',
  name: 'Review',
  slug: 'review',
  icon: '🔍',
  description: 'Pending changes, paused gate reviews, and review evidence',
  type: 'review',
});

/**
 * The canonical deep link into a Project's Review layout (#2065). One
 * derivation, because three producers need it — the attention projection's
 * proposed-change and gate-review rows, starter work's independent-review
 * inspection card, and the retired `/review-queue` redirect — and three
 * hand-built spellings that agree today are three that can drift tomorrow.
 *
 * `params` carries the item selector the layout reads (`change`, `review`,
 * or `receipt`).
 */
export function projectReviewLayoutHref(
  projectSlug: string,
  params?: Readonly<Record<string, string>>,
): string {
  const search = new URLSearchParams(params).toString();
  return `/projects/${encodeURIComponent(projectSlug)}/layouts/${BUILTIN_REVIEW_LAYOUT.slug}${search ? `?${search}` : ''}`;
}

/** The server owns this list so callers never inject a starter independently. */
export const BUILTIN_PROJECT_LAYOUTS: readonly AvailableProjectLayout[] =
  Object.freeze([
    BUILTIN_CODING_LAYOUT,
    BUILTIN_TASKS_LAYOUT,
    BUILTIN_SESSION_BOARD_LAYOUT,
    BUILTIN_REVIEW_LAYOUT,
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
