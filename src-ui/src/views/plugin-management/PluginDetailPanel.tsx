import { permissionTier } from '@kontourai/station-contracts/plugin';
import type {
  PluginProviderDetail,
  PluginSettingField,
} from '@kontourai/station-sdk';
import { DetailHeader } from '../../components/DetailHeader';
import { Skeleton } from '../../components/state';
import { Toggle } from '../../components/Toggle';
import {
  type PluginPermissionEntry,
  PluginPermissionsSection,
} from './PluginPermissionsSection';
import { PluginSettingFieldRow } from './PluginSettingFieldRow';
import {
  isRejectedPlugin,
  type Plugin,
  type PluginMessage,
  type PluginUpdateSummary,
} from './types';
import { WorkspaceHomeRoleSection } from './WorkspaceHomeRoleSection';

/**
 * The plugin's HELD permissions, paired with their tier.
 *
 * The tier comes from the SAME contracts-level map the server enforces with
 * (`permissionTier`), not from the payload. An earlier version recovered it
 * from the `missing` entries and defaulted the rest to `trusted` — but a
 * GRANTED permission is by definition not missing, so every held row would
 * have rendered "Trusted" regardless of its real tier. That is a label the
 * data does not support, on the surface whose whole job is telling someone
 * accurately what a plugin can do.
 */
function grantedPermissionEntries(selected: {
  permissions?: { granted: string[] };
}): PluginPermissionEntry[] {
  return (selected.permissions?.granted ?? []).map((permission) => ({
    permission,
    tier: permissionTier(permission),
  }));
}

