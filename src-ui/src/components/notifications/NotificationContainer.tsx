import {
  captureReturnFocus,
  restoreReturnFocus,
} from '@kontourai/station-shared/return-focus';
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useAllActiveChats } from '../../contexts/ActiveChatsContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { useNotificationHistory, useToast } from '../../contexts/ToastContext';
import { openConnectionsModal } from '../../lib/connectionModalEvents';
import './NotificationContainer.css';
import {
  buildToastStackLayout,
  selectToastStackItems,
} from './toast-stack-layout';

type Notification = ReturnType<typeof useNotificationHistory>[number];

function formatTimestamp(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;

  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function ToastCard({
  notification,
  dismissToast,
  getSessionShortcut,
  handleNavigateTo,
  handleAction,
  onActivate,
  clickable,
  collapsedContentHidden,
}: {
  notification: Notification;
  dismissToast: (id: string) => void;
  getSessionShortcut: (sessionId: string | undefined) => string | null;
  handleNavigateTo: (
    metadata: Record<string, unknown>,
    toastId: string,
  ) => void;
/**
* Optional: only the approval-queue call site (tool-approval/pairing-request
* items) ever needs this — the transient toast-stack call site filters
* those types out entirely (see `transientNotifications` below), so it has
* no real `handleAction` to pass and shouldn't need to invent one just to
* satisfy a prop this component structurally never exercises there.
*/
  handleAction?: (notificationId: string, actionId: string) => void;
  onActivate?: () => void;
  clickable: boolean;
  collapsedContentHidden?: boolean;
}) {
  const isApproval = notification.type === 'tool-approval';
  const isActivity = notification.type === 'tool-activity';
  const isPairing = notification.type === 'pairing-request';
  const shortcut = getSessionShortcut(notification.sessionId);

  const activate = (event?: ReactMouseEvent | ReactKeyboardEvent) => {
    if (!clickable || !onActivate) return;
    event?.stopPropagation?.();
    onActivate();
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (!clickable) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate(event);
    }
  };

  return (
    <article
      className={[
        'toast-card',
        isApproval ? 'toast-card--approval' : '',
        isPairing ? 'toast-card--pairing' : '',
        clickable ? 'toast-card--clickable' : '',
        collapsedContentHidden ? 'toast-card--collapsed-hidden' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid={
        collapsedContentHidden ? 'toast-card-collapsed' : 'toast-card'
      }
      {...(clickable
        ? {
            role: 'button',
            tabIndex: 0,
            onClick: () => activate(),
            onKeyDown,
          }
        : {})}
    >
      <div className="toast-card__header">
        <div className="toast-card__content">
          <div className="toast-card__meta">
            {isApproval && (
              <span className="toast-card__eyebrow">Tool Approval Request</span>
            )}
            {isActivity && (
              <span className="toast-card__eyebrow">Tool Activity</span>
            )}
            {isPairing && (
              <span className="toast-card__eyebrow">
                Device Pairing Request
              </span>
            )}
            <time className="toast-card__time">
              {formatTimestamp(notification.timestamp)}
            </time>
          </div>
          <div className="toast-card__message">{notification.message}</div>
          {notification.metadata?.detail ? (
            <div className="toast-card__detail">
              {String(notification.metadata.detail)}
            </div>
          ) : null}
          {notification.conversationTitle && notification.onNavigate && (
            <div className="toast-card__conversation">
              <span>in</span>
              <button
                type="button"
                className="toast-card__link"
                onClick={(event) => {
                  event.stopPropagation();
                  notification.onNavigate?.();
                  dismissToast(notification.id);
                }}
              >
                “{notification.conversationTitle}”
              </button>
              {shortcut && (
                <kbd className="toast-card__shortcut">{shortcut}</kbd>
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          className="toast-card__dismiss"
          aria-label={
            isApproval
              ? 'Dismiss approval alert'
              : isPairing
                ? 'Dismiss pairing request'
                : 'Dismiss notification'
          }
          onClick={(event) => {
            event.stopPropagation();
            dismissToast(notification.id);
          }}
        >
          ×
        </button>
      </div>

      {notification.actions && notification.actions.length > 0 && (
        <div className="toast-card__actions">
          {notification.actions.map((action, index) => (
            <button
              type="button"
              key={`${action.label}-${index}`}
              className={`toast-card__action toast-card__action--${action.variant || 'secondary'}`}
              onClick={(event) => {
                event.stopPropagation();
                action.onClick();
                dismissToast(notification.id);
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}

      {isPairing && !notification.actions && (
        <div className="toast-card__actions">
          <button
            type="button"
            className="toast-card__action toast-card__action--primary"
            onClick={(event) => {
              event.stopPropagation();
              handleAction?.(notification.id, 'allow');
              dismissToast(notification.id);
            }}
          >
            Allow
          </button>
          <button
            type="button"
            className="toast-card__action toast-card__action--danger"
            onClick={(event) => {
              event.stopPropagation();
              handleAction?.(notification.id, 'deny');
              dismissToast(notification.id);
            }}
          >
            Deny
          </button>
        </div>
      )}

      {notification.metadata?.navigateTo != null && !isPairing && (
        <div className="toast-card__actions">
          <button
            type="button"
            className="toast-card__action toast-card__action--primary"
            onClick={(event) => {
              event.stopPropagation();
              handleNavigateTo(notification.metadata!, notification.id);
            }}
          >
            View
          </button>
        </div>
      )}
    </article>
  );
}

export function NotificationContainer() {
  const history = useNotificationHistory();
  const { dismissToast } = useToast();
  const activeChats = useAllActiveChats();
  const { navigate } = useNavigation();
  const approvalQueueRef = useRef<HTMLDivElement>(null);
  const approvalQueueTriggerRef = useRef<HTMLButtonElement>(null);
  const [approvalQueueOpen, setApprovalQueueOpen] = useState(false);
/**
* archive#1259. This popover is the one surface in the app whose own action
* removes the control it has to hand focus back to: approving or denying the
* last request empties `approvals`, the queue element unmounts with the
* trigger inside it, and — when nothing transient is left — the whole
* container returns `null`. So the live-ref restore other menus get is not
* available here; the trigger has to be captured while it is still attached,
* together with the ancestors focus can fall back to.
*/
  const returnFocusRef = useRef<HTMLElement[]>([]);

/**
* Every close path, not just Escape. The outside-pointerdown path used to
* leave focus wherever the pointer put it — on `<body>` for a tap on
* non-focusable chrome (archive#1126's outcome) — and the auto-close effect
* below restored nothing at all. `applyReturnFocus` declines when another
* actor already holds focus, which is what makes it safe to call on the
* pointer path: a tap on a real control keeps that control.
*/
  const closeApprovalQueue = useCallback(() => {
    setApprovalQueueOpen(false);
    restoreReturnFocus(returnFocusRef.current, approvalQueueRef.current);
  }, []);

  const activeNotifications = history.filter((item) => !item.dismissed);
  const approvals = activeNotifications.filter(
    (item) => item.type === 'tool-approval' || item.type === 'pairing-request',
  );
  const transientNotifications = activeNotifications.filter(
    (item) => item.type !== 'tool-approval' && item.type !== 'pairing-request',
  );
  const stackedTransients = selectToastStackItems(transientNotifications);
  const stackLayout = buildToastStackLayout(stackedTransients.length);
/**
 * Coarse-pointer expansion for the archive#1960 stack. CSS `:hover`/`:focus-within`
* expansion has no touch equivalent, so on a device that cannot hover the
* stack could never be expanded at all. A tap on the collapsed stack sets
* this state (the CSS treats it as a third expansion trigger); outside-tap
* and Escape clear it. Hover-capable pointers never reach the tap path —
* their stack is already expanded by :hover before any click lands.
*/
  const toastStackRef = useRef<HTMLDivElement>(null);
  const [stackExpanded, setStackExpanded] = useState(false);

  useEffect(() => {
    if (stackExpanded && stackedTransients.length <= 1) {
      setStackExpanded(false);
    }
  }, [stackExpanded, stackedTransients.length]);

  useEffect(() => {
    if (!stackExpanded) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!toastStackRef.current?.contains(event.target as Node)) {
        setStackExpanded(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setStackExpanded(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [stackExpanded]);

  const expandStackOnCoarseTap = (event: ReactMouseEvent) => {
    if (stackExpanded || stackedTransients.length <= 1) return;
// Missing matchMedia (jsdom) reads as hover-capable: interception is a
// touch affordance, never desktop default behavior.
    const hoverCapable = window.matchMedia?.('(hover: hover)').matches ?? true;
    if (hoverCapable) return;
    event.preventDefault();
    event.stopPropagation();
    setStackExpanded(true);
  };

  useEffect(() => {
    if (!approvalQueueOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!approvalQueueRef.current?.contains(event.target as Node)) {
        closeApprovalQueue();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeApprovalQueue();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [approvalQueueOpen, closeApprovalQueue]);

  useEffect(() => {
    if (approvals.length > 0 || !approvalQueueOpen) return;
    closeApprovalQueue();
  }, [approvals.length, approvalQueueOpen, closeApprovalQueue]);

  const handleNavigateTo = (
    metadata: Record<string, unknown>,
    toastId: string,
  ) => {
// Pairing requests: open Connections in pair-device mode (host approve).
    if (
      metadata.surface === 'connections:pairing' ||
      (metadata.navigateTo as { mode?: string } | undefined)?.mode ===
        'pair-device'
    ) {
      openConnectionsModal({ mode: 'pair-device' });
      dismissToast(toastId);
      return;
    }
    const nav = metadata.navigateTo as
      | { project?: string; layout?: string; path?: string }
      | undefined;
    if (!nav) return;
    if (nav.path === '/connections') {
      openConnectionsModal({
        mode:
          (nav as { mode?: 'list' | 'pair-device' }).mode === 'pair-device'
            ? 'pair-device'
            : 'list',
      });
      dismissToast(toastId);
      return;
    }
// Use navigate for project/layout navigation
    if (nav.project && nav.layout) {
      navigate(`/projects/${nav.project}/layouts/${nav.layout}`);
    } else if (nav.project) {
      navigate(`/projects/${nav.project}`);
    } else if (nav.path) {
      navigate(nav.path);
    }
    dismissToast(toastId);
  };

  const activateNotification = (notification: Notification) => {
    if (notification.onNavigate) {
      notification.onNavigate();
      dismissToast(notification.id);
      return;
    }
    if (notification.metadata?.navigateTo != null) {
      handleNavigateTo(notification.metadata, notification.id);
    }
  };

  const handleAction = useCallback(
    (notificationId: string, actionId: string) => {
      fetch(`/api/notifications/${notificationId}/action/${actionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }).catch(() => undefined);
    },
    [],
  );

  const getSessionShortcut = (sessionId: string | undefined): string | null => {
    if (!sessionId) return null;
    const sessionIndex = Object.keys(activeChats).indexOf(sessionId);
    if (sessionIndex < 0 || sessionIndex >= 9) return null;
    const isMac = navigator.platform.toUpperCase().includes('MAC');
    return `${isMac ? '⌘' : 'Ctrl+'}${sessionIndex + 1}`;
  };

/**
 * archive#872 (archive#1971) put an empty state here and it was the wrong
* surface. This container is mounted unconditionally in `main.tsx` as the
* fixed-position toast overlay (z-index 1900) — it has no open/closed state,
* so "render something when empty" means a card pinned over the top-right of
* every page forever, with `pointer-events: auto` swallowing clicks on the
* chrome underneath it. The issue asked for an empty state on the surfaces a
* user *navigates to*, and both already have one: the header popover
* (`NotificationHistory`) renders its zero-notifications `Empty` card, and
* `/notifications` is a routed destination reachable at zero notifications.
* An overlay with nothing to show must render nothing.
*/
  if (activeNotifications.length === 0) return null;

  const approvalCountLabel = `${approvals.length} pending approval${approvals.length === 1 ? '' : 's'}`;

  return (
    <div className="notification-container" aria-live="polite">
      {approvals.length > 0 && (
        <div className="notification-approval-queue" ref={approvalQueueRef}>
          <button
            type="button"
            ref={approvalQueueTriggerRef}
            className="notification-approval-queue__trigger"
            aria-label={approvalCountLabel}
            aria-expanded={approvalQueueOpen}
            aria-controls="notification-approval-panel"
            onClick={() => {
              if (approvalQueueOpen) {
                closeApprovalQueue();
                return;
              }
              returnFocusRef.current = captureReturnFocus(
                approvalQueueTriggerRef.current,
              );
              setApprovalQueueOpen(true);
            }}
          >
            <span
              className="notification-approval-queue__pulse"
              aria-hidden="true"
            />
            <span>Approval needed</span>
            <span className="notification-approval-queue__count">
              {approvals.length}
            </span>
          </button>
          <section
            id="notification-approval-panel"
            data-testid="approval-queue-panel"
            className={`notification-approval-queue__panel${approvalQueueOpen ? ' is-open' : ''}`}
            aria-label="Pending approvals"
          >
            {approvals.map((notification) => (
              <ToastCard
                key={notification.id}
                notification={notification}
                dismissToast={dismissToast}
                getSessionShortcut={getSessionShortcut}
                handleNavigateTo={handleNavigateTo}
                handleAction={handleAction}
                clickable={false}
              />
            ))}
          </section>
        </div>
      )}

      {transientNotifications.length >= 3 && (
        <button
          type="button"
          className="notification-container__dismiss-all"
          onClick={() => {
            for (const notification of transientNotifications) {
              dismissToast(notification.id);
            }
          }}
        >
          Dismiss notifications ({transientNotifications.length})
        </button>
      )}

      {stackedTransients.length > 0 && (
        <div
          ref={toastStackRef}
          className="toast-stack"
          data-testid="toast-stack"
          data-count={stackedTransients.length}
          data-expanded={stackExpanded || undefined}
          onClickCapture={expandStackOnCoarseTap}
        >
          {stackedTransients.map((notification, index) => {
            const layout = stackLayout[index]!;
            const canNavigate =
              Boolean(notification.onNavigate) ||
              notification.metadata?.navigateTo != null;
            return (
              <div
                key={notification.id}
                className="toast-stack__item"
                data-depth={layout.depth}
                data-front={layout.depth === 0 ? 'true' : 'false'}
                style={
                  {
                    '--toast-stack-depth': layout.depth,
                    '--toast-stack-offset-y': `${layout.offsetY}px`,
                    '--toast-stack-scale': layout.scale,
                    '--toast-stack-z': layout.zIndex,
                  } as CSSProperties
                }
              >
                <ToastCard
                  notification={notification}
                  dismissToast={dismissToast}
                  getSessionShortcut={getSessionShortcut}
                  handleNavigateTo={handleNavigateTo}
                  clickable={canNavigate}
                  onActivate={
                    canNavigate
                      ? () => activateNotification(notification)
                      : undefined
                  }
                  collapsedContentHidden={layout.hideContentWhenCollapsed}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
