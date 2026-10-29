import {
  useLibraryQuery,
  useToolLibraryChange,
} from '@kontourai/station-sdk/tool-library';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { useToolLibraryClient } from './ToolLibraryContext';
export function ToolAccountPanel({
  sourceId,
  project,
  actorId,
}: {
  sourceId: string;
  project: { id: string; slug: string };
  actorId: string;
}) {
  const client = useToolLibraryClient();
  const account = useLibraryQuery<{ connectedAs: string }>(
    client,
    `/accounts/${encodeURIComponent(sourceId)}?project=${encodeURIComponent(project.slug)}`,
  );
  const change = useToolLibraryChange(client);
  const [url, setUrl] = useState<string>();
  const [callback, setCallback] = useState('');
  const [notice, setNotice] = useState<string>();
  const intent = {
    project: project.slug,
    projectId: project.id,
    expectedActor: actorId,
  };
  async function connect() {
    const result = await change.mutateAsync({
      path: `/accounts/${encodeURIComponent(sourceId)}/authorize`,
      body: intent,
    });
    if (
      result &&
      typeof result === 'object' &&
      'authorizationUrl' in result &&
      typeof result.authorizationUrl === 'string'
    ) {
      const parsed = new URL(result.authorizationUrl);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:')
        setUrl(parsed.toString());
    }
    change.reset();
  }
  return (
    <div className="agent-tool-library">
      <span>
        {account.data?.connectedAs === 'you' ||
        account.data?.connectedAs === 'you-in-project'
          ? 'Your account connected'
          : 'Your account is required'}
      </span>
      <Button onClick={() => void connect().catch(() => {})}>
        Connect your account
      </Button>
      {url && (
        <>
          <a href={url} target="_blank" rel="noopener noreferrer">
            Open sign-in
          </a>
          <label>
            Returned sign-in URL
            <input
              className="editor-input"
              autoComplete="off"
              value={callback}
              onChange={(event) => setCallback(event.target.value)}
            />
          </label>
          <Button
            pending={change.isPending}
            disabled={!callback.trim()}
            onClick={() =>
              void change
                .mutateAsync({
                  path: `/accounts/${encodeURIComponent(sourceId)}/callback`,
                  body: { ...intent, callbackUrl: callback },
                })
                .then(() => {
                  setUrl(undefined);
                  setNotice('Your account is connected.');
                })
                .catch(() => setNotice('Could not finish sign-in.'))
                .finally(() => {
                  setCallback('');
                  change.reset();
                })
                .catch(() => {})
            }
          >
            Finish sign-in
          </Button>
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      {(account.isError || change.isError) && (
        <p role="alert">Account connection unavailable.</p>
      )}
    </div>
  );
}