export function PluginDetailPanel({
  selected,
  updates,
  message,
  settingsData,
  changelogData,
  expandedProviders,
  providerDetails,
  loadingProviderDetails,
  changelogExpanded,
  updatePending,
  updateTarget,
  onUpdate,
  onCheckUpdates,
  onRemove,
  onToggleProviders,
  onToggleProvider,
  onSaveSetting,
  onToggleChangelog,
  onReviewPermissions,
  onRevokePermission,
  revokingPermissions,
  onReloadRejected,
  reloadRejectedPending,
}: {
  selected: Plugin;
  updates: PluginUpdateSummary[];
  message: PluginMessage | null;
  settingsData:
    | {
        schema: PluginSettingField[];
        values: Record<string, unknown>;
      }
    | undefined;
  changelogData:
    | {
        entries: Array<{
          hash: string;
          short: string;
          subject: string;
          author: string;
          date: string;
        }>;
      }
    | undefined;
  expandedProviders: Set<string>;
  providerDetails: PluginProviderDetail[] | undefined;
  loadingProviderDetails: boolean;
  changelogExpanded: boolean;
  updatePending: boolean;
  updateTarget: string | undefined;
  onUpdate: (name: string) => void;
  onCheckUpdates: () => void;
  onRemove: (name: string) => void;
  onToggleProviders: (pluginName: string) => void;
  onToggleProvider: (
    pluginName: string,
    providerType: string,
    currentlyEnabled: boolean,
  ) => void;
  onSaveSetting: (name: string, key: string, value: unknown) => void;
  onToggleChangelog: () => void;
  onReviewPermissions: () => Promise<void>;
  onRevokePermission: (entry: PluginPermissionEntry) => void;
  revokingPermissions: ReadonlySet<string>;
  onReloadRejected: () => void;
  reloadRejectedPending: boolean;
}) {
  if (isRejectedPlugin(selected)) {
    return (
      <div className="detail-panel">
        <DetailHeader
          title={selected.displayName}
          subtitle="Installed files are present, but Station rejected plugin.json."
          badge={{ label: 'Rejected', variant: 'warning' as const }}
        >
          <button
            type="button"
            className="editor-btn editor-btn--primary"
            onClick={onReloadRejected}
            disabled={reloadRejectedPending}
          >
            {reloadRejectedPending ? 'Reloading…' : 'Reload plugins'}
          </button>
        </DetailHeader>
        <div className="detail-panel__body">
          <div
            className="plugins__message plugins__message--error"
            role="alert"
          >
            {selected.rejection.reason}
          </div>
          <div className="detail-panel__section">
            <strong>How to recover</strong>
            <p>{selected.rejection.recovery.instruction}</p>
          </div>
        </div>
      </div>
    );
  }
  const update = updates.find((entry) => entry.name === selected.name);
  const providersExpanded = expandedProviders.has(selected.name);

  return (
    <div className="detail-panel">
      {message && (
        <div className={`plugins__message plugins__message--${message.type}`}>
          {message.text}
        </div>
      )}

      <DetailHeader
        title={selected.displayName || selected.name}
        subtitle={selected.description}
        badge={{
          label: `v${selected.version}`,
          variant: 'muted' as const,
        }}
      >
        {update ? (
          <button
            type="button"
            className="editor-btn editor-btn--primary"
            onClick={() => onUpdate(selected.name)}
            disabled={updatePending && updateTarget === selected.name}
          >
            {updatePending && updateTarget === selected.name
              ? 'Updating…'
              : update.source === 'git'
                ? `Update (${update.latestVersion})`
                : `Update to v${update.latestVersion}`}
          </button>
        ) : (
          <button type="button" className="editor-btn" onClick={onCheckUpdates}>
            Check for Updates
          </button>
        )}
        <button
          type="button"
          className="editor-btn editor-btn--danger"
          onClick={() => onRemove(selected.name)}
        >
          Remove
        </button>
      </DetailHeader>

      <div className="detail-panel__body">
        <div className="detail-panel__caps">
          {selected.hasBundle && (
            <span className="plugins__cap plugins__cap--bundle">ui</span>
          )}
          {selected.layout && (
            <span className="plugins__cap plugins__cap--workspace">
              layout:{selected.layout.slug}
            </span>
          )}
          {selected.agents?.map((agent) => (
            <span key={agent.slug} className="plugins__cap plugins__cap--agent">
              agent:{agent.slug}
            </span>
          ))}
          {selected.providers?.map((provider) => (
            <span
              key={provider.type}
              className="plugins__cap plugins__cap--provider"
            >
              type:{provider.type}
            </span>
          ))}
          {selected.git && (
            <span className="plugins__cap plugins__cap--ref">
              {selected.git.branch}@{selected.git.hash?.slice(0, 7)}
            </span>
          )}
        </div>

        {selected.providers && selected.providers.length > 0 && (
          <div className="detail-panel__section">
            <button
              type="button"
              className="plugins__providers-toggle"
              onClick={() => onToggleProviders(selected.name)}
            >
              <span
                className={`plugins__providers-arrow${providersExpanded ? ' plugins__providers-arrow--expanded' : ''}`}
              >
                ▶
              </span>{' '}
              Connection types ({selected.providers.length})
            </button>
            {providersExpanded &&
              (loadingProviderDetails && !providerDetails ? (
                <Skeleton variant="line" />
              ) : (
                providerDetails && (
                  <div className="plugins__providers-list">
                    {providerDetails.map((provider: PluginProviderDetail) => (
                      <div
                        key={provider.type}
                        className="plugins__provider-row"
                      >
                        <span className="plugins__cap plugins__cap--provider">
                          {provider.type}
                        </span>
                        {provider.layout && (
                          <span className="plugins__provider-scope">
                            {provider.layout}
                          </span>
                        )}
                        <div className="plugins__provider-toggle">
                          <Toggle
                            checked={provider.enabled}
                            onChange={() =>
                              onToggleProvider(
                                selected.name,
                                provider.type,
                                provider.enabled,
                              )
                            }
                            size="sm"
                            label={
                              provider.enabled
                                ? 'Disable provider'
                                : 'Enable provider'
                            }
                          />
                          {provider.enabled ? 'Enabled' : 'Disabled'}
                        </div>
                      </div>
                    ))}
                  </div>
                )
              ))}
          </div>
        )}

        <WorkspaceHomeRoleSection pluginName={selected.name} />

        {selected.hasSettings && settingsData?.schema?.length ? (
          <div className="detail-panel__section">
            <div className="plugins__settings-header">Settings</div>
            <div className="plugins__settings-form">
              {settingsData.schema.map((field: PluginSettingField) => (
                <PluginSettingFieldRow
                  key={field.key}
                  field={field}
                  value={settingsData.values[field.key]}
                  onChange={(value) =>
                    onSaveSetting(selected.name, field.key, value)
                  }
                />
              ))}
            </div>
          </div>
        ) : null}

        {selected.git && changelogData?.entries?.length ? (
          <div className="detail-panel__section">
            <button
              type="button"
              className="plugins__providers-toggle"
              onClick={onToggleChangelog}
            >
              <span
                className={`plugins__providers-arrow${changelogExpanded ? ' plugins__providers-arrow--expanded' : ''}`}
              >
                ▶
              </span>{' '}
              Changelog ({changelogData.entries.length})
            </button>
            {changelogExpanded && (
              <div className="plugins__changelog-list">
                {changelogData.entries.map((entry) => (
                  <div key={entry.hash} className="plugins__changelog-entry">
                    <code className="plugins__changelog-hash">
                      {entry.short}
                    </code>
                    <span className="plugins__changelog-subject">
                      {entry.subject}
                    </span>
                    <span className="plugins__changelog-meta">
                      {entry.author} ·{' '}
                      {new Date(entry.date).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {/* archive#3815: what this plugin HOLDS, not only what it still
            wants. The old control here surfaced the pending ask alone, so a
            permission disappeared from the product the moment it was
            granted. */}
        <PluginPermissionsSection
          granted={grantedPermissionEntries(selected)}
          missing={selected.permissions?.missing ?? []}
          revoking={revokingPermissions}
          contentBinding={selected.permissions?.contentBinding}
          withheld={selected.permissions?.withheld}
          onRevoke={onRevokePermission}
          onReviewPermissions={onReviewPermissions}
        />
      </div>
    </div>
  );
}
