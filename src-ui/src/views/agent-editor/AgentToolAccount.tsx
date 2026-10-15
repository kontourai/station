import {
  useFinishIntegrationOAuthMutation,
  useIntegrationAccountQuery,
  useStartIntegrationOAuthMutation,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import { Button } from '../../components/Button';

export function AgentToolAccount({
  id,
  projectSlug,
}: {
  id: string;
  projectSlug?: string;
}) {
  const account = useIntegrationAccountQuery(id, projectSlug);
  const start = useStartIntegrationOAuthMutation();
  const finish = useFinishIntegrationOAuthMutation();
  const [callback, setCallback] = useState('');
  const [notice, setNotice] = useState('');
  const status = account.data?.connectedAs;
  const label =
    status === 'you'
      ? 'Your account'
      : status === 'you-in-project'
        ? 'Your project account'
        : status === 'shared'
          ? 'Shared account'
          : 'No OAuth account reported';
  let authorizationUrl: string | undefined;
  if (start.data?.authorizationUrl) {
    try {
      const url = new URL(start.data.authorizationUrl);
      if (['http:', 'https:'].includes(url.protocol))
        authorizationUrl = url.toString();
    } catch {}
  }
  return (
    <div className="agent-tool-picker__account">
      <p>{account.isPending ? 'Checking account…' : label}</p>
      {account.isError && <p role="alert">Account unavailable.</p>}
      <Button
        variant="secondary"
        pending={start.isPending}
        pendingLabel="Connecting…"
        onClick={() => {
          setNotice('');
          start.mutate({ id, projectSlug });
        }}
      >
        Connect account
      </Button>
      {authorizationUrl && (
        <>
          <a href={authorizationUrl} target="_blank" rel="noopener noreferrer">
            Open sign-in
          </a>
          <label>
            Returned sign-in URL
            <input
              className="editor-input"
              value={callback}
              onChange={(event) => setCallback(event.target.value)}
              autoComplete="off"
            />
          </label>
          <Button
            disabled={!callback.trim()}
            pending={finish.isPending}
            pendingLabel="Completing…"
            onClick={() =>
              finish.mutate(
                { id, projectSlug, callbackUrl: callback },
                {
                  onSuccess: () => {
                    start.reset();
                    setNotice('Account connected.');
                  },
                  onError: () => setNotice('Could not complete sign-in.'),
                  onSettled: () => {
                    setCallback('');
                    finish.reset();
                  },
                },
              )
            }
          >
            Complete sign-in
          </Button>
        </>
      )}
      {start.isError && (
        <p role="alert">Could not start sign-in. Check the connection.</p>
      )}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
