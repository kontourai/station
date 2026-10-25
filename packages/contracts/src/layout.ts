import type { AgentId } from './agent-identity.js';
import type { PersonalBoardDefinition } from './personal-board.js';
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
  /**
   * Opaque and server-issued: changes whenever this contribution's
   * installation is replaced (a reinstall of the same version included) or
   * its enablement is changed, and never repeats. What a host records against
   * an occurrence it opened, so one opened before a disable or a reinstall is
   * not taken for the current installation. `null` when the server cannot
   * vouch for the lifecycle history (lost, unreadable or rewritten): a host
   * admits no occurrence under it. Identity only, never a permission; absent
   * from a server that does not issue it.
   */
  lifecycleGeneration?: string | null;
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

/** The Project a layout looks at. Absence on a personal record remains a Board/template. */
export interface LayoutSubject {
  kind: 'project';
  projectSlug: string;
}

/** Derive subject without changing legacy stored records or granting access. */
export function layoutSubject(
  record: LayoutOwnership & { subject?: LayoutSubject },
): LayoutSubject | undefined {
  const owner = layoutOwner(record);
  const subject = record.subject;
  if (
    subject !== undefined &&
    (subject.kind !== 'project' || !isNonBlankString(subject.projectSlug))
  ) {
    throw new TypeError('Invalid layout subject');
  }
  if (owner.kind === 'project') {
    if (subject && subject.projectSlug !== owner.projectSlug)
      throw new TypeError('Layout subject contradicts its project owner');
    return { kind: 'project', projectSlug: owner.projectSlug };
  }
  if (owner.kind === 'instance' && subject)
    throw new TypeError('Instance layouts have no subject');
  return subject;
}

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

export type LayoutWorkspaceBinding = 'repository';

/** A legacy Coding record remains repository-bound even without its plugin. */
export function layoutUsesRepositoryWorkspace(layout: {
  type?: string;
  workspaceBinding?: LayoutWorkspaceBinding;
}): boolean {
  return layout.workspaceBinding === 'repository' || layout.type === 'coding';
}

/** Parse the optional declaration; null and unknown bindings are invalid. */
export function parseLayoutWorkspaceBinding(
  value: unknown,
): LayoutWorkspaceBinding | undefined {
  if (value === undefined || value === 'repository') return value;
  throw new TypeError(
    'Layout workspaceBinding must be repository when supplied',
  );
}

/**
 * The layout contract fields of `docs/design/shell-plugins-distributions.md`
 * ("Layout contract fields", slice a, #2995). Any layout, built-in or
 * contributed, may declare them, and the shell honours them generically:
 *
 * - `primary: 'chat'` claims the centre for Chat. While such a layout is
 *   mounted the shell suspends the dock's Chat, and ⌘D (`dock.toggle`)
 *   focuses the layout's Chat instead of toggling the dock. A contributed
 *   layout keeps the claim only while its plugin holds
 *   {@link LAYOUT_PRIMARY_CHAT_PERMISSION}.
 * - `presentation: 'stack'` is the Chat → drill-in navigation stack, with a
 *   breadcrumb, an icon rail and Back. `tabs`, the default, is the tab host.
 * - `drillIns` are the pane descriptor ids a stack layout may push, in rail
 *   order. Each resolves at runtime through the ordinary pane availability
 *   check; one the catalog does not issue is simply not on the rail.
 */
export type LayoutPrimary = 'chat';
export type LayoutPresentation = 'stack' | 'tabs';

export interface LayoutPresentationDeclaration {
  readonly primary?: LayoutPrimary;
  readonly presentation?: LayoutPresentation;
  readonly drillIns?: readonly string[];
}

/**
 * The plugin permission a contributed layout needs for `primary: 'chat'`
 * (the design's `layout.primaryChat` grant). It is an ordinary install-time
 * plugin permission (`PERMISSION_TIERS`), granted when the operator approves
 * it; without the grant the server answers the layout without its claim.
 */
export const LAYOUT_PRIMARY_CHAT_PERMISSION = 'layout.primaryChat';

/** Upper bound on declared drill-ins; one more is refused, not truncated. */
export const MAX_LAYOUT_DRILL_INS = 16;

