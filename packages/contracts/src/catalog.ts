import { layoutUsesRepositoryWorkspace } from './layout.js';

export interface SkillSourceContext {
  kind: 'agent' | 'plugin' | 'user' | 'asset';
  agentSlug?: string;
  conversationId?: string;
  asset?: GuidanceAssetReference;
  action?: GuidanceAssetConversionAction;
  convertedAt?: string;
}

export type GuidanceAssetReferenceKind = 'skill' | 'provider-capability';
export type GuidanceAssetSourceOwner =
  | 'user'
  | 'registry'
  | 'plugin'
  | 'provider';
export type GuidanceAssetConversionAction = 'provider-capability-to-skill';

export interface GuidanceAssetReference {
  kind: GuidanceAssetReferenceKind;
  id: string;
  name: string;
  owner: GuidanceAssetSourceOwner;
  providerId?: string;
  connectionId?: string;
}

export interface RegistryCatalogSelection {
  sourceId: string;
  itemId: string;
  revision: string;
  /**
   * The catalog this item was selected from. `agents` is additive: an agent
   * entry from a source's Station manifest, installed through the plugin
   * pipeline like any manifest entry.
   */
  kind: 'skills' | 'plugins' | 'agents';
}

/**
 * Everything a source can be recognized as providing. `integrations` is
 * reported by detection but has no catalog selection yet.
 */
export type RegistrySourceKind =
  | RegistryCatalogSelection['kind']
  | 'integrations';

/** One kind a source's content was recognized as providing. */
export interface RegistrySourceDetectedKind {
  kind: RegistrySourceKind;
  count: number;
  /** The detector that recognized it, such as `station-manifest` or `skill-md`. */
  via: string;
  /** Whether Station can list and install these items from this source. */
  installable: boolean;
  /** Why the items are listed as recognized but not installable. */
  note?: string;
  /** The managed policy refuses this kind from this source. */
  managedDenial?: string;
}

/**
 * What Station recognized in a source's content. The kinds follow from the
 * content's structure, never from a type the person chose.
 */
export interface RegistrySourceDetection {
  /**
   * `nothing-recognized` is a successful read that found nothing Station
   * knows; `refused` is a read Station stopped at a bound; `unavailable` is a
   * read that failed.
   */
  state: 'detected' | 'nothing-recognized' | 'refused' | 'unavailable';
  kinds: RegistrySourceDetectedKind[];
  /** The source's revision when it was last read: a commit, or a content digest. */
  revision?: string;
  checkedAt?: string;
  /** When a read last found a different revision from the one before it. */
  changedAt?: string;
  /** The root index that decided the kinds it declares, when there is one. */
  index?: string;
  /** The sentence for `refused` and `unavailable`. */
  reason?: string;
}

export interface RegistrySource {
  /**
   * The source's primary catalog kind, kept for older clients. A source can
   * provide several kinds; `detection.kinds` lists them all.
   */
  kind: RegistryCatalogSelection['kind'];
  id: string;
  displayName: string;
  origin: 'station' | 'configured' | 'user' | 'plugin';
  location?: string;
  /** Branch, tag or commit of a repository source; absent means its default branch. */
  ref?: string;
  /**
   * How Station reads the location. For a person's own source this is derived
   * from the location, not chosen, and does not decide what the source
   * provides.
   */
  adapter: 'manifest' | 'directory' | 'github' | 'provider';
  /** Present on a person's own sources. */
  detection?: RegistrySourceDetection;
  enabled: boolean;
  owner?: string;
  status: 'ready' | 'stale' | 'error' | 'disabled' | 'unknown';
  checkedAt?: string;
  lastSuccessfulAt?: string;
  error?: string;
  itemCount?: number;
  /**
   * #4521: the machine's managed policy (`limits.registries`) does not allow
   * this source; it reads as disabled and cannot be enabled. The sentence
   * clients show. Absent otherwise and on older servers.
   */
  managedDenial?: string;
}

export interface SkillProvenance {
  catalog?: RegistryCatalogSelection & {
    source: string;
    contentDigest: string;
    installedAt: string;
  };
  createdFrom?: SkillSourceContext;
  updatedFrom?: SkillSourceContext;
}

export interface SkillStats {
  runs: number;
  successes: number;
  failures: number;
  qualityScore: number | null;
  lastRunAt?: string;
  lastOutcomeAt?: string;
}

export type SkillOutcome = 'success' | 'failure';

export type GuidanceAssetKind = 'skill';
export type GuidanceAssetStorageMode =
  | 'json-inline'
  | 'markdown-file'
  | 'skill-package';
export type GuidanceAssetRuntimeMode =
  | 'slash-command'
  | 'prompt-record'
  | 'skill-catalog';

export interface GuidanceAssetPackaging {
  installable: boolean;
  installed?: boolean;
  installedVersion?: string;
  version?: string;
  path?: string;
  source?: string;
  resources?: Array<{ name: string; path: string }>;
  scripts?: Array<{ name: string; path: string }>;
}

