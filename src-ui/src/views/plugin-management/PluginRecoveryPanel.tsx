import { permissionTier } from '@kontourai/station-contracts/plugin';
import {
  usePluginRecoveryMutation,
  usePluginRecoveryPreviewQuery,
} from '@kontourai/station-sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { DetailHeader } from '../../components/DetailHeader';
import { ResponsiveSurfaceActions } from '../../components/ResponsiveDialogSurface';
import { usePermissions } from '../../core/PermissionManager';
import type { ReadyPlugin } from './types';

export function PluginRecoveryPanel({
  plugin,
  onRemove,
}: {
  plugin: ReadyPlugin;
  onRemove(name: string): void;
}) {
  const preview = usePluginRecoveryPreviewQuery(plugin.name, {
    enabled: false,
  });
  const recovery = usePluginRecoveryMutation();
  const queries = useQueryClient();
  const { requestInstallConsent } = usePermissions();
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
      setNotice(
        result.configurationActivation?.status === 'pending'
          ? 'Recovery was accepted. Runtime activation is still pending; refresh status before reviewing another recovery.'
          : 'Recovery completed. Refreshing plugin status.',
      );
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'Recovery is unavailable. Review the current installation before retrying.',
      );
    } finally {
      setReviewedRevision(undefined);
      busy.current = false;
    }
  }
  return (
    <div className="detail-panel">
      <DetailHeader
        title={plugin.displayName || plugin.name}
        subtitle={`Version ${plugin.version}`}
        badge={{
          label: pending ? 'Activation pending' : 'Unavailable',
          variant: 'warning',
        }}
      />
      <div className="detail-panel__body plugins__recovery">
        <p>
          {pending
            ? 'The retained plugin is not active yet. Its workspace panes and actions stay unavailable until runtime activation completes.'
            : 'Station cannot verify this installation. Refresh its status before using it.'}
        </p>
        <p>
          Recovery uses the retained code and data. It does not download a
          replacement or reset stored data.
        </p>
        {notice && <p role="status">{notice}</p>}
        {preview.error && <p role="alert">{preview.error.message}</p>}
        {basis && (
          <section aria-label="Recovery review">
            <h3>Review recovery</h3>
            <p>
              Permissions: {basis.permissions.required.join(', ') || 'None'}
            </p>
            <p>
              Dependencies:{' '}
              {basis.dependencies
                .map((dependency) => dependency.id)
                .join(', ') || 'None'}
            </p>
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
