import { useConnections } from '@kontourai/station-connect';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  clearOfflineReading,
  type OfflineCopy,
  offlineReadingBinding,
  readDeviceOfflineCopies,
  subscribeOfflineReading,
} from '../lib/offlineReading';
import { usePlatformProfile } from '../platform/PlatformProfileContext';
import { ActionRow } from './ActionRow';
import { Button } from './Button';
import './OfflineReadingBoundary.css';

/** Local opt-in copies live outside the access gate, never inside its query cache. */
export function OfflineReadingBoundary({ children }: { children: ReactNode }) {
  const { captureCredentialEvidence } = useConnections();
  const evidence = captureCredentialEvidence();
  const binding = offlineReadingBinding(evidence);
  const profile = usePlatformProfile();
  const isReloadShell = () =>
    document.querySelector('meta[name="station-offline-shell"]') !== null;
  const initiallyOffline = () => navigator.onLine === false || isReloadShell();
  // In the reload-time shell there is no live workspace behind the reader, so
  // reloading is the way back; in an open workspace, returning to it is.
  const [reloadShell] = useState(isReloadShell);
  const [offline, setOffline] = useState(initiallyOffline);
  const [readerOpen, setReaderOpen] = useState(initiallyOffline);
  const [copies, setCopies] = useState<{
    binding: string;
    values: OfflineCopy[];
  }>();
  const [error, setError] = useState<string>();
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState(false);
  const previousBinding = useRef(binding);
  useEffect(() => {
    if (previousBinding.current !== null && previousBinding.current !== binding)
      void clearOfflineReading().catch(() => {});
    previousBinding.current = binding;
  }, [binding]);
  useEffect(() => {
    const changed = () => {
      setOffline(navigator.onLine === false);
      // The anonymous fallback intentionally omits runtime endpoint bootstraps.
      if (
        navigator.onLine &&
        document.querySelector('meta[name="station-offline-shell"]')
      )
        window.location.reload();
    };
    window.addEventListener('online', changed);
    window.addEventListener('offline', changed);
    return () => {
      window.removeEventListener('online', changed);
      window.removeEventListener('offline', changed);
    };
  }, []);
  useEffect(() => {
    if (!offline || !binding) return;
    let cancelled = false;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const values = await readDeviceOfflineCopies(binding);
        if (!cancelled) {
          setCopies({ binding, values });
          clearTimeout(expiry);
          if (values.length)
            expiry = setTimeout(
              () => void refresh(),
              Math.max(
                1,
                Math.min(...values.map((copy) => copy.expiresAt)) - Date.now(),
              ),
            );
          setError(undefined);
        }
      } catch {
        if (!cancelled) setError('Offline storage is unavailable.');
      }
    };
    void refresh();
    const unsubscribe = subscribeOfflineReading(() => void refresh());
    return () => {
      cancelled = true;
      clearTimeout(expiry);
      unsubscribe();
    };
  }, [offline, binding]);
  const values = copies?.binding === binding ? copies.values : [];
  const showReader = offline && readerOpen && !profile.isTauri;
  const reconnectAction = (
    <Button
      variant={reloadShell ? 'primary' : 'secondary'}
      onClick={() => window.location.reload()}
    >
      Reconnect
    </Button>
  );
  const backAction = (
    <Button
      variant={reloadShell ? 'secondary' : 'primary'}
      onClick={() => setReaderOpen(false)}
    >
      Back to workspace
    </Button>
  );
  return (
    <>
      <div
        hidden={showReader}
        style={showReader ? undefined : { display: 'contents' }}
      >
        {children}
      </div>
      {offline && !readerOpen && !profile.isTauri && (
        <aside className="offline-reading-launcher">
          <Button onClick={() => setReaderOpen(true)}>Read saved copies</Button>
        </aside>
      )}
      {showReader && (
        <main className="offline-reading">
          <h1>Station is offline</h1>
          <p>Saved copies from this device. Reconnect for live chats.</p>
          <ActionRow
            label="Offline reading actions"
            overflowLabel="More offline reading actions"
            primary={reloadShell ? reconnectAction : backAction}
            secondary={reloadShell ? backAction : reconnectAction}
          />
          {error && <p role="alert">{error}</p>}
          {!values.length && (
            <p>
              No saved copies. Turn on offline reading in Settings › Privacy &
              sharing while connected.
            </p>
          )}
          {values.map((copy) => (
            <details key={copy.conversationId}>
              <summary>Chat {copy.conversationId}</summary>
              <p role="status">
                Read-only copy saved {new Date(copy.savedAt).toLocaleString()}.
                Recent text only, without tools or attachments.
                {copy.truncated
                  ? ' Earlier text was left out to save space.'
                  : ''}
              </p>
              {copy.turns.map((turn, index) => (
                <div key={`${index}-${turn.role}`}>
                  <strong>{turn.role === 'user' ? 'You' : 'Agent'}</strong>
                  <p className="offline-reading__text">{turn.text}</p>
                </div>
              ))}
            </details>
          ))}
          <Button
            variant="secondary"
            disabled={clearing}
            onClick={async () => {
              setClearing(true);
              setCleared(false);
              try {
                await clearOfflineReading();
                setCopies(undefined);
                setCleared(true);
              } catch {
                setError('Couldn’t clear saved copies.');
              } finally {
                setClearing(false);
              }
            }}
          >
            Clear saved copies
          </Button>
          {cleared && <p role="status">Saved copies cleared.</p>}
        </main>
      )}
    </>
  );
}
