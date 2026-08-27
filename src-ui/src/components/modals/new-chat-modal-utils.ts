import type { AgentId } from '@kontourai/station-contracts/agent-identity';
import type {
  AgentConnectionView,
  ConnectionConfig,
} from '@kontourai/station-contracts/tool';
import type { AgentData } from '../../contexts/AgentsContext';
import type { ProjectMetadata } from '../../contexts/ProjectsContext';
import type { LastChosenModelMap } from '../../hooks/lastChosenModel';
import {
  agentBindingId,
  buildLastChosenModelBindingKey,
  isProviderManagedAgent,
} from '../../hooks/lastChosenModel';
import type { ACPSelectionConnection } from '../../hooks/useNewChatSelectionModel';
import {
  connectionStatusLabel,
  guaranteeConcreteModel,
  resolveEffectiveModel,
  runtimeCatalogSourceLabel,
} from '../../utils/execution';
import {
  AUTHORED_BAND_LABEL,
  ENGINE_BAND_LABEL,
  isEngineProvenanceAgent,
} from '../agent-provenance';
import { AGENT_NOT_SET_UP_LABEL, agentRunnability } from '../agent-runnability';
import { selectProjectScopedChatAgents } from '../agent-selection-policy';
import { resolveNewChatAgentEnable } from './new-chat-agent-enable';

export const GLOBAL_CONTEXT = '__global__';

/**
 * Where the chat about to be started will actually run.
 *
 * `'connection'` exists because of station#1089. The picker used to print
 * "~ (defaults to home)" for any project without a `workingDirectory`, and for
 * an engine connection carrying its own Working Directory that was simply
 * untrue: measured on origin/main, a chat in a directoryless project on a
 * connection with `cwd: /tmp/s1089-elsewhere` started with
 * `session.cwd = /tmp/s1089-elsewhere` and the engine CLI's own `getcwd` read
 * back `/private/tmp/s1089-elsewhere`, while this control said home.
 *
 * The precedence below is a mirror of the server's, not a second opinion:
 * `orchestration-service.ts`'s `resolveStartSessionCwd` turns a project's
 * `workingDirectory` into the session's `cwd`, and `acp-adapter.ts` then
 * resolves `input.cwd || connectionCwd || safeHomeDirectory()`. So a project
 * directory outranks a connection default (verified live: project `bound`
 * + connection `oc-elsewhere` → `/tmp/s1089-project`), and a connection
 * default outranks `$HOME`.
 */
export type NewChatWorkspaceHint =
  | { kind: 'project'; path: string }
  | { kind: 'connection'; path: string }
  | { kind: 'home' };

/** Spoken when the server refused a row without saying why. */
export const NEW_CHAT_AGENT_UNAVAILABLE_FALLBACK =
  'This agent is currently unavailable.';

/**
 * The short state a "not yet enabled" engine-default row reads as. Two words,
 * and a STATE rather than an instruction: the row's own Enable button already
 * carries the verb, so repeating it here would say the same thing twice.
 * Sibling vocabulary note: `workspacePaneAvailabilityPresentation.ts` labels
 * the analogous pane state "Setup needed"; that phrasing pairs with a
 * "Complete setup" action, whereas this row's action is "Enable".
 */
export const NEW_CHAT_AGENT_NOT_SET_UP_LABEL = AGENT_NOT_SET_UP_LABEL;

/**
 * How an unavailable picker row presents itself.
 *
 * `unavailableReason` is a server string written for API clients, the 400 body
 * on a refused turn, and delegation — the engine-default refusal alone is 249
 * characters, and five engine rows turned the picker into a wall of amber
 * prose that read as an explanation rather than a state. So the row's VISIBLE
 * treatment is chosen here:
 *   - `state`  — the row carries the machine-readable `enable` signal, so its
 *     condition is fully known ("no authored Agent yet"). Render the chip; the
 *     full sentence stays as the row's accessible description.
 *   - `reason` — anything else. The server's text is the only thing that knows
 *     what is wrong, so keep showing it, visually bounded to one line.
 *
 * `description` is always the complete text either way: nothing is truncated
 * in the DOM, only in pixels, so `aria-describedby` is unaffected.
 */
