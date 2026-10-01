import type { StationProfile } from '@kontourai/station-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { Button } from '../../components/Button';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { PageRow } from '../../components/PageRow';
import { SkeletonBlock } from '../../components/state';
import {
  type NativeRelayGrantRedemptionFailureCode,
  type NativeRelayGrantState,
  nativeRelayGrantAdapter,
} from '../../platform/native/nativeRelayGrantAdapter';
import { MAX_NATIVE_RELAY_ROUTES_TO_SUPERVISE } from '../../platform/native/nativeRelayGrantRenewalSupervisor';
import { nativeRelayKeyApproval } from '../../platform/native/relayKeyApproval';
import {
  nativeProfileRepository,
  usePlatformProfile,
} from '../../platform/PlatformProfileContext';
import { RelayRouteKeyApproval } from './RelayRouteKeyApproval';
import { RelayRouteProfileDialog } from './RelayRouteProfileDialog';
import './ComputersSection.css';

const NO_RELAY_PROFILES: readonly StationProfile[] = [];
const NO_SUBSCRIBE = () => () => {};

const grantFailureCopy: Record<NativeRelayGrantRedemptionFailureCode, string> =
  {
    invalidProfile:
      'The saved route is unavailable. Refresh the route list and try again.',
    staleProfile: 'The saved route changed. Review it and try again.',
    stationTrustRequired:
      'Approve this Station signing key separately before redeeming a routing grant.',
    invitationInvalid:
      'The operator invitation was rejected. Check that you pasted the complete invitation.',
    invitationExpired:
      'This operator invitation has expired. Ask the Station operator for a new one.',
    stationTrustUnavailable:
      'Station trust could not be verified. Try again when the device key store is available.',
    proofKey: 'The native Station proof key could not be used.',
    proofKeyMissing:
      'The native Station proof key is unavailable on this device.',
    brokerTransport:
      'The broker could not be reached. Check the saved broker address and connection.',
    brokerRejected: 'The broker did not accept this invitation.',
    grantInvalid: 'The broker returned a grant Station could not verify.',
    grantStore: 'Station could not safely store the routing grant.',
    grantMissing: 'No existing grant was available for this route.',
    grantExists:
      'A routing grant already exists for this route. Refresh its status.',
    grantExpired:
      'The routing grant has expired. Ask the operator for a new invitation.',
    grantRenewalConflict:
      'The routing grant changed during setup. Refresh its status.',
    grantRenewalNotDue: 'The routing grant is not ready for renewal.',
  };

function grantQueryKey(profile: StationProfile) {
  const route = profile.relayRoute!;
  return [
    'native-relay-grant',
    profile.name.toLowerCase(),
    profile.updatedAt,
    route.brokerOrigin,
    route.stationId,
    route.enrollmentId,
  ] as const;
}

function grantSelection(profile: StationProfile) {
  const route = profile.relayRoute!;
  return {
    profileName: profile.name,
    expectedRoute: {
      brokerOrigin: route.brokerOrigin,
      stationId: route.stationId,
      enrollmentId: route.enrollmentId,
    },
  };
}