export interface GuidanceAsset {
  id: string;
  kind: GuidanceAssetKind;
  name: string;
  body: string;
  description?: string;
  tags?: string[];
  category?: string;
  scope?: {
    agent?: string;
    global?: boolean;
  };
  source?: string;
  storageMode: GuidanceAssetStorageMode;
  runtimeMode: GuidanceAssetRuntimeMode;
  packaging?: GuidanceAssetPackaging;
  provenance?: SkillProvenance;
  stats?: SkillStats;
  createdAt?: string;
  updatedAt?: string;
}

export interface RegistryItem {
  providesTools?: boolean;
  id: string;
  catalog?: RegistryCatalogSelection;
  catalogSourceName?: string;
  catalogFreshness?: 'live' | 'stale';
  packageRevision?: string;
  displayName?: string;
  description?: string;
  version?: string;
  source?: string;
  toolOrigin?: import('./tool.js').ToolOrigin;
  status?: string;
  tags?: string[];
  installed: boolean;
  installedPluginName?: string;
  /** Manifest-declared glyph; see `ToolDef.icon`. Present only when the
   * underlying provider read the full manifest (e.g. disk-installed
   * integrations); curated-but-not-yet-installed registry entries fall back
   * to initials in the UI. */
  icon?: string;
  /** Same-origin, output-only URL for signature-validated local raster art. */
  iconUrl?: string;
  /** Present on entries read from an MCP subregistry (#3483). */
  mcpServer?: RegistryMcpServerListing;
  /**
   * What a plugin catalog entry is, derived from its package's manifest when
   * the catalog is listed. Absent when Station did not read the manifest: a
   * remote package, or a manifest that is missing, malformed or over a bound.
   */
  app?: RegistryAppFacts;
}

/**
 * Where an app's screen can open: as a screen of its own, as a view inside a
 * project, or as a pane beside other work.
 */
export type RegistryAppPlacement = 'screen' | 'project-view' | 'pane';

/**
 * What an app works with. Each is read from a manifest declaration: agents,
 * chat capabilities and prompt actions; knowledge namespaces; panes that need
 * a task; and panes or layouts that need a project's files.
 */
export type RegistryAppWorksWith =
  | 'chats-and-agents'
  | 'knowledge'
  | 'tasks'
  | 'files-and-code';

/**
 * The facts of a plugin that has a screen (a layout or a Workspace Pane), or
 * `{ kind: 'none' }` for one that only adds providers, skills or agents.
 */
export type RegistryAppFacts =
  | {
      readonly kind: 'app';
      /** Tab labels of its layouts, in declaration order. */
      readonly screens: readonly string[];
      /** Names of its Workspace Panes. */
      readonly panes: readonly string[];
      readonly opensAs: readonly RegistryAppPlacement[];
      readonly worksWith: readonly RegistryAppWorksWith[];
      /** Agents the package brings. */
      readonly agents: number;
      /**
       * One label per distinct prompt its screens, panes and package actions
       * send. Two actions that send the same plugin prompt are one prompt.
       */
      readonly promptActions: readonly string[];
      /** Labels of the knowledge collections it brings. */
      readonly knowledge: readonly string[];
      /** Tool servers it needs (`integrations.required`). */
      readonly toolServers: readonly string[];
      /** Whether one of its views is an MCP tool UI in a sandboxed frame. */
      readonly sandboxedToolView: boolean;
      /**
       * Whether it ships screen code that runs inside Station's window (a
       * manifest `entrypoint`), with no isolation from Station.
       */
      readonly inProcessScreen: boolean;
    }
  | { readonly kind: 'none' };

/** The most entries any list in {@link RegistryAppFacts} may hold. */
export const REGISTRY_APP_LIST_BOUND = 32;
const REGISTRY_APP_LABEL_BOUND = 120;
const REGISTRY_APP_PLACEMENTS: readonly RegistryAppPlacement[] = [
  'screen',
  'project-view',
  'pane',
];
const REGISTRY_APP_WORKS_WITH: readonly RegistryAppWorksWith[] = [
  'chats-and-agents',
  'knowledge',
  'tasks',
  'files-and-code',
];
const REGISTRY_APP_LABEL_LISTS = [
  'screens',
  'panes',
  'promptActions',
  'knowledge',
  'toolServers',
] as const;

function isAppRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAppLabel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= REGISTRY_APP_LABEL_BOUND
  );
}

/**
 * The distinct labels, or null when one is not a bounded label or there are
 * more than the bound. Never truncates.
 */
function appLabels(values: readonly unknown[]): string[] | null {
  const labels = [...new Set(values)];
  if (labels.length > REGISTRY_APP_LIST_BOUND) return null;
  return labels.every(isAppLabel) ? labels : null;
}

