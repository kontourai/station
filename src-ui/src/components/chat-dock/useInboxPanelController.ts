import {
  type RefObject,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { conversationStateKey } from '../../connections/station-state';
import type { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useAuthorityPersistence } from '../../contexts/AuthorityPersistenceContext';
import { navigationStore } from '../../contexts/navigation-store';
import { useCoarseNow } from '../../hooks/useCoarseNow';
import { migrateSnoozeKey } from '../../utils/activity-snooze-store';
import { migrateInboxDismissal } from '../../utils/inbox-dismissal-store';
import {
  chatTaskSessionId,
  type HomeWorkItem,
} from '../../views/home/home-view-model';
import type { WorkFactsById } from '../../views/home/work-facts';
import {
  openWorkItem,
  type WorkItemOpenHandlers,
  workItemOpenFailureMessage,
} from '../../views/home/work-item-open-policy';
import { describeReadFailure } from '../state/describeReadFailure';
import { moveFocusBeforeRemovingInboxRow } from './ChatDockInboxRows';
import { useInboxScope } from './InboxScopeFilter';
import { useInboxDismissActions } from './inbox-dismissals';
import {
  clearSnooze,
  snoozeKeyFor,
  writeSnooze,
} from './mobile-activity-groups';
import { useInboxGroups } from './useInboxGroups';

export interface InboxPanelControllerOptions extends WorkItemOpenHandlers {
  items: HomeWorkItem[];
  open: boolean;
  panelRef: RefObject<HTMLElement | null>;
  authority?: ReturnType<typeof useHostRequestAuthorityScope>;
  openChatSessionIds?: string[];
  workFacts?: WorkFactsById;
  now?: number;
  onOpenFailed?: (message: string) => void;
  onCloseChat?: (id: string) => void;
  onAcknowledgeConversation?: (item: HomeWorkItem) => void;
  onActivated?: () => void;
}

/** Both shells use the same selection lease, including the dock's before-focus seam. */
export function useInboxPanelController(options: InboxPanelControllerOptions) {
  const { items, open, authority, panelRef, workFacts, onCloseChat } = options;
  const { namespace } = useAuthorityPersistence();
  const now = useCoarseNow(options.now, { enabled: open });
  useLayoutEffect(() => {
    for (const item of items) {
      if (!item.chatSessionId || !item.conversationId) continue;
      const oldId = conversationStateKey(
        workFacts?.get(item.id)?.chatBinding,
        item.chatSessionId,
      );
      migrateSnoozeKey(oldId, item.id, now, namespace);
      migrateInboxDismissal(oldId, item.id, namespace);
    }
  }, [items, workFacts, now, namespace]);
  const [query, setQuery] = useState('');
  const scope = useInboxScope(items, now, workFacts);
  const groups = useInboxGroups(scope.items, now, workFacts, query);
  const openChatIds = useMemo(
    () =>
      new Set(
        options.openChatSessionIds ??
          items.filter((item) => item.kind === 'chat').map(chatTaskSessionId),
      ),
    [items, options.openChatSessionIds],
  );
  const dismissals = useInboxDismissActions(items, workFacts);
  const authorityKey = JSON.stringify([
    namespace,
    authority?.apiBase,
    authority?.authorityKey,
  ]);
  const selection = useRef<{ generation: number; abort?: AbortController }>({
    generation: 0,
  });
  const latest = useRef({
    open,
    authorityKey,
    filter: scope.value,
    query,
    items,
    workFacts,
  });
  latest.current = {
    open,
    authorityKey,
    filter: scope.value,
    query,
    items,
    workFacts,
  };
  const invalidate = useCallback(() => {
    selection.current.generation += 1;
    selection.current.abort?.abort();
  }, []);
  useLayoutEffect(() => {
    void open;
    void authorityKey;
    void scope.value;
    void query;
    invalidate();
    return invalidate;
  }, [open, authorityKey, scope.value, query, invalidate]);

  const activate = async (item: HomeWorkItem) => {
    invalidate();
    if (!open || authority === null || authority?.isCurrent() === false) return;
    const generation = selection.current.generation;
    const abort = new AbortController();
    selection.current.abort = abort;
    // The row's stable identity: where it lives and which row it is. Not
    // `chatSessionId` or the chat binding, which the open itself writes when
    // it binds a dock chat to the row; keyed on those, the selection stopped
    // being current mid-open and the open was dropped without a word (#4814).
    const rowKey = (row: HomeWorkItem, facts = workFacts) =>
      JSON.stringify([
        authorityKey,
        row.environmentId,
        facts?.get(row.id)?.station?.id,
        row.id,
      ]);
    const selectedKey = rowKey(item);
    const current = () =>
      !abort.signal.aborted &&
      generation === selection.current.generation &&
      latest.current.open &&
      latest.current.authorityKey === authorityKey &&
      latest.current.filter === scope.value &&
      latest.current.query === query &&
      authority?.isCurrent() !== false &&
      latest.current.items.some(
        (candidate) =>
          rowKey(candidate, latest.current.workFacts) === selectedKey,
      );
    try {
      if (!current()) return;
      if (item.kind === 'task') {
        navigationStore.navigate(`/tasks/${encodeURIComponent(item.id)}`, {
          dock: null,
          chat: null,
          maximize: null,
          surface: null,
          taskView: 'overview',
        });
        if (current()) options.onActivated?.();
        return;
      }
      const outcome = await openWorkItem(item, {
        agentsLoaded: options.agentsLoaded,
        onFocusChat: (id) => {
          if (current()) options.onFocusChat(id);
        },
        onOpenSession: (id) => {
          if (current()) options.onOpenSession(id);
        },
        onOpenConversation: (id, agent, project, name, model, updated) => {
          if (!current()) return 'cancelled';
          return options.onOpenConversation(
            id,
            agent,
            project,
            name,
            model,
            updated,
            undefined,
            {
              // A later selection retires focus, not history for this authority.
              isCurrent: () =>
                latest.current.authorityKey === authorityKey &&
                authority?.isCurrent() !== false,
              beforeFocus: current,
            },
          );
        },
      });
      if (!current() || outcome === 'cancelled') return;
      if (outcome === 'opened' || outcome === 'fallback') {
        options.onAcknowledgeConversation?.(item);
        if (current()) options.onActivated?.();
      } else options.onOpenFailed?.(workItemOpenFailureMessage(item, outcome));
    } catch (error) {
      if (current()) options.onOpenFailed?.(describeReadFailure(error));
    }
  };
  const beforeRemoval = (action: HTMLButtonElement) => {
    invalidate();
    moveFocusBeforeRemovingInboxRow(panelRef.current, action);
  };
  return {
    stateKey: JSON.stringify([namespace, authorityKey]),
    now,
    scope,
    query,
    setQuery,
    groups,
    openChatIds,
    hasVisibleItems: groups.some((group) => group.items.length > 0),
    notice: dismissals.notice,
    rowActions: {
      onActivate: (item: HomeWorkItem) => {
        void activate(item);
      },
      onSnoozeWake: (
        item: HomeWorkItem,
        wakeAt: number | null,
        action: HTMLButtonElement,
      ) => {
        beforeRemoval(action);
        const key = snoozeKeyFor(item);
        if (wakeAt === null) clearSnooze(key, now, namespace);
        else writeSnooze(key, wakeAt, now, namespace);
      },
      onDismiss: (item: HomeWorkItem, action: HTMLButtonElement) => {
        beforeRemoval(action);
        dismissals.dismiss(item);
      },
      onRestore: (item: HomeWorkItem, action: HTMLButtonElement) => {
        beforeRemoval(action);
        dismissals.restore(item);
      },
      onCloseChat: onCloseChat
        ? (id: string, action: HTMLButtonElement) => {
            beforeRemoval(action);
            onCloseChat(id);
          }
        : undefined,
      onDraftDiscarded: (item: HomeWorkItem, action: HTMLButtonElement) => {
        if (action.closest('.inbox-row')?.contains(document.activeElement))
          beforeRemoval(action);
        if (item.chatSessionId && openChatIds.has(item.chatSessionId))
          onCloseChat?.(item.chatSessionId);
      },
    },
  };
}
