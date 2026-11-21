import {
  permissionTier,
  pluginLifecycleUnapplied,
} from '@kontourai/station-contracts/plugin';
import {
  usePluginRecoveryMutation,
  usePluginRecoveryPreviewQuery,
} from '@kontourai/station-sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { DetailHeader } from '../../components/DetailHeader';
import { ResponsiveSurfaceActions } from '../../components/ResponsiveDialogSurface';
import { usePermissions } from '../../core/PermissionManager';
import { userFacingErrorMessage } from '../../utils/errorText';
import { PluginRegistryTrustSection } from './PluginRegistryTrustSection';
import {
  installedDependencyPermissions,
  type PluginMessage,
  type ReadyPlugin,
} from './types';
import { consentFailureMessage, recoveryStoppedNotice } from './view-utils';

export function PluginRecoveryPanel({
  plugin,
  message,
  onRemove,
  onOutcome,
}: {
  plugin: ReadyPlugin;
  /** The view's latest outcome, e.g. the install that left this row pending. */
  message?: PluginMessage | null;
  onRemove(name: string): void;
  /**
   * The outcome of a recovery that activated the plugin. The panel unmounts
   * as soon as the plugin reads ready, so its own notice would never show.
   */
  onOutcome?(message: PluginMessage): void;
}) {
  const preview = usePluginRecoveryPreviewQuery(plugin.name, {
    enabled: false,
  });
  const recovery = usePluginRecoveryMutation();
  const queries = useQueryClient();
  const { requestConsent, requestInstallConsent } = usePermissions();
  const [reviewedRevision, setReviewedRevision] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const busy = useRef(false);
  const pending = plugin.installationReadiness?.state === 'pending';
  const basis =
    preview.data?.recoveryRevision === reviewedRevision
      ? preview.data
      : undefined;
  async function review() {
    setReviewedRevision(undefined);
    setNotice(undefined);
    const result = await preview.refetch();
    if (result.data && !result.error)
      setReviewedRevision(result.data.recoveryRevision);
  }
  // A pending row is a plugin whose activation did not complete; nothing
  // resumes it, so the review that recovers it is loaded straight away. It
  // is a read: recovering still takes the person's explicit decision below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per plugin row (the panel is keyed by plugin name).
  useEffect(() => {
    if (pending) void review();
  }, []);
  async function recover() {
    if (busy.current || !basis) return;
    busy.current = true;
    try {
      const approved = await requestInstallConsent(
        plugin.name,
        plugin.displayName || plugin.name,
        [
          ...basis.permissions.pendingConsent,
          ...basis.dependencies.flatMap((dependency) =>
            dependency.consent.permissions.map((permission) => ({
              permission: `${dependency.id}: ${permission}`,
              tier: permissionTier(permission),
            })),
          ),
        ],
        { action: 'recover' },
      );
      if (!approved) return;
      const result = await recovery.mutateAsync({
        name: plugin.name,
        recoveryRevision: basis.recoveryRevision,
        consent: {
          contentDigest: basis.contentDigest,
          registryTrustRevision: basis.registryTrustRevision,
          grantRevision: basis.grantRevision,
          permissions: basis.permissions.required,
          dependencies: basis.dependencies.map((dependency) => dependency.id),
          dependencyApprovals: basis.dependencies.map(({ id, consent }) => ({
            id,
            ...consent,
          })),
        },
      });
      const unapplied = pluginLifecycleUnapplied(result);
      if (unapplied) {
        setNotice(
          unapplied.kind === 'activation' && unapplied.recovery === 'none'
            ? 'Recovery was saved; Station finishes applying it in the background.'
            : recoveryStoppedNotice(unapplied),
        );
        return;
      }
      // Active now, so the trusted host approval it still owes can be
      // recorded: ask for it here, as a completed install does, rather than
      // leave the plugin's server code off until someone finds the request.
      const name = plugin.displayName || plugin.name;
      let outcome: PluginMessage = {
        type: 'success',
        text: `${name} was recovered and is active.`,
      };
      const owed = result.permissions?.pendingConsent ?? [];
      if (owed.length > 0 && !(await requestConsent(plugin.name, name, owed)))
        outcome = { type: 'error', text: consentFailureMessage(name, owed) };
      for (const dependency of installedDependencyPermissions(result) ?? []) {
        if (outcome.type === 'error') break;
        if (dependency.pendingConsent.length === 0) continue;
        if (
          !(await requestConsent(
            dependency.id,
            dependency.id,
            dependency.pendingConsent,
          ))
        )
          outcome = {
            type: 'error',
            text: consentFailureMessage(
              `Dependency ${dependency.id}`,
              dependency.pendingConsent,
            ),
          };
      }
      void queries.invalidateQueries({ queryKey: ['plugins'] });
      setNotice(outcome.text);
      onOutcome?.(outcome);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? userFacingErrorMessage(error)
          : 'Recovery is unavailable. Review the current installation before retrying.',
      );
    } finally {
      setReviewedRevision(undefined);
      busy.current = false;
    }
  }
  return (
    <div className="detail-panel">
      {message && (
        <div
          className={`plugins__message plugins__message--${message.type}`}
          role="status"
        >
          <span>{message.text}</span>
          {message.action && (
            <Button onClick={message.action.invoke}>
              {message.action.label}
            </Button>
          )}
        </div>
      )}
      <DetailHeader
        title={plugin.displayName || plugin.name}
        subtitle={`Version ${plugin.version}`}
        badge={{
          label: pending ? 'Needs recovery' : 'Unavailable',
          variant: 'warning',
        }}
      />
      <div className="detail-panel__body plugins__recovery">
        <p>
          {pending
            ? 'This plugin is installed but not active: its activation did not finish, and Station does not retry it on its own. Its workspace panes and actions stay unavailable until you recover it.'
            : 'Station cannot verify this installation. Refresh its status before using it.'}
        </p>
        <p>
          Recovery uses the retained code and data. It does not download a
          replacement or reset stored data.
        </p>
        {notice && <p role="status">{notice}</p>}
        {preview.error && (
          <p role="alert">{userFacingErrorMessage(preview.error)}</p>
        )}
        {basis && (
          <section aria-label="Recovery review">
            <h3>Review recovery</h3>
            <PluginRegistryTrustSection
              trust={basis.registryTrust}
              context="installed"
            />
            <p>
              Permissions: {basis.permissions.required.join(', ') || 'None'}
            </p>
            <p>
              Dependencies:{' '}
              {basis.dependencies
                .map((dependency) => dependency.id)
                .join(', ') || 'None'}
            </p>
            {basis.dependencies.map((dependency) => (
              <PluginRegistryTrustSection
                key={dependency.id}
                trust={dependency.registryTrust}
                context="installed"
                dependency={dependency.id}
              />
            ))}
            {basis.permissions.pendingConsent.some(
              (entry) => entry.tier === 'trusted',
            ) && (
              <p>
                Trusted permissions still require the separate host approval
                flow.
              </p>
            )}
            <Button
              onClick={() => void recover()}
              disabled={recovery.isPending || preview.isFetching}
            >
              {recovery.isPending ? 'Recovering…' : 'Recover plugin'}
            </Button>
          </section>
        )}
        <ResponsiveSurfaceActions className="plugins__recovery-actions">
          {pending && !basis && (
            <Button
              onClick={() => void review()}
              disabled={preview.isFetching || recovery.isPending}
            >
              {preview.isFetching ? 'Loading review…' : 'Review recovery'}
            </Button>
          )}
          <Button
            onClick={() =>
              void queries.invalidateQueries({ queryKey: ['plugins'] })
            }
            disabled={recovery.isPending}
          >
            Refresh status
          </Button>
          <Button
            onClick={() => onRemove(plugin.name)}
            disabled={recovery.isPending}
          >
            Remove plugin
          </Button>
        </ResponsiveSurfaceActions>
      </div>
    </div>
  );
}
