import type { ReactNode } from 'react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { useAuthorityPersistence } from '../../contexts/AuthorityPersistenceContext';
import { toastStore } from '../../contexts/ToastContext';
import {
  dismissInboxItem,
  dropInboxDismissals,
  hasInboxDismissal,
  inboxDismissalsVersion,
  isInboxDismissed,
  readHostThirdPartyDismissals,
  readInboxDismissals,
  restoreInboxItems,
  subscribeInboxDismissals,
} from '../../utils/inbox-dismissal-store';
import type { HomeWorkItem } from '../../views/home/home-view-model';
import type { WorkFactsById } from '../../views/home/work-facts';
import {
  trackPendingUndo,
  untrackPendingUndo,
} from '../undo/UndoableActionShortcut';
import {
  inboxHideTarget,
  isHostHidden,
  useConversationWorkState,
} from './useConversationWorkState';
import { useHeldLifecycles } from './useHeldLifecycles';

/** Migrations in flight, by namespace and host authority. */
const migrating = new Set<string>();

export function useInboxDismissals(
  items: HomeWorkItem[],
  facts?: WorkFactsById,
) {
  const { namespace } = useAuthorityPersistence();
  const version = useSyncExternalStore(
    subscribeInboxDismissals,
    inboxDismissalsVersion,
    inboxDismissalsVersion,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: storage version invalidates the persisted snapshot
  const entries = useMemo(
    () => readInboxDismissals(namespace),
    [version, namespace],
  );
  const heldItems = useHeldLifecycles(items);
  const workState = useConversationWorkState();
  const { hidden, hideSupported } = workState;
  const { visible, dismissed, woken, adopted } = useMemo(() => {
    const visible: HomeWorkItem[] = [];
    const dismissed: HomeWorkItem[] = [];
    const woken: HomeWorkItem[] = [];
    // Hidden on the host, but no longer a third-party Session here: it was
    // adopted into Station, so its hidden record has served its purpose.
    const adopted: string[] = [];
    for (const item of heldItems) {
      const itemFacts = facts?.get(item.id);
      if (
        isHostHidden(item, hidden, itemFacts) ||
        isInboxDismissed(item, entries, itemFacts)
      )
        dismissed.push(item);
      else {
        visible.push(item);
        if (hasInboxDismissal(item, entries)) woken.push(item);
        const threadId =
          item.kind === 'orchestration' && !item.environmentId
            ? (item.orchestrationThreadId ?? item.id)
            : undefined;
        if (
          threadId &&
          item.controlMode !== 'read-only-attached' &&
          Object.hasOwn(hidden, threadId)
        )
          adopted.push(threadId);
      }
    }
    return { visible, dismissed, woken, adopted };
  }, [heldItems, entries, facts, hidden]);
  useEffect(() => {
    if (!woken.length) return;
    try {
      restoreInboxItems(woken, namespace);
    } catch {
      // Visibility follows the current observation even if storage is unavailable.
    }
  }, [woken, namespace]);
  const unhideAdopted = workState.hide.mutate;
  useEffect(() => {
    for (const sessionId of adopted)
      unhideAdopted({ sessionId, hidden: false });
  }, [adopted, unhideAdopted]);
  // Local third-party dismissals move to the host, then leave this browser;
  // another Station's rows stay local. Moved entries are gone, so this runs
  // again only when local dismissals or host support change.
  const migrateHidden = useRef(workState.migrateHidden);
  migrateHidden.current = workState.migrateHidden;
  const { scopeKey } = workState;
  useEffect(() => {
    void version;
    if (!hideSupported) return;
    const marker = JSON.stringify([namespace, scopeKey]);
    if (migrating.has(marker)) return;
    let local: string[];
    try {
      local = readHostThirdPartyDismissals(namespace);
    } catch {
      return;
    }
    if (!local.length) return;
    migrating.add(marker);
    void migrateHidden
      .current(local)
      .then((done) => {
        try {
          dropInboxDismissals(done, namespace);
        } catch {
          // A later change retries what this one could not drop.
        }
      })
      .finally(() => migrating.delete(marker));
  }, [hideSupported, namespace, scopeKey, version]);
  return { visible, dismissed };
}

export function useInboxDismissActions(
  items: HomeWorkItem[],
  facts?: WorkFactsById,
) {
  const { namespace } = useAuthorityPersistence();
  const currentNamespace = useRef(namespace);
  currentNamespace.current = namespace;
  const [error, setError] = useState<string | null>(null);
  // A toast can outlive the render where a local draft gained a durable ID.
  const currentItems = useRef(items);
  currentItems.current = items;
  // An Undo toast outlives the render that hid the row; read the latest map.
  const workState = useConversationWorkState();
  const workStateRef = useRef(workState);
  workStateRef.current = workState;
  /** The host Session this row hides on, when the host keeps hidden Sessions. */
  const hostTarget = (item: HomeWorkItem) =>
    workStateRef.current.hideSupported
      ? inboxHideTarget(item, facts?.get(item.id))
      : null;
  const restore = (item: HomeWorkItem) => {
    if (currentNamespace.current !== namespace) return;
    const target = hostTarget(item);
    if (target && Object.hasOwn(workStateRef.current.hidden, target)) {
      workStateRef.current.hide.mutate({ sessionId: target, hidden: false });
      if (lastDismissToast) toastStore.dismiss(lastDismissToast);
      lastDismissToast = null;
    }
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
      restoreInboxItems([current], namespace);
      if (lastDismissToast) toastStore.dismiss(lastDismissToast);
      lastDismissToast = null;
      setError(null);
    } catch {
      setError('Could not restore this conversation. Try again.');
    }
  };
  return {
    async dismissSelected(item: HomeWorkItem) {
      if (currentNamespace.current !== namespace)
        throw new Error('Station changed');
      const target = hostTarget(item);
      if (target) {
        if (!workState.hide.mutateAsync) throw new Error('Hide unavailable');
        await workState.hide.mutateAsync({ sessionId: target, hidden: true });
      } else dismissInboxItem(item, facts?.get(item.id), namespace);
    },
    dismiss: (item: HomeWorkItem) => {
      const target = hostTarget(item);
      if (target) {
        workState.hide.mutate({ sessionId: target, hidden: true });
        setError(null);
        if (lastDismissToast) toastStore.dismiss(lastDismissToast);
        lastDismissToast = null;
        lastDismissToast = offerDismissUndo('Session hidden', () =>
          restore(item),
        );
        return;
      }
      try {
        dismissInboxItem(item, facts?.get(item.id), namespace);
      } catch {
        setError('Could not save dismissal. Try again.');
        return;
      }
      // The dismissal is saved; a toast failure must not report otherwise,
      // and ⌘Z and Restore still reach it.
      setError(null);
      if (lastDismissToast) toastStore.dismiss(lastDismissToast);
      lastDismissToast = null;
      lastDismissToast = offerDismissUndo('Conversation dismissed', () =>
        restore(item),
      );
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
let dismissToastSequence = 0;

/**
 * Shows the Undo notice for a dismissal and enters it in the app's undo stack,
 * so Mod+Z reaches it through the one registered Undo command, in order with
 * every other undoable action. Null when the notice could not be shown; the
 * dismissal itself is already saved, and Restore still reaches it.
 */
function offerDismissUndo(message: string, onUndo: () => void): string | null {
  dismissToastSequence += 1;
  const id = `inbox-dismiss-${dismissToastSequence}`;
  try {
    toastStore.upsert({
      id,
      message,
      tone: 'info',
      duration: 8000,
      actions: [{ label: 'Undo', onClick: onUndo }],
      onDismiss: () => untrackPendingUndo(id),
    });
  } catch {
    return null;
  }
  trackPendingUndo(id);
  return id;
}

/**
 * Drops the latest dismissal's Undo notice when the Station or namespace it
 * was made for changes, so an Undo for another authority is never offered.
 */
export function InboxDismissUndo({ children }: { children: ReactNode }) {
  const { apiBase } = useApiBase();
  const { namespace } = useAuthorityPersistence();
  useEffect(() => {
    void apiBase;
    void namespace;
    if (lastDismissToast) toastStore.dismiss(lastDismissToast);
    lastDismissToast = null;
  }, [apiBase, namespace]);
  return children;
}
