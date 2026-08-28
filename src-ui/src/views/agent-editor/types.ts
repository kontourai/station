import type {
  AgentDelegationPolicy,
  AgentTools,
  SlashCommand,
} from '@kontourai/station-contracts/agent';
import type { AgentEditorTabKey } from '@kontourai/station-contracts/agent-capability-profile';
import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import type { Dispatch, SetStateAction } from 'react';
import type { NavigationView, Tool } from '../../types';
import type { EngineKind } from './AgentEditorEngineSelection';

export interface AgentFormData {
  slug: string;
  name: string;
  description: string;
  prompt: string;
  modelId: string;
  region: string;
  guardrails: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    maxSteps?: number;
  } | null;
  maxSteps: string;
  /**
   * Every contract tool field, all present. Deriving this instead of listing
   * it means a field added to `AgentTools` becomes a COMPILE ERROR here until
   * the form models it — rather than being silently dropped on save, which is
   * exactly how `aliases` was lost (archive#2693).
   */
  tools: Required<AgentTools>;
  /**
   * The spec's `tools` object exactly as loaded, so a save can distinguish an
   * ABSENT key from an authored-empty one and can carry through fields this
   * form does not model (`tools.env`).
   *
   * Absent is not the same as empty anywhere downstream: the runtime reads
   * `spec.tools.available || ['*']`, and `[]` is truthy — so writing an empty
   * array where the key was absent flips "all tools allowed" into "no tools
   * allowed". Likewise an authored-empty `mcpServers` means "explicitly
   * disable every tool server" and ships `strictMcpConfig: true` to external
   * engines. `undefined` = the agent had no `tools` object at all.
   */
  toolsOriginal?: Partial<AgentTools> & Record<string, unknown>;
  /** Preserved and displayed in Advanced; not editable in this UI yet. */
  delegation?: AgentDelegationPolicy;
  execution: {
    agentConnectionId: string;
    modelConnectionId: string;
    runtimeOptions: Record<string, unknown>;
    modelOptions?: Record<string, unknown>;
    /**
     * archive#3530: which credential profile (account) of the bound engine
     * this agent runs on. Preserved and displayed in the Engine tab; not
     * editable in this UI yet (same contract as `delegation` above) — an
     * account picker needs a way to enrol more than one account per engine
     * first (archive#3532).
     *
     * It must round-trip even though nothing here edits it: the save payload
     * builds `execution` as an explicit whitelist, so a field absent from
     * this type is silently DELETED by any unrelated edit — rename the agent
     * and its pinned account is gone, falling back to the connection's
     * account with no signal.
     */
    credentialProfileRef?: string;
  };
  icon: string;
  skills: string[];
  /**
   * Owning project slug; `''` = global (agent-engine-unification.md §3.3,
   * archive#1004 unification). Rendered by the Basic tab's Project
   * `<select>`.
   */
  project: string;
}

/** The editor's active-tab key — archive#975: derived per-agent from
 * `deriveAgentEditorTabs` (packages/contracts/src/agent-capability-profile.ts)
 * instead of a fixed per-type set (`AgentType` itself retired in,
 * archive#1003). */
export type AgentEditorTab = AgentEditorTabKey;

export interface AgentEditorFormProps {
  form: AgentFormData;
  setForm: Dispatch<SetStateAction<AgentFormData>>;
  isCreating: boolean;
  locked: boolean;
  isPlugin: boolean | '' | undefined;
  isLocked: boolean;
  validationErrors: Record<string, string>;
  /**
   * Whether this agent must author its own system prompt — the engine's
   * `systemPrompt.state` combined with the reserved-`station` exemption, the
   * SAME predicate the save validates against. The field's required marker
   * and the Create gate both read it (archive#3741).
   */
  promptIsRequired: boolean;
  availableTools: Tool[];
  availableSkills: any[];
  integrationTools: Record<string, Tool[]>;
  appConfig: any;
  enrich: (prompt: string) => Promise<string | null>;
  isEnriching: boolean;
  onNavigate: (view: NavigationView) => void;
  onOpenAddModal: (type: 'integrations' | 'skills') => void;
  agentConnections?: ConnectionConfig[];
  /** Persisted authored commands, exposed read-only when the engine cannot deliver them. */
  authoredCommands?: Record<string, SlashCommand>;
  /**
   * DESIGN.md §3.2's engine question as an explicit answer rather than one
   * derived from the binding. It has to be explicit for the one state the
   * binding cannot represent: "an installed agent CLI" chosen, none named yet.
   */
  engineKind: EngineKind;
  onEngineKindChange: (kind: EngineKind) => void;
  /** The Station-engine connection to bind when "Use a model connection" wins. */
  stationConnectionId: string;
}
