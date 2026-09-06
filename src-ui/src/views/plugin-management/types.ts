import type {
  PermissionTier,
  PluginInstallationReadiness,
  PluginInstallationRevision,
  RejectedInstalledPluginRecord,
} from '@kontourai/station-contracts/plugin';

export interface ReadyPlugin {
  installationReadiness?: PluginInstallationReadiness;
  retainedOnRemoval?: boolean;
  name: string;
  displayName: string;
  version: string;
  description?: string;
  hasBundle: boolean;
  hasSettings?: boolean;
  /**
   * `name` is optional because `GET /api/plugins` sends `manifest.layout`,
   * which carries only the slug and source — the layout's own display name
   * lives in its layout.json. A server that later fills it in reaches the
   * detail page with no client change (#1536 review M4).
   */
  layout?: {
    slug: string;
    name?: string;
    displayName?: string;
    title?: string;
  };
  /**
   * Panes the manifest declares. `GET /api/plugins` has always sent these;
   * the client dropped them, so an installed plugin's detail page could not
   * say what it had added (#1536 G2).
   */
  workspacePanes?: Array<{ id: string; name: string }>;
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

export type Plugin = ReadyPlugin | RejectedInstalledPluginRecord;

export function isRejectedPlugin(
  plugin: Plugin,
): plugin is RejectedInstalledPluginRecord {
  return 'status' in plugin && plugin.status === 'rejected';
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
  grantRevision?: string;
  registryTrustRevision?: string;
  installationRevision?: PluginInstallationRevision | null;
  existingDataScope?: boolean;
  valid: boolean;
  error?: string;
  manifest?: ReadyPlugin;
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
    consent?: {
      grantRevision?: string;
      registryTrustRevision?: string;
      contentDigest: string;
      permissions: string[];
      dependencies: string[];
      pendingConsent: Array<{ permission: string; tier: PermissionTier }>;
    };
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
  action?: {
    label: string;
    invoke(): void;
  };
}

/** Installed permission truth, never inferred from a pre-install preview. */
export function installedDependencyPermissions(result: unknown):
  | Array<{
      id: string;
      pendingConsent: Array<{ permission: string; tier: PermissionTier }>;
    }>
  | undefined {
  const rows = (result as { permissions?: { dependencies?: unknown } } | null)
    ?.permissions?.dependencies;
  if (!Array.isArray(rows)) return undefined;
  if (
    rows.some(
      (row) =>
        !row ||
        typeof row.id !== 'string' ||
        !Array.isArray(row.pendingConsent) ||
        row.pendingConsent.some(
          (entry: { permission?: unknown; tier?: unknown }) =>
            !entry ||
            typeof entry.permission !== 'string' ||
            !['passive', 'active', 'trusted'].includes(entry.tier as string),
        ),
    )
  )
    return undefined;
  return rows;
}
