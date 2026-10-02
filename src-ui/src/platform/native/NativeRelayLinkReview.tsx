import type { StationProfile } from '@kontourai/station-contracts';
import type { NativeRelayLinkDelivery } from '@kontourai/station-contracts/native-relay-link';
import {
  QueryClient,
  QueryClientProvider,
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
import { nativeRelayGrantAdapter } from './nativeRelayGrantAdapter';
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
}: {
  delivery: NativeRelayLinkDelivery;
  onClose: () => void;
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
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [redeemed, setRedeemed] = useState(false);
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
      if (result.status !== 'redeemed') throw new Error('refused');
      setRedeemed(true);
      await queryClient.invalidateQueries({ queryKey: ['native-relay-grant'] });
    } catch {
      if (active.current)
        setError(
          'Station did not confirm routing grant redemption. Check native status before continuing; do not reuse an uncertain invitation.',
        );
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <>
      <Dialog
        title="Review Station link"
        closeLabel="Close Station link review"
        onClose={close}
        historyMode="none"
        size="lg"
        footer={<Button onClick={close}>Close link review</Button>}
      >
        <p>
          Opening this link does not select a Station, approve a key, sign in,
          enroll a Device, or grant Project access.
        </p>
        {delivery.kind === 'rejected' ? (
          <p role="alert">{delivery.message}</p>
        ) : (
          <>
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
            {matching.length > 1 ? (
              <p role="alert">
                More than one saved route matches. Resolve the duplicate routes
                before continuing.
              </p>
            ) : null}
            {delivery.kind === 'route-intent' &&
            !profile &&
            matching.length === 0 ? (
              <Button onClick={() => setSaving(true)}>
                Review and save route
              </Button>
            ) : null}
            {delivery.kind === 'bound-invitation' && !profile ? (
              <p role="alert">
                This invitation requires one exact saved route and its existing
                native install proof. Save the public setup link first and ask
                the operator for a matching invitation.
              </p>
            ) : null}
            {profile ? (
              <>
                <p>
                  Saved route: {profile.name}. Prepare its public install proof
                  and share it with the operator separately.
                </p>
                <RelayRouteKeyApproval
                  key={`${profile.name}:${profile.updatedAt}`}
                  profileName={profile.name}
                  brokerOrigin={delivery.route.brokerOrigin}
                  stationId={delivery.route.stationId}
                  enrollmentId={delivery.route.enrollmentId}
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
                {delivery.kind === 'bound-invitation' && !redeemed ? (
                  <Button
                    disabled={
                      busy || delivery.invitation.expiresAt <= Date.now()
                    }
                    pending={busy}
                    onClick={() => void redeem()}
                  >
                    Redeem linked routing invitation
                  </Button>
                ) : null}
                {redeemed && selection ? (
                  <>
                    <p role="status">
                      Routing grant confirmed. Device approval and account
                      access remain separate.
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