function isDistinctListOf<T>(
  value: unknown,
  members: readonly T[],
): value is T[] {
  return (
    Array.isArray(value) &&
    new Set(value).size === value.length &&
    value.every((entry) => members.includes(entry as T))
  );
}

/**
 * Reads {@link RegistryAppFacts} from an untrusted value, such as a stored
 * catalog snapshot. Returns null for anything outside the shape or its
 * bounds; nothing is truncated.
 */
export function parseRegistryAppFacts(value: unknown): RegistryAppFacts | null {
  if (!isAppRecord(value)) return null;
  // Fields a newer writer adds beside `kind` do not change what it is.
  if (value.kind === 'none') return { kind: 'none' };
  if (value.kind !== 'app') return null;
  const lists: Partial<
    Record<(typeof REGISTRY_APP_LABEL_LISTS)[number], string[]>
  > = {};
  for (const key of REGISTRY_APP_LABEL_LISTS) {
    const list = value[key];
    if (!Array.isArray(list) || appLabels(list)?.length !== list.length)
      return null;
    lists[key] = list as string[];
  }
  const { screens, panes, promptActions, knowledge, toolServers } = lists;
  if (
    !screens ||
    !panes ||
    !promptActions ||
    !knowledge ||
    !toolServers ||
    !isDistinctListOf(value.opensAs, REGISTRY_APP_PLACEMENTS) ||
    !isDistinctListOf(value.worksWith, REGISTRY_APP_WORKS_WITH) ||
    typeof value.agents !== 'number' ||
    !Number.isSafeInteger(value.agents) ||
    value.agents < 0 ||
    value.agents > REGISTRY_APP_LIST_BOUND ||
    typeof value.sandboxedToolView !== 'boolean' ||
    typeof value.inProcessScreen !== 'boolean'
  )
    return null;
  return {
    kind: 'app',
    screens,
    panes,
    opensAs: value.opensAs,
    worksWith: value.worksWith,
    agents: value.agents,
    promptActions,
    knowledge,
    toolServers,
    sandboxedToolView: value.sandboxedToolView,
    inProcessScreen: value.inProcessScreen,
  };
}

/** The manifest fields {@link deriveRegistryAppFacts} reads. */
interface RegistryAppManifest {
  name?: string;
  entrypoint?: string;
  capabilities?: readonly string[];
  permissions?: readonly string[];
  agents?: readonly unknown[];
  workspacePanes?: readonly unknown[];
  workspacePaneHost?: { readonly actions?: readonly unknown[] };
  integrations?: { readonly required?: readonly string[] };
  knowledge?: { readonly namespaces?: readonly unknown[] };
}

const PROMPT_ACTION_TYPES = new Set(['prompt', 'inline-prompt']);
const HOST_PROMPT_INTENT_KINDS = new Set(['prompt', 'plugin-prompt']);

/** A prompt an action sends, and the label it is offered under. */
interface PromptAction {
  key: string;
  label: unknown;
}

/**
 * The prompt actions of a tab or pane. A layout action whose `data` is
 * `<plugin>:<prompt id>` sends that plugin prompt, the same identity a
 * package action's `plugin-prompt` intent names; any other `data` is the
 * prompt text itself.
 */
function layoutPromptActions(
  actions: unknown,
  pluginName: string | undefined,
): PromptAction[] | null {
  if (actions === undefined) return [];
  if (!Array.isArray(actions)) return null;
  return actions
    .filter(
      (action) =>
        isAppRecord(action) && PROMPT_ACTION_TYPES.has(String(action.type)),
    )
    .map((action) => {
      const { data, label } = action as Record<string, unknown>;
      const prefix = pluginName ? `${pluginName}:` : undefined;
      const key =
        typeof data !== 'string'
          ? `label:${String(label)}`
          : prefix && data.startsWith(prefix)
            ? `plugin:${data.slice(prefix.length)}`
            : `text:${data}`;
      return { key, label };
    });
}

/**
 * Derives what a plugin is from its parsed manifest and the layout documents
 * its `layout` and `layouts` entries name, in that order. Returns null when a
 * declaration is malformed or a list exceeds its bound, so the caller lists
 * the entry without facts. Never truncates.
 */
