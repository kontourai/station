import {
  getAccountAuthentication,
  getAccountSession,
  getProjectInvitationPreview,
  runAccountOperation,
} from '@kontourai/station-sdk/account-authentication';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { Button } from '../../components/Button';
import { PageFrame } from '../../components/page-frame';
import { ErrorState, SkeletonList } from '../../components/state';
import { errorText } from '../../utils/errorText';
import {
  INVITATION_STATE_KEY,
  readAccountEntryContinuation,
} from './account-entry-continuation';
import './account-entry.css';

// Read once so React StrictMode cannot consume the URL proof twice.
const browserFlow = readAccountEntryContinuation();

/** The lazy entry owns a fresh, non-persisted cache and no operator query callbacks. */
export function AccountEntryPage({ apiBase }: { apiBase: string }) {
  const [client] = useState(() => new QueryClient());
  useEffect(() => () => client.clear(), [client]);
  return (
    <QueryClientProvider client={client}>
      <AccountEntryView apiBase={apiBase} />
    </QueryClientProvider>
  );
}

/** Account entry never mounts personal connections or persisted Project caches. */
export function AccountEntryView({
  apiBase,
  initialFlow = browserFlow,
}: {
  apiBase: string;
  initialFlow?: { invitation?: string; resetToken?: string };
}) {
  const client = useQueryClient();
  const [invitation, setInvitation] = useState(initialFlow.invitation);
  const [mode, setMode] = useState<
    'sign-in' | 'register' | 'recover' | 'reset'
  >(initialFlow.resetToken ? 'reset' : 'sign-in');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [joined, setJoined] = useState(false);
  const entryId = useId();
  const descriptor = useQuery({
    queryKey: ['account', apiBase, 'provider'],
    queryFn: () => getAccountAuthentication(apiBase),
    retry: false,
    gcTime: 0,
  });
  const session = useQuery({
    queryKey: ['account', apiBase, 'session'],
    queryFn: () => getAccountSession(apiBase),
    enabled: descriptor.isSuccess,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: true,
  });
  const preview = useQuery({
    queryKey: ['account', apiBase, 'invitation', entryId],
    queryFn: () => getProjectInvitationPreview(apiBase, invitation!),
    enabled: descriptor.isSuccess && !!invitation && mode !== 'reset',
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const invitationView = preview.isSuccess ? preview.data : undefined;
  const mutation = useMutation({
    gcTime: 0,
    mutationFn: (input: {
      path: string;
      body: Record<string, unknown>;
      invitation?: string;
    }) =>
      runAccountOperation(apiBase, input.path, input.body, input.invitation),
  });
  const busy = mutation.isPending;
  const login = descriptor.data?.login;
  const endpoint = (operation: string) =>
    descriptor.data?.endpoints.find(
      (candidate) =>
        candidate.operation === operation && candidate.methods.includes('POST'),
    )?.path;
  function changeMode(next: typeof mode) {
    setMode(next);
    setPassword('');
    setError(undefined);
    setNotice(undefined);
  }

  async function submit() {
    setError(undefined);
    setNotice(undefined);
    try {
      if (mode === 'reset') {
        const path = endpoint('complete-recovery');
        if (!path || !initialFlow.resetToken)
          throw new Error(
            'Open the password reset link from your email to continue.',
          );
        await mutation.mutateAsync({
          path,
          body: { token: initialFlow.resetToken, newPassword: password },
        });
        setNotice('Password updated. Sign in with your new password.');
        setMode('sign-in');
      } else if (mode === 'recover') {
        const path = endpoint('request-recovery');
        if (!path)
          throw new Error(
            'Contact this Station’s operator for account recovery.',
          );
        await mutation.mutateAsync({ path, body: { email } });
        setNotice(
          'If this account exists, check your email for a password reset link.',
        );
      } else {
        if (
          login?.kind !== 'email-password' &&
          login?.kind !== 'username-password'
        )
          throw new Error('Use this Station’s configured sign-in method.');
        const path = mode === 'register' ? login.signUpPath : login.signInPath;
        if (!path || (mode === 'register' && !invitation))
          throw new Error('Open your Project invitation to create an account.');
        await mutation.mutateAsync({
          path,
          body: {
            ...(login.kind === 'username-password'
              ? { username: email }
              : { email }),
            password,
            ...(mode === 'register' &&
            (login.kind === 'email-password' || name.trim())
              ? { name }
              : {}),
          },
          ...(mode === 'register' ? { invitation } : {}),
        });
        if (mode === 'register') {
          setNotice(
            login.kind === 'username-password'
              ? 'Account created. Sign in to accept your invitation.'
              : 'Check your email to verify your account, then sign in here.',
          );
          setMode('sign-in');
        }
      }
      await client.resetQueries({ queryKey: ['account', apiBase, 'session'] });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPassword('');
      mutation.reset();
    }
  }
  async function join() {
    if (!invitation) return;
    setError(undefined);
    try {
      const result = await mutation.mutateAsync({
        path: '/accept-invitation',
        body: { token: invitation },
      });
      if (
        !result ||
        typeof result !== 'object' ||
        !('grantsDeviceAccess' in result) ||
        result.grantsDeviceAccess !== false
      )
        throw new Error('Station did not confirm Project membership.');
      setJoined(true);
      setInvitation(undefined);
      try {
        sessionStorage.removeItem(INVITATION_STATE_KEY);
      } catch {
        /* The server has already consumed this invitation. */
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      mutation.reset();
    }
  }
  async function signOut() {
    const path = endpoint('logout');
    if (!path) return;
    setError(undefined);
    try {
      await mutation.mutateAsync({ path, body: {} });
      await client.resetQueries({ queryKey: ['account', apiBase, 'session'] });
      setJoined(false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      mutation.reset();
    }
  }

  return (
    <main className="account-entry">
      <div className="account-entry__card">
        <PageFrame
          routeIdentity="account-entry"
          spec={{
            eyebrow: 'Station',
            title: joined
              ? 'You joined the Project'
              : mode === 'reset'
                ? 'Choose a new password'
                : invitation
                  ? invitationView
                    ? `Join ${invitationView.projectName}`
                    : 'Join your Project'
                  : 'Sign in to Station',
            subtitle: `${descriptor.data?.displayName ?? 'Your Station account'} · ${new URL(apiBase).host}`,
            width: 'narrow',
            body: 'flow',
          }}
        >
          {invitationView && invitation && mode !== 'reset' && (
            <div className="account-entry__invitation">
              <p>
                {invitationView.inviterName} invited you as a{' '}
                <strong>
                  {invitationView.role === 'admin'
                    ? 'Project admin'
                    : invitationView.role}
                </strong>
                .
              </p>
              <p>
                Expires {new Date(invitationView.expiresAt).toLocaleString()}.
              </p>
              {invitationView.recipientEmail && (
                <p>
                  Use an account with the verified email{' '}
                  <strong>{invitationView.recipientEmail}</strong>.
                </p>
              )}
            </div>
          )}
          {descriptor.isPending ? (
            <SkeletonList count={2} />
          ) : descriptor.isError ? (
            <ErrorState
              title="Sign-in is unavailable"
              description="This Station’s account service could not be loaded. Contact its operator or try again."
              action={
                <Button onClick={() => void descriptor.refetch()}>
                  Try again
                </Button>
              }
            />
          ) : invitation && mode !== 'reset' && preview.isPending ? (
            <SkeletonList count={2} label="Checking invitation" />
          ) : invitation && mode !== 'reset' && preview.isError ? (
            <ErrorState
              title="Invitation unavailable"
              description="This link may have expired, been accepted or been cancelled. Ask the inviter for a new link, or try again if this Station is unavailable."
              action={
                <Button onClick={() => void preview.refetch()}>
                  Check invitation again
                </Button>
              }
            />
          ) : joined ? (
            <>
              <p>
                Your membership is active. Opening Project work still requires
                an approved device; joining does not share your computer or
                files.
              </p>
              {endpoint('logout') && (
                <Button disabled={busy} onClick={() => void signOut()}>
                  Sign out
                </Button>
              )}
            </>
          ) : session.isPending ? (
            <SkeletonList count={1} />
          ) : session.isError ? (
            <ErrorState
              title="Could not verify your account"
              description={errorText(session.error)}
              action={
                <Button onClick={() => void session.refetch()}>
                  Try again
                </Button>
              }
            />
          ) : session.data && mode !== 'reset' ? (
            <>
              <p>
                Signed in as <strong>{session.data.principal.display}</strong>
              </p>
              {session.data.contacts.map((contact) => (
                <p key={contact.value}>{contact.value}</p>
              ))}
              {invitation ? (
                <Button
                  variant="primary"
                  pending={busy}
                  pendingLabel="Joining…"
                  onClick={() => void join()}
                >
                  Accept invitation
                </Button>
              ) : (
                <p>Open the invitation you received to join its Project.</p>
              )}
              {endpoint('logout') && (
                <Button disabled={busy} onClick={() => void signOut()}>
                  Sign out
                </Button>
              )}
            </>
          ) : login?.kind === 'redirect' ? (
            <Button
              variant="primary"
              onClick={() => {
                window.location.assign(
                  `${apiBase}/api/account-auth${login.startPath}`,
                );
              }}
            >
              Continue to sign in
            </Button>
          ) : login?.kind === 'email-password' ||
            login?.kind === 'username-password' ? (
            <>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
              >
                {mode === 'register' && login.kind === 'email-password' && (
                  <label>
                    Your name
                    <input
                      required
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      autoComplete="name"
                      disabled={busy}
                    />
                  </label>
                )}
                {mode !== 'reset' && (
                  <label>
                    {login.kind === 'username-password'
                      ? 'Username'
                      : 'Email address'}
                    <input
                      type={
                        login.kind === 'username-password' ? 'text' : 'email'
                      }
                      required
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      autoComplete={
                        login.kind === 'username-password'
                          ? 'username'
                          : 'email'
                      }
                      autoCapitalize="none"
                      spellCheck={false}
                      disabled={busy}
                    />
                  </label>
                )}
                {mode !== 'recover' && (
                  <label>
                    {mode === 'reset' ? 'New password' : 'Password'}
                    <input
                      type="password"
                      required
                      minLength={mode === 'sign-in' ? undefined : 12}
                      maxLength={128}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete={
                        mode === 'sign-in' ? 'current-password' : 'new-password'
                      }
                      disabled={busy}
                    />
                  </label>
                )}
                <Button
                  variant="primary"
                  type="submit"
                  pending={busy}
                  pendingLabel="Working…"
                >
                  {mode === 'register'
                    ? 'Create account'
                    : mode === 'recover'
                      ? 'Send reset link'
                      : mode === 'reset'
                        ? 'Update password'
                        : 'Sign in'}
                </Button>
              </form>
              <div className="account-entry__links">
                {login.kind === 'username-password' && mode === 'sign-in' && (
                  <p>
                    Need help signing in? Ask the Station operator for a
                    recovery link.
                  </p>
                )}
                {invitation && login.signUpPath && mode === 'sign-in' && (
                  <Button
                    disabled={busy}
                    onClick={() => changeMode('register')}
                  >
                    Create an account
                  </Button>
                )}
                {mode !== 'sign-in' && (
                  <Button disabled={busy} onClick={() => changeMode('sign-in')}>
                    Back to sign in
                  </Button>
                )}
                {mode === 'sign-in' && endpoint('request-recovery') && (
                  <Button
                    variant="link"
                    disabled={busy}
                    onClick={() => changeMode('recover')}
                  >
                    Forgot password?
                  </Button>
                )}
              </div>
            </>
          ) : (
            <p>
              This provider uses its own sign-in interface. Contact the Station
              operator for its login link.
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          {error && <p role="alert">{error}</p>}
        </PageFrame>
      </div>
    </main>
  );
}
