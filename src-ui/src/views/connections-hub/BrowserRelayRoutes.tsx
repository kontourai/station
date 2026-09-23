import {
  type SavedConnection,
  useConnections,
} from '@kontourai/station-connect';
import { openDeviceConnectionTrustStore } from '@kontourai/station-connect/connection-trust';
import {
  BrowserRoutingGrantCustody,
  parseBrokerRouteInvitationUrl,
  redeemBrokerRouteInvitation,
} from '@kontourai/station-connect/self-hosted-browser';
import type { SelfHostedBrokerRouteInvitationV1 } from '@kontourai/station-contracts/self-hosted-broker';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { PageRow } from '../../components/PageRow';
import { retireBrowserRelayRoute } from '../../lib/browserRelayRouteBinding';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import { BrowserStationTrustApproval } from './BrowserStationTrustApproval';

const BrowserRelayEnrollmentDialog = lazy(async () => {
  const module = await import('./BrowserRelayEnrollmentDialog');
  return { default: module.BrowserRelayEnrollmentDialog };
});

/** Browser-only route custody. A route grant never enters SavedConnection. */
export function BrowserRelayRoutes() {
  const { isTauri } = usePlatformProfile();
  const {
    connections,
    activeConnection,
    addBrokerRoute,
    removeConnection,
    setActiveConnection,
  } = useConnections();
  const [name, setName] = useState('');
  const [applicationOrigin, setApplicationOrigin] = useState('');
  const [invitationText, setInvitationText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enrolling, setEnrolling] = useState<SavedConnection | null>(null);
  const enrollment = useRef<{
    controller: AbortController;
    custody: BrowserRoutingGrantCustody;
  } | null>(null);
  const routes = connections.filter((connection) => connection.brokerRoute);

  useEffect(
    () => () => {
      enrollment.current?.controller.abort(
        new Error('Route acceptance closed'),
      );
      enrollment.current?.custody.invalidate();
      enrollment.current = null;
    },
    [],
  );

  useEffect(() => {
    if (enrolling && activeConnection?.id !== enrolling.id) setEnrolling(null);
  }, [activeConnection?.id, enrolling]);

  if (isTauri) return null;

  async function acceptInvitation() {
    if (busy || enrollment.current) return;
    setBusy(true);
    setError(null);
    const submitted = invitationText;
    setInvitationText('');
    const custody = new BrowserRoutingGrantCustody();
    const controller = new AbortController();
    enrollment.current = { controller, custody };
    let trustStore: Awaited<
      ReturnType<typeof openDeviceConnectionTrustStore>
    > | null = null;
    try {
      if (submitted.length > 8192)
        throw new Error('Broker invitation is too large.');
      // The operator CLI currently emits a private JSON file, while a future
      // share flow may encode the same typed invitation in a fragment link.
      // redeemBrokerRouteInvitation validates either form before broker use.
      const invitation = submitted.trim().startsWith('{')
        ? (JSON.parse(submitted) as SelfHostedBrokerRouteInvitationV1)
        : parseBrokerRouteInvitationUrl(submitted);
      const origin = applicationOrigin.trim();
      const address = new URL(origin);
      const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(
        address.hostname.toLowerCase(),
      );
      if (
        address.origin !== origin ||
        (address.protocol !== 'https:' &&
          !(address.protocol === 'http:' && loopback))
      )
        throw new Error('Enter a secure Station application origin.');
      const brokerRoute = {
        brokerOrigin: invitation.brokerOrigin,
        scope: invitation.scope,
      };
      const conflicting = routes.find(
        (connection) =>
          connection.brokerRoute?.brokerOrigin === brokerRoute.brokerOrigin &&
          connection.brokerRoute.scope.stationId ===
            brokerRoute.scope.stationId &&
          connection.brokerRoute.scope.enrollmentId ===
            brokerRoute.scope.enrollmentId &&
          connection.brokerRoute.scope.routingGeneration ===
            brokerRoute.scope.routingGeneration &&
          connection.brokerRoute.scope.browserOrigin ===
            brokerRoute.scope.browserOrigin &&
          connection.url !== origin,
      );
      if (conflicting)
        throw new Error(
          'This broker route is already saved for a different Station application address.',
        );
      trustStore = await openDeviceConnectionTrustStore();
      controller.signal.throwIfAborted();
      const trustRecord = await trustStore.read(invitation.scope.stationId);
      controller.signal.throwIfAborted();
      if (trustRecord?.status === 'revoked')
        throw new Error(
          'Station trust is revoked on this browser. Independently approve the current rotated Station key before accepting this invitation.',
        );
      if (
        !trustRecord ||
        trustRecord.trust.enrollmentId !== invitation.scope.enrollmentId
      )
        throw new Error(
          'Approve this Station’s signing key from the operator’s separate key report before accepting its broker invitation.',
        );
      if (trustRecord.status !== 'approved')
        throw new Error(
          'Approve this Station’s signing key before accepting its broker invitation.',
        );
      // Persist only metadata first. A storage refusal must never consume an
      // invitation or replace an existing usable routing grant. A later
      // redemption failure leaves an inert saved route that can be retried.
      addBrokerRoute({ name, applicationOrigin: origin, brokerRoute });
      controller.signal.throwIfAborted();
      await redeemBrokerRouteInvitation({
        invitation,
        trustRecord,
        trustStore,
        custody,
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      setName('');
      setApplicationOrigin('');
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error ? cause.message : 'Could not accept route.',
        );
    } finally {
      custody.invalidate();
      trustStore?.close();
      if (enrollment.current?.controller === controller) {
        enrollment.current = null;
        setBusy(false);
      }
    }
  }

  async function select(id: string) {
    setBusy(true);
    setError(null);
    try {
      await setActiveConnection(id);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not reach Station.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function forget(id: string) {
    const connection = routes.find((saved) => saved.id === id);
    const route = connection?.brokerRoute;
    if (!connection || !route) return;
    setBusy(true);
    setError(null);
    // Stop application traffic before any asynchronous custody operation.
    retireBrowserRelayRoute(id);
    try {
      const { removeBrowserRelayApplicationAuthority } = await import(
        '../../lib/browserRelayApplicationAuthority'
      );
      await removeBrowserRelayApplicationAuthority({
        connectionId: id,
        applicationOrigin: connection.url,
        route,
      });
      await new BrowserRoutingGrantCustody().forgetRoute(route);
      removeConnection(id);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not forget route.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="relay-route-profiles"
      aria-label="Browser broker routes"
    >
      <h2 className="relay-route-profiles__heading">Broker routes</h2>
      <p className="connections-computers__note">
        A broker can find a Station. The Station still checks your account,
        approved Device and Project access separately.
      </p>
      <BrowserStationTrustApproval />
      {routes.map((connection) => (
        <PageRow
          key={connection.id}
          className="connections-computers__row"
          label={connection.name}
          description={`${connection.brokerRoute!.brokerOrigin} · ${connection.url}`}
          status={
            <span className="connections-computers__state">
              {activeConnection?.id === connection.id
                ? 'Route selected; Station authorization separate'
                : 'Saved; not connected'}
            </span>
          }
          control={
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void select(connection.id)}
            >
              {activeConnection?.id === connection.id ? 'Reconnect' : 'Connect'}
            </Button>
          }
        >
          {activeConnection?.id === connection.id && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => setEnrolling(connection)}
            >
              Verify account and Device
            </Button>
          )}
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void forget(connection.id)}
          >
            Forget route
          </Button>
        </PageRow>
      ))}
      <div className="relay-route-profiles__form">
        <label>
          Station name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          Station application address
          <input
            value={applicationOrigin}
            placeholder="https://station.example"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => setApplicationOrigin(event.target.value)}
          />
        </label>
        <label>
          Broker invitation link or private JSON
          <input
            type="password"
            value={invitationText}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => setInvitationText(event.target.value)}
          />
        </label>
        <Button
          size="sm"
          disabled={busy || !applicationOrigin || !invitationText}
          onClick={() => void acceptInvitation()}
        >
          Accept route
        </Button>
      </div>
      {error && (
        <p className="connections-computers__alert" role="alert">
          {error}
        </p>
      )}
      {enrolling && (
        <Suspense fallback={<p role="status">Opening account verification…</p>}>
          <BrowserRelayEnrollmentDialog
            connection={enrolling}
            onClose={() => setEnrolling(null)}
          />
        </Suspense>
      )}
    </section>
  );
}
