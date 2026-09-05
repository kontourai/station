import type { AgentId } from './agent-identity.js';

export const WORKSPACE_PANE_HOST_CONTRIBUTION_VERSION =
  'station.workspace-pane-host-contribution/v1' as const;

/** Author-owned reference; `own-plugin-agent` is qualified by the host. */
export type WorkspacePaneHostAgentRef =
  | { readonly kind: 'own-plugin-agent'; readonly agentId: AgentId }
  | { readonly kind: 'station-agent'; readonly agentId: AgentId };

export interface WorkspacePaneHostPromptAction {
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
  /** A `skill-prompt` is presentation history, not an installed Skill. */
  readonly presentation: 'action' | 'skill-prompt';
  readonly intent: (
    | {
        readonly kind: 'prompt';
        readonly prompt: string;
      }
    | {
        readonly kind: 'plugin-prompt';
        /** Exact own-package registered prompt id, never inferred from prompt text. */
        readonly promptId: string;
      }
  ) & {
    /** Omission uses only this declaration's explicit default Agent. */
    readonly agent?: WorkspacePaneHostAgentRef;
  };
}

/** Package-level composition data; it is not duplicated onto every Pane. */
export interface WorkspacePaneHostContributionV1 {
  readonly version: typeof WORKSPACE_PANE_HOST_CONTRIBUTION_VERSION;
  readonly actions: readonly WorkspacePaneHostPromptAction[];
  readonly agentSelection: {
    readonly availableAgents: readonly WorkspacePaneHostAgentRef[];
    readonly defaultAgent?: WorkspacePaneHostAgentRef;
  };
}

export interface WorkspacePaneHostContributionOwner {
  readonly pluginId: string;
  readonly installationGeneration: string;
}

export type WorkspacePaneHostBoundAgent =
  | {
      readonly kind: 'plugin-agent';
      readonly pluginId: string;
      readonly installationGeneration: string;
      readonly agentId: AgentId;
    }
  | { readonly kind: 'station-agent'; readonly agentId: AgentId };

export type WorkspacePaneHostAgentResolution =
  | { readonly state: 'available'; readonly agent: WorkspacePaneHostBoundAgent }
  | { readonly state: 'restricted' }
  | { readonly state: 'unavailable' };

export interface WorkspacePaneHostCompositionProjection {
  readonly version: typeof WORKSPACE_PANE_HOST_CONTRIBUTION_VERSION;
  readonly owner: WorkspacePaneHostContributionOwner;
  readonly projectId: string;
  readonly actions: readonly {
    readonly key: string;
    readonly id: string;
    readonly label: string;
    readonly icon?: string;
    readonly presentation: 'action' | 'skill-prompt';
    readonly availability: WorkspacePaneHostAgentResolution['state'];
  }[];
  readonly agentSelection: {
    readonly availableAgents: readonly {
      readonly declaration: WorkspacePaneHostAgentRef;
      readonly resolution: WorkspacePaneHostAgentResolution;
    }[];
    readonly defaultAgent:
      | {
          readonly declaration: WorkspacePaneHostAgentRef;
          readonly resolution: WorkspacePaneHostAgentResolution;
        }
      | { readonly state: 'not-declared' };
  };
}

export type WorkspacePaneHostCompositionOutcome =
  | {
      readonly state: 'available';
      readonly projection: WorkspacePaneHostCompositionProjection;
    }
  | { readonly state: 'owner-retired' }
  | { readonly state: 'unavailable' };

export type WorkspacePaneHostActionDispatchResult =
  | { readonly state: 'launched'; readonly sessionId: string }
  | {
      readonly state: 'refused';
      readonly reason:
        | 'action-not-found'
        | 'agent-restricted'
        | 'agent-unavailable'
        | 'no-default-agent'
        | 'owner-retired';
    }
  | { readonly state: 'unavailable' };