/**
 * A layout author's declaration that cannot be honoured — its own type so a
 * route reports the author's fault instead of a storage failure, as
 * {@link RetiredLayoutKeyError} does.
 */
export class InvalidLayoutDeclarationError extends TypeError {
  readonly code = 'INVALID_LAYOUT_DECLARATION';

  constructor(label: string, reason: string) {
    super(`${label} declaration is invalid: ${reason}`);
    this.name = 'InvalidLayoutDeclarationError';
  }
}

export interface ParseLayoutPresentationDeclarationOptions {
  /**
   * Whether a drill-in id names a pane this layout's contributor can place.
   * For a plugin layout that is one of its own declared Workspace Panes.
   */
  resolvesDrillIn(paneId: string): boolean;
  /** Names the source in a refusal (a plugin, a file). */
  label?: string;
}

/**
 * Parse the three fields off an author's raw layout definition. Absent fields
 * stay absent; every other value is refused by name:
 *
 * - `primary` other than `'chat'` (`'terminal'` is not a primary);
 * - `presentation` other than `'stack'` or `'tabs'`;
 * - `drillIns` that is not an array of distinct, non-empty ids, that has more
 *   than {@link MAX_LAYOUT_DRILL_INS} entries, or names an id that does not
 *   resolve;
 * - `drillIns` or `primary: 'chat'` on a layout that is not `stack`: only the
 *   stack host pushes drill-ins and renders a Chat centre, so on a tab host
 *   the dock's Chat would be suspended with nothing in its place.
 */
export function parseLayoutPresentationDeclaration(
  value: unknown,
  options: ParseLayoutPresentationDeclarationOptions,
): LayoutPresentationDeclaration {
  const label = options.label ?? 'Layout';
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidLayoutDeclarationError(label, 'it must be an object');
  }
  const raw = value as Record<string, unknown>;
  const declaration: {
    primary?: LayoutPrimary;
    presentation?: LayoutPresentation;
    drillIns?: string[];
  } = {};

  if (raw.primary !== undefined) {
    if (raw.primary !== 'chat') {
      throw new InvalidLayoutDeclarationError(
        label,
        `primary must be 'chat' when supplied, not ${JSON.stringify(raw.primary)}`,
      );
    }
    declaration.primary = 'chat';
  }

  if (raw.presentation !== undefined) {
    if (raw.presentation !== 'stack' && raw.presentation !== 'tabs') {
      throw new InvalidLayoutDeclarationError(
        label,
        `presentation must be 'stack' or 'tabs', not ${JSON.stringify(raw.presentation)}`,
      );
    }
    declaration.presentation = raw.presentation;
  }

  if (raw.drillIns !== undefined) {
    if (!Array.isArray(raw.drillIns)) {
      throw new InvalidLayoutDeclarationError(
        label,
        'drillIns must be an array of pane ids',
      );
    }
    if (raw.drillIns.length > MAX_LAYOUT_DRILL_INS) {
      throw new InvalidLayoutDeclarationError(
        label,
        `drillIns may name at most ${MAX_LAYOUT_DRILL_INS} panes, not ${raw.drillIns.length}`,
      );
    }
    const seen = new Set<string>();
    for (const paneId of raw.drillIns) {
      if (typeof paneId !== 'string' || paneId.trim() !== paneId || !paneId) {
        throw new InvalidLayoutDeclarationError(
          label,
          `drill-in ${JSON.stringify(paneId)} is not a pane id`,
        );
      }
      if (seen.has(paneId)) {
        throw new InvalidLayoutDeclarationError(
          label,
          `drill-in '${paneId}' is listed twice`,
        );
      }
      if (!options.resolvesDrillIn(paneId)) {
        throw new InvalidLayoutDeclarationError(
          label,
          `drill-in '${paneId}' does not resolve to a pane this layout can place`,
        );
      }
      seen.add(paneId);
    }
    declaration.drillIns = [...seen];
  }

  if (declaration.presentation !== 'stack') {
    if (declaration.drillIns !== undefined) {
      throw new InvalidLayoutDeclarationError(
        label,
        "drillIns are pushed only by presentation 'stack'",
      );
    }
    if (declaration.primary === 'chat') {
      throw new InvalidLayoutDeclarationError(
        label,
        "primary 'chat' needs presentation 'stack': no other host renders the layout's Chat",
      );
    }
  }
  return declaration;
}