function NativeRelayGrantControls({ profile }: { profile: StationProfile }) {
  const queryClient = useQueryClient();
  const [invitation, setInvitation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const selection = grantSelection(profile);
  const queryKey = grantQueryKey(profile);
  const status = useQuery({
    queryKey,
    queryFn: () => nativeRelayGrantAdapter.status(selection),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const trust = useQuery({
    queryKey: ['native-relay-key-approval', profile.name, 'status'],
    queryFn: () => nativeRelayKeyApproval.status(profile.name),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const trustMatchesRoute = Boolean(
    trust.data?.status === 'approved' &&
      trust.data.profileName === profile.name &&
      trust.data.brokerOrigin === selection.expectedRoute.brokerOrigin &&
      trust.data.stationId === selection.expectedRoute.stationId &&
      trust.data.enrollmentId === selection.expectedRoute.enrollmentId,
  );
  const redeem = useMutation({
    mutationFn: async (invitationJson: string) => {
      setError(null);
      const currentProfile = nativeProfileRepository()
        .getRelayRouteProfiles()
        .find(
          (candidate) =>
            candidate.name.toLowerCase() === profile.name.toLowerCase(),
        );
      if (
        !currentProfile ||
        currentProfile.updatedAt !== profile.updatedAt ||
        JSON.stringify(currentProfile.relayRoute) !==
          JSON.stringify(profile.relayRoute)
      )
        throw new Error('staleProfile');

      const freshStatus = await status.refetch();
      if (!freshStatus.data || freshStatus.data.profileRevision < 1)
        throw new Error('statusUnavailable');

      const trustStatus = await queryClient.fetchQuery({
        queryKey: ['native-relay-key-approval', profile.name, 'status'],
        queryFn: () => nativeRelayKeyApproval.status(profile.name),
        staleTime: 0,
      });
      if (
        trustStatus.status !== 'approved' ||
        trustStatus.profileName !== profile.name ||
        trustStatus.brokerOrigin !== selection.expectedRoute.brokerOrigin ||
        trustStatus.stationId !== selection.expectedRoute.stationId ||
        trustStatus.enrollmentId !== selection.expectedRoute.enrollmentId
      )
        throw new Error('stationTrustRequired');

      const result = await nativeRelayGrantAdapter.redeem({
        profileName: profile.name,
        expectedProfileRevision: freshStatus.data.profileRevision,
        expectedUpdatedAt: profile.updatedAt,
        invitationJson,
        expectedRoute: selection.expectedRoute,
      });
      if (result.status === 'failed') throw new Error(result.failure.primary);
      return result;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: (cause) => {
      const code = cause instanceof Error ? cause.message : 'statusUnavailable';
      setError(
        code in grantFailureCopy
          ? grantFailureCopy[code as NativeRelayGrantRedemptionFailureCode]
          : 'Station could not verify routing grant status. Try again.',
      );
    },
  });

  function redeemInvitation() {
    const copy = invitation;
    setInvitation('');
    redeem.mutate(copy);
  }

  return (
    <section
      className="connections-computers__note"
      aria-label={`Routing grant for ${profile.name}`}
    >
      <h3>Broker routing grant</h3>
      <p>
        Station trust must be approved separately before redemption. The native
        host checks trust again when it redeems the invitation. A routing grant
        only authorizes broker signaling; account access, device approval, and
        Project access remain separate steps.
      </p>
      {trust.isPending ? (
        <SkeletonBlock count={1} label="Checking Station key trust" />
      ) : null}
      {trust.isError ? (
        <p role="status">
          Station key trust could not be checked. Retry when the device key
          store is available.
        </p>
      ) : null}
      {!trust.isPending && !trust.isError && !trustMatchesRoute ? (
        <p role="status">
          Approve the Station signing key below before redeeming a routing
          grant.
        </p>
      ) : null}
      {trustMatchesRoute ? (
        <p role="status">
          Station key trust is approved for this saved route; the native host
          will verify it again at redemption.
        </p>
      ) : null}
      {status.isPending ? (
        <SkeletonBlock count={1} label="Checking this device’s routing grant" />
      ) : null}
      {status.isError ? (
        <p role="status">
          Routing grant status is unavailable. Retry before using an invitation.
        </p>
      ) : null}
      {status.data ? <NativeRelayGrantSummary state={status.data} /> : null}
      {status.data?.cleanups.some(
        (cleanup) =>
          !cleanup.brokerRetired ||
          (cleanup.localCleanupRequired && !cleanup.localCleanupComplete),
      ) ? (
        <p role="status">
          A previous grant cleanup is still pending on this device.
        </p>
      ) : null}
      <label>
        One-time routing invitation
        <textarea
          aria-label="One-time routing invitation"
          autoComplete="off"
          spellCheck={false}
          value={invitation}
          onChange={(event) => setInvitation(event.target.value)}
          rows={4}
        />
      </label>
      <Button
        variant="primary"
        disabled={
          !invitation.trim() ||
          status.isError ||
          status.isFetching ||
          !trustMatchesRoute ||
          Boolean(status.data?.grants.length)
        }
        pending={redeem.isPending}
        pendingLabel="Redeeming…"
        onClick={redeemInvitation}
      >
        Redeem routing grant
      </Button>
      {error ? <p role="alert">{error}</p> : null}
      {redeem.isSuccess ? (
        <p role="status">Routing grant saved on this device.</p>
      ) : null}
    </section>
  );
}

function NativeRelayGrantSummary({ state }: { state: NativeRelayGrantState }) {
  const grant = state.grants[0];
  if (!grant) return <p>A routing grant has not been saved on this device.</p>;
  const expired = grant.expired || grant.metadata.expiresAt <= Date.now();
  return (
    <p>
      {expired ? 'Routing grant expired' : 'Routing grant active'} · expires{' '}
      <time dateTime={new Date(grant.metadata.expiresAt).toISOString()}>
        {new Date(grant.metadata.expiresAt).toLocaleString()}
      </time>
    </p>
  );
}

export function RelayRouteProfiles() {
  const { isTauri, isDesktop } = usePlatformProfile();
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
  const [creating, setCreating] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<StationProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isTauri) return null;

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
        {isDesktop && (
          <>
            {' '}
            Existing approved routing grants renew while this desktop app is
            awake; remove a saved route to stop maintaining it.
          </>
        )}
      </p>
      <Button onClick={() => setCreating(true)}>Add broker route</Button>
      {profiles.length === 0 && (
        <p className="connections-computers__note">
          No broker routes are saved on this device yet. Save the Station and
          broker details provided by the Station operator to begin setup.
        </p>
      )}
      {isDesktop && profiles.length > MAX_NATIVE_RELAY_ROUTES_TO_SUPERVISE && (
        <p className="connections-computers__alert" role="alert">
          Automatic grant renewal is paused for all saved routes because there
          are more than {MAX_NATIVE_RELAY_ROUTES_TO_SUPERVISE}. Remove routes to
          resume renewal.
        </p>
      )}
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
            <Button
              size="sm"
              onClick={() => {
                setCreating(false);
                setEditing(profile);
              }}
            >
              Edit
            </Button>
          }
        >
          <NativeRelayGrantControls
            key={`grant:${profile.name}:${profile.updatedAt}:${profile.relayRoute!.brokerOrigin}:${profile.relayRoute!.stationId}:${profile.relayRoute!.enrollmentId}`}
            profile={profile}
          />
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
      {(creating || editing) && (
        <RelayRouteProfileDialog
          profile={editing}
          onClose={() => {
            setCreating(false);
            setEditing(undefined);
          }}
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
