import {
  type PluginLocalSourceStatus,
  permissionTier,
} from '@kontourai/station-contracts/plugin';
import type {
  PluginProviderDetail,
  PluginSettingField,
} from '@kontourai/station-sdk';
import { Button } from '../../components/Button';
import { DetailHeader } from '../../components/DetailHeader';
import { Skeleton } from '../../components/state';
import { Toggle } from '../../components/Toggle';
import {
  type PluginPermissionEntry,
  PluginPermissionsSection,
} from './PluginPermissionsSection';
import { PluginRecoveryPanel } from './PluginRecoveryPanel';
import { PluginSettingFieldRow } from './PluginSettingFieldRow';
import {
  isRejectedPlugin,
  type Plugin,
  type PluginMessage,
  type PluginUpdateSummary,
} from './types';
import { pluginContributions } from './view-utils';
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
  layoutTargetProjectName,
  onAddLayout,
  addLayoutPending,
  localSource,
  localSourceProjectName,
  onReinstallFromSource,
  reinstallPending = false,
}: {
  /**
   * #2323 S4: whether the Project folder this plugin was installed from
   * still holds the installed code. Absent when the plugin has no Project
   * folder as its source, or the viewer is not the operator.
   */
  localSource?: PluginLocalSourceStatus;
  localSourceProjectName?: string;
  onReinstallFromSource?: () => void;
  reinstallPending?: boolean;
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
  /**
   * The one project an "Add to project" would target without asking, by name,
   * or null when the picker has to ask (no projects, or several).
   */
  layoutTargetProjectName: string | null;
  onAddLayout: () => void;
  addLayoutPending: boolean;
}) {
  if (isRejectedPlugin(selected)) {
    return (
      <div className="detail-panel">
        {message && (
          <div className={`plugins__message plugins__message--${message.type}`}>
            {message.text}
          </div>
        )}
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
  if (
    selected.installationReadiness &&
    selected.installationReadiness.state !== 'ready'
  )
    return (
      <PluginRecoveryPanel
        key={selected.name}
        plugin={selected}
        onRemove={onRemove}
      />
    );
  const update = updates.find((entry) => entry.name === selected.name);
  const providersExpanded = expandedProviders.has(selected.name);
  const contributions = pluginContributions(selected);

  return (
    <div className="detail-panel">
      {message && (
        <div className={`plugins__message plugins__message--${message.type}`}>
          <span>{message.text}</span>
          {message.action && (
            <Button onClick={message.action.invoke}>
              {message.action.label}
            </Button>
          )}
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
        {update || (selected.retainedOnRemoval && selected.git?.remote) ? (
          <button
            type="button"
            className="editor-btn editor-btn--primary"
            onClick={() => onUpdate(selected.name)}
            disabled={updatePending && updateTarget === selected.name}
          >
            {updatePending && updateTarget === selected.name
              ? 'Updating…'
              : !update
                ? 'Update from source'
                : update.source === 'git'
                  ? `Update (${update.latestVersion})`
                  : `Update to v${update.latestVersion}`}
          </button>
        ) : (
          <button type="button" className="editor-btn" onClick={onCheckUpdates}>
            Check for Updates
          </button>
        )}
        {localSource?.status === 'changed' && onReinstallFromSource && (
          <button
            type="button"
            className="editor-btn editor-btn--primary"
            onClick={onReinstallFromSource}
            disabled={reinstallPending}
          >
            {reinstallPending ? 'Checking source…' : 'Reinstall from source'}
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
      {localSource && (
        <LocalSourceNote
          status={localSource}
          projectName={localSourceProjectName ?? localSource.projectSlug}
        />
      )}
      {selected.retainedOnRemoval && (
        <p>
          Updates preserve stored data. Removing this plugin retains its data
          and prior code versions.
        </p>
      )}

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

        {/* #1536 G2: the chips above say `ui` and `layout:getting-started`.
            They do not say that a layout arrived, what it is called, or how to
            reach it — installing a starter and then finding nothing to open
            was the whole complaint. Only a layout gets an action, because a
            layout is the only contribution the operator has to place. */}
        {contributions.length > 0 && (
          <div className="detail-panel__section">
            <div className="plugins__contributions-header">What it adds</div>
            <ul className="plugins__contributions">
              {contributions.map((contribution) => (
                <li key={contribution.id} className="plugins__contribution">
                  <span className="plugins__contribution-kind">
                    {contribution.kindLabel}
                  </span>
                  <span className="plugins__contribution-name">
                    {contribution.name}
                  </span>
                  {contribution.kind === 'layout' && (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="plugins__contribution-action"
                      disabled={addLayoutPending}
                      onClick={onAddLayout}
                    >
                      {addLayoutPending
                        ? 'Adding…'
                        : layoutTargetProjectName
                          ? `Add to ${layoutTargetProjectName}`
                          : 'Add to project…'}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

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

/**
 * #2323 S4: what Station knows about the Project folder this plugin was
 * installed from. Nothing is said for `unchanged`: there is nothing to act on.
 */
function LocalSourceNote({
  status,
  projectName,
}: {
  status: PluginLocalSourceStatus;
  projectName: string;
}) {
  if (status.status === 'unchanged') return null;
  if (status.status === 'changed')
    return (
      <p data-testid="plugin-local-source-note">
        The {projectName} folder has changed since this plugin was installed.
        Reinstalling shows what changed before anything is replaced, and keeps
        the plugin&rsquo;s data.
      </p>
    );
  return (
    <p data-testid="plugin-local-source-note">
      This plugin was installed from the {projectName} folder, but Station
      cannot tell whether it changed: {unknownSourceReason(status.reason)}
    </p>
  );
}

function unknownSourceReason(
  reason: PluginLocalSourceStatus['reason'],
): string {
  switch (reason) {
    case 'too-large':
      return 'the folder is too large to compare.';
    case 'unreadable':
      return 'the folder could not be read.';
    case 'not-recorded':
      return 'the installation has no record of its source to compare with.';
    case 'source-path-not-absolute':
      return 'the Project stores its folder as a ~ path. Set an absolute folder path on the Project to reinstall from it.';
    default:
      return 'no reason was reported.';
  }
}
