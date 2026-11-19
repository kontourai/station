import { useSyncExternalStore } from 'react';

/**
 * Whether this document is on screen AND has input focus: the only state in
 * which a person can be said to be reading what it shows (#3075). A window
 * that is visible but unfocused (another app in front) does not count.
 */
export function isDocumentFocused(doc: Document = document): boolean {
  return doc.visibilityState === 'visible' && doc.hasFocus();
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('focus', onChange);
  window.addEventListener('blur', onChange);
  document.addEventListener('visibilitychange', onChange);
  return () => {
    window.removeEventListener('focus', onChange);
    window.removeEventListener('blur', onChange);
    document.removeEventListener('visibilitychange', onChange);
  };
}

export function useDocumentFocused(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isDocumentFocused(),
    () => false,
  );
}
