import type { StationProfile } from '@kontourai/station-contracts';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { Button } from '../../components/Button';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { PageRow } from '../../components/PageRow';
import {
  nativeProfileRepository,
  usePlatformProfile,
} from '../../platform/PlatformProfileContext';
import { RelayRouteKeyApproval } from './RelayRouteKeyApproval';
import { RelayRouteProfileDialog } from './RelayRouteProfileDialog';
import './ComputersSection.css';

const NO_RELAY_PROFILES: readonly StationProfile[] = [];
const NO_SUBSCRIBE = () => () => {};

export function RelayRouteProfiles() {
  const { isTauri } = usePlatformProfile();
  const repository = isTauri ? nativeProfileRepository() : null;
  const subscribe = useCallback(
    (listener: () => void) =>
      repository?.subscribeRelayRouteProfiles(listener) ?? NO_SUBSCRIBE(),
    [repository],
  );
  const getSnapshot = useCallback(
    () => repository?.getRelayRouteProfiles() ?? NO_RELAY_PROFILES,
    [repository],
  );
  const profiles = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [editing, setEditing] = useState<StationProfile | undefined>();
  const [removeTarget, setRemoveTarget] = useState<StationProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isTauri || profiles.length === 0) return null;

  async function removeRoute() {
    if (!removeTarget || !repository) return;
    setError(null);
    try {
      await repository.removeRelayRouteProfile(
        `station-profile:${removeTarget.name.toLowerCase()}`,
        removeTarget.updatedAt,
      );
      setRemoveTarget(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not remove route.',
      );
    }
  }

  return (
    <section className="relay-route-profiles" aria-label="Saved broker routes">
      <h2 className="relay-route-profiles__heading">Saved broker routes</h2>
      <p className="connections-computers__note">
        These routes are saved locally. They are not connected, signed in, or
        available for work until the broker transport is enabled.
      </p>
      {profiles.map((profile) => (
        <PageRow
          key={profile.name.toLowerCase()}
          className="connections-computers__row"
          label={
            <>
              {profile.name}{' '}
              <span className="connections-computers__chip">Broker route</span>
            </>
          }
          description={`${profile.relayRoute!.brokerOrigin} · ${profile.endpoint}`}
          status={
            <span className="connections-computers__state">Not connected</span>
          }
          control={
            <Button size="sm" onClick={() => setEditing(profile)}>
              Edit
            </Button>
          }
        >
          <RelayRouteKeyApproval
            key={`${profile.name}:${profile.updatedAt}:${profile.relayRoute!.brokerOrigin}:${profile.relayRoute!.stationId}:${profile.relayRoute!.enrollmentId}`}
            profileName={profile.name}
            brokerOrigin={profile.relayRoute!.brokerOrigin}
            stationId={profile.relayRoute!.stationId}
            enrollmentId={profile.relayRoute!.enrollmentId}
          />
          <button
            type="button"
            className="connections-computers__remove tap-target"
            onClick={() => setRemoveTarget(profile)}
          >
            Remove this route
          </button>
        </PageRow>
      ))}
      {error && (
        <p className="connections-computers__alert" role="alert">
          {error}
        </p>
      )}
      {editing && (
        <RelayRouteProfileDialog
          profile={editing}
          onClose={() => setEditing(undefined)}
        />
      )}
      <ConfirmModal
        isOpen={removeTarget !== null}
        title="Remove broker route?"
        message={
          removeTarget
            ? `Remove the saved route to ${removeTarget.name}? This does not change the Station or revoke its separately stored trust.`
            : ''
        }
        confirmLabel="Remove route"
        onConfirm={() => void removeRoute()}
        onCancel={() => setRemoveTarget(null)}
        variant="danger"
      />
    </section>
  );
}
