import type { PermissionTier } from '@kontourai/station-contracts/plugin';

export interface Plugin {
  name: string;
  displayName: string;
  version: string;
  description?: string;
  hasBundle: boolean;
  hasSettings?: boolean;
  layout?: { slug: string };
  agents?: Array<{ slug: string }>;
  providers?: Array<{ type: string }>;
  providerDetails?: Array<{
    type: string;
    module: string;
    layout: string | null;
    enabled: boolean;
  }>;
  git?: { hash: string; branch: string; remote?: string };
  permissions?: {
    declared: string[];
    granted: string[];
    missing: Array<{
      permission: string;
      tier: PermissionTier;
    }>;
    /**
     * How the recorded grant relates to the code that is installed now
     * (archive#4288). Server-derived — the UI never computes it — and
     * optional only because an older server does not send it.
     */
    contentBinding?: 'none' | 'bound' | 'unverified' | 'changed';
    /** Permissions the binding is withholding, by name. */
    withheld?: string[];
  };
}

export interface PreviewComponent {
  type: string;
  id: string;
  detail?: string;
  conflict?: { type: string; id: string; existingSource?: string };
  skippable?: boolean;
}

export interface GitInfo {
  hash: string;
  branch: string;
  remote?: string;
}

export interface PreviewData {
  valid: boolean;
  error?: string;
  manifest?: Plugin;
  components: PreviewComponent[];
  conflicts: Array<{ type: string; id: string; existingSource?: string }>;
  /**
   * SHA-256 of the staged source the preview inspected (archive#4288).
   * Carried back into `POST /install` so the server can refuse — before it
   * writes anything — an install whose bytes are not the bytes that were
   * reviewed. Optional only because an older server does not send it; without
   * it the client cannot install, which is the fail-closed direction.
   */
  contentDigest?: string;
  /**
   * What installing this source would require, DERIVED by the server from the
   * staged manifest. The UI never computes it; it renders it and sends the
   * answer back.
   */
  permissions?: {
    required: string[];
    autoGranted: string[];
    pendingConsent: Array<{ permission: string; tier: PermissionTier }>;
  };
  dependencies?: Array<{
    id: string;
    source?: string;
    status: string;
    components?: Array<{ type: string; id: string }>;
    git?: GitInfo;
  }>;
  git?: GitInfo;
}

export interface PluginUpdateSummary {
  name: string;
  currentVersion: string;
  latestVersion: string;
  source: string;
}

export interface PluginMessage {
  type: 'success' | 'error';
  text: string;
}
