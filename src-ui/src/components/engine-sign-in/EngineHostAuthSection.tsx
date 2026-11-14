import type {
  EngineHostAuthView,
  HostAuthLoginStart,
  ManagedInstallStateView,
} from '@kontourai/station-sdk/engine-sign-in';
import {
  useEngineHostAuthLoginMutation,
  useEngineHostAuthLoginQuery,
  useEngineHostAuthSignOutMutation,
  useManagedEngineInstallMutation,
} from '@kontourai/station-sdk/engine-sign-in';
import { useEffect, useRef, useState } from 'react';
import type { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { openExternalLink } from '../../platform/openExternalLink';
import { describeStationFailure } from '../../utils/stationFailure';
import { Button } from '../Button';

type Scope = NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;

const INSTALL_FAILURE: Record<
  Extract<ManagedInstallStateView, { kind: 'failed' }>['reason'],
  string
> = {
  'manifest-digest-mismatch':
    'The published build does not match the one this Station pins, so nothing was installed.',
  'artifact-digest-mismatch':
    'A download did not match its pinned checksum, so nothing was installed.',
  'artifact-size-mismatch':
    'A download was not the pinned size, so nothing was installed.',
  'unsafe-entry-name':
    'An archive had a file Station will not unpack, so nothing was installed.',
  'tree-verification-failed':
    'The unpacked files did not check out, so nothing was installed.',
  'runtime-refused':
    'This build needs a runtime Station does not run engines on.',
  'download-failed': 'The download did not finish.',
  'consent-required': 'Installing needs your go-ahead.',
};

function megabytes(bytes: number | undefined): string {
  return bytes === undefined ? '?' : `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function InstallBlock({
  engineName,
  install,
  allowed,
  connectionId,
  scope,
}: {
  engineName: string;
  install: NonNullable<EngineHostAuthView['install']>;
  allowed: boolean;
  connectionId: string;
  scope: Scope;
}) {
  const mutation = useManagedEngineInstallMutation(connectionId, scope);
  const { state } = install;
  if (state.kind === 'installed')
    return <small>{`${engineName} ${state.version} is installed.`}</small>;
  if (state.kind === 'unsupported-platform')
    return (
      <small>{`${engineName} has no build for this computer (${state.platform}).`}</small>
    );
  if (state.kind === 'installing')
    return (
      <small role="status" aria-live="polite">
        {`Installing ${engineName} ${install.version}: ${megabytes(state.receivedBytes)} of ${megabytes(state.totalBytes)}.`}
      </small>
    );
  return (
    <div className="engine-sign-in__keys">
      <strong>Install</strong>
      {state.kind === 'failed' && (
        <small role="alert">
          {INSTALL_FAILURE[state.reason]}
          {state.detail ? ` ${state.detail}` : ''}
        </small>
      )}
      <small>
        {`Downloads ${engineName} ${install.version} and its Node.js build, checked against pinned checksums and installed read-only; it never updates itself.`}
      </small>
      {!allowed && (
        <small>This device is not allowed to install engines.</small>
      )}
      <div className="engine-sign-in__key">
        <Button
          size="sm"
          variant="primary"
          disabled={!allowed}
          pending={mutation.isPending}
          onClick={() => mutation.mutate({ consent: true })}
        >
          {state.kind === 'failed' ? 'Try the install again' : 'Install'}
        </Button>
      </div>
      {mutation.error && (
        <small role="alert">
          {describeStationFailure(mutation.error).body}
        </small>
      )}
    </div>
  );
}

type HostAuthIdentityChoice = EngineHostAuthView['identities'][number];

const SOCIAL_PROVIDER_LABEL: Record<string, string> = {
  google: 'Google',
  github: 'GitHub',
};

function signedInLabel(
  identity: NonNullable<NonNullable<EngineHostAuthView['status']>['identity']>,
): string {
  if (identity.kind === 'identity-center')
    return `Signed in with IAM Identity Center (${identity.startUrl ?? ''}, ${identity.region ?? ''}).`;
  if (identity.kind === 'social')
    return `Signed in with ${SOCIAL_PROVIDER_LABEL[identity.provider ?? ''] ?? 'Google or GitHub'}.`;
  return 'Signed in with AWS Builder ID.';
}

function LoginProgress({
  login,
  onCancel,
  cancelling,
}: {
  login: HostAuthLoginStart;
  onCancel: () => void;
  cancelling: boolean;
}) {
  if (login.phase === 'failed')
    return (
      <p className="engine-sign-in__attempt" role="alert">
        {`The sign-in did not finish.${login.reason ? ` ${login.reason}` : ''}`}
      </p>
    );
  if (login.phase === 'cancelled')
    return (
      <p className="engine-sign-in__attempt" role="status">
        The sign-in was cancelled.
      </p>
    );
  if (login.phase === 'completed')
    return (
      <p className="engine-sign-in__attempt" role="status">
        Signed in.
      </p>
    );
  return (
    <div className="engine-sign-in__attempt" role="status" aria-live="polite">
      {login.phase === 'awaiting-approval' && login.userCode ? (
        <>
          <span>
            Open the link and enter the code <code>{login.userCode}</code> to
            approve the sign-in.
          </span>
          {login.verificationUri && (
            <span className="engine-sign-in__link">
              <code>{login.verificationUri}</code>
              <Button
                size="sm"
                onClick={() =>
                  void openExternalLink(login.verificationUri as string)
                }
              >
                Open link
              </Button>
            </span>
          )}
        </>
      ) : login.phase === 'awaiting-approval' && login.authorizationUrl ? (
        <>
          <span>
            Finish signing in to Kiro in the browser on this computer.
          </span>
          <span className="engine-sign-in__link">
            <Button
              size="sm"
              variant="primary"
              onClick={() =>
                void openExternalLink(login.authorizationUrl as string)
              }
            >
              Open sign-in page
            </Button>
          </span>
        </>
      ) : (
        <span>
          {login.phase === 'verifying'
            ? 'Checking the sign-in.'
            : 'Starting the sign-in.'}
        </span>
      )}
      <Button size="sm" onClick={onCancel} pending={cancelling}>
        Cancel sign-in
      </Button>
    </div>
  );
}

/**
 * Sign-in and install for an engine Station signs in itself (the engine
 * delegates its credential to the host). Shows the device code and link, the
 * vault's state and sign-out, and the install with consent and progress.
 * Station never shows or sends a token.
 */
export function EngineHostAuthSection({
  connectionId,
  engineName,
  hostAuth,
  signInAllowed,
  scope,
  onSignedIn,
}: {
  connectionId: string;
  engineName: string;
  hostAuth: EngineHostAuthView;
  signInAllowed: boolean;
  scope: Scope;
  onSignedIn: () => void;
}) {
  const owned = hostAuth.status !== undefined;
  const login = useEngineHostAuthLoginQuery(
    connectionId,
    scope,
    owned && signInAllowed,
  );
  const loginMutation = useEngineHostAuthLoginMutation(connectionId, scope);
  const signOut = useEngineHostAuthSignOutMutation(connectionId, scope);
  const [identity, setIdentity] =
    useState<HostAuthIdentityChoice>('builder-id');
  const [startUrl, setStartUrl] = useState('');
  const [region, setRegion] = useState('us-east-1');

  const current = login.data ?? null;
  const completedAt = useRef<string | null>(null);
  useEffect(() => {
    if (current?.phase !== 'completed') return;
    if (completedAt.current === current.startedAt) return;
    completedAt.current = current.startedAt;
    onSignedIn();
  }, [current, onSignedIn]);

  const running =
    current?.phase === 'starting' ||
    current?.phase === 'awaiting-approval' ||
    current?.phase === 'verifying';
  const status = hostAuth.status;
  const error = loginMutation.error || signOut.error;
  const canStart =
    signInAllowed &&
    !running &&
    hostAuth.policy === 'allowed' &&
    hostAuth.identities.includes(identity) &&
    (identity !== 'identity-center' ||
      (startUrl.trim() !== '' && region.trim() !== ''));

  return (
    <div className="engine-sign-in__keys">
      {hostAuth.install && (
        <InstallBlock
          engineName={engineName}
          install={hostAuth.install}
          allowed={hostAuth.allowed.install}
          connectionId={connectionId}
          scope={scope}
        />
      )}
      {status && (
        <>
          <strong>Kiro sign-in kept by Station</strong>
          {hostAuth.policy === 'off' && (
            <small role="alert">
              Your organization's policy stops Station giving engines a sign-in.
            </small>
          )}
          {status.state === 'signed-in' && status.identity && (
            <div className="engine-sign-in__key">
              <span>{signedInLabel(status.identity)}</span>
              <Button
                size="sm"
                variant="danger"
                disabled={!signInAllowed}
                pending={signOut.isPending}
                onClick={() => signOut.mutate()}
              >
                Sign out
              </Button>
            </div>
          )}
          {status.state === 'refresh-rejected' && (
            <small role="alert">
              Kiro no longer accepts the saved sign-in. Sign in again.
            </small>
          )}
          {current && (
            <LoginProgress
              login={current}
              cancelling={
                loginMutation.isPending &&
                loginMutation.variables?.kind === 'cancel'
              }
              onCancel={() => loginMutation.mutate({ kind: 'cancel' })}
            />
          )}
          {status.state !== 'signed-in' && (
            <form
              className="engine-sign-in__key"
              onSubmit={(event) => {
                event.preventDefault();
                if (!canStart) return;
                loginMutation.mutate({
                  kind: 'start',
                  request:
                    identity === 'identity-center'
                      ? {
                          identity: 'identity-center',
                          startUrl: startUrl.trim(),
                          region: region.trim(),
                        }
                      : { identity },
                });
              }}
            >
              <label htmlFor={`host-auth-identity-${connectionId}`}>
                Sign in with
              </label>
              <select
                id={`host-auth-identity-${connectionId}`}
                value={identity}
                disabled={!signInAllowed || running}
                onChange={(event) =>
                  setIdentity(event.target.value as HostAuthIdentityChoice)
                }
              >
                <option value="builder-id">AWS Builder ID</option>
                <option value="identity-center">IAM Identity Center</option>
                {hostAuth.identities.includes('social') && (
                  <option value="social">Google or GitHub</option>
                )}
              </select>
              {identity === 'identity-center' && (
                <>
                  <input
                    aria-label="Start URL"
                    placeholder="https://your-company.awsapps.com/start"
                    value={startUrl}
                    disabled={!signInAllowed || running}
                    onChange={(event) => setStartUrl(event.target.value)}
                  />
                  <input
                    aria-label="Region"
                    placeholder="us-east-1"
                    value={region}
                    disabled={!signInAllowed || running}
                    onChange={(event) => setRegion(event.target.value)}
                  />
                </>
              )}
              <Button
                type="submit"
                size="sm"
                variant="primary"
                disabled={!canStart}
                pending={
                  loginMutation.isPending &&
                  loginMutation.variables?.kind === 'start'
                }
              >
                Sign in
              </Button>
            </form>
          )}
          {status.state !== 'signed-in' &&
            hostAuth.socialSignIn === 'needs-browser-on-host' && (
              <small>
                Google and GitHub sign-in needs a browser on the computer
                Station runs on.
              </small>
            )}
          <small>
            For this engine only: {engineName} gets short-lived access tokens,
            never the refresh token.
          </small>
        </>
      )}
      {error && (
        <small role="alert">{describeStationFailure(error).body}</small>
      )}
    </div>
  );
}
