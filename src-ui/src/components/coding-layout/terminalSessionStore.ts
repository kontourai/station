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

export function useTerminalSessionStore(): TerminalSessionStore {
  const { apiBase, connectionId } = useApiBase();
  const key = `${apiBase}\n${connectionId ?? ''}`;
  const entry = storeFor(key, apiBase);
  useEffect(() => {
    ++entry.users;
    return () => {
      if (--entry.users > 0) return;
      // Keep the store a moment past its last view, so a remount (a tab
      // move, a layout change) reattaches on the same socket.
      setTimeout(() => {
        if (current === entry && entry.users === 0) {
          entry.store.dispose();
          current = undefined;
        }
      }, 5000);
    };
  }, [entry]);
  return entry.store;
}
