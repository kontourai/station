import type { StationProfile } from '@kontourai/station-contracts';
import type { NativeRelayLinkDelivery } from '@kontourai/station-contracts/native-relay-link';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { NativeRelayEnrollmentWizard } from '../../views/connections-hub/NativeRelayEnrollmentWizard';
import { RelayRouteKeyApproval } from '../../views/connections-hub/RelayRouteKeyApproval';
import { RelayRouteProfileDialog } from '../../views/connections-hub/RelayRouteProfileDialog';
import { nativeProfileRepository } from '../PlatformProfileContext';
import {
  type NativeRelayGrantRedemptionFailureCode,
  nativeRelayGrantAdapter,
} from './nativeRelayGrantAdapter';
import { nativeRelayKeyApproval } from './relayKeyApproval';
import '../../views/connections-hub/ComputersSection.css';

type PendingDelivery = Exclude<NativeRelayLinkDelivery, { kind: 'rejected' }>;
function matches(profile: StationProfile, delivery: PendingDelivery) {
  return (
    profile.endpoint === delivery.route.applicationOrigin &&
    profile.relayRoute?.brokerOrigin === delivery.route.brokerOrigin &&
    profile.relayRoute.stationId === delivery.route.stationId &&
    profile.relayRoute.enrollmentId === delivery.route.enrollmentId
  );
}
function Review({
  delivery,
  onClose,
  onRedemptionConfirmed,
}: {
  delivery: NativeRelayLinkDelivery;
  onClose: () => void;
  onRedemptionConfirmed: (pendingId: string) => void;
}) {
  const queryClient = useQueryClient();
  const repository = nativeProfileRepository();
  const subscribe = useCallback(
    (listener: () => void) => repository.subscribeRelayRouteProfiles(listener),
    [repository],
  );
  const snapshot = useCallback(
    () => repository.getRelayRouteProfiles(),
    [repository],
  );
  const profiles = useSyncExternalStore(subscribe, snapshot, snapshot);
  const matching =
    delivery.kind === 'rejected'
      ? []
      : profiles.filter((profile) => matches(profile, delivery));
  const profile = matching.length === 1 ? matching[0] : undefined;
  const trust = useQuery({
    queryKey: ['native-relay-key-approval', profile?.name ?? '', 'status'],
    queryFn: () => {
      if (!profile) throw new Error('Saved Station is unavailable.');
      return nativeRelayKeyApproval.status(profile.name);
    },
    enabled: Boolean(profile),
    retry: false,
    staleTime: 0,
  });
  const boundConfirmed =
    delivery.kind === 'bound-invitation' &&
    profile &&
    trust.isSuccess &&
    !trust.isFetching &&
    trust.data.status === 'approved' &&
    trust.data.stationId === delivery.route.stationId &&
    trust.data.enrollmentId === delivery.route.enrollmentId &&
    trust.data.brokerOrigin === delivery.route.brokerOrigin &&
    trust.data.keyId === delivery.invitation.stationSigningKeyId &&
    trust.data.generation === delivery.invitation.stationSigningGeneration;
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [redeemed, setRedeemed] = useState(false);
  const [routingFailure, setRoutingFailure] =
    useState<NativeRelayGrantRedemptionFailureCode>();
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  // Late IPC replies belong to the keyed review that initiated them.
  const close = () => {
    active.current = false;
    onClose();
  };
  const selection = profile?.relayRoute
    ? { profileName: profile.name, expectedRoute: profile.relayRoute }
    : null;
  async function redeem() {
    if (delivery.kind !== 'bound-invitation' || !profile || !selection) return;
    setBusy(true);
    setError(null);
    setRoutingFailure(undefined);
    try {
      if (delivery.invitation.expiresAt <= Date.now())
        throw new Error('expired');
      const current = repository
        .getRelayRouteProfiles()
        .find((candidate) => candidate.name === profile.name);
      if (
        !current ||
        current.updatedAt !== profile.updatedAt ||
        !matches(current, delivery)
      )
        throw new Error('changed');
      const trust = await nativeRelayKeyApproval.status(profile.name);
      if (
        trust.status !== 'approved' ||
        trust.brokerOrigin !== delivery.route.brokerOrigin ||
        trust.stationId !== delivery.route.stationId ||
        trust.enrollmentId !== delivery.route.enrollmentId ||
        trust.keyId !== delivery.invitation.stationSigningKeyId ||
        trust.generation !== delivery.invitation.stationSigningGeneration
      )
        throw new Error('trust');
      const status = await nativeRelayGrantAdapter.status(selection);
      if (!active.current) return;
      const result = await nativeRelayGrantAdapter.redeemLinked({
        pendingId: delivery.pendingId,
        profileName: profile.name,
        expectedUpdatedAt: profile.updatedAt,
        expectedProfileRevision: status.profileRevision,
        expectedRoute: selection.expectedRoute,
      });
      if (!active.current) return;
      if (result.status === 'failed') {
        setRoutingFailure(result.failure.primary);
        throw new Error('refused');
      }
      onRedemptionConfirmed(delivery.pendingId);
      setRedeemed(true);
      await queryClient.invalidateQueries({ queryKey: ['native-relay-grant'] });
    } catch {
      if (active.current)
        setError(
          'The connection wasn’t confirmed. Close this screen and check the Station’s status before using another invitation.',
        );
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <>
      <Dialog
        panelClassName="native-relay-setup"
        title={
          delivery.kind === 'rejected'
            ? 'Couldn’t open this invitation'
            : profile
              ? `Connect to ${profile.name}`
              : 'Connect to this Station'
        }
        closeLabel="Close"
        hideClose={delivery.kind === 'rejected'}
        onClose={close}
        historyMode="none"
        size="lg"
        footer={
          delivery.kind === 'rejected' ? (
            <Button onClick={close}>Close</Button>
          ) : undefined
        }
      >
        <p>
          Only continue if you expected an invitation from this Station’s owner.
        </p>
        {delivery.kind === 'rejected' ? (
          <>
            <p role="alert">Ask the Station owner for a new link.</p>
            <details>
              <summary>Details</summary>
              <p>{delivery.message}</p>
              <p>Error: {delivery.code}</p>
            </details>
          </>
        ) : (
          <>
            <details>
              <summary>Connection details</summary>
              <p>
                The address is supplied by this link and hasn’t been verified.
              </p>
              <dl>
                <dt>Application address hint · untrusted</dt>
                <dd>{delivery.route.applicationOrigin}</dd>
                <dt>Broker address</dt>
                <dd>{delivery.route.brokerOrigin}</dd>
                <dt>Station ID</dt>
                <dd>{delivery.route.stationId}</dd>
                <dt>Enrollment ID</dt>
                <dd>{delivery.route.enrollmentId}</dd>
              </dl>
            </details>
            {matching.length > 1 ? (
              <p role="alert">
                More than one saved route matches. Resolve the duplicate routes
                before continuing.
              </p>
            ) : null}
            {delivery.kind === 'route-intent' &&
            !profile &&
            matching.length === 0 ? (
              <Button variant="primary" onClick={() => setSaving(true)}>
                Save this Station
              </Button>
            ) : null}
            {delivery.kind === 'bound-invitation' && !profile ? (
              <p role="alert">
                Save this Station first. Share your device details with its
                owner, then ask for a setup link.
              </p>
            ) : null}
            {profile ? (
              <>
                <RelayRouteKeyApproval
                  key={`${profile.name}:${profile.updatedAt}`}
                  profileName={profile.name}
                  brokerOrigin={delivery.route.brokerOrigin}
                  stationId={delivery.route.stationId}
                  enrollmentId={delivery.route.enrollmentId}
                  publicSetupIntent={delivery.kind === 'route-intent'}
                  linkedInvitation={
                    delivery.kind === 'bound-invitation'
                      ? {
                          pendingId: delivery.pendingId,
                          expectedUpdatedAt: profile.updatedAt,
                          surface: delivery.invitation.surface,
                          expiresAt: delivery.invitation.expiresAt,
                        }
                      : undefined
                  }
                />
                {boundConfirmed && !redeemed ? (
                  <Button
                    variant="primary"
                    disabled={
                      busy || delivery.invitation.expiresAt <= Date.now()
                    }
                    pending={busy}
                    onClick={() => void redeem()}
                  >
                    Continue to device approval
                  </Button>
                ) : null}
                {redeemed && selection ? (
                  <>
                    <p role="status">
                      Connection invitation accepted. The Station owner still
                      needs to approve this device.
                    </p>
                    <NativeRelayEnrollmentWizard
                      profile={profile}
                      onEnrollmentStart={() => {}}
                      onEnrollmentCancel={() => {}}
                      refreshGrantStatus={() =>
                        nativeRelayGrantAdapter.status(selection)
                      }
                    />
                  </>
                ) : null}
              </>
            ) : null}
          </>
        )}
        {error ? <p role="alert">{error}</p> : null}
        {error && routingFailure ? (
          <details>
            <summary>Connection troubleshooting</summary>
            <p>Routing failure: {routingFailure}</p>
          </details>
        ) : null}
      </Dialog>
      {saving && delivery.kind === 'route-intent' ? (
        <RelayRouteProfileDialog
          initialRoute={delivery.route}
          onClose={() => setSaving(false)}
        />
      ) : null}
    </>
  );
}
export function NativeRelayLinkReview(props: {
  delivery: NativeRelayLinkDelivery;
  onClose: () => void;
  onRedemptionConfirmed: (pendingId: string) => void;
}) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <Review {...props} />
    </QueryClientProvider>
  );
}