export type NewChatAgentUnavailability =
  | { kind: 'state'; stateLabel: string; description: string }
  | { kind: 'reason'; description: string };

export function resolveNewChatAgentUnavailability(
  agent: Pick<AgentData, 'available' | 'enable' | 'unavailableReason'>,
): NewChatAgentUnavailability | undefined {
  if (agent.available !== false) return undefined;
  const description =
    agent.unavailableReason ?? NEW_CHAT_AGENT_UNAVAILABLE_FALLBACK;
  return resolveNewChatAgentEnable(agent)
    ? {
        kind: 'state',
        stateLabel: NEW_CHAT_AGENT_NOT_SET_UP_LABEL,
        description,
      }
    : { kind: 'reason', description };
}

/**
 * FIND half of Enable's find-or-create: the authored (non-alias) Agent
 * already bound to this engine connection, if one is loaded. The alias row
 * itself carries the same binding, so engine defaults are excluded.
 *
 * AC7 note: this and the three `engineDefault` reads below are the surviving
 * consumers of that flag, and every one of them is about PRESENTATION of a
 * virtual row — which Agent an alias stands in for, whether the alias should
 * still be shown, and which engine group a row belongs to. None is a lock.
 * The one that WAS a lock (`useAgentsViewModel`'s `locked`) is gone; a flag
 * meaning "no Agent file exists yet" was never a reason to disable an editor,
 * and the fix for a missing file is to create it, not to grey out the six
 * tabs that would have edited it.
 */
export function findAuthoredAgentForEngineConnection(
  agents: AgentData[],
  engineConnectionId: string,
): AgentData | undefined {
  return agents.find(
    (agent) =>
      !agent.engineDefault &&
      agent.execution?.agentConnectionId === engineConnectionId,
  );
}

/**
 * station#1089. Deliberately reports the CONNECTION directory rather than
 * relocating the agent to `$HOME` to match the old copy. A project with no
 * `workingDirectory` is, in the server resolver's own words, "an
 * organizational/knowledge scope, not a directory binding" — the absence of a
 * statement. The connection's Working Directory is a path the user typed into
 * a form. Ranking the absence above the statement would relocate NEW chats on
 * such a connection. The lie was in this label, so this label is what changes.
 *
 * An earlier version of this comment also claimed the reorder would invalidate
 * existing sessions' resume cursors. That is FALSE and review proved it: a
 * recovered session replays its persisted `cwd` as `input.cwd`
 * (orchestration-session-state.ts), and the recovery hook short-circuits the
 * resolver entirely when one is present (orchestration-service.ts) — so no
 * precedence change BELOW `input.cwd` can reach an existing session, and its
 * fingerprint is unchanged. Only new sessions would move. The argument above
 * stands on its own; this one never did.
 */
export function resolveNewChatWorkspaceHint({
  agent,
  project,
  acpConnections,
}: {
  agent: AgentData | undefined;
  project: ProjectMetadata | undefined;
  acpConnections: ACPSelectionConnection[];
}): NewChatWorkspaceHint {
  const projectDirectory = project?.workingDirectory?.trim();
  if (projectDirectory) return { kind: 'project', path: projectDirectory };

  const connectionId = agent?.execution?.agentConnectionId;
  const connectionDirectory = connectionId
    ? acpConnections
        .find((connection) => connection.id === connectionId)
        ?.cwd?.trim()
    : undefined;
  if (connectionDirectory) {
    return { kind: 'connection', path: connectionDirectory };
  }

  return { kind: 'home' };
}

export function resolveNewChatInitialContext(
  activeProjectSlug: string | null | undefined,
  projects: ProjectMetadata[],
): string {
  const activeProject = activeProjectSlug
    ? projects.find((project) => project?.slug === activeProjectSlug)
    : undefined;
  // A direct chat must not inherit Station's placeholder/organisational
  // project as an execution workspace. The server rightly rejects that
  // target because it cannot resolve a working directory; global chat is the
  // usable, explicit fallback until the person picks a real project.
  return activeProject?.workingDirectory?.trim()
    ? activeProject.slug
    : GLOBAL_CONTEXT;
}

