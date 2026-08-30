export interface ACPConnectionConfig {
  id: string;
  name: string;
  command: string;
  args?: string[];
  icon?: string;
  cwd?: string;
  enabled: boolean;
  source?: 'user' | 'plugin';
  interactive?: {
    args: string[];
  };
  /**
   * Explicit opt-in (docs/design/connections-onboarding.md §5): ids of
   * Station tool servers (`ToolDef.id`, kind 'mcp') to pass through to this
   * ACP-connected agent's sessions via `session/new`'s `mcpServers`. Absent
   * or empty means no passthrough — OFF by default; the hygiene rule is
   * "never silent" (§5), so this must always be a deliberate per-connection
   * choice, never inferred. Only stdio-transport tool servers can be
   * resolved today; others are skipped with a logged reason (http/sse
   * passthrough is a follow-up, see connections-onboarding.md §5/§6).
   */
  provideToolServers?: string[];
}

export interface ACPConnectionRegistryEntry {
  id: string;
  name: string;
  command: string;
  args?: string[];
  icon?: string;
  cwd?: string;
  description?: string;
  tags?: string[];
  source?: 'core' | 'plugin';
  sourceName?: string;
  /** The provider executable was found on this Station host. */
  detected?: boolean;
  /** A connection for this provider is configured in Station. */
  installed?: boolean;
  installedSource?: 'user' | 'plugin';
  interactive?: {
    args: string[];
  };
}

export interface ACPConfig {
  connections: ACPConnectionConfig[];
}

/** ACP's unstable LLM routing protocol vocabulary. Unknown future values stay representable. */
export type ACPLlmProtocol =
  | 'anthropic'
  | 'openai'
  | 'azure'
  | 'vertex'
  | 'bedrock'
  | 'other';

/** Non-secret provider routing state observed from `providers/list`. */
export interface ACPProviderInfo {
  providerId: string;
  supported: ACPLlmProtocol[];
  required: boolean;
  current?: { apiType: ACPLlmProtocol; baseUrl: string } | null;
}

/**
 * Declared-vs-observed provider evidence, parallel to RuntimeCatalogStatus.
 * `source: 'none'` plus its reason distinguishes no observation from an
 * observed initialize handshake that advertised no provider capability.
 */
export interface ACPProviderRoutingStatus {
  source: 'live' | 'none';
  fetchedAt?: string | null;
  reason?: string | null;
  providers: ACPProviderInfo[];
}

/** Write-only API shape; binding ids are metadata, never secret values. */
export interface ACPSetProviderRequest {
  providerId: string;
  apiType: ACPLlmProtocol;
  baseUrl: string;
  /** Explicitly non-secret headers only. Credential-bearing values use secretHeaderRefs. */
  headers?: Record<string, string>;
  /** Header name to Station secret-binding id. Resolved only for the ACP call. */
  secretHeaderRefs?: Record<string, string>;
}

export const ACPStatus = {
  AVAILABLE: 'available',
  UNAVAILABLE: 'unavailable',
  PROBING: 'probing',
} as const;

export type ACPStatusValue = (typeof ACPStatus)[keyof typeof ACPStatus];
