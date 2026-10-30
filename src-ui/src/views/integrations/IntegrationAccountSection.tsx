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
import { ScopesField } from './ScopesField';

/** The server resolves account ownership; this view never selects another person. */
export function IntegrationAccountSection(props: {
  integrationId: string;
  projectSlug?: string;
  requireSave?: boolean;
  /** The integration's default scopes; the person can change them here. */
  defaultScopes?: string[];
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
        props.defaultScopes,
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
  defaultScopes,
}: {
  integrationId: string;
  projectSlug?: string;
  requireSave?: boolean;
  requestScope: ApiRequestScope;
  defaultScopes?: string[];
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
  const scopesId = useId();
  // Undefined until the person edits: then the choice remembered from their
  // last completed sign-in, else the integration default.
  const [edited, setEdited] = useState<string[] | undefined>();
  const pending = start.isPending || finish.isPending || disconnect.isPending;
  const input = { id: integrationId, projectSlug, requestScope };

  async function begin() {
    setError(null);
    setAuthorizationUrl(null);
    setCallbackUrl('');
    try {
      // Always the person's explicit choice for this sign-in. An empty list
      // means the server's own scopes, never the integration default.
      const result = await start.mutateAsync({ ...input, scopes });
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
  const scopes = edited ?? status?.rememberedScopes ?? defaultScopes ?? [];
  const sharedAccount = status?.ownership === 'instance';
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
          : sharedAccount
            ? 'The shared Station account is not connected'
            : 'Your account is not connected';

  return (
    <section
      className="agent-editor__section"
      aria-label="Your connected account"
    >
      <h3 className="agent-editor__section-title">
        {sharedAccount ? 'Shared account' : 'Your account'}
      </h3>
      <p className="agent-editor__section-desc">
        {sharedAccount
          ? 'This integration uses the shared Station account.'
          : 'Each person connects their own account.'}
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
          <p role="status" className="integration-account__status">
            {connectedLabel}
          </p>
          <ScopesField
            id={scopesId}
            label="Scopes"
            hint="One per line. Access you grant at sign-in; empty uses the server's."
            scopes={scopes}
            disabled={pending}
            onChange={setEdited}
          />
          <Button onClick={() => void begin()} disabled={pending}>
            {start.isPending
              ? 'Preparing sign-in…'
              : sharedAccount
                ? 'Sign in'
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