export function deriveRegistryAppFacts(input: {
  manifest: RegistryAppManifest;
  layouts: readonly unknown[];
}): RegistryAppFacts | null {
  const { manifest, layouts } = input;
  const panes = manifest.workspacePanes ?? [];
  if (layouts.length === 0 && panes.length === 0) return { kind: 'none' };
  if (
    layouts.length > REGISTRY_APP_LIST_BOUND ||
    panes.length > REGISTRY_APP_LIST_BOUND
  )
    return null;

  const opensAs = new Set<RegistryAppPlacement>();
  const worksWith = new Set<RegistryAppWorksWith>();
  const screenLabels: unknown[] = [];
  const layoutActions: PromptAction[] = [];
  let sandboxedToolView = false;

  for (const layout of layouts) {
    if (!isAppRecord(layout) || !Array.isArray(layout.tabs)) return null;
    if (layout.tabs.length > REGISTRY_APP_LIST_BOUND) return null;
    // A repository-bound layout derives its workspace from a project.
    if (
      layoutUsesRepositoryWorkspace({
        type: typeof layout.type === 'string' ? layout.type : undefined,
        workspaceBinding:
          layout.workspaceBinding === 'repository' ? 'repository' : undefined,
      })
    )
      worksWith.add('files-and-code');
    else opensAs.add('screen');
    opensAs.add('project-view');
    for (const tab of layout.tabs) {
      if (!isAppRecord(tab)) return null;
      screenLabels.push(tab.label);
      if (isAppRecord(tab.component) && tab.component.kind === 'mcp-tool-ui')
        sandboxedToolView = true;
      const actions = layoutPromptActions(tab.actions, manifest.name);
      if (!actions) return null;
      layoutActions.push(...actions);
    }
  }

  const paneNames: unknown[] = [];
  for (const pane of panes) {
    if (!isAppRecord(pane) || !isAppRecord(pane.placement)) return null;
    paneNames.push(pane.name);
    if (isAppRecord(pane.renderer) && pane.renderer.kind === 'mcp-tool-ui')
      sandboxedToolView = true;
    const requirements = (Array.isArray(pane.modes) ? pane.modes : []).map(
      (mode) =>
        isAppRecord(mode) && isAppRecord(mode.contextRequirement)
          ? mode.contextRequirement
          : {},
    );
    for (const requirement of requirements) {
      if (requirement.task === true) worksWith.add('tasks');
      if (requirement.workspace === true || requirement.source === true)
        worksWith.add('files-and-code');
      if (requirement.session === true || requirement.run === true)
        worksWith.add('chats-and-agents');
    }
    const needsProject =
      requirements.length > 0 &&
      requirements.every((requirement) => requirement.project === true);
    const regions = Array.isArray(pane.placement.supportedRegions)
      ? pane.placement.supportedRegions
      : [];
    if (regions.includes('primary') || regions.includes('standalone'))
      opensAs.add(needsProject ? 'project-view' : 'screen');
    if (regions.includes('secondary') || regions.includes('docked'))
      opensAs.add('pane');
    const actions = layoutPromptActions(pane.actions, manifest.name);
    if (!actions) return null;
    layoutActions.push(...actions);
  }

  const hostActions = manifest.workspacePaneHost?.actions ?? [];
  if (!Array.isArray(hostActions)) return null;
  const packageActions: PromptAction[] = [];
  for (const action of hostActions) {
    if (!isAppRecord(action)) return null;
    // Both intent kinds the host contribution defines send a prompt.
    const intent = action.intent;
    if (
      !isAppRecord(intent) ||
      !HOST_PROMPT_INTENT_KINDS.has(String(intent.kind))
    )
      continue;
    packageActions.push({
      key:
        intent.kind === 'plugin-prompt'
          ? `plugin:${String(intent.promptId)}`
          : `text:${String(intent.prompt)}`,
      label: action.label,
    });
  }
  // One label per distinct prompt; a package action's label is preferred.
  const promptsByKey = new Map<string, unknown>();
  for (const action of [...packageActions, ...layoutActions])
    if (!promptsByKey.has(action.key))
      promptsByKey.set(action.key, action.label);
  const actionLabels = [...promptsByKey.values()];

  const namespaces = manifest.knowledge?.namespaces ?? [];
  if (!Array.isArray(namespaces)) return null;
  const knowledgeLabels = namespaces.map((namespace) =>
    isAppRecord(namespace) ? (namespace.label ?? namespace.id) : undefined,
  );
  const agents = manifest.agents?.length ?? 0;
  const capabilities = manifest.capabilities ?? [];
  if (knowledgeLabels.length > 0 || capabilities.includes('knowledge'))
    worksWith.add('knowledge');
  if (
    agents > 0 ||
    actionLabels.length > 0 ||
    capabilities.includes('chat') ||
    capabilities.includes('agents') ||
    (manifest.permissions ?? []).includes('agents.invoke')
  )
    worksWith.add('chats-and-agents');

  const screens = appLabels(screenLabels);
  const paneLabels = appLabels(paneNames);
  const promptActions = appLabels(actionLabels);
  const knowledge = appLabels(knowledgeLabels);
  const toolServers = appLabels(manifest.integrations?.required ?? []);
  if (
    !screens ||
    !paneLabels ||
    !promptActions ||
    !knowledge ||
    !toolServers ||
    agents > REGISTRY_APP_LIST_BOUND
  )
    return null;
  return {
    kind: 'app',
    screens,
    panes: paneLabels,
    opensAs: REGISTRY_APP_PLACEMENTS.filter((placement) =>
      opensAs.has(placement),
    ),
    worksWith: REGISTRY_APP_WORKS_WITH.filter((kind) => worksWith.has(kind)),
    agents,
    promptActions,
    knowledge,
    toolServers,
    sandboxedToolView,
    inProcessScreen:
      typeof manifest.entrypoint === 'string' &&
      manifest.entrypoint.trim().length > 0,
  };
}