export function buildNewChatModelOverrideKey(
  agent: Pick<AgentData, 'slug' | 'execution'>,
  context: string,
): string {
  return `${context}\u001f${agentBindingId(agent)}\u001f${agent.slug}`;
}

export function newChatProjectDefaultModel(
  agent: Pick<AgentData, 'execution'> | null | undefined,
  projectDefaultModel?: string,
): string | undefined {
  return isProviderManagedAgent(agent) ? undefined : projectDefaultModel;
}

/**
 * "Remember the most-recently-chosen model" is an External-agent (agent
 * app) concept. For a PROVIDER_MANAGED (Station) agent the resolved model
 * already comes from the project/global default model chain, which an
 * admin can change at any time; a stale remembered value must never
 * shadow that, so this mirrors the same PROVIDER_MANAGED gate used by
 * newChatProjectDefaultModel above.
 */
export function newChatLastChosenModel(
  agent: Pick<AgentData, 'slug' | 'execution'> | null | undefined,
  lastChosenModelByBinding: LastChosenModelMap,
): string | undefined {
  if (!agent || isProviderManagedAgent(agent)) {
    return undefined;
  }
  return lastChosenModelByBinding[buildLastChosenModelBindingKey(agent)];
}

export function scheduleSelectedAgentVisibility(
  element: HTMLButtonElement | null,
  schedule: (callback: FrameRequestCallback) => number = requestAnimationFrame,
): number | null {
  if (!element) return null;
  return schedule(() => element.scrollIntoView({ block: 'nearest' }));
}

export function splitCwdBreadcrumb(path: string): {
  parent: string;
  separator: string;
  leaf: string;
} {
  const normalized = path === '/' ? path : path.replace(/\/+$/, '');
  const separatorIndex = normalized.lastIndexOf('/');
  if (separatorIndex < 0) {
    return { parent: '', separator: '', leaf: normalized };
  }
  if (normalized === '/') {
    return { parent: '', separator: '', leaf: '/' };
  }
  return {
    parent: normalized.slice(0, separatorIndex),
    separator: '/',
    leaf: normalized.slice(separatorIndex + 1),
  };
}

export interface NewChatModalContextOption {
  value: string;
  label: string;
  icon?: string;
  glyph?: 'folder' | 'globe';
  workingDirectory?: string;
}

export interface NewChatModalAgentGroup {
  label: string;
  icon?: string;
  glyph?: 'engine' | 'globe' | 'plug' | 'time';
  agents: AgentData[];
}

export interface NewChatModalViewModel {
  isGlobal: boolean;
  selectedProject: ProjectMetadata | undefined;
  contextOptions: NewChatModalContextOption[];
  filteredContextOptions: NewChatModalContextOption[];
  currentContextOption: NewChatModalContextOption | undefined;
  groups: NewChatModalAgentGroup[];
  flatList: AgentData[];
  /**
   * The scope-filtered, pre-search eligible set (project ownership + agent
   * filter applied). Enable's FIND must run over THIS set, not the raw
   * agents prop, or an out-of-scope authored Agent could be silently
   * selected into a context the scope policy excludes it from (#3027 M2).
   */
  scopedAgents: AgentData[];
  compatibilityMessage?: string;
}

