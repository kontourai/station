import { type ReactNode, useRef } from 'react';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useSwipeActions } from '../../hooks/useSwipeActions';
import { formatNotificationTime } from '../../utils/notifications';
import { SNOOZE_ACTION_LABEL } from '../inbox-row/snooze-presets';
import { useSheetGesturesPreview } from '../useResponsiveSheetGesture';
import { type InboxMark, InboxMarkTile } from './inboxPresentation';
import { NoticeAction } from './NoticeAction';
import { RowMenu, type RowMenuItem } from './RowMenu';

export function NotificationHistoryRow({
  items,
  title,
  label,
  mark,
  updatedAt,
  primaryAction,
  onManagementStart,
  children,
}: {
  items: readonly RowMenuItem[];
  title: ReactNode;
  label: string;
  mark: InboxMark;
  updatedAt: string;
  primaryAction?: RowMenuItem;
  onManagementStart?: () => void;
  children: ReactNode;
}) {
  const mobile = useIsMobile();
  const menuHost = useRef<HTMLSpanElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const exit = useRef<Animation | null>(null);
  const snooze = items.find((item) => item.id.startsWith('snooze-'));
  const dismiss = items.find((item) => item.id === 'dismiss');
  const gestures = useSheetGesturesPreview();
  const enabled = mobile && gestures && Boolean(snooze || dismiss);
  const swipe = useSwipeActions(enabled, {
    actionWidth: snooze && dismiss ? 152 : 88,
    triggerSelector:
      '.notification-history__item-title, .notification-history__detail, .notification-history__meta',
  });
  const select = (item: RowMenuItem, trigger: HTMLButtonElement) => {
    if (exit.current) return;
    onManagementStart?.();
    swipe.close();
    const row = content.current;
    if (
      !row?.animate ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      item.onSelect(trigger);
      return;
    }
    const animation = row.animate(
      [
        { opacity: 1, clipPath: 'inset(0)', height: `${row.offsetHeight}px` },
        { opacity: 0, clipPath: 'inset(0 25% 100% 0)', height: '0px' },
      ],
      { duration: 180, easing: 'ease-in', fill: 'forwards' },
    );
    exit.current = animation;
    const reset = () => {
      animation.cancel();
      exit.current = null;
    };
    void animation.finished
      .then(() => {
        if (row.isConnected) return item.onSelect(trigger);
      })
      .then(reset, reset);
  };
  const menuItems = items.map((item) => ({
    ...item,
    onSelect: (trigger: HTMLButtonElement) => select(item, trigger),
  }));
  return (
    <div
      ref={swipe.ref}
      className="notification-history__row"
      data-swipe={enabled || undefined}
      style={swipe.style}
      onPointerDown={swipe.onPointerDown}
      onPointerMove={swipe.onPointerMove}
      onPointerUp={swipe.onPointerUp}
      onPointerCancel={swipe.onPointerCancel}
      onLostPointerCapture={swipe.onLostPointerCapture}
      onClickCapture={swipe.onClickCapture}
    >
      {enabled && (
        <div
          className="notification-history__swipe-actions"
          hidden={!swipe.actionsVisible}
          inert={!swipe.open}
        >
          {snooze && (
            <NoticeAction
              type="button"
              className="notification-history__action"
              disabled={snooze.disabled}
              onClick={() => {
                swipe.close();
                menuHost.current?.querySelector('button')?.click();
              }}
            >
              {SNOOZE_ACTION_LABEL}
            </NoticeAction>
          )}
          {dismiss && (
            <NoticeAction
              type="button"
              className="notification-history__action"
              disabled={dismiss.disabled}
              onClick={(event) => select(dismiss, event.currentTarget)}
            >
              {dismiss.label}
            </NoticeAction>
          )}
        </div>
      )}
      <div
        className="notification-history__row-content"
        data-dragging={swipe.dragging || undefined}
        ref={content}
      >
        <div className="notification-history__item">
          <InboxMarkTile mark={mark} />
          <div className="notification-history__item-content">
            <div className="notification-history__heading">
              <div className="notification-history__item-title">{title}</div>
              <span ref={menuHost}>
                <RowMenu items={menuItems} />
              </span>
              <div className="notification-history__meta">
                <span className="notification-history__eyebrow">{label}</span>
                <time
                  className="notification-history__time"
                  dateTime={updatedAt}
                >
                  {formatNotificationTime(updatedAt)}
                </time>
              </div>
            </div>
            {children}
            {primaryAction && (
              <div className="notification-history__footer-row">
                <NoticeAction
                  type="button"
                  className="notification-history__action"
                  disabled={primaryAction.disabled}
                  onClick={(event) =>
                    select(primaryAction, event.currentTarget)
                  }
                >
                  {primaryAction.label}
                </NoticeAction>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
