import { TerminalSessionStore } from '@kontourai/station-sdk';
import { useEffect } from 'react';
import { useApiBase } from '../../contexts/ApiBaseContext';

type Entry = { key: string; store: TerminalSessionStore; users: number };

/**
 * One terminal store per selected Station connection: every terminal view on
 * this page shares its single socket. A connection change retires the old
 * store, which ends its views; nothing carries a session to another Station.
 */
let current: Entry | undefined;

function storeFor(key: string, apiBase: string): Entry {
  if (current?.key !== key) {
    current?.store.dispose();
    current = { key, store: new TerminalSessionStore({ apiBase }), users: 0 };
  }
  return current;
}

function storeKey(apiBase: string, connectionId: string | null | undefined) {
  return `${apiBase}\n${connectionId ?? ''}`;
}

function release(entry: Entry) {
  if (--entry.users > 0) return;
  // Keep the store a moment past its last user, so a remount (a tab move, a
  // layout change) reattaches on the same socket.
  setTimeout(() => {
    if (current === entry && entry.users === 0) {
      entry.store.dispose();
      current = undefined;
    }
  }, 5000);
}

/**
 * The connection's store for a caller outside React (a related-pane open),
 * held until `release`.
 */
export function borrowTerminalSessionStore(
  apiBase: string,
  connectionId: string | null | undefined,
): { store: TerminalSessionStore; release(): void } {
  const entry = storeFor(storeKey(apiBase, connectionId), apiBase);
  ++entry.users;
  let held = true;
  return {
    store: entry.store,
    release() {
      if (!held) return;
      held = false;
      release(entry);
    },
  };
}

export function useTerminalSessionStore(): TerminalSessionStore {
  const { apiBase, connectionId } = useApiBase();
  const entry = storeFor(storeKey(apiBase, connectionId), apiBase);
  useEffect(() => {
    ++entry.users;
    return () => release(entry);
  }, [entry]);
  return entry.store;
}