export function resolveNewChatDefaultSelection({
  flatList,
  agentConnections,
  modelConnections,
  acpConnections,
  projectDefaultModel,
  lastChosenModelByBinding = {},
}: {
  flatList: AgentData[];
  agentConnections: AgentConnectionView[];
  modelConnections: ConnectionConfig[];
  acpConnections: ACPSelectionConnection[];
  projectDefaultModel?: string;
  lastChosenModelByBinding?: LastChosenModelMap;
}) {
  // The first RUNNABLE row, or NONE. `flatList` deliberately includes
  // unavailable Agents (the picker lists them so their reason and repair path
  // are visible), so `flatList[0]` recommended an Agent the very same modal
  // labels "Not set up" — and Home's "Start direct chat" card, which reads
  // this, printed exactly that.
  //
  // The first fix kept `?? flatList[0]` as a fallback so the card would still
  // name something. That reintroduced the contradiction for exactly the home
  // that suffers most from it — a fresh install where nothing is set up yet —
  // and it is the wrong shape anyway: when no agent can run, the honest card
  // is a SET-UP call to action, not a recommendation. `undefined` is that
  // signal; Home renders the CTA (see `useHomeViewModel.startReady`).
  const agent = flatList.find(
    (candidate) => agentRunnability(candidate).runnable,
  );
  const runtimeConnection = agentConnections.find(
    (connection) => connection.id === agent?.execution?.agentConnectionId,
  );
  const providerConnection = modelConnections.find(
    (connection) =>
      connection.id === agent?.execution?.runtimeOptions?.providerId,
  );
  const acpConnection = acpConnections.find(
    (connection) => connection.id === runtimeConnection?.id,
  );
  const effectiveModel = resolveEffectiveModel({
    agent,
    runtimeConnection: providerConnection ?? runtimeConnection,
    runtimeCurrentModel: acpConnection?.currentModel,
    runtimeCurrentMode: acpConnection?.configOptions?.find(
      (option) => option.category === 'mode',
    )?.currentValue,
    projectDefaultModel: newChatProjectDefaultModel(agent, projectDefaultModel),
    lastChosenModel: newChatLastChosenModel(agent, lastChosenModelByBinding),
  });
  return { agent, effectiveModel: guaranteeConcreteModel(effectiveModel) };
}

type ActiveChatSnapshot = Record<
  string,
  {
    agentSlug?: string;
    messages?: unknown[];
    projectSlug?: string;
    lastActivity?: number;
  }
>;

export function buildContextOptions(
  projects: ProjectMetadata[],
): NewChatModalContextOption[] {
  const options: NewChatModalContextOption[] = [
    { value: GLOBAL_CONTEXT, label: 'No workspace', glyph: 'globe' },
  ];
  for (const project of projects) {
    if (!project) {
      continue;
    }
    options.push({
      value: project.slug,
      label: project.name,
      ...(project.icon ? { icon: project.icon } : { glyph: 'folder' as const }),
      workingDirectory: project.workingDirectory,
    });
  }
  return options;
}

export function filterContextOptions(
  contextOptions: NewChatModalContextOption[],
  contextSearch: string,
): NewChatModalContextOption[] {
  if (!contextSearch) return contextOptions;
  const query = contextSearch.toLowerCase();
  return contextOptions.filter((option) =>
    option.label.toLowerCase().includes(query),
  );
}

export function getRecentAgentSlugsForContext(
  chats: ActiveChatSnapshot,
  context: string,
  storedRecentSlugs: string[],
): string[] {
  const isGlobal = context === GLOBAL_CONTEXT;
  const slugs: string[] = [];

  const entries = Object.values(chats)
    .filter((chat) => {
      if (!chat.agentSlug || !chat.messages?.length) return false;
      if (isGlobal) return !chat.projectSlug;
      return chat.projectSlug === context;
    })
    .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));

  for (const chat of entries) {
    const agentSlug = chat.agentSlug;
    if (agentSlug && !slugs.includes(agentSlug)) {
      slugs.push(agentSlug);
    }
    if (slugs.length >= 3) break;
  }

  for (const slug of storedRecentSlugs) {
    if (!slugs.includes(slug)) {
      slugs.push(slug);
    }
    if (slugs.length >= 5) break;
  }

  return slugs;
}