/**
 * How a person authorizes an MCP server's remote endpoint.
 * - `dcr`: OAuth with dynamic client registration, which Station's tool
 *   server OAuth flow performs today.
 * - `pre-registered-required`: OAuth whose authorization server has no
 *   registration endpoint, so the operator must bring a client.
 * - `token`: a secret request header such as a bearer token.
 * - `none`: the endpoint answers without authorization.
 * - `unknown`: the source does not say; only Station curation records this.
 */
export type RegistryMcpAuthMode =
  | 'dcr'
  | 'pre-registered-required'
  | 'token'
  | 'none'
  | 'unknown';

/**
 * - `qualified`: Station checked the endpoint and authorization mode against
 *   the live server, and its connect flow can be used today.
 * - `setup-required`: checked and addable, but sign-in needs an OAuth client
 *   the person registers with the provider, a path Station's check did not
 *   complete.
 * - `blocked`: Station checked the entry, but cannot deliver it yet; the
 *   reasons are in `unavailable`.
 * - `unqualified`: Station has not checked the entry. Every entry from a
 *   source other than Station's bundled curation is unqualified, whatever
 *   the source claims about itself.
 */
export type RegistryMcpQualificationState =
  | 'qualified'
  | 'setup-required'
  | 'blocked'
  | 'unqualified';

export interface RegistryMcpServerListing {
  /** Reverse-DNS server name from server.json, exactly as published. */
  name: string;
  version: string;
  /** The server.json schema revision the entry was parsed against. */
  schema: string;
  /** The remote Station would connect to; absent when none is usable. */
  remote?: { transport: 'streamable-http'; url: string };
  authMode: RegistryMcpAuthMode;
  qualification: {
    state: RegistryMcpQualificationState;
    /** What Station checked, in plain language. */
    summary?: string;
    checkedAt?: string;
  };
  /** Vendor launch stage when it is not generally available. */
  launchStage?: 'preview' | 'developer-preview';
  /**
   * `untrusted`: the server returns content written by others, such as
   * email. Added servers carry it as `ToolDef.contentTrust`, which the
   * person can change; see docs/design/mcp-subregistry-curation.md.
   */
  contentTrust?: 'untrusted';
  /** Station's curation trusts this server's read-only tool hints. */
  trustReadOnlyHints?: boolean;
  websiteUrl?: string;
  /** Why Add is refused. Empty means the entry can be added. */
  unavailable: string[];
}

/** Read state of one MCP subregistry source. */
export interface RegistryMcpSourceStatus {
  id: string;
  displayName: string;
  /** `station`: the bundled curation. `configured`: an operator-set URL. */
  origin: 'station' | 'configured';
  /** Where entries came from; `bundled` never goes stale. */
  freshness: 'bundled' | 'live' | 'stale' | 'none';
  fetchedAt: string | null;
  checkedAt: string | null;
  lastError: string | null;
  serverCount: number;
  refused: { name: string; reasons: string[] }[];
}

/**
 * A skill that is also runnable as a slash command.
 *
 * `enabled` is DECLARED, never inferred: it is written by an author in
 * `SKILL.md` frontmatter and mirrored into `skill.json` so a listing does not
 * have to parse bodies. Nothing derives it from a skill's shape, its body, or
 * where it was found — a skill with `{{variables}}` in its body is not a
 * command until someone says so.
 *
 * `enabled` and `global` are two different facts, not one switch:
 * `enabled` = "runnable as `/command`"; `global` = "offered in every agent's
 * chat without being attached to that agent". An enabled, non-global command
 * skill is offered only to the agents whose `skills` list names it.
 */
export interface SkillCommand {
  enabled: boolean;
  /**
   * The command word, without the leading `/`. Absent means "derive it from
   * the skill name" — `skillCommandSlug(skill.name)` in
   * `@kontourai/station-contracts/skill-command`, the one derivation every
   * consumer shares.
   */
  name?: string;
  global?: boolean;
}

/**
 * One `{{placeholder}}` a skill body substitutes.
 *
 * The SET of variables is always derived from the body; a frontmatter
 * declaration only attaches `description`/`default` to a name the body
 * already uses (see `mergeSkillVariables`).
 */
export interface SkillVariable {
  name: string;
  description?: string;
  default?: string;
}

