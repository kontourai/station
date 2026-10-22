import { useConnections } from '@kontourai/station-connect';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  clearOfflineReading,
  type OfflineCopy,
  readDeviceOfflineCopies,
  subscribeOfflineReading,
} from '../lib/offlineReading';
import { usePlatformProfile } from '../platform/PlatformProfileContext';
import { Button } from './Button';
import './OfflineReadingBoundary.css';

/** Local opt-in copies live outside the access gate, never inside its query cache. */
export function OfflineReadingBoundary({ children }: { children: ReactNode }) {
  const { captureCredentialEvidence } = useConnections();
  const evidence = captureCredentialEvidence();
  const binding = evidence
    ? JSON.stringify([
        evidence.connectionId,
        evidence.origin,
        evidence.generation,
      ])
    : null;
  const profile = usePlatformProfile();
  const [offline, setOffline] = useState(() => navigator.onLine === false);
  const [readerOpen, setReaderOpen] = useState(
    () => navigator.onLine === false,
  );
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
          <Button onClick={() => setReaderOpen(true)}>
            Read offline copies
          </Button>
        </aside>
      )}
      {showReader && (
        <main className="offline-reading">
          <h1>Station is offline</h1>
          <Button onClick={() => setReaderOpen(false)}>
            Back to workspace
          </Button>
          <p>
            Saved reading copies from this device. These are not live
            conversations. Reconnect to verify access and load current data.
          </p>
          {error && <p role="alert">{error}</p>}
          {!values.length && (
            <p>
              No offline copies available. Enable offline reading in Settings →
              Privacy & sharing while connected, then open conversations to save
              their recent text.
            </p>
          )}
          <Button
            disabled={clearing}
            onClick={async () => {
              setClearing(true);
              setCleared(false);
              try {
                await clearOfflineReading();
                setCopies(undefined);
                setCleared(true);
              } catch {
                setError('Could not clear offline copies.');
              } finally {
                setClearing(false);
              }
            }}
          >
            Clear offline copies
          </Button>
          {cleared && <p role="status">Offline copies cleared.</p>}
          <Button onClick={() => window.location.reload()}>
            Retry connection
          </Button>
          {values.map((copy) => (
            <details key={copy.conversationId}>
              <summary>Conversation {copy.conversationId}</summary>
              <p role="status">
                Read-only offline copy from{' '}
                {new Date(copy.savedAt).toLocaleString()}. Recent text only;
                tools, attachments and live actions are unavailable.
                {copy.truncated
                  ? ' Earlier text was omitted to fit the storage limit.'
                  : ''}
              </p>
              {copy.turns.map((turn, index) => (
                <div key={`${index}-${turn.role}`}>
                  <strong>{turn.role === 'user' ? 'You' : 'Assistant'}</strong>
                  <p className="offline-reading__text">{turn.text}</p>
                </div>
              ))}
            </details>
          ))}
        </main>
      )}
    </>
  );
}
