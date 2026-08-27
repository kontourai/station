import {
  captureReturnFocus,
  restoreReturnFocus,
} from '@kontourai/station-shared/return-focus';
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  chatTaskSessionId,
  type HomeTaskItem,
} from '../../views/home/home-view-model';
import {
  openWorkItem,
  workItemOpenFailureMessage,
} from '../../views/home/work-item-open-policy';
import { registerDialogHistory } from '../dialog-history';
import { ResponsiveDialogCloseButton } from '../ResponsiveDialogSurface';
import { Empty } from '../state';
import {
  InboxGroupList,
  type InboxGroupListProps,
  moveFocusBeforeRemovingInboxRow,
} from './ChatDockInboxRows';
import {
  clearSnooze,
  groupMobileActivity,
  type MobileActivityGroupId,
  readSnoozes,
  type SnoozeMap,
  snoozeKeyFor,
  writeSnooze,
} from './mobile-activity-groups';

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Which entry point opened the sheet.
 *
 * `'activity'` (the header's activity button) leads with what is running or has
 * just come back; `'tasks'` (the chat-title chevron) is the full switcher. Same
 * sheet, same rows — only the default scope differs, so there is one list
 * implementation rather than two near-identical ones.
 */
export type MobileTaskSwitcherMode = 'tasks' | 'activity';

const ACTIVITY_GROUPS: MobileActivityGroupId[] = [
  'active',
  'settled',
  'snoozed',
];

export function MobileTaskSwitcher({
  open,
  mode = 'tasks',
  tasks,
  openChatSessionIds,
  activeChatSessionId,
  visualViewportStyle,
  triggerRef,
  onClose,
  onFocusChat,
  onOpenConversation,
  onOpenSession,
  agentsLoaded,
  onOpenFailed,
  onCloseChat,
  onAcknowledgeConversation,
  backgroundTaskCount,
  onOpenBackgroundTasks,
  now,
  agents,
}: {
  open: boolean;
  mode?: MobileTaskSwitcherMode;
  tasks: HomeTaskItem[];
  openChatSessionIds?: string[];
  activeChatSessionId: string | null;
  visualViewportStyle: CSSProperties;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onFocusChat: (id: string) => void;
  /** station#1297: rehydrates a session with no live tab into the chat
   *  overlay — mirrors `useChatDockActions`' `openConversation`. */
  onOpenConversation: (
    conversationId: string,
    agentSlug: string,
    projectSlug?: string,
    projectName?: string,
    model?: string,
    conversationUpdatedAt?: string,
  ) => Promise<boolean> | boolean | undefined;
  onOpenSession: (threadId: string) => void;
  /** See WorkItemOpenHandlers.agentsLoaded (station#3687). */
  agentsLoaded?: boolean;
  /** A click that opened nothing reports why; the host owns the toast. */
  onOpenFailed?: (message: string) => void;
  /** kontourai/station#3312: closes an open chat's tab from its shared-row
   *  close action. Optional — a host with no tab teardown hides the action. */
  onCloseChat?: (id: string) => void;
  /** Marks the rendered conversation version as seen before opening it. */
  onAcknowledgeConversation?: (item: HomeTaskItem) => void;
  /**
   * station#1301 slice 1: the active chat's running-background-task count
   * and its opener. Both omitted render no row (a test/host with no active
   * chat has nothing to count).
   */
  backgroundTaskCount?: number;
  onOpenBackgroundTasks?: () => void;
  /** Injectable clock for the recency boundary; defaults to wall time. */
  now?: number;
  /**
   * station#2802: live agent catalog for the rows' leading agent icons — the
   * same shared-row affordance the desktop panel gets, so the two chromes do
   * not drift into different row anatomy. Omitted renders no icons.
   */
  agents?: InboxGroupListProps['agents'];
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const openMembership = useMemo(
    () =>
      new Set(
        openChatSessionIds ??
          tasks.filter((task) => task.kind === 'chat').map(chatTaskSessionId),
      ),
    [openChatSessionIds, tasks],
  );
  const collectionTasks = useMemo(
    () =>
      tasks.filter(
        (task) =>
          task.kind !== 'chat' || openMembership.has(chatTaskSessionId(task)),
      ),
    [openMembership, tasks],
  );
  const [snoozed, setSnoozed] = useState<SnoozeMap>({});
  const [showEverything, setShowEverything] = useState(mode === 'tasks');
  const returnFocusRef = useRef<HTMLElement[]>([]);
  // Found by station#1245's sweep, not listed on the issue: this sheet is
  // hand-rolled rather than a `ResponsiveDialogSurface` (see the history-layer
  // note below), and its restore was `requestAnimationFrame(() =>
  // triggerRef.current?.focus())` with no guard at all — the same shape as
  // `CommandPalette`'s. Selecting a row opens a different chat, which can
  // replace the header the trigger lives in, and `.focus()` on a detached node
  // strands focus on `<body>` (#1126).
  const closeAndRestoreFocus = useCallback(() => {
    const chain = returnFocusRef.current;
    const panel = panelRef.current;
    returnFocusRef.current = [];
    onClose();
    restoreReturnFocus(chain, panel);
  }, [onClose]);

  // Each opening starts from its entry point's own scope — a previous
  // "show all" must not leak into the next activity-button tap.
  useEffect(() => {
    if (open) setShowEverything(mode === 'tasks');
  }, [mode, open]);

  // Read snoozes when the sheet opens rather than on every render: the map is
  // in localStorage and lapsed entries are pruned on read.
  useEffect(() => {
    if (open) setSnoozed(readSnoozes(now ?? Date.now()));
  }, [now, open]);

  const groups = useMemo(
    () => groupMobileActivity(collectionTasks, now ?? Date.now(), snoozed),
    [collectionTasks, now, snoozed],
  );
  const visibleGroups = useMemo(
    () =>
      (showEverything
        ? groups
        : groups.filter((group) => ACTIVITY_GROUPS.includes(group.id))
      ).filter((group) => group.items.length > 0),
    [groups, showEverything],
  );
  const hiddenCount = useMemo(
    () =>
      showEverything
        ? 0
        : groups
            .filter((group) => !ACTIVITY_GROUPS.includes(group.id))
            .reduce((total, group) => total + group.items.length, 0),
    [groups, showEverything],
  );

  useLayoutEffect(() => {
    if (!open) return;
    // Capture before moving focus into the panel, while the trigger and every
    // ancestor are still attached.
    returnFocusRef.current = captureReturnFocus(triggerRef.current);
    panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [open, triggerRef]);

  /**
   * This sheet is hand-rolled rather than a `ResponsiveDialogSurface`, so it
   * never got that component's `historyMode` layer — an Android back swipe
   * navigated the page *underneath* it instead of dismissing it. Register the
   * same same-URL history layer directly so Back closes the sheet first.
   */
  useEffect(() => {
    if (!open) return;
    return registerDialogHistory('mobile-task-switcher', onClose);
  }, [onClose, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeAndRestoreFocus();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
      );
      if (!controls.length) return;
      const first = controls[0];
      const last = controls.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [closeAndRestoreFocus, open]);

  if (!open) return null;

  const isActivity = mode === 'activity' && !showEverything;
  // 'Switch task' is the established accessible name for this sheet and is what
  // the e2e suite and any name-driven caller already target — renaming it would
  // be churn for no user benefit. Activity mode gets its own name because it is
  // a genuinely different scope.
  const heading = isActivity ? 'Activity' : 'Switch task';
  // "Active" matches the group label the list actually renders: since
  // station#3227 A6 the Active group is the shared lane model's "not
  // finished" (including idle-but-open work), so "Running…" would promise a
  // narrower scope than the rows below it deliver.
  const eyebrow = isActivity ? 'Active and just finished' : 'Chats and tasks';

  // Portaled to <body>: this sheet used to render inside the ChatDock
  // subtree, whose `position: fixed; z-index: 100` root creates a stacking
  // context — so the overlay's dialog-layer z-index was local and the app
  // toolbar (root context, z-index 200) painted over the sheet's header,
  // hiding and blocking the Close affordance whenever the sheet reached
  // full height (#1051).
  return createPortal(
    <div
      className="mobile-task-switcher__overlay responsive-surface-overlay"
      style={visualViewportStyle}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) closeAndRestoreFocus();
      }}
    >
      <section
        ref={panelRef}
        className="mobile-task-switcher__panel responsive-surface-panel"
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        // Focus fallback target when a removed row has no neighbor (#1054).
        tabIndex={-1}
      >
        <header className="mobile-task-switcher__header">
          <div>
            <p>{eyebrow}</p>
            <h2>{heading}</h2>
          </div>
          <ResponsiveDialogCloseButton
            label={isActivity ? 'Close activity' : 'Close task switcher'}
            onClick={closeAndRestoreFocus}
          />
        </header>
        <div className="mobile-task-switcher__list chat-dock-inbox--touch">
          {isActivity && onOpenBackgroundTasks && (
            <button
              type="button"
              className="mobile-task-switcher__background-tasks-row"
              onClick={() => {
                closeAndRestoreFocus();
                onOpenBackgroundTasks();
              }}
            >
              {`Background tasks (${backgroundTaskCount ?? 0})`}
            </button>
          )}
          {visibleGroups.length === 0 && (
            <Empty
              variant="compact"
              label={
                isActivity ? 'Nothing running right now.' : 'No chats yet.'
              }
            />
          )}
          {/* kontourai/station#3312: rows/groups are the shared inbox
              anatomy (`ChatDockInboxRows.tsx`) — same richness as the
              desktop panel, with `--touch` chrome for ≥44px targets. */}
          <InboxGroupList
            groups={visibleGroups}
            idPrefix="mobile-task-switcher"
            activeChatSessionId={activeChatSessionId}
            openChatIds={openMembership}
            now={now ?? Date.now()}
            agents={agents}
            showGroupCounts
            onActivate={(task) => {
              // station#3687: acknowledge only after the click did something,
              // and say so when it could not (same contract as the desktop
              // panel — see ChatDockInboxPanel's onActivate).
              void openWorkItem(task, {
                onFocusChat,
                onOpenConversation,
                onOpenSession,
                agentsLoaded,
              })
                .then((outcome) => {
                  if (outcome === 'opened' || outcome === 'fallback') {
                    onAcknowledgeConversation?.(task);
                    return;
                  }
                  onOpenFailed?.(workItemOpenFailureMessage(task, outcome));
                })
                .catch(() => {
                  onOpenFailed?.(
                    'Could not open this item. Try again, or open it from Activity.',
                  );
                });
              closeAndRestoreFocus();
            }}
            onSnoozeWake={(task, wakeAt, action) => {
              // The row leaves its group on snooze/unsnooze; keep focus in
              // the sheet rather than stranding it on a removed node (#1054).
              moveFocusBeforeRemovingInboxRow(panelRef.current, action);
              const clock = now ?? Date.now();
              const snoozeKey = snoozeKeyFor(task);
              setSnoozed(
                wakeAt === null
                  ? clearSnooze(snoozeKey, clock)
                  : writeSnooze(snoozeKey, wakeAt, clock),
              );
            }}
            onCloseChat={
              onCloseChat
                ? (sessionId, action) => {
                    moveFocusBeforeRemovingInboxRow(panelRef.current, action);
                    onCloseChat(sessionId);
                  }
                : undefined
            }
          />
          {hiddenCount > 0 && (
            <button
              type="button"
              className="mobile-task-switcher__show-all"
              onClick={() => setShowEverything(true)}
            >
              {`Show all chats (${hiddenCount} more)`}
            </button>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