/**
 * Where a skill came from, written by the writer that knows: `createLocalSkill`
 * writes `user` (or `project` when the write is project-scoped), a registry
 * install writes `registry`, and `package`/`plugin`/`project` are derived from
 * the root a skill was discovered under. `migrated-playbook` is written by
 * `station doctor --migrate-playbooks`, the one-shot helper that reads a legacy
 * `prompts.json` — the word records where the skill came from, and is not a
 * live product noun.
 *
 * `user` and `project` are both writable roots and differ only in scope:
 * `user` is `<home>/skills` (every project on this machine sees it), `project`
 * is `<home>/projects/<slug>/skills` (one workspace does). Before `project`
 * existed a workspace-scoped skill reported `user`, so a reader could not tell
 * the two apart and no surface could name the difference (#1582 D6).
 */
export type SkillOrigin =
  | 'user'
  | 'project'
  | 'registry'
  | 'plugin'
  | 'package'
  | 'migrated-playbook';

/**
 * Why Station will not write a skill's own package, as a code a reader may
 * branch on.
 *
 * The DECISION belongs to the server (`SkillService.isSkillWritable`); this is
 * that decision projected, never a second derivation of it. `source` and
 * `origin` are close enough to be tempting and answer a different question: a
 * registry install living in a writable root is perfectly writable, and an
 * install record stating `source: 'local'` says nothing about which root the
 * package actually sits in. The rule has moved once already: it stopped meaning
 * "this name resolves to this one directory" and now means "this package sits
 * in a root Station writes" (#1619) — so a client rebuilding it from those
 * fields would have been wrong before that change and wrong again after it.
 */
export type SkillWriteRefusalReason =
  /**
   * A SOURCE serves it in place (a plugin's prompt file), not a directory
   * Station owns. Its remedy is unlike the others': there is no registry entry
   * to install, so the plugin that provides it is the thing to change.
   */
  | 'served-in-place'
  /** It is served from a canonical package root, which ships read-only. */
  | 'canonical-package'
  /** Its package sits in some other root, which Station does not write. */
  | 'outside-writable-root'
  /**
   * Discovery found its package in a directory whose NAME is not the skill's —
   * by case, or because the frontmatter names it something else.
   *
   * Its own code because its remedy is unlike the others': the package is
   * plainly the user's own and sits in a root Station writes, so "Station does
   * not own this" would be a false explanation of a real refusal. What has to
   * change is the directory name or the frontmatter name, so the two agree.
   */
  | 'directory-name-mismatch'
  /**
   * Where a write to it would land could not be determined — a dangling link,
   * an unreadable ancestor, a loop.
   *
   * Its own code because it is NOT "sits outside a writable root", and the
   * remedy for that one is unfollowable here: the package may be sitting inside
   * a root Station writes with a broken path, where installing it again repairs
   * nothing. Station refuses because it cannot tell where the bytes would go.
   */
  | 'containment-unreadable'
  /**
   * Its name cannot become a directory NAME, so Station cannot work out where
   * it would write this package. Discovery registers a frontmatter `name`
   * unvalidated, so this is reachable; the remedy is a rename, not an install.
   *
   * What could not be resolved is the WRITE TARGET. The package itself was
   * discovered and its directory is known, so `packageDirectory` is populated
   * here like anywhere else — a rename is not actionable without it.
   */
  | 'unresolvable-name';

/** The server's refusal to write a skill package, with its own sentence about it. */
export interface SkillWriteRefusal {
  reason: SkillWriteRefusalReason;
  /**
   * WHAT is wrong, in Station's own words, as a complete sentence — for
   * display. Readers render it rather than composing a description from
   * `reason`, and nothing may branch on the text.
   *
   * It contains NO author-controlled text: not the skill's name, not its
   * path, and not an exception message. That is the whole point of it. An
   * earlier draft of this field interpolated the package directory, and review
   * showed the mitigation had simply moved rather than held — a plugin names
   * its own directories, so a refusal could be made to read as a session-expiry
   * notice directing the reader to another domain, using a bland frontmatter
   * name and hostile prose one level up in the path.
   *
   * Where the package sits is a fact a reader needs, so it is carried in
   * `packageDirectory` and rendered as its own element. What to DO about the refusal
   * belongs to `reason` — the remedies genuinely differ — so a reader switches
   * on the code for the remedy and renders this for the description.
   */
  detail: string;
  /**
   * WHERE THE PACKAGE SITS — the directory the refused package was discovered
   * in. Named for the package on purpose: a refusal involves two directories,
   * this one and the place Station would have written instead, and a bare
   * `directory` reads just as easily as the latter.
   *
   * REQUIRED, because every refusal has one. The rule answers "writable"
   * outright when no package was discovered, so a refusal always has a
   * discovered location behind it, and each of its refusal branches reports it.
   *
   * It was optional for one release cycle, on the theory that #1619 might add a
   * reason with no directory to report. It did not — checked against the landed
   * rule, branch by branch, rather than assumed — and an optional marker that
   * can never be absent is a documented case that does not exist, which is the
   * defect this whole projection was written to remove. A reader must not have
   * to handle an absence the server cannot produce.
   *
   * AUTHOR-CONTROLLED, every segment of it: a plugin chooses its directory
   * names and the last segment is usually the skill's own name. Surfaces must
   * render it as its own element — a path, labelled as a path — and never
   * splice it into `detail`'s sentence, because text that borrows the grammar
   * of Station's explanation is read as Station speaking.
   */
  packageDirectory: string;
}

