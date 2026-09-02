import type {
  AgentDelegationPolicy,
  AgentSpec,
  AgentTools,
} from '@kontourai/station-contracts/agent';
import {
  agentId,
  engineConnectionId,
  isStationAgentIdentity,
} from '@kontourai/station-contracts/agent-identity';
import {
  requiresAgentPromptForRuntime,
  requiresAuthoredAgentPrompt,
} from '@kontourai/station-contracts/agent-validation';
import { classifyManagedModelBinding } from '@kontourai/station-contracts/managed-model-binding';
import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import type { Tool } from '../../types';
import { connectionStatusLabel } from '../../utils/execution';
import type { AgentFormData } from './types';

type AgentLike = {
  slug?: string;
  id?: string;
  name?: string;
  description?: string;
  prompt?: string;
  model?:
    | string
    | {
        modelId?: string;
      };
  region?: string;
  guardrails?: AgentFormData['guardrails'] | Record<string, unknown> | null;
  maxSteps?: number | string | null;
  /**
   * Sourced from the contract rather than redeclared. A local copy of this
   * shape omitted `aliases`, so `formFromAgent` could not see a field the
   * contract, the API, and `src-ui/src/types.ts` all define — which is how the
   * editor silently discarded an agent's aliases (archive#2693).
   */
  toolsConfig?: Partial<AgentTools>;
  delegation?: AgentDelegationPolicy;
  execution?: {
    agentConnectionId?: string;
    /** `null` is how the catalog projection spells "explicitly none". */
    modelConnectionId?: string | null;
    runtimeOptions?: Record<string, unknown>;
    modelOptions?: Record<string, unknown>;
    modelId?: string | null;
    /**
     * archive#3530. This local shape is a narrowing of the real
     * `AgentExecutionConfig`, and the docblock above already records what that
     * costs: a field the editor's types do not carry is a field the editor
     * silently discards (archive#2693, aliases). A pinned account dropped by
     * an unrelated save is the same failure with credentials attached.
     */
    credentialProfileRef?: string | null;
  };
  icon?: string;
  skills?: string[];
  project?: string;
};

/**
 * Every persisted Agent field is deliberately classified before copying.
 * `satisfies Record<keyof AgentSpec,...>` turns a new contract field into a
 * compile failure until its copy policy is explicitly chosen.
 */
export const AGENT_SPEC_COPY_CLASSIFICATION = {
  name: 'clone',
  prompt: 'clone',
  description: 'clone',
  icon: 'clone',
  model: 'clone',
  execution: 'clone',
  region: 'clone',
  maxSteps: 'clone',
  guardrails: 'clone',
  tools: 'clone',
  skills: 'clone',
  project: 'exclude',
  delegation: 'exclude',
  streaming: 'exclude',
  commands: 'exclude',
  ui: 'exclude',
  provenance: 'exclude',
} as const satisfies Record<keyof AgentSpec, 'clone' | 'exclude'>;

export function createEmptyAgentForm(
  defaultRuntimeConnectionId = '',
): AgentFormData {
  return {
    slug: '',
    name: '',
    description: '',
    prompt: '',
    modelId: '',
    region: '',
    guardrails: null,
    maxSteps: '',
    tools: { mcpServers: [], available: [], autoApprove: [] },
    toolsOriginal: undefined,
    execution: {
      agentConnectionId: defaultRuntimeConnectionId,
      modelConnectionId: '',
      runtimeOptions: {},
      modelOptions: {},
    },
    icon: '',
    skills: [],
    project: '',
  };
}

/**
 * archive#3662: an absent `agentConnectionId` is carried into
 * the form AS ABSENT (`''`), which is how the form spells "runs on Station's
 * own engine". It used to be replaced with the default managed-runtime
 * connection id, so merely opening the healed Station Agent and saving an
 * unrelated field re-created the binding the heal had just removed — and
 * server dispatch switched from the Station branch back to the connection
 * branch. The engine picker maps `''` <-> "Station"; nothing else may invent
 * an id for it.
 */
