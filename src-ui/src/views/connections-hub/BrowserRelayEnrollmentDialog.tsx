import type { SavedConnection } from '@kontourai/station-connect';
import { useEffect, useId, useRef, useState } from 'react';
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
const INVITATION_TOKEN = /^[A-Za-z0-9_-]{43}$/;

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
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [invitationToken, setInvitationToken] = useState('');
  const [joinedProject, setJoinedProject] = useState<string | null>(null);
  const enrollmentAbort = useRef<AbortController | null>(null);
  const invitationAbort = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const invitationFieldId = useId();

  useEffect(
    () => () => {
      enrollmentAbort.current?.abort(new Error('Dialog closed'));
      invitationAbort.current?.abort(new Error('Dialog closed'));
    },
    [],
  );

  function close() {
    enrollmentAbort.current?.abort(new Error('Dialog closed'));
    invitationAbort.current?.abort(new Error('Dialog closed'));
    onClose();
  }

  async function joinProject(token: string) {
    if (accepting || invitationAbort.current) return;
    setAccepting(true);
    setError(null);
    const operation = new AbortController();
    invitationAbort.current = operation;
    try {
      const { acceptBrowserRelayProjectInvitation } = await import(
        '../../lib/browserRelayProjectInvitation'
      );
      operation.signal.throwIfAborted();
      const result = await acceptBrowserRelayProjectInvitation({
        connection,
        token,
        signal: operation.signal,
      });
      setJoinedProject(result.projectSlug);
      setInvitationToken('');
    } catch (cause) {
      if (!operation.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Station did not accept this Project invitation.',
        );
    } finally {
      if (invitationAbort.current === operation) invitationAbort.current = null;
      setAccepting(false);
    }
  }

  async function begin() {
    const route = connection.brokerRoute;
    if (busy || enrollmentAbort.current || !route) return;
    setError(null);
    setPendingRequestId(null);
    const submittedInvitation = invitationToken.trim();
    if (submittedInvitation && !INVITATION_TOKEN.test(submittedInvitation)) {
      setError('Enter a valid Project invitation token.');
      return;
    }
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
        onPending: (request) => setPendingRequestId(request.requestId),
      });
      await owner.enroll(submitted, operation.signal);
      if (submittedInvitation && !operation.signal.aborted)
        await joinProject(submittedInvitation);
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
          {state === 'enrolled' && !joinedProject && invitationToken && (
            <Button
              variant="primary"
              disabled={
                busy ||
                accepting ||
                !INVITATION_TOKEN.test(invitationToken.trim())
              }
              pending={accepting}
              pendingLabel="Joining…"
              onClick={() => void joinProject(invitationToken.trim())}
            >
              Join Project
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
      {!joinedProject && (
        <div className="editor-field">
          <label className="editor-label" htmlFor={invitationFieldId}>
            Project invitation token (optional)
          </label>
          <input
            id={invitationFieldId}
            className="editor-input"
            type="password"
            autoComplete="off"
            aria-describedby={`${invitationFieldId}-hint`}
            value={invitationToken}
            disabled={busy || accepting}
            onChange={(event) => setInvitationToken(event.target.value)}
          />
          <span id={`${invitationFieldId}-hint`} className="editor-hint">
            Accept your Project invitation after this Device is approved. The
            invitation grants only its named Project role, never Device access.
          </span>
        </div>
      )}
      <p role="status">{STATUS[state]}</p>
      {joinedProject && (
        <p role="status">
          Joined Project {joinedProject}. You can open its work after closing
          this dialog.
        </p>
      )}
      {state === 'awaiting-approval' && pendingRequestId && (
        <p className="connections-computers__note">
          Device approval request ID: <code>{pendingRequestId}</code>
        </p>
      )}
      {error && (
        <p className="connections-computers__alert" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