export interface Skill extends RegistryItem {
  name: string;
  source?: string;
  /**
   * May Station write this skill's own package — the server's writability
   * predicate PROJECTED, never re-derived here. Absent means the server did
   * not state it, and a reader must then treat the package as read-only: a
   * missing decision is not a permissive one.
   */
  writable?: boolean;
  /** Why `writable` is false. Absent whenever `writable` is not false. */
  writeRefusal?: SkillWriteRefusal;
  path?: string;
  installedVersion?: string;
  updateAvailable?: boolean;
  body?: string;
  resources?: Array<{ name: string; path: string }>;
  scripts?: Array<{ name: string; path: string }>;
  provenance?: SkillProvenance;
  command?: SkillCommand;
  /**
   * Why an enabled command declaration is not in effect (a clash the server's
   * `resolveSkillCommands` awarded to another skill, a word nobody can type).
   * Written by the skills listing/detail — `command.enabled: false` plus this
   * field is the server's verdict, and clients must not re-arbitrate it.
   */
  commandDiagnostic?: string;
  variables?: SkillVariable[];
  /**
   * Usage counters, joined from `<home>/skills/.usage.json`. Never present on
   * disk in the skill package itself; a read-only package/plugin skill has
   * stats too.
   */
  stats?: SkillStats;
  /**
   * Why `stats` is absent, when the counter store could not be read. An
   * unreadable store is NOT an unused skill: a reader must render this instead
   * of "0 runs", which is a different fact.
   */
  statsUnavailable?: string;
  /** Identifiers this skill was migrated from (legacy UUIDs, `<plugin>:<id>`). */
  legacyIds?: string[];
  origin?: SkillOrigin;
}

export interface InstallResult {
  success: boolean;
  message: string;
}

export interface SkillRegistryProvider {
  readonly registryKey?: string;
  refresh?(): Promise<void>;
  getPackageRevision?(id: string): Promise<string | null>;
  listAvailable(): Promise<RegistryItem[]>;
  listInstalled(): Promise<RegistryItem[]>;
  install(
    id: string,
    targetDir: string,
    options?: { expectedPackageRevision?: string },
  ): Promise<InstallResult>;
  uninstall(id: string, targetDir: string): Promise<InstallResult>;
  update?(id: string): Promise<InstallResult>;
  getContent?(id: string): Promise<string | null>;
}

/** Rows and package claims from one fresh observation of a catalog revision. */
export interface PluginRegistryCatalogSnapshot {
  revision: string;
  items: RegistryItem[];
  packages: Array<{ id: string; source: string; claim?: unknown }>;
}

export interface PluginRegistryProvider {
  getCatalogSnapshot?(): Promise<PluginRegistryCatalogSnapshot>;
  readonly registryKey?: string;
  refresh?(): Promise<void>;
  getCatalogRevision?(): Promise<string>;
  resolvePackage?(
    id: string,
  ): Promise<{ source: string; claim?: unknown } | null>;
  resolveSource?(id: string): Promise<string | null>;
  listAvailable(): Promise<RegistryItem[]>;
  listInstalled(): Promise<RegistryItem[]>;
  install(
    id: string,
    options?: { expectedInstalledPluginName?: string },
  ): Promise<InstallResult & { rollback?: () => Promise<void> }>;
  uninstall(id: string): Promise<InstallResult>;
  update?(id: string): Promise<InstallResult>;
  preview?(id: string): Promise<import('./plugin.js').PluginPreview>;
}

export type ProviderCapabilityStatus =
  | 'ready'
  | 'warning'
  | 'error'
  | 'disabled'
  | 'unknown';
export type ProviderCapabilityAuthStatus =
  | 'authenticated'
  | 'unauthenticated'
  | 'unknown';
export type ProviderCapabilityFreshness =
  | 'live'
  | 'cached'
  | 'stale'
  | 'unknown';

export interface ProviderCapabilityModel {
  id: string;
  name: string;
  provider?: string;
  capabilities?: Record<string, unknown>;
}

export interface ProviderNativeSkill {
  id: string;
  name: string;
  description?: string;
  path?: string;
  scope?: string;
  enabled: boolean;
  provenance: GuidanceAssetReference;
}

export interface ProviderNativeSlashCommand {
  id: string;
  name: string;
  description?: string;
  inputHint?: string;
  provenance: GuidanceAssetReference;
}

/** #895 wave B: per-connection session-surface evidence from a live protocol
 * handshake (ACP initialize). Evidence only — probe results may upgrade the
 * matrix, never downgrade a session (agent-engine-unification.md §4.1). */
