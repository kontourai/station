import {
  type ApiRequestScope,
  useDisconnectIntegrationAccountMutation,
  useFinishIntegrationOAuthMutation,
  useIntegrationAccountQuery,
  useStartIntegrationOAuthMutation,
} from '@kontourai/station-sdk';
import { useId, useState } from 'react';
import { Button } from '../../components/Button';
import { ErrorState, Skeleton } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { openExternalLink } from '../../platform/openExternalLink';
import { errorText } from '../../utils/errorText';

/** The server resolves account ownership; this view never selects another person. */
export function IntegrationAccountSection(props: {
  integrationId: string;
  projectSlug?: string;
  requireSave?: boolean;
}) {
  const scope = useHostRequestAuthorityScope();
  if (!scope) return null;
  return (
    <IntegrationAccountControls
      key={JSON.stringify([
        scope.apiBase,
        scope.authorityKey,
        props.integrationId,
        props.projectSlug,
      ])}
      {...props}
      requestScope={scope}
    />
  );
}

function IntegrationAccountControls({
  integrationId,
  projectSlug,
  requireSave = false,
  requestScope,
}: {
  integrationId: string;
  projectSlug?: string;
  requireSave?: boolean;
  requestScope: ApiRequestScope;
}) {
  const account = useIntegrationAccountQuery(
    integrationId,
    projectSlug,
    requestScope,
  );
  const start = useStartIntegrationOAuthMutation();
  const finish = useFinishIntegrationOAuthMutation();
  const disconnect = useDisconnectIntegrationAccountMutation();
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [callbackUrl, setCallbackUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const callbackId = useId();
  const pending = start.isPending || finish.isPending || disconnect.isPending;
  const input = { id: integrationId, projectSlug, requestScope };

  async function begin() {
    setError(null);
    setAuthorizationUrl(null);
    setCallbackUrl('');
    try {
      const result = await start.mutateAsync(input);
      setAuthorizationUrl(result.authorizationUrl);
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function complete() {
    const suppliedCallback = callbackUrl.trim();
    setCallbackUrl('');
    setError(null);
    try {
      await finish.mutateAsync({ ...input, callbackUrl: suppliedCallback });
      setAuthorizationUrl(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      finish.reset();
    }
  }

  async function remove() {
    setError(null);
    try {
      await disconnect.mutateAsync(input);
      setAuthorizationUrl(null);
      setCallbackUrl('');
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  const status = account.data;
  const ownAccountConnected = projectSlug
    ? status?.project?.connected
    : status?.personal?.connected;
  const connectedLabel =
    status?.connectedAs === 'you-in-project'
      ? 'Using your account for this Project'
      : status?.connectedAs === 'you'
        ? 'Using your account'
        : status?.connectedAs === 'shared'
          ? 'Using the shared Station account'
          : 'Your account is not connected';

  return (
    <section
      className="agent-editor__section"
      aria-label="Your connected account"
    >
      <h3 className="agent-editor__section-title">Your account</h3>
      <p className="agent-editor__section-desc">
        Each person connects their own account. Connecting does not grant
        Project membership or change the integration's allowed tools.
      </p>
      {requireSave ? (
        <p>Save the integration changes before managing your account.</p>
      ) : account.isLoading ? (
        <Skeleton variant="line" />
      ) : account.isError ? (
        <ErrorState
          title="Could not check your account"
          description={errorText(account.error)}
          action={<Button onClick={() => void account.refetch()}>Retry</Button>}
        />
      ) : status ? (
        <>
          <p role="status">{connectedLabel}</p>
          <Button onClick={() => void begin()} disabled={pending}>
            {start.isPending
              ? 'Preparing sign-in…'
              : ownAccountConnected
                ? 'Reconnect your account'
                : 'Connect your account'}
          </Button>
          {ownAccountConnected && (
            <Button
              variant="secondary"
              onClick={() => void remove()}
              disabled={pending}
            >
              {disconnect.isPending
                ? 'Disconnecting…'
                : 'Disconnect your account'}
            </Button>
          )}
          {authorizationUrl && (
            <div className="editor-field">
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  void openExternalLink(authorizationUrl).then(
                    (opened) => {
                      if (!opened) setError('Could not open the sign-in page.');
                    },
                    () => setError('Could not open the sign-in page.'),
                  );
                }}
              >
                Open sign-in page
              </Button>
              <p className="editor-field-hint">
                Complete sign-in, then copy the full redirected localhost URL
                from the browser address bar. The localhost page may not load;
                paste its URL here to finish.
              </p>
              <label className="editor-label" htmlFor={callbackId}>
                Redirected URL
              </label>
              <input
                id={callbackId}
                className="editor-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={callbackUrl}
                disabled={pending}
                onChange={(event) => setCallbackUrl(event.target.value)}
              />
              <Button
                onClick={() => void complete()}
                disabled={pending || !callbackUrl.trim()}
              >
                {finish.isPending ? 'Finishing sign-in…' : 'Finish sign-in'}
              </Button>
            </div>
          )}
        </>
      ) : null}
      {error && (
        <ErrorState title="Account action failed" description={error} />
      )}
    </section>
  );
}
