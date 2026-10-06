import type { EnrolmentAuthState } from '@kontourai/station-sdk';
import { getAuthorityObservation } from '@kontourai/station-sdk/authority-observation';
import {
  DeviceCodeLoginRefusal,
  type DeviceCodeLoginTarget,
  useCancelDeviceCodeLoginMutation,
  useDeviceCodeLoginQuery,
  useStartDeviceCodeLoginMutation,
} from '@kontourai/station-sdk/device-code-login';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Button } from '../components/Button';
import { SkeletonBlock } from '../components/state';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';

export function CredentialProfileDeviceCodeLogin({
  connectionId,
  profileRef,
  authState,
  onCompleted,
}: {
  connectionId: string;
  profileRef: string;
  authState: EnrolmentAuthState;
  onCompleted: () => void;
}) {
  const requestScope = useHostRequestAuthorityScope();
  if (!requestScope)
    return <p>Connect to this Station to start engine sign-in.</p>;
  return (
    <DeviceCodeLoginSurface
      key={`${requestScope.apiBase}\u0000${requestScope.authorityKey}\u0000${connectionId}\u0000${profileRef}`}
      target={{ connectionId, profileRef, requestScope }}
      authState={authState}
      onCompleted={onCompleted}
    />
  );
}

function DeviceCodeLoginSurface({
  target,
  authState,
  onCompleted,
}: {
  target: DeviceCodeLoginTarget;
  authState: EnrolmentAuthState;
  onCompleted: () => void;
}) {
  const client = useQueryClient();
  const authority = useQuery({
    queryKey: [
      'engine-login-authority',
      target.requestScope.apiBase,
      target.requestScope.authorityKey,
    ],
    queryFn: ({ signal }) =>
      getAuthorityObservation(target.requestScope.apiBase, {
        requestScope: target.requestScope,
        signal,
      }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });
  const allowed =
    !authority.isError &&
    (authority.data?.grant.kind === 'operator' ||
      (authority.data?.grant.kind === 'device' &&
        authority.data.grant.grantedScopes.includes('engine:login')));
  const loginQuery = useDeviceCodeLoginQuery(target, allowed);
  const start = useStartDeviceCodeLoginMutation();
  const cancel = useCancelDeviceCodeLoginMutation();
  const login = allowed ? loginQuery.data : undefined;
  const active =
    login?.phase === 'starting' ||
    login?.phase === 'awaiting-approval' ||
    login?.phase === 'verifying';
  const lastCompleted = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (
      login?.phase !== 'completed' ||
      lastCompleted.current === login.startedAt
    )
      return;
    lastCompleted.current = login.startedAt;
    onCompleted();
    void client.invalidateQueries({
      queryKey: ['connections', target.connectionId],
    });
    void client.invalidateQueries({ queryKey: ['connections', 'engines'] });
  }, [login, onCompleted, client, target.connectionId]);
  const actionError = cancel.error ?? start.error;

  if (authority.isPending)
    return <SkeletonBlock count={1} label="Checking engine sign-in access" />;
  if (authority.isError)
    return (
      <div>
        <p role="alert">Could not check engine sign-in access.</p>
        <Button onClick={() => void authority.refetch()}>
          Check access again
        </Button>
      </div>
    );
  if (!allowed)
    return (
      <p>
        The Station operator can grant this device{' '}
        <strong>Start engine sign-in</strong> under Change access.
      </p>
    );

  return (
    <section
      className="credential-device-login"
      aria-label={`Sign in ${target.profileRef}`}
    >
      {login && (
        <p role="status">
          {login.phase === 'starting'
            ? 'Starting sign-in…'
            : login.phase === 'awaiting-approval'
              ? 'Open the verification link and enter the code to sign in.'
              : login.phase === 'verifying'
                ? 'Confirming sign-in with the engine…'
                : login.phase === 'completed'
                  ? 'The engine confirmed you are signed in.'
                  : login.phase === 'cancelled'
                    ? 'Sign-in cancelled.'
                    : (login.reason ?? 'Sign-in failed.')}
        </p>
      )}
      {login?.phase === 'awaiting-approval' && (
        <>
          {login.verificationUri && (
            <a
              href={login.verificationUri}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open verification page
            </a>
          )}
          {login.userCode && (
            <p>
              Verification code:{' '}
              <code className="credential-device-login__code">
                {login.userCode}
              </code>
            </p>
          )}
          <p>
            Finish on the provider’s page. Station will check the result
            automatically.
          </p>
        </>
      )}
      {loginQuery.error && (
        <div>
          <p role="alert">
            Could not refresh sign-in status. The login may still be running.
          </p>
          <Button onClick={() => void loginQuery.refetch()}>
            Check sign-in status
          </Button>
        </div>
      )}
      {actionError && (
        <p role="alert">
          {actionError instanceof DeviceCodeLoginRefusal
            ? actionError.message
            : 'Could not confirm the sign-in request. Check its status before trying again.'}
        </p>
      )}
      <div className="credential-device-login__actions">
        {active ? (
          <Button
            pending={cancel.isPending}
            pendingLabel="Cancelling…"
            onClick={() => {
              start.reset();
              cancel.mutate(target);
            }}
          >
            Cancel sign-in
          </Button>
        ) : (
          authState === 'unauthenticated' &&
          login?.phase !== 'completed' && (
            <Button
              variant="primary"
              pending={start.isPending}
              pendingLabel="Starting sign-in…"
              disabled={loginQuery.isPending || loginQuery.isError}
              onClick={() => {
                cancel.reset();
                start.mutate(target);
              }}
            >
              Sign in
            </Button>
          )
        )}
      </div>
    </section>
  );
}
