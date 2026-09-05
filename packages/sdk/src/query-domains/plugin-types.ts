import type { PluginSettingField } from '@kontourai/station-contracts/plugin';

export type { PluginSettingField } from '@kontourai/station-contracts/plugin';

export interface PluginSettingsData {
  schema: PluginSettingField[];
  values: Record<string, unknown>;
}

export interface PluginChangelogEntry {
  hash: string;
  short: string;
  subject: string;
  author: string;
  date: string;
}

export interface PluginChangelogData {
  entries: PluginChangelogEntry[];
  source: 'git' | 'local';
  changelog?: string | null;
  error?: string;
}

export interface PluginProviderDetail {
  type: string;
  module: string;
  layout: string | null;
  enabled: boolean;
}

export interface AgentHealthStatus {
  success: boolean;
  healthy: boolean;
  error?: string;
  checks?: Record<string, boolean>;
  status?: string;
}

export type {
  PluginRecoveryConsent,
  PluginRecoveryInput,
  PluginRecoveryPreview,
  PluginRecoveryResult,
} from '../client/plugins';
