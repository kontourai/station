import {
  useConnectionStatus,
  useConnections,
} from '@kontourai/station-connect';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '../../components/Button';
import { Toggle } from '../../components/Toggle';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useAuthorityPersistence } from '../../contexts/AuthorityPersistenceContext';
import {
  configureOfflineReading,
  offlineReadingBinding,
  readOfflineReading,
  subscribeOfflineReading,
} from '../../lib/offlineReading';
import { requestPersistentStorage } from '../../lib/persistentStorage';
import {
  checkServerHealth,
  probeServerConnection,
} from '../../lib/serverHealth';

export function OfflineReadingSection() {
  const { namespace } = useAuthorityPersistence();
  return namespace ? (
    <VerifiedOfflineReadingSection namespace={namespace} />
  ) : null;
}

function VerifiedOfflineReadingSection({ namespace }: { namespace: string }) {
  const scope = useHostRequestAuthorityScope();
  const { captureCredentialEvidence } = useConnections();
  const evidence = captureCredentialEvidence();
  const binding = offlineReadingBinding(evidence);
  const { status } = useConnectionStatus({
    checkHealth: checkServerHealth,
    probeEndpoint: probeServerConnection,
    pollInterval: 10_000,
  });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const index = useQuery<{
    savedAt: number;
    rows: { threadId: string; conversationId?: string }[];
  }>({
    queryKey: ['offline-session-index'],
    enabled: false,
  });
  const saved = useQuery({
    queryKey: ['offline-reading', namespace],
    queryFn: () => readOfflineReading(namespace!),
    enabled: namespace !== null,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    networkMode: 'always',
  });
  const refetch = saved.refetch;
  useEffect(() => subscribeOfflineReading(() => void refetch()), [refetch]);
  const change = async (enabled: boolean) => {
    if (!namespace || !scope || !binding) return;
    setBusy(true);
    setError(undefined);
    // Asked from the person's own opt-in: some browsers prompt for it.
    if (enabled) void requestPersistentStorage();
    try {
      await configureOfflineReading(namespace, binding, enabled, () =>
        scope.isCurrent(),
      );
      await saved.refetch();
    } catch {
      setError('Offline storage is unavailable. Your change was not saved.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <h3>Offline reading on this device</h3>
      <p>
        Saves recent chat text here for 24 hours, unencrypted. Anyone using this
        browser profile can read it, including pasted secrets.
      </p>
      <Toggle
        label="Save offline reading copies"
        checked={saved.data?.enabled ?? false}
        disabled={
          !namespace ||
          !scope ||
          !binding ||
          busy ||
          saved.isPending ||
          saved.isError
        }
        onChange={(enabled) => void change(enabled)}
      />
      <Button disabled={!namespace || busy} onClick={() => void change(false)}>
        Clear offline copies
      </Button>
      <details className="editor-disclosure">
        <summary>Details</summary>
        <ul>
          <li>Off by default.</li>
          <li>
            Keeps the last 20 chats opened here, up to 10 recent turns each.
          </li>
          <li>Up to 256 KiB per chat and 2 MiB in total.</li>
          <li>Tools and attachments are left out.</li>
        </ul>
      </details>
      <p>
        Clearing also turns off saving. Sign-out or switching authority removes
        copies.
      </p>
      {(error || saved.isError) && (
        <p role="alert">{error ?? 'Offline storage is unavailable.'}</p>
      )}
      {status !== 'connected' && index.data && (
        <p>
          Saved session list from{' '}
          {new Date(index.data.savedAt).toLocaleString()}:{' '}
          {index.data.rows
            .map((row) => row.conversationId ?? row.threadId)
            .join(', ')}
        </p>
      )}
      {status !== 'connected' &&
        saved.data?.copies.map((copy) => (
          <details key={copy.conversationId}>
            <summary>
              Conversation {copy.conversationId} — offline copy from{' '}
              {new Date(copy.savedAt).toLocaleString()}
            </summary>
            <p role="status">
              Read-only saved text. Reconnect and open the conversation for its
              live transcript.
              {copy.truncated
                ? ' Earlier text was omitted to fit the storage limit.'
                : ''}
            </p>
            {copy.turns.map((turn, index) => (
              <div key={`${index}-${turn.role}`}>
                <strong>{turn.role === 'user' ? 'You' : 'Assistant'}</strong>
                <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {turn.text}
                </p>
              </div>
            ))}
          </details>
        ))}
    </div>
  );
}
