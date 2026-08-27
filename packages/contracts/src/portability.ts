import type { AgentSpec } from './agent.js';
import type {
  AppConfig,
  ApprovalGuardianConfig,
  TemplateVariable,
} from './config.js';

export type PortabilityFormat = 'agents-md' | 'claude-desktop';

export type PortabilityLossCode =
  | 'omitted-field'
  | 'unsupported-transport'
  | 'unsupported-kind'
  | 'unsupported-config'
  | 'ambiguous-prose'
  | 'degraded-field';

export interface PortabilityLoss {
  code: PortabilityLossCode;
  scope: 'app-config' | 'agent' | 'integration' | 'document';
  path: string;
  message: string;
  severity: 'info' | 'warning';
}

export interface NormalizedMcpConfig {
  id: string;
  displayName?: string;
  description?: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  endpoint?: string;
  env?: Record<string, string>;
  /** Credential-free names required to make a redacted import complete. */
  requiredEnvNames?: string[];
  exposedTools?: string[];
  timeouts?: { startupMs?: number; requestMs?: number };
}

export interface GuidanceWorkspaceExport {
  systemPrompt?: string;
  templateVariables?: TemplateVariable[];
  approvalGuardian?: ApprovalGuardianConfig;
}

export interface GuidanceAgentExport {
  slug: string;
  spec: AgentSpec;
}

export interface GuidanceExportModel {
  workspace: GuidanceWorkspaceExport;
  agents: GuidanceAgentExport[];
  integrations: NormalizedMcpConfig[];
}

export interface AgentsMdPortabilityDocument {
  kind: 'station-agents-md';
  version: 1;
  generatedAt: string;
  guidance: GuidanceExportModel;
  losses: PortabilityLoss[];
}

export interface PortabilityImportLedgerEntry {
  id: string;
  sourceFormat: PortabilityFormat;
  importedAt: string;
  sourcePath: string;
  degradedFields: PortabilityLoss[];
  notesPath?: string;
  applied: {
    appConfigUpdated: boolean;
    agentSlugs: string[];
    integrationIds: string[];
  };
}

export type AppConfigGuidanceKeys =
  | 'systemPrompt'
  | 'templateVariables'
  | 'approvalGuardian';

export type ExportableAppConfig = Pick<AppConfig, AppConfigGuidanceKeys>;
