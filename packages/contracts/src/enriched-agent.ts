import type {
  AgentDelegationPolicy,
  AgentExecutionConfig,
  AgentGuardrails,
  AgentSource,
  AgentSpec,
  AgentTools,
  AgentUIConfig,
  DelegationDeniedCommandCatalog,
  SlashCommand,
} from './agent.js';
import type {
  AgentId,
  EngineConnectionId,
  EngineId,
} from './agent-identity.js';
import type { AgentOwnershipFinding } from './project-reference-integrity.js';
import type { ModelOption } from './tool.js';

/**
 * Shared wire projection returned by the enriched Agent catalog.
 *
 * Capability identity (`engineId`) is deliberately distinct from the
 * navigable connection identity carried by `execution.agentConnectionId`.
 * Keeping this shape in contracts prevents API, SDK, and UI consumers from
 * silently widening one namespace into the other.
 */
export interface EnrichedAgentProjection {
  slug: AgentId;
  name: string;
  prompt?: string;
  description?: string;
  model?: string;
  region?: string;
  guardrails?: AgentGuardrails;
  maxSteps?: number;
  icon?: string;
  updatedAt?: string;
  commands?: Record<string, SlashCommand>;
  ui?: AgentUIConfig;
  toolsConfig?: Partial<AgentTools>;
  execution?: AgentExecutionConfig;
  delegation?: AgentDelegationPolicy;
  /** Built-in and Agent-configured denials, derived from the enforcement catalog. */
  deniedCommandCatalog?: DelegationDeniedCommandCatalog;
  skills?: string[];
  workflowWarnings?: string[];
  source?: AgentSource;
  plugin?: string;
  modelOptions?: ModelOption[] | null;
  engineId?: EngineId;
  /** Legacy display-only connection label retained for older catalog rows. */
  connectionName?: string;
  engineDisplayName?: string;
  engineConnectionType?: string;
  engineDefault?: boolean;
  /** How this definition was first created (`AgentSpec.provenance`). */
  provenance?: AgentSpec['provenance'];
  /**
   * Set on an Agent that is bound to an engine connection ANOTHER Agent is
   * already the canonical row for (station#3027 follow-up). Two authored
   * files can legitimately bind one engine — Station never deletes a user's
   * file to resolve that — but listing them side by side with nothing to tell
   * them apart makes one engine read as two Agents, and it hid which one the
   * seeding path actually adopted. Carries the engine's display name so a row
   * can say what it is also bound to. Computed only on the full catalog read:
   * it is a statement ABOUT a set, and a slug-filtered read has no set.
   */
  secondaryEngineBinding?: { engineDisplayName: string };
  /**
   * Set when Station tried to activate this Agent and gave up. It is not the
   * same as `available: false`, which is about whether the Agent can run right
   * now; this says the runtime stopped trying and why, so a surface can show
   * the reason and a repair rather than an indefinite "still starting".
   */
  activationFailure?: { reason: string; at: string };
  project?: string;
  ownership?: { findings: AgentOwnershipFinding[] };
  available?: boolean;
  unavailableReason?: string;
  /**
   * The server-derived repair for an unavailable Agent. `unavailableReason`
   * is explanatory prose; consumers must use this descriptor for behaviour.
   */
  unavailableFix?: {
    kind:
      | 'model-connection'
      | 'engine-disabled'
      | 'cli-missing'
      | 'connection-broken'
      | 'agent-configuration'
      | 'unknown'
      | 'policy'
      | 'none';
    target?: string;
  };
  /**
   * Machine-readable enable signal (station#3027). Present exactly when this
   * row is an engine-default alias refused only for lacking an authored
   * Agent spec AND its bound engine connection exists. The UI keys the
   * one-click Enable affordance on THIS field — never on parsing
   * `unavailableReason`, which is explanatory text, not an authorization
   * (the same rule `resolveNewChatAgentRemedy` already follows).
   */
  enable?: { engineConnectionId: EngineConnectionId };
}
