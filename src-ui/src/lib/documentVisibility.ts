import { useSyncExternalStore } from 'react';

/**
 * The page's visibility as one shared subscription. A hidden page should hold
 * no timers or renders nobody can see (a backgrounded phone pays for both in
 * battery), so visibility consumers read this rather than each attaching
 * their own `visibilitychange` listener.
 */
const listeners = new Set<() => void>();

export function isDocumentVisible(): boolean {
  // Browsers keep these in step; either one saying hidden is enough.
  return (
    typeof document === 'undefined' ||
    (!document.hidden && document.visibilityState !== 'hidden')
  );
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeDocumentVisibility(listener: () => void): () => void {
  if (listeners.size === 0 && typeof document !== 'undefined')
    document.addEventListener('visibilitychange', notify);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', notify);
  };
}

/** Re-renders when the page is hidden or shown. */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeDocumentVisibility,
    isDocumentVisible,
    () => true,
  );
}
