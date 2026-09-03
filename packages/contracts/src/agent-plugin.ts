/** Published Agent Plugins portable manifest schema supported by Station v1. */
export const AGENT_PLUGIN_MANIFEST_SCHEMA_1_0 =
  'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json' as const;

/** Matching portable MCP configuration schema. */
export const AGENT_PLUGIN_MCP_SCHEMA_1_0 =
  'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json' as const;

/** Station-owned Agent Plugins extension namespace and directory name. */
export const STATION_AGENT_PLUGIN_EXTENSION_ID =
  'io.kontourai.station' as const;

/**
 * Agent Plugins 1.0 name grammar: 1-64 lowercase ASCII letters, digits,
 * hyphens, or periods; alphanumeric endpoints; no repeated `--` or `..`.
 */
export const AGENT_PLUGIN_NAME_PATTERN =
  /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;

export function isAgentPluginName(value: unknown): value is string {
  return typeof value === 'string' && AGENT_PLUGIN_NAME_PATTERN.test(value);
}

export interface AgentPluginAuthor {
  name?: string;
  email?: string;
  url?: string;
}

export interface AgentPluginExtensionsV1 {
  [namespace: string]: object | undefined;
  [STATION_AGENT_PLUGIN_EXTENSION_ID]?: StationAgentPluginExtensionV1;
}

/** Closed portable Agent Plugins 1.0 manifest shape. */
export interface AgentPluginManifestV1 {
  $schema: typeof AGENT_PLUGIN_MANIFEST_SCHEMA_1_0;
  name: string;
  version?: string;
  description?: string;
  author?: AgentPluginAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  /** Unknown namespaces stay opaque; only Station's namespace is interpreted. */
  extensions?: AgentPluginExtensionsV1;
}

interface StationPluginSettingBaseV1 {
  key: string;
  title: string;
  description?: string;
  required?: boolean;
}

export type StationPluginSettingV1 =
  | (StationPluginSettingBaseV1 & { type: 'string'; default?: string })
  | (StationPluginSettingBaseV1 & { type: 'number'; default?: number })
  | (StationPluginSettingBaseV1 & { type: 'boolean'; default?: boolean })
  | {
      key: string;
      title: string;
      type: 'select';
      description?: string;
      default?: string;
      required?: boolean;
      options: Array<{ title: string; value: string }>;
    };

/** A requested secret slot. Values remain in Station's secret authority. */
export interface StationPluginSecretReferenceV1 {
  key: string;
  title: string;
  description?: string;
  required?: boolean;
}

/** Generic candidate fields that could move to a future portable revision. */
export interface StationPluginGenericOverlayV1 {
  permissions?: string[];
  settings?: StationPluginSettingV1[];
  secretReferences?: StationPluginSecretReferenceV1[];
  dependencies?: Array<{ name: string; version: string }>;
}

/**
 * Station's v1 client extension. Host-only declarations intentionally remain
 * opaque here where an existing owning contract performs stricter parsing.
 */
export interface StationAgentPluginExtensionV1
  extends StationPluginGenericOverlayV1 {
  schemaVersion: '1.0';
  title?: string;
  sdkVersion?: string;
  entrypoint?: string;
  serverModule?: string;
  build?: string;
  capabilities?: string[];
  commands?: unknown[];
  links?: unknown;
  agents?: unknown[];
  workspacePanes?: unknown[];
  operationalEventSubscriptions?: unknown[];
  providers?: unknown[];
  integrations?: unknown;
  tools?: unknown;
  knowledge?: unknown;
  prompts?: unknown;
}
