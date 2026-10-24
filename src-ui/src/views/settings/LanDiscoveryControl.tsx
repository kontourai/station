import type { LanDiscoveryStatus } from '@kontourai/station-contracts/config';
import {
  useConfigQuery,
  useUpdateConfigMutation,
} from '@kontourai/station-sdk';
import { Button } from '../../components/Button';
import { SkeletonBlock } from '../../components/state';
import { SettingsToggle } from './feature-toggle';
import { settingsRow } from './settings-catalog';

export function LanDiscoveryControl() {
  const query = useConfigQuery({ refetchInterval: 2000 });
  const update = useUpdateConfigMutation();
  const status: LanDiscoveryStatus | undefined = query.data?.lanDiscoveryStatus;
  const enabled = query.data?.lanDiscoveryEnabled === true;
  return (
    <div {...settingsRow('lan-discovery')} tabIndex={-1}>
      <SettingsToggle
        className="settings__feature-toggle"
        checked={enabled}
        disabled={query.isPending || query.isError || update.isPending}
        label="Discover this Station nearby"
        describedBy="lan-discovery-description"
        onChange={() => update.mutate({ lanDiscoveryEnabled: !enabled })}
      >
        <div>
          <div className="settings__toggle-name">
            Discover this Station nearby
          </div>
          <div
            className="settings__toggle-detail"
            id="lan-discovery-description"
          >
            Makes this Station’s name and local address visible to nearby
            devices. Connecting still requires your approval. Only this
            Station’s local operator can change this setting.
          </div>
        </div>
      </SettingsToggle>
      {query.isPending ? (
        <SkeletonBlock count={1} label="Reading discovery status" />
      ) : (
        <p className="settings__section-note" role="status">
          {query.isError
            ? 'Discovery status could not be refreshed.'
            : (status?.message ?? 'Discovery status is unavailable.')}
          {status?.state === 'published' && (
            <>
              {' '}
              {status.serviceName} ·{' '}
              {status.addresses
                ?.map((address) => `${address}:${status.port}`)
                .join(', ')}
            </>
          )}
        </p>
      )}
      {update.isError && (
        <p role="alert">
          {update.error instanceof Error
            ? update.error.message
            : 'Discovery setting could not be saved.'}
        </p>
      )}
      {query.isError && (
        <Button size="sm" onClick={() => void query.refetch()}>
          Retry
        </Button>
      )}
    </div>
  );
}
