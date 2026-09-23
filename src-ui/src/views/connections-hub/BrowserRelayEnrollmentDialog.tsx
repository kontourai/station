import type { SavedConnection } from '@kontourai/station-connect';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import type { BrowserRelayEnrollmentState } from '../../lib/browserRelayEnrollmentController';
import { captureBrowserRelayRoute } from '../../lib/browserRelayRouteBinding';

const STATUS: Record<BrowserRelayEnrollmentState, string> = {
  idle: 'Ready to verify this account.',
  starting: 'Verifying this account with the selected Station…',
  'awaiting-approval':
    'Waiting for the Station operator to approve this Device…',
  activating: 'Activating the approved Device and account session…',
  enrolled: 'This Device is approved and signed in to this Station.',
  failed: 'Enrollment did not complete.',
  cancelled: 'Enrollment cancelled.',
};

/** A routing grant is already selected; account and Device approval are separate. */
export function BrowserRelayEnrollmentDialog({
  connection,
  onClose,
}: {
  connection: SavedConnection;
  onClose(): void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [state, setState] = useState<BrowserRelayEnrollmentState>('idle');
  const [error, setError] = useState<string | null>(null);
  const enrollmentAbort = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(
    () => () => enrollmentAbort.current?.abort(new Error('Dialog closed')),
    [],
  );

  function close() {
    enrollmentAbort.current?.abort(new Error('Dialog closed'));
    onClose();
  }

  async function begin() {
    const route = connection.brokerRoute;
    if (busy || enrollmentAbort.current || !route) return;
    setError(null);
    const selected = captureBrowserRelayRoute(
      connection.id,
      connection.url,
      route,
    );
    if (!selected?.isCurrent()) {
      setError('Reconnect to this Station before verifying your account.');
      return;
    }
    const submitted = { username, password };
    setUsername('');
    setPassword('');
    setBusy(true);
    const operation = new AbortController();
    enrollmentAbort.current = operation;
    try {
      const [enrollment, authority, session] = await Promise.all([
        import('../../lib/browserRelayEnrollmentController'),
        import('../../lib/browserRelayApplicationAuthority'),
        import('@kontourai/station-sdk/application-session'),
      ]);
      operation.signal.throwIfAborted();
      if (!selected.isCurrent())
        throw new Error('The selected Station route changed.');
      const owner = new enrollment.BrowserRelayEnrollmentController({
        route: {
          connectionId: connection.id,
          applicationOrigin: connection.url,
          clientOrigin: window.location.origin,
          route,
          transport: selected.transport,
          isCurrent: selected.isCurrent,
        },
        stageApprovedBundle: async (stageId, bundle, key, signal) => {
          await authority.stageBrowserRelayApplicationAuthority({
            stageId,
            connectionId: connection.id,
            applicationOrigin: connection.url,
            route,
            bearer: { kind: 'device', credential: bundle.deviceCredential },
            key: session.restoreApplicationSessionKey(
              key.privateKey,
              key.publicKey,
            ),
            continuation: bundle.continuation,
            signal,
          });
        },
        publishAuthority: async (
          stageId,
          _bundle,
          _key,
          receipt,
          isRouteCurrent,
          signal,
        ) => {
          await authority.publishBrowserRelayApplicationAuthority({
            stageId,
            connectionId: connection.id,
            applicationOrigin: connection.url,
            route,
            activationReceipt: receipt,
            isRouteCurrent,
            signal,
          });
        },
        removeProvisionalAuthority: async (stageId) => {
          await authority.removeProvisionalBrowserRelayApplicationAuthority({
            stageId,
            connectionId: connection.id,
            applicationOrigin: connection.url,
            route,
          });
        },
        onState: setState,
      });
      await owner.enroll(submitted, operation.signal);
    } catch (cause) {
      if (!operation.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Station account verification did not complete.',
        );
    } finally {
      if (enrollmentAbort.current === operation) enrollmentAbort.current = null;
      setBusy(false);
    }
  }

  return (
    <Dialog
      eyebrow="Station access"
      title={`Verify account on ${connection.name}`}
      subtitle="A broker route only reaches this Station. Its operator must approve this Device; Project access remains separate."
      closeLabel="Close account verification"
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Close</Button>
          {state !== 'enrolled' && (
            <Button
              variant="primary"
              disabled={busy || !username || !password}
              pending={busy}
              pendingLabel="Verifying…"
              onClick={() => void begin()}
            >
              Verify account
            </Button>
          )}
        </>
      }
    >
      <p className="connections-computers__note">
        This pilot supports Stations with a provider-approved username and
        password enrollment flow. Other provider configurations refuse until
        they support this Device ceremony.
      </p>
      <label className="editor-field">
        <span className="editor-label">Station account name</span>
        <input
          className="editor-input"
          autoComplete="username"
          value={username}
          disabled={busy}
          onChange={(event) => setUsername(event.target.value)}
        />
      </label>
      <label className="editor-field">
        <span className="editor-label">Password</span>
        <input
          className="editor-input"
          type="password"
          autoComplete="current-password"
          value={password}
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <p role="status">{STATUS[state]}</p>
      {error && (
        <p className="connections-computers__alert" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
