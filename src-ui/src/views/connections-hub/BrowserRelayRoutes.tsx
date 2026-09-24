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
import { Dialog } from '../../components/Dialog';
import { PageRow } from '../../components/PageRow';
import { retireBrowserRelayRoute } from '../../lib/browserRelayRouteBinding';
import {
  BrowserRelayTurnCustody,
  parseBrowserRelayTurnConfiguration,
} from '../../lib/browserRelayTurnCustody';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import { BrowserStationTrustApproval } from './BrowserStationTrustApproval';
import '../page-layout.css';
import './ComputersSection.css';

const BrowserRelayEnrollmentDialog = lazy(async () => {
  const module = await import('./BrowserRelayEnrollmentDialog');
  return { default: module.BrowserRelayEnrollmentDialog };
});

/** Browser-only route custody. A route grant never enters SavedConnection. */
export function BrowserRelayRoutes({
  onEnrollmentOpenChange,
}: {
  onEnrollmentOpenChange?: (open: boolean) => void;
} = {}) {
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
  const [turnUrl, setTurnUrl] = useState('');
  const [turnUsername, setTurnUsername] = useState('');
  const [turnCredential, setTurnCredential] = useState('');
  const [configuringTurn, setConfiguringTurn] =
    useState<SavedConnection | null>(null);
  const [savedTurnUrl, setSavedTurnUrl] = useState('');
  const [savedTurnUsername, setSavedTurnUsername] = useState('');
  const [savedTurnCredential, setSavedTurnCredential] = useState('');
  const [turnError, setTurnError] = useState<string | null>(null);
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

  useEffect(() => {
    onEnrollmentOpenChange?.(enrolling !== null);
  }, [enrolling, onEnrollmentOpenChange]);
  useEffect(
    () => () => onEnrollmentOpenChange?.(false),
    [onEnrollmentOpenChange],
  );

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
    let turnCustody: BrowserRelayTurnCustody | null = null;
    let savedTurnConfiguration = false;
    let routeMetadataSaved = false;
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
      const alreadySaved = routes.some(
        (connection) =>
          connection.url === origin &&
          connection.brokerRoute?.brokerOrigin === brokerRoute.brokerOrigin &&
          connection.brokerRoute.scope.stationId ===
            brokerRoute.scope.stationId &&
          connection.brokerRoute.scope.enrollmentId ===
            brokerRoute.scope.enrollmentId &&
          connection.brokerRoute.scope.routingGeneration ===
            brokerRoute.scope.routingGeneration &&
          connection.brokerRoute.scope.browserOrigin ===
            brokerRoute.scope.browserOrigin,
      );
      if (alreadySaved)
        throw new Error(
          'This broker route is already saved. Use Configure TURN to change its TURN settings, or forget the route before accepting another invitation.',
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
      const hasTurnInput =
        turnUrl !== '' || turnUsername !== '' || turnCredential !== '';
      let turnConfiguration = null;
      if (hasTurnInput) {
        if (!turnUrl || !turnUsername || !turnCredential)
          throw new Error('Complete all TURN fields or leave them all blank.');
        turnConfiguration = parseBrowserRelayTurnConfiguration({
          schemaVersion: 1,
          url: turnUrl,
          username: turnUsername,
          credential: turnCredential,
        });
      }
      if (turnConfiguration) {
        turnCustody = new BrowserRelayTurnCustody({
          applicationOrigin: origin,
          browserOrigin: window.location.origin,
          route: brokerRoute,
        });
        // Persist operator-supplied TURN credentials before spending the
        // invitation. A custody failure must not redeem or activate a route.
        await turnCustody.save(turnConfiguration);
        savedTurnConfiguration = true;
        controller.signal.throwIfAborted();
      }
      // Persist only metadata first. A storage refusal must never consume an
      // invitation or replace an existing usable routing grant. A later
      // redemption failure leaves an inert saved route that can be retried.
      addBrokerRoute({ name, applicationOrigin: origin, brokerRoute });
      routeMetadataSaved = true;
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
      if (savedTurnConfiguration && !routeMetadataSaved)
        await turnCustody?.forget().catch(() => undefined);
    } finally {
      custody.invalidate();
      trustStore?.close();
      setTurnUrl('');
      setTurnUsername('');
      setTurnCredential('');
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

  function configureTurn(connection: SavedConnection) {
    setSavedTurnUrl('');
    setSavedTurnUsername('');
    setSavedTurnCredential('');
    setTurnError(null);
    setConfiguringTurn(connection);
  }

  function closeTurnSettings() {
    if (busy) return;
    setSavedTurnUrl('');
    setSavedTurnUsername('');
    setSavedTurnCredential('');
    setTurnError(null);
    setConfiguringTurn(null);
  }

  async function updateSavedTurn(
    connection: SavedConnection,
    value: unknown | null,
  ) {
    const route = connection.brokerRoute;
    if (!route || busy) return;
    const reconnect = activeConnection?.id === connection.id;
    setBusy(true);
    setTurnError(null);
    // Retire the selected peer before replacing/removing its ICE credentials.
    // The same selected route is re-prepared after the atomic IndexedDB write.
    if (reconnect) retireBrowserRelayRoute(connection.id);
    let updated = false;
    try {
      const turnCustody = new BrowserRelayTurnCustody({
        applicationOrigin: connection.url,
        browserOrigin: window.location.origin,
        route,
      });
      if (value === null) await turnCustody.forget();
      else await turnCustody.save(value);
      updated = true;
      if (reconnect) await setActiveConnection(connection.id);
      setSavedTurnUrl('');
      setSavedTurnUsername('');
      setSavedTurnCredential('');
      setConfiguringTurn(null);
    } catch (cause) {
      setTurnError(
        cause instanceof Error
          ? cause.message
          : 'Could not update TURN settings.',
      );
      // IndexedDB writes are atomic. If the update failed, reconnect the
      // selected route with its previous saved settings when they still exist.
      if (reconnect && !updated) {
        try {
          await setActiveConnection(connection.id);
        } catch {
          /* The visible TURN error already keeps this failure in view. */
        }
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveSavedTurn(connection: SavedConnection) {
    setTurnError(null);
    try {
      const configuration = parseBrowserRelayTurnConfiguration({
        schemaVersion: 1,
        url: savedTurnUrl,
        username: savedTurnUsername,
        credential: savedTurnCredential,
      });
      await updateSavedTurn(connection, configuration);
    } catch (cause) {
      setTurnError(
        cause instanceof Error
          ? cause.message
          : 'Could not update TURN settings.',
      );
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
      await new BrowserRelayTurnCustody({
        applicationOrigin: connection.url,
        browserOrigin: window.location.origin,
        route,
      }).forget();
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
            onClick={() => configureTurn(connection)}
          >
            Configure TURN
          </Button>
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
        <label>
          TURN server URL
          <input
            value={turnUrl}
            placeholder="turn:turn.example:3478?transport=udp"
            maxLength={2048}
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => setTurnUrl(event.target.value)}
          />
        </label>
        <label>
          TURN username
          <input
            value={turnUsername}
            maxLength={512}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => setTurnUsername(event.target.value)}
          />
        </label>
        <label>
          TURN credential
          <input
            type="password"
            value={turnCredential}
            maxLength={1024}
            autoComplete="new-password"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => setTurnCredential(event.target.value)}
          />
        </label>
        <p className="connections-computers__note">
          TURN is optional for same-network testing. The browser connects to
          this operator-supplied service and sends encrypted WebRTC traffic;
          Station and the broker do not receive its credentials.
        </p>
        <Button
          size="sm"
          disabled={busy || !applicationOrigin || !invitationText}
          onClick={() => void acceptInvitation()}
        >
          Accept route
        </Button>
      </div>
      {configuringTurn && (
        <Dialog
          eyebrow="Browser route"
          title={`Configure TURN for ${configuringTurn.name}`}
          subtitle="Use this when the browser and Station cannot establish a direct WebRTC connection. The browser connects to the TURN service; application content stays encrypted between the browser and Station. Saving reconnects an active route."
          closeLabel="Close TURN settings"
          onClose={closeTurnSettings}
          size="md"
          footer={
            <>
              <Button disabled={busy} onClick={closeTurnSettings}>
                Cancel
              </Button>
              <Button
                disabled={busy}
                onClick={() => void updateSavedTurn(configuringTurn, null)}
              >
                Clear TURN settings
              </Button>
              <Button
                variant="primary"
                disabled={
                  busy ||
                  !savedTurnUrl ||
                  !savedTurnUsername ||
                  !savedTurnCredential
                }
                onClick={() => void saveSavedTurn(configuringTurn)}
              >
                Save TURN settings
              </Button>
            </>
          }
        >
          <label className="editor-field">
            <span className="editor-label">TURN server URL</span>
            <input
              className="editor-input"
              value={savedTurnUrl}
              placeholder="turn:turn.example:3478?transport=udp"
              maxLength={2048}
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => setSavedTurnUrl(event.target.value)}
            />
          </label>
          <label className="editor-field">
            <span className="editor-label">TURN username</span>
            <input
              className="editor-input"
              value={savedTurnUsername}
              maxLength={512}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => setSavedTurnUsername(event.target.value)}
            />
          </label>
          <label className="editor-field">
            <span className="editor-label">TURN credential</span>
            <input
              className="editor-input"
              type="password"
              value={savedTurnCredential}
              maxLength={1024}
              autoComplete="new-password"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => setSavedTurnCredential(event.target.value)}
            />
          </label>
          {turnError && (
            <p className="connections-computers__alert" role="alert">
              {turnError}
            </p>
          )}
        </Dialog>
      )}
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
