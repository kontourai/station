import type { ReactNode } from 'react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { toastStore } from '../../contexts/ToastContext';
import { useKeyboardShortcut } from '../../hooks/useKeyboardShortcut';
import {
  dismissInboxItem,
  hasInboxDismissal,
  inboxDismissalsVersion,
  isInboxDismissed,
  readInboxDismissals,
  restoreInboxItems,
  subscribeInboxDismissals,
} from '../../utils/inbox-dismissal-store';
import type { HomeWorkItem } from '../../views/home/home-view-model';
import type { WorkFactsById } from '../../views/home/work-facts';
import { useHeldLifecycles } from './useHeldLifecycles';

export function useInboxDismissals(
  items: HomeWorkItem[],
  facts?: WorkFactsById,
) {
  const version = useSyncExternalStore(
    subscribeInboxDismissals,
    inboxDismissalsVersion,
    inboxDismissalsVersion,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: storage version invalidates the persisted snapshot
  const entries = useMemo(readInboxDismissals, [version]);
  const heldItems = useHeldLifecycles(items);
  const { visible, dismissed, woken } = useMemo(() => {
    const visible: HomeWorkItem[] = [];
    const dismissed: HomeWorkItem[] = [];
    const woken: HomeWorkItem[] = [];
    for (const item of heldItems) {
      if (isInboxDismissed(item, entries, facts?.get(item.id)))
        dismissed.push(item);
      else {
        visible.push(item);
        if (hasInboxDismissal(item, entries)) woken.push(item);
      }
    }
    return { visible, dismissed, woken };
  }, [heldItems, entries, facts]);
  useEffect(() => {
    if (!woken.length) return;
    try {
      restoreInboxItems(woken);
    } catch {
      // Visibility follows the current observation even if storage is unavailable.
    }
  }, [woken]);
  return { visible, dismissed };
}

export function useInboxDismissActions(
  items: HomeWorkItem[],
  facts?: WorkFactsById,
) {
  const [error, setError] = useState<string | null>(null);
  // A toast can outlive the render where a local draft gained a durable ID.
  const currentItems = useRef(items);
  currentItems.current = items;
  const restore = (item: HomeWorkItem) => {
    try {
      const current =
        currentItems.current.find(
          (candidate) =>
            candidate.environmentId === item.environmentId &&
            (candidate.id === item.id ||
              Boolean(
                item.chatSessionId &&
                  candidate.chatSessionId === item.chatSessionId,
              )),
        ) ?? item;
      restoreInboxItems([current]);
      if (lastDismissToast) toastStore.dismiss(lastDismissToast);
      lastDismissToast = null;
      undoLastDismiss = null;
      setError(null);
    } catch {
      setError('Could not restore this conversation. Try again.');
    }
  };
  return {
    dismiss: (item: HomeWorkItem) => {
      try {
        dismissInboxItem(item, facts?.get(item.id));
      } catch {
        setError('Could not save dismissal. Try again.');
        return;
      }
      // The dismissal is saved; a toast failure must not report otherwise,
      // and ⌘Z and Restore still reach it.
      undoLastDismiss = () => restore(item);
      setError(null);
      if (lastDismissToast) toastStore.dismiss(lastDismissToast);
      lastDismissToast = null;
      try {
        lastDismissToast = toastStore.show(
          'Conversation dismissed',
          undefined,
          8000,
          [{ label: 'Undo', onClick: () => restore(item) }],
        );
      } catch {}
    },
    restore,
    notice: error ? (
      <div className="chat-dock-inbox__dismiss-notice">
        <span role="status">{error}</span>
      </div>
    ) : null,
  };
}

let lastDismissToast: string | null = null;
let undoLastDismiss: (() => void) | null = null;
/** One registered Undo command for the latest dismissal across inbox hosts. */
export function InboxDismissUndo({ children }: { children: ReactNode }) {
  const { apiBase } = useApiBase();
  useEffect(() => {
    void apiBase;
    undoLastDismiss = null;
  }, [apiBase]);
  useKeyboardShortcut(
    'inbox.undoDismiss',
    'z',
    ['cmd'],
    'Undo inbox dismissal',
    () => {
      if (
        document.activeElement?.closest(
          'input, textarea, select, [contenteditable], [role="textbox"], .xterm',
        )
      )
        return false;
      if (!undoLastDismiss) return false;
      undoLastDismiss();
    },
  );
  return children;
}