export interface ProviderSessionSurfaceEvidence {
  loadSession?: boolean;
  mcpTransports?: Array<'stdio' | 'http' | 'sse'>;
  promptImage?: boolean;
  promptAudio?: boolean;
  promptEmbeddedContext?: boolean;
  sessionResume?: boolean;
}

/** A sign-in method an engine declared, reduced to what may be shown. */
export interface ProviderDeclaredAuthMethod {
  id: string;
  name: string;
  description?: string;
  type?: string;
}

/** A declared fact Station refused to serve because it exceeded its bounds. */
export type ProviderDeclaredHandshakeFact =
  | 'agentInfo'
  | 'authMethods'
  | 'extensionMethods'
  /** The probe session's `models` list (#352). */
  | 'models'
  | 'declaredFeatures'
  | 'logChannels';

/**
 * Which engine variant a reviewed handshake-identity entry matched
 * (`acp-handshake-facts.ts`). A variant names an engine and protocol
 * generation, never a version: `kiro-v2` is kiro-cli's own engine
 * (`agentInfo.name` `Kiro CLI Agent`), `kiro-v3` its agent service (it
 * declares `agentCapabilities._meta.kiro`), `grok-build` the xAI Grok CLI's
 * `grok agent` (its `initialize` result sets `_meta.grokShell: true`).
 */
export type ProviderDeclaredEngineVariant =
  | 'kiro-v2'
  | 'kiro-v3'
  | 'grok-build';

/**
 * Feature flags an engine declared under its vendor namespace in
 * `agentCapabilities._meta`, read against Station's bounds. Each is the
 * engine's own claim. Station binds behavior to a flag only through a
 * reviewed entry; an unbound flag is recorded, not acted on.
 */
export interface ProviderDeclaredFeatures {
  /** The vendor `_meta` namespace the flags were read from (`kiro`). */
  namespace: string;
  /** Workspace checkpoints the engine can revert to. */
  checkpoints?: boolean;
  /** The engine lists its own stored sessions. */
  sessionList?: boolean;
  /** Updates replayed by a session load are marked as replayed. */
  replayMarking?: boolean;
  /** The engine reports a model fallback it performed. */
  modelFallbackReporting?: boolean;
  /** The engine reports organization policy changes. */
  policyNotifications?: boolean;
  /** `session/fork` accepts a message id to fork at. */
  forkAtMessage?: boolean;
  /** Bounds of the engine's auto-compaction threshold, in percent of context. */
  autoCompactionThreshold?: { min: number; max: number; default: number };
  /** Where the engine can run a session (`local`, `cloud-sandbox`, …). */
  executionTargets?: string[];
  /** Where the engine's sessions can come from (`local`, `remote`). */
  sessionSources?: string[];
  /** Scopes the engine's session list can be asked for. */
  sessionListScopes?: string[];
}

/**
 * ADR 0013: what one engine connection declared about itself at its protocol
 * handshake (ACP `initialize`). Self-reported by the engine: a declaration,
 * never proof that a surface works, and kept beside the capability matrix.
 */
export interface ProviderDeclaredHandshake {
  /** When the handshake that declared these facts succeeded. */
  observedAt: string;
  protocolVersion: number;
  agentInfo?: { name: string; title?: string; version?: string };
  /** Core session lifecycle methods the engine named. */
  sessionCapabilities: Array<'list' | 'resume' | 'close' | 'fork' | 'delete'>;
  /** Sign-in methods; launch arguments, environment and `_meta` are not served. */
  authMethods?: ProviderDeclaredAuthMethod[];
  /** Extension methods the engine listed in its capability `_meta`. */
  extensionMethods?: string[];
  /** The engine variant a reviewed identity entry matched; absent when none did. */
  engineVariant?: ProviderDeclaredEngineVariant;
  /** Vendor feature flags; absent when the engine declared none Station reads. */
  declaredFeatures?: ProviderDeclaredFeatures;
  /**
   * Names of the log channels the engine declared. Their file paths are host
   * paths and stay on the server, where only an administrator reads a tail.
   */
  logChannels?: string[];
  /**
   * Facts the engine declared beyond Station's bounds. Each is absent above,
   * never shortened, so a refused list cannot read as a complete one.
   */
  refused?: ProviderDeclaredHandshakeFact[];
}

export interface ProviderCapabilityInventory {
  providerId: string;
  connectionId?: string;
  displayName: string;
  status: ProviderCapabilityStatus;
  authStatus: ProviderCapabilityAuthStatus;
  version?: string | null;
  checkedAt?: string;
  freshness: ProviderCapabilityFreshness;
  source: GuidanceAssetSourceOwner;
  message?: string;
  models: ProviderCapabilityModel[];
  skills: ProviderNativeSkill[];
  slashCommands: ProviderNativeSlashCommand[];
  sessionSurfaces?: ProviderSessionSurfaceEvidence;
  declaredHandshake?: ProviderDeclaredHandshake;
}