export function buildNewChatModalViewModel({
  agents,
  projects,
  agentConnections,
  selectedContext,
  contextSearch,
  agentSearch,
  selectedProjectAgentFilter,
  layoutAvailableAgents,
  layoutName,
  layoutIcon,
  providerManagedAgentSlugs = [],
  recentSlugs,
}: {
  agents: AgentData[];
  projects: ProjectMetadata[];
  agentConnections: AgentConnectionView[];
  selectedContext: string;
  contextSearch: string;
  agentSearch: string;
  selectedProjectAgentFilter?: AgentId[];
  layoutAvailableAgents: string[];
  layoutName?: string;
  layoutIcon?: string;
  providerManagedAgentSlugs?: AgentId[];
  recentSlugs: string[];
}): NewChatModalViewModel {
  const contextOptions = buildContextOptions(projects);
  const filteredContextOptions = filterContextOptions(
    contextOptions,
    contextSearch,
  );
  const selectedProject = projects.find(
    (project) => project.slug === selectedContext,
  );
  const currentContextOption = contextOptions.find(
    (option) => option.value === selectedContext,
  );
  const isGlobal = selectedContext === GLOBAL_CONTEXT;

  const query = agentSearch.toLowerCase();
  const { chatReadyAgents, providerManagedAgents, unavailableAgents } =
    selectProjectScopedChatAgents({
      agents,
      agentConnections,
      selectedProjectSlug: selectedProject?.slug,
      selectedProjectAgentFilter,
      providerManagedAgentSlugs,
    });
  const eligibleAgents = new Map<string, AgentData>();
  for (const agent of [
    ...chatReadyAgents,
    ...providerManagedAgents,
    ...unavailableAgents,
  ]) {
    if (!eligibleAgents.has(agent.slug)) {
      eligibleAgents.set(agent.slug, agent);
    }
  }
  // station#3027(c): an engine-default alias row exists to say "this engine
  // has no authored Agent yet". Once an authored Agent bound to the same
  // engine connection is in scope, the alias would sit as a permanently dead
  // row beside the live one — hide it. Purely derived state: deleting the
  // authored Agent un-hides the alias on the next build. Derived from the
  // pre-search eligible set so typing a query matching only the alias cannot
  // resurrect it.
  const authoredBoundConnectionIds = new Set<string>();
  for (const agent of eligibleAgents.values()) {
    const boundConnectionId = agent.execution?.agentConnectionId;
    if (!agent.engineDefault && boundConnectionId) {
      authoredBoundConnectionIds.add(boundConnectionId);
    }
  }
  const isDemotedAliasRow = (agent: AgentData) =>
    Boolean(
      agent.engineDefault &&
        agent.execution?.agentConnectionId &&
        authoredBoundConnectionIds.has(agent.execution.agentConnectionId),
    );
  const filtered = [...eligibleAgents.values()].filter(
    (agent) =>
      !isDemotedAliasRow(agent) &&
      (agent.name.toLowerCase().includes(query) ||
        agent.slug.toLowerCase().includes(query)),
  );

  const isLayoutAgent = (agent: AgentData) => {
    if (agent.engineConnectionType === 'acp') return false;
    if (layoutAvailableAgents.includes(agent.slug)) return true;
    if (agent.plugin) return true;
    return false;
  };

  // Registry-owned defaults join their engine group by explicit marker.
  // Presentation only — see `findAuthoredAgentForEngineConnection` (AC7).
  const engineGroupSlugs = new Set(
    filtered
      .filter((agent) => isEngineProvenanceAgent(agent))
      .map((agent) => agent.slug),
  );

  const isAcpAgent = (agent: AgentData) => agent.engineConnectionType === 'acp';
  const engineAgents = filtered.filter(
    (agent) => engineGroupSlugs.has(agent.slug) && !isAcpAgent(agent),
  );
  const wsAgents = filtered.filter(
    (agent) => !engineGroupSlugs.has(agent.slug) && isLayoutAgent(agent),
  );
  const globalAgents = filtered.filter(
    (agent) =>
      !isAcpAgent(agent) &&
      !engineGroupSlugs.has(agent.slug) &&
      !isLayoutAgent(agent),
  );
  const acpAgents = filtered.filter(isAcpAgent);

  const seenRecentSlugs = new Set<string>();
  const recentAgents = agentSearch
    ? []
    : recentSlugs
        .map((slug) => filtered.find((agent) => agent.slug === slug))
        .filter((agent): agent is AgentData => {
          if (!agent) return false;
          if (seenRecentSlugs.has(agent.slug)) return false;
          seenRecentSlugs.add(agent.slug);
          return true;
        });
  const recentSet = new Set(recentAgents.map((agent) => agent.slug));

  const groups: NewChatModalAgentGroup[] = [];

  if (recentAgents.length > 0) {
    groups.push({ label: 'Recent', glyph: 'time', agents: recentAgents });
  }
  const visibleEngineAgents = engineAgents.filter(
    (agent) => !recentSet.has(agent.slug) || !!agentSearch,
  );

  const showLayoutAgents = isGlobal || (selectedProject?.layoutCount ?? 0) > 0;
  if (showLayoutAgents && wsAgents.length > 0) {
    groups.push({
      label: layoutName || 'Layout',
      icon: layoutIcon,
      agents: wsAgents.filter(
        (agent) => !recentSet.has(agent.slug) || !!agentSearch,
      ),
    });
  }

  /*
   * DESIGN.md §5: the picker is grouped "the same two ways" the Agents list
   * is — `Engines on this machine` (the `engineDefault` provenance marker,
   * command-backed engines included) and `Your agents`. It used to open one
   * group PER ENGINE DISPLAY NAME plus a `Global` group, so a fresh install
   * showed four one-row groups and an authored agent sat under a heading
   * ("Global") that names a scope, not a kind. `engineDefault` is the same
   * field `buildAgentsViewItems` bands on, so the two surfaces cannot band
   * the same agent differently.
   *
   * `Recent` and a project layout's own group survive above them: those are
   * CONTEXT groupings (what you used last here, what this layout offers),
   * orthogonal to what an agent IS, and the list has no equivalent because
   * it is not opened inside a context.
   */
  const notRecent = (agent: AgentData) =>
    !recentSet.has(agent.slug) || !!agentSearch;
  const engineBand = [...visibleEngineAgents, ...acpAgents.filter(notRecent)];
  if (engineBand.length > 0) {
    groups.push({
      label: ENGINE_BAND_LABEL,
      glyph: 'engine',
      agents: engineBand,
    });
  }
  const authoredBand = globalAgents.filter(notRecent);
  if (authoredBand.length > 0) {
    groups.push({
      label: AUTHORED_BAND_LABEL,
      glyph: 'globe',
      agents: authoredBand,
    });
  }

  const visibleGroups = groups.filter((group) => group.agents.length > 0);
  // Only warn about genuinely-degraded runtimes — not optional ones that are
  // simply unconfigured (e.g. the always-present Bedrock runtime with no AWS
  // creds). Flagging those nags every creds-free Ollama user with a scary
  // "Setup required" banner they don't need to act on.
  const degradedRuntime = agentConnections.find(
    (connection) =>
      connection.type !== 'acp' &&
      connection.enabled &&
      connection.capabilities.includes('agent-runtime') &&
      (connection.status === 'degraded' || connection.status === 'error'),
  );
  const compatibilityMessage = degradedRuntime
    ? `${degradedRuntime.name}: ${connectionStatusLabel(degradedRuntime.status)}${
        degradedRuntime.runtimeCatalog?.source
          ? ` · Catalog ${runtimeCatalogSourceLabel(
              degradedRuntime.runtimeCatalog.source,
            )}`
          : ''
      }`
    : undefined;
  return {
    isGlobal,
    selectedProject,
    contextOptions,
    filteredContextOptions,
    currentContextOption,
    groups: visibleGroups,
    flatList: visibleGroups.flatMap((group) => group.agents),
    scopedAgents: [...eligibleAgents.values()],
    compatibilityMessage,
  };
}

// Re-exported from their new entry-safe homes (hooks/lastChosenModel.ts;
// ./new-chat-agent-enable.ts, whose own note explains why it moved) so
// existing modal-side importers keep working.
export {
  buildLastChosenModelBindingKey,
  isProviderManagedAgent,
  resolveNewChatAgentEnable,
};