/** The facts the declaration reader needs off a layout record or listing. */
export interface LayoutPresentationFacts {
  id?: unknown;
  slug?: unknown;
  type?: string;
  primary?: unknown;
  presentation?: unknown;
  drillIns?: unknown;
  /** `LayoutMetadata.plugin`: a listing's stored `config.plugin`. */
  plugin?: unknown;
  config?: Record<string, unknown> | null;
  owner?: LayoutOwner;
  catalogContribution?: { provenance: { origin: string } };
  paneReferences?: unknown;
}

/**
 * Whether a record is contributed: catalog provenance `plugin`/`mcp`, or a
 * stored plugin binding from before attribution was recorded.
 */
function isContributedLayoutRecord(layout: LayoutPresentationFacts): boolean {
  const origin = layout.catalogContribution?.provenance.origin;
  if (origin === 'plugin' || origin === 'mcp') return true;
  const configPlugin = layout.config?.plugin;
  if (typeof configPlugin === 'string' && configPlugin.length > 0) return true;
  return typeof layout.plugin === 'string' && layout.plugin.length > 0;
}

/**
 * The declaration a layout record carries, as the shell reads it. The ONE
 * field reader: the renderer's host choice, App's dock suspension and ⌘D
 * routing, and {@link findPrimaryChatLayout} all answer from it.
 *
 * - A record whose plugin binding was withheld from this reader (#2090)
 *   declares nothing: the facts that would justify a claim are gone.
 * - A record that states `presentation` is a server's answer: Station's
 *   layout reads always state it, and it is read as stated (an unknown value
 *   reads as absent, never as a claim).
 * - **Legacy rule (removed by slice j):** a record stating nothing that is
 *   the built-in Coding layout — `type: 'coding'`, contributed by nobody —
 *   reads as {@link BUILTIN_CODING_LAYOUT}'s declaration. That is the shape
 *   every stored Coding record and every older server's answer has. A
 *   contributed layout that merely carries the word `coding` gets nothing.
 */
export function layoutPresentationDeclaration(
  layout: LayoutPresentationFacts | null | undefined,
): LayoutPresentationDeclaration {
  if (!layout || layout.paneReferences !== undefined) return {};
  if (layout.presentation !== undefined) {
    const presentation =
      layout.presentation === 'stack' || layout.presentation === 'tabs'
        ? layout.presentation
        : undefined;
    const stack = presentation === 'stack';
    const drillIns =
      stack && Array.isArray(layout.drillIns)
        ? layout.drillIns.filter(
            (paneId): paneId is string =>
              typeof paneId === 'string' && paneId.length > 0,
          )
        : undefined;
    return {
      ...(stack && layout.primary === 'chat' ? { primary: 'chat' } : {}),
      ...(presentation ? { presentation } : {}),
      ...(drillIns ? { drillIns } : {}),
    };
  }
  if (layout.type === BUILTIN_CODING_LAYOUT.type) {
    if (isContributedLayoutRecord(layout) || layout.owner?.kind === 'principal')
      return {};
    return builtinLayoutPresentationDeclaration(BUILTIN_CODING_LAYOUT);
  }
  return {};
}

/** Whether the layout claims the centre for Chat (`primary: 'chat'`). */
export function layoutClaimsPrimaryChat(
  layout: LayoutPresentationFacts | null | undefined,
): boolean {
  return layoutPresentationDeclaration(layout).primary === 'chat';
}

/** Whether the layout renders through the stack host (`presentation: 'stack'`). */
export function layoutPresentsAsStack(
  layout: LayoutPresentationFacts | null | undefined,
): boolean {
  return layoutPresentationDeclaration(layout).presentation === 'stack';
}

/**
 * The project's layout that claims the centre for Chat: where "open this
 * conversation in its layout" goes. Replaces the `type === 'coding'` lookups.
 *
 * Deterministic when several layouts claim Chat: the built-in Coding record
 * first (it hosts Coding's own panes), then the lowest `id`, then the lowest
 * `slug` — never the order a store happened to list them in.
 */
