import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
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
import { Button } from '../Button';
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
  const [last, setLast] = useState<HomeWorkItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const restore = (item: HomeWorkItem) => {
    try {
      const current =
        items.find(
          (candidate) =>
            candidate.environmentId === item.environmentId &&
            (candidate.id === item.id ||
              Boolean(
                item.chatSessionId &&
                  candidate.chatSessionId === item.chatSessionId,
              )),
        ) ?? item;
      restoreInboxItems([current]);
      setLast(null);
      setError(null);
    } catch {
      setError('Could not restore this conversation. Try again.');
    }
  };
  return {
    dismiss: (item: HomeWorkItem) => {
      try {
        dismissInboxItem(item, facts?.get(item.id));
        setLast(item);
        setError(null);
      } catch {
        setError('Could not save dismissal. Try again.');
      }
    },
    restore,
    notice:
      error || last ? (
        <div className="chat-dock-inbox__dismiss-notice">
          <span role="status">{error ?? 'Conversation dismissed'}</span>
          {!error && last && (
            <Button variant="ghost" onClick={() => restore(last)}>
              Undo
            </Button>
          )}
        </div>
      ) : null,
  };
}