export function formFromAgent(agent: AgentLike): AgentFormData {
  return {
    slug: agent.slug || agent.id || '',
    name: agent.name || '',
    description: agent.description || '',
    prompt: agent.prompt || '',
    modelId:
      typeof agent.execution?.modelId === 'string'
        ? agent.execution.modelId
        : typeof agent.model === 'string'
          ? agent.model
          : agent.model?.modelId || '',
    region: agent.region || '',
    guardrails:
      typeof agent.guardrails === 'object' && agent.guardrails
        ? agent.guardrails
        : null,
    maxSteps: agent.maxSteps?.toString() || '',
    tools: {
      mcpServers: agent.toolsConfig?.mcpServers || [],
      available: agent.toolsConfig?.available || [],
      autoApprove: agent.toolsConfig?.autoApprove || [],
    },
    toolsOriginal: agent.toolsConfig,
    ...(agent.delegation ? { delegation: agent.delegation } : {}),
    execution: {
      agentConnectionId: agent.execution?.agentConnectionId || '',
      modelConnectionId: agent.execution?.modelConnectionId || '',
      runtimeOptions: agent.execution?.runtimeOptions || {},
      modelOptions: agent.execution?.modelOptions || {},
      ...(typeof agent.execution?.credentialProfileRef === 'string' &&
      agent.execution.credentialProfileRef
        ? { credentialProfileRef: agent.execution.credentialProfileRef }
        : {}),
    },
    icon: agent.icon || '',
    skills: agent.skills || [],
    project: agent.project || '',
  };
}

/**
 * The one safe copy projection. It intentionally omits identity, ownership,
 * provenance, delegation, commands, UI metadata, credentials, and tool
 * environment values; a copied Agent starts with its own defaults for those.
 */
export function cloneableAgentFields(agent: AgentLike): Partial<AgentFormData> {
  return {
    name: agent.name || '',
    description: agent.description || '',
    prompt: agent.prompt || '',
    modelId:
      typeof agent.execution?.modelId === 'string'
        ? agent.execution.modelId
        : typeof agent.model === 'string'
          ? agent.model
          : agent.model?.modelId || '',
    region: agent.region || '',
    guardrails:
      typeof agent.guardrails === 'object' && agent.guardrails
        ? agent.guardrails
        : null,
    maxSteps: agent.maxSteps?.toString() || '',
    tools: {
      mcpServers: [...(agent.toolsConfig?.mcpServers || [])],
      available: [...(agent.toolsConfig?.available || [])],
      autoApprove: [...(agent.toolsConfig?.autoApprove || [])],
    },
    execution: {
      agentConnectionId: agent.execution?.agentConnectionId || '',
      modelConnectionId: agent.execution?.modelConnectionId || '',
      runtimeOptions: { ...(agent.execution?.runtimeOptions || {}) },
      modelOptions: { ...(agent.execution?.modelOptions || {}) },
    },
    icon: agent.icon || '',
    skills: [...(agent.skills || [])],
  };
}

export function createNewAgentForm(
  initialForm?: Partial<AgentFormData>,
  defaultRuntimeConnectionId = '',
) {
  return initialForm
    ? { ...createEmptyAgentForm(defaultRuntimeConnectionId), ...initialForm }
    : createEmptyAgentForm(defaultRuntimeConnectionId);
}

export function isAgentFormDirty(
  form: AgentFormData,
  saved: AgentFormData,
): boolean {
  return JSON.stringify(form) !== JSON.stringify(saved);
}

/**
 * archive#1003 (unification): the caller passes the already-
 * computed matrix-derived `requiresPrompt` (the engine's `systemPrompt.state
 * === 'native'`, `useAgentsViewModel.ts`) — no `agentType` classification
 * left here. Falls back to resolving it from `agentConnectionId` directly
 * when the caller omits it (existing test-double/legacy call sites).
 */