export function findPrimaryChatLayout<T extends LayoutPresentationFacts>(
  layouts: readonly T[] | null | undefined,
): T | undefined {
  const claimants = (layouts ?? []).filter((layout) =>
    layoutClaimsPrimaryChat(layout),
  );
  const rank = (layout: T) =>
    layout.type === BUILTIN_CODING_LAYOUT.type &&
    !isContributedLayoutRecord(layout)
      ? 0
      : 1;
  const key = (value: unknown) => (typeof value === 'string' ? value : '');
  return [...claimants].sort(
    (left, right) =>
      rank(left) - rank(right) ||
      key(left.id).localeCompare(key(right.id)) ||
      key(left.slug).localeCompare(key(right.slug)),
  )[0];
}

/** A built-in starter's declaration, copied so callers cannot share arrays. */
export function builtinLayoutPresentationDeclaration(
  layout: AvailableProjectLayout,
): LayoutPresentationDeclaration {
  return {
    ...(layout.primary ? { primary: layout.primary } : {}),
    presentation: layout.presentation ?? 'tabs',
    ...(layout.drillIns ? { drillIns: [...layout.drillIns] } : {}),
  };
}

export interface LayoutConfig {
  subject?: LayoutSubject;
  /** Derive the workspace from the owning Project; this grants no file access. */
  workspaceBinding?: LayoutWorkspaceBinding;
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

/**
 * A Layout as a READ answers it: the stored record plus the response-only
 * verdict above.
 *
 * Named so both sides of the wire can refer to one type. The field is NOT on
 * {@link LayoutConfig}, because that is the shape the storage schema parses
 * and it is `.strict()` — a record carrying this key is a hard storage
 * rejection, which is why the write paths strip it.
 */
export type LayoutReadView = LayoutConfig &
  LayoutPresentationReadFields & {
    paneReferences?: LayoutPaneReferences;
  };

/**
 * Response-only, like {@link LayoutPaneReferences}: a layout read (detail and
 * list) states the declaration of the layout's CONTRIBUTOR — the built-in
 * starter, or the installed plugin's current layout definition, less any
 * claim its plugin is not granted. Never persisted and never accepted from a
 * request body, so a client cannot write itself a Chat centre. Read through
 * {@link layoutPresentationDeclaration}, never directly.
 */
export interface LayoutPresentationReadFields {
  primary?: LayoutPrimary;
  presentation?: LayoutPresentation;
  drillIns?: readonly string[];
}

export interface LayoutMetadata {
  subject?: LayoutSubject;
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

/** A listing as the list read answers it; see {@link LayoutPresentationReadFields}. */
export type LayoutMetadataReadView = LayoutMetadata &
  LayoutPresentationReadFields;

export interface AvailableProjectLayout {
  /** Derive the workspace from the owning Project; this grants no file access. */
  workspaceBinding?: LayoutWorkspaceBinding;
  /** The layout contract fields; see {@link LayoutPresentationDeclaration}. */
  primary?: LayoutPrimary;
  presentation?: LayoutPresentation;
  drillIns?: readonly string[];
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
  workspaceBinding: 'repository',
  // Chat is the centre and every tool a drill-in, in rail order. The ids
  // are restated literals because `workspace-pane.ts` imports this module;
  // `layout-presentation-declaration.test.ts` pins each to its constant.
  primary: 'chat',
  presentation: 'stack',
  drillIns: Object.freeze([
    'pane:builtin:coding:diff',
    'pane:builtin:coding:file-browser',
    'pane:builtin:coding:terminal',
    'pane:builtin:evidence:plan',
    'pane:builtin:evidence:readiness',
    'pane:builtin:evidence:trust',
  ]),
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
  /** Derive the workspace from the owning Project; this grants no file access. */
  workspaceBinding?: LayoutWorkspaceBinding;
  /** The layout contract fields; see {@link LayoutPresentationDeclaration}. */
  primary?: LayoutPrimary;
  presentation?: LayoutPresentation;
  drillIns?: readonly string[];
  dashboard?: PersonalBoardDefinition;
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
