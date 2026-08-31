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

/** ACP protocol identifier, preserved losslessly for unstable/future values. */
export type ACPLlmProtocol = string;

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
  source: 'live' | 'stale' | 'none';
  fetchedAt?: string | null;
  reason?: string | null;
  providers: ACPProviderInfo[];
}

/** Write-only API shape; binding ids are metadata, never secret values. */
export interface ACPSetProviderRequest {
  providerId: string;
  apiType: ACPLlmProtocol;
  baseUrl: string;
  /** Every header value crosses Station's secret boundary; literal values are not accepted. */
  secretHeaderRefs?: Record<string, string>;
}

export const ACPStatus = {
  AVAILABLE: 'available',
  UNAVAILABLE: 'unavailable',
  PROBING: 'probing',
} as const;

export type ACPStatusValue = (typeof ACPStatus)[keyof typeof ACPStatus];