export function validateAgentForm(
  form: AgentFormData,
  isCreating: boolean,
  options?: { requiresPrompt?: boolean },
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!form.name.trim()) errors.name = 'Name is required';
  // archive#3662: the reserved `station` Agent is the one Station-engine
  // Agent whose instance the runtime builds, not this record — so an empty
  // prompt on it is Station's own prompt, not a missing one. Same predicate
  // the persistence validator applies, so the form and the save agree.
  const requiresPrompt = requiresAuthoredAgentPrompt(
    form.slug,
    options?.requiresPrompt ??
      requiresAgentPromptForRuntime(form.execution.agentConnectionId),
  );
  if (requiresPrompt && !form.prompt.trim()) {
    errors.prompt = 'System prompt is required';
  }
  if (isCreating) {
    if (!form.slug.trim()) errors.slug = 'Slug is required';
    else if (!/^[a-z0-9-]+$/.test(form.slug))
      errors.slug = 'Lowercase letters, numbers, hyphens only';
  }
  return errors;
}

/**
 * Build the `tools` object to send, preserving the distinction between a key
 * that was ABSENT on the spec and one authored as empty.
 *
 * Writing `[]` where a key was absent is not a no-op downstream: the runtime
 * reads `spec.tools.available || ['*']` and `[]` is truthy, so an absent
 * allow-list ("every tool") becomes an empty one ("no tools") and the agent
 * silently loads nothing; an authored-empty `mcpServers` additionally means
 * "disable every tool server" and ships `strictMcpConfig: true` to external
 * engines, suppressing their own MCP discovery. Fields this form does not
 * model (`tools.env`) are carried through from the original rather than
 * dropped, since replacing the whole object is what destroys them.
 *
 * Returns undefined when there is nothing to say, so an omitted key keeps its
 * "no change" meaning at the server.
 */
