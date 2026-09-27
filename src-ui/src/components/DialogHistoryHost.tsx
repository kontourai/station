import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from 'react';
import type { DialogHistoryHost } from './dialog-history';

const DialogHistoryHostContext = createContext<DialogHistoryHost | null>(null);

/**
 * Marks a view whose removal is not a decision any dialog inside it made
 * (#2414). A dialog registered under it that is unmounted BY this boundary's
 * unmount leaves its history layer in place instead of travelling back, so a
 * route swap cannot cancel a navigation the user started meanwhile.
 *
 * App wraps its routed view in one: the route outlet replaces that view with
 * other states of the same URL (pending, unavailable, error) on data arrival,
 * which is exactly the removal nobody asked for.
 */
export function DialogHistoryHostBoundary({
  children,
}: {
  children: ReactNode;
}) {
  const [host] = useState(() => ({ removed: false }));
  useEffect(() => {
    // Reset on (re)mount: StrictMode replays this cleanup on a boundary that
    // stays mounted, and the replay must not leave it reading as removed.
    host.removed = false;
    return () => {
      host.removed = true;
    };
  }, [host]);
  return (
    <DialogHistoryHostContext.Provider value={host}>
      {children}
    </DialogHistoryHostContext.Provider>
  );
}

/** The nearest routed view's host, or `null` outside one. */
export function useDialogHistoryHost() {
  return useContext(DialogHistoryHostContext);
}