function buildToolsPayload(
  form: AgentFormData,
): (Partial<AgentTools> & Record<string, unknown>) | undefined {
  const original = form.toolsOriginal;
  const authored = (key: keyof AgentTools) =>
    original !== undefined && original[key] !== undefined;

  const next: Partial<AgentTools> & Record<string, unknown> = {
    // Unmodelled fields (e.g. `env`) survive the round trip.
    ...(original ?? {}),
  };

  const put = <K extends keyof AgentTools>(
    key: K,
    value: NonNullable<AgentTools[K]>,
  ) => {
    const empty = Array.isArray(value)
      ? value.length === 0
      : Object.keys(value ?? {}).length === 0;
    if (empty && !authored(key)) {
      delete next[key];
      return;
    }
    (next as Partial<AgentTools>)[key] = value;
  };

  put('mcpServers', form.tools.mcpServers);
  put('available', form.tools.available);
  put('autoApprove', form.tools.autoApprove);

  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * `project` is the ownership field (archive#1004, unification). A
 * non-empty select value is sent as-is. An empty ("Global") selection means
 * two different things depending on the request: on CREATE it's simply
 * omitted (undefined drops out of the JSON body — no project field at all,
 * the schema-valid "global" shape); on UPDATE it's the explicit
 * ownership-clearing signal the server's `project: null` path expects
 * (agent-service.ts §4) — an omitted key there would mean "no change",
 * leaving a previously-owned agent stuck owned.
 */
/**
 * The `execution` block a save should send, or `null` to delete it.
 *
 * `undefined` would mean "leave whatever is persisted alone" (the server's
 * update filters undefined values), which is wrong for a deliberate switch to
 * Station: the binding would survive a save that visibly said otherwise.
 */
function buildExecutionPayload(form: AgentFormData) {
  const runtimeOptions =
    Object.keys(form.execution.runtimeOptions).length > 0
      ? form.execution.runtimeOptions
      : undefined;
  const modelOptions =
    Object.keys(form.execution.modelOptions ?? {}).length > 0
      ? form.execution.modelOptions
      : undefined;
  const execution = {
    // The detail read projects the built-in Agent's live Station setting so
    // the Engine row can state what will run. That projection is display
    // state, not an Agent field: never submit it back through the write seam.
    ...(!isStationAgentIdentity(form.slug) && form.execution.agentConnectionId
      ? {
          agentConnectionId: engineConnectionId(
            form.execution.agentConnectionId,
          ),
        }
      : {}),
    modelConnectionId: form.execution.modelConnectionId || undefined,
    modelId: form.modelId || undefined,
    runtimeOptions,
    modelOptions,
    // archive#3530: nothing in this editor sets this, but this object is an
    // explicit whitelist — omitting it DELETES a pinned account on any
    // unrelated save.
    credentialProfileRef: form.execution.credentialProfileRef || undefined,
  };
  return Object.values(execution).some((value) => value !== undefined)
    ? execution
    : null;
}

const STATION_ENGINE_SETTING_SAVE_MESSAGE =
  'Change the built-in Agent engine in Settings, then save your changes again.';

/** Translate structured save refusals into reader-facing editor actions. */
export function agentSaveErrorMessage(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'STATION_ENGINE_IS_APP_SETTING'
  ) {
    return STATION_ENGINE_SETTING_SAVE_MESSAGE;
  }
  return error instanceof Error ? error.message : 'Could not save this Agent.';
}

export function buildAgentPayload(
  form: AgentFormData,
  options: { isCreating?: boolean } = {},
) {
  return {
    slug: agentId(form.slug),
    name: form.name,
    description: form.description || undefined,
    prompt: form.prompt,
    model: form.modelId || undefined,
    region: form.region || undefined,
    guardrails: form.guardrails || undefined,
    maxSteps: form.maxSteps ? parseInt(form.maxSteps, 10) : undefined,
    // Send `tools` when ANY of its fields carries state. Gating on
    // mcpServers alone silently discarded available/autoApprove/aliases for
    // an agent with no MCP servers — a save the editor reported as success
    // (archive#2693).
    tools: buildToolsPayload(form),
    ...(form.delegation ? { delegation: form.delegation } : {}),
    // archive#3662: gated on the whole block carrying state, not
    // on the binding alone. A Station-engine Agent has NO `agentConnectionId`
    // and may still have a model pin or runtime options, and the old gate
    // silently dropped them. `null` is the explicit clear — the same signal
    // `project` uses below — so switching an Agent from an external engine TO
    // Station actually removes the binding instead of leaving the server's
    // merge to keep it.
    execution: buildExecutionPayload(form),
    icon: form.icon || undefined,
    skills: form.skills.length > 0 ? form.skills : undefined,
    ...(form.project
      ? { project: form.project }
      : options.isCreating
        ? {}
        : { project: null }),
  };
}

export function groupAgentToolsByServer(agentTools: Tool[]) {
  const grouped: Record<string, Tool[]> = {};
  for (const tool of agentTools) {
    if (!tool.server) {
      continue;
    }
    if (!grouped[tool.server]) {
      grouped[tool.server] = [];
    }
    grouped[tool.server].push(tool);
  }
  return grouped;
}

/**
 * Can Station's engine run a chat on this connection RIGHT NOW? The server's
 * own facts, read as the server computed them.
 *
 * archive#3747: the LLM-capability half used to be re-derived here. It is the
 * model inventory's own membership rule and the connections this is asked
 * about come from that inventory, so asking it again was a second derivation
 * of a question already answered upstream.
 */
export function isModelConnectionRunnable(
  connection: ConnectionConfig | undefined,
): connection is ConnectionConfig {
  return Boolean(connection?.enabled && connection.status === 'ready');
}

/**
 * Which model connection a Station-engine agent will actually run on — or why
 * it cannot run — from the LIVE connection list.
 *
 * archive#3743/archive#3740: the Create gate used to test a connection id captured
 * into form state when "Chat with a model" was pressed. Pressed before the
 * connections query resolved, that captured the empty string and nothing ever
 * backfilled it, so the §3.3 picker listed a connection as Ready while Create
 * stayed disabled with nothing on screen saying why — a state-dependent
 * disagreement between two answers to one question. The picker also OFFERS
 * "Use the app default", which the gate read as "no engine", so even with warm
 * data the two disagreed by construction.
 *
 * WHICH connection is bound is not decided here at all: that is
 * `classifyManagedModelBinding`, the rule the runtime itself imports. The
 * first fix re-expressed that rule locally and the copy drifted immediately —
 * it chose "the sole READY candidate" where the runtime counts every ENABLED
 * one and calls two of them ambiguous, so one ready connection beside one
 * enabled-but-degraded connection made Create pressable for an agent the
 * runtime would refuse to run.
 *
 * What is decided here is the SECOND question, and only about the connection
 * the shared rule named: can it run right now? That is this surface's to ask —
 * the gate exists so pressing Create is never how someone learns the engine
 * cannot answer — and it is applied AFTER the binding, never folded into it.
 */
export type StationModelBinding =
  | { kind: 'resolved'; connection: ConnectionConfig; explicit: boolean }
  | { kind: 'unresolved'; reason: string };

/** Why a named connection cannot serve, in the server's own words if it said. */
function connectionUnavailableReason(connection: ConnectionConfig): string {
  return (
    connection.readinessEvidence?.summary ??
    `${connection.name} is ${connectionStatusLabel(connection.status)}.`
  );
}

export function resolveStationModelBinding(input: {
  modelConnectionId: string;
  modelConnections: ConnectionConfig[];
  appConfig?: { defaultLLMProvider?: string | null } | null;
}): StationModelBinding {
  const binding = classifyManagedModelBinding({
    declaredConnectionId: input.modelConnectionId,
    appDefaultConnectionId: input.appConfig?.defaultLLMProvider,
    connections: input.modelConnections,
  });

  switch (binding.kind) {
    case 'none':
      return {
        kind: 'unresolved',
        reason:
          'Station needs a ready model connection before it can run this agent.',
      };
    case 'ambiguous':
      return {
        kind: 'unresolved',
        reason: "Choose which model connection Station's engine should use.",
      };
    case 'invalid':
      return {
        kind: 'unresolved',
        reason:
          binding.source === 'explicit'
            ? 'The model connection this agent names is no longer configured.'
            : 'The model connection set as the app default is no longer configured.',
      };
    default: {
      const connection = input.modelConnections.find(
        (candidate) => candidate.id === binding.connectionId,
      );
      // The second question, about the connection the shared rule named.
      if (isModelConnectionRunnable(connection)) {
        return {
          kind: 'resolved',
          connection,
          explicit: binding.source === 'explicit',
        };
      }
      return {
        kind: 'unresolved',
        reason: connection
          ? connectionUnavailableReason(connection)
          : 'The model connection this agent names is no longer configured.',
      };
    }
  }
}

/**
 * DESIGN.md §4: may Create be pressed?
 *
 * "The engine choice is made AND that engine is Ready." Both halves read the
 * SERVER's answer: a Station-engine agent needs a selectable managed runtime
 * connection (its `status`), a CLI agent needs the connection it named to be
 * selectable. Neither is a client guess, and neither is a post-submit
 * validation message — the repair for an unready engine is shown inline
 * beside it, so pressing Create can never be the way a person discovers the
 * engine cannot run.
 */
export function createEngineIsReady(input: {
  engineKind: 'model' | 'cli';
  /** A managed Station-engine connection is selectable right now. */
  stationEngineSelectable: boolean;
  /** The CLI connection this form named is selectable right now. */
  namedCliEngineSelectable: boolean;
}): boolean {
  return input.engineKind === 'model'
    ? input.stationEngineSelectable
    : input.namedCliEngineSelectable;
}

/**
 * DESIGN.md §4, second half (archive#3741): Create is also disabled while a
 * required field is empty.
 *
 * Create used to be pressable into `Can't save yet — please fix: System
 * prompt is required`, for a field carrying no required marker, rendered on a
 * section the person was not looking at. The errors read here are
 * `validateAgentForm`'s own, so the button and the refusal cannot disagree
 * about what is missing — and the fields say which they are.
 */
export function createIsBlocked(input: {
  isCreating: boolean;
  engineReady: boolean;
  formErrors: Record<string, string>;
}): boolean {
  return (
    input.isCreating &&
    (!input.engineReady || Object.keys(input.formErrors).length > 0)
  );
}
