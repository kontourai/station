import { activityDeepLink } from '@kontourai/station-contracts/surface-deep-link';
import type { MouseEvent, ReactNode } from 'react';
import { navigationStore } from '../../../contexts/navigation-store';
import { openChatsStore } from '../../../contexts/open-chats-store';

/**
 * A link to another Session, in the transcript's own words. It is a real
 * anchor (copyable, openable in a new tab) whose plain click opens the Session:
 * in the dock when it is already an open chat, else in Activity through the
 * canonical deep link (`/?surface=activity&session=<id>`), which reads any
 * Session Station knows.
 *
 * It goes to the Session, not to a message in it: the exact message or call
 * needs the read-at-message anchor of #3413.
 */
export function AgentSessionLink({
  sessionId,
  className,
  label,
  children,
}: {
  sessionId: string;
  className?: string;
  /** What the link says it opens, for a screen reader. */
  label: string;
  children: ReactNode;
}) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    // Let the browser keep new-tab and download gestures.
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    const isOpenChat = Object.entries(openChatsStore.getSnapshot()).some(
      ([id, chat]) => id === sessionId || chat.conversationId === sessionId,
    );
    if (isOpenChat) openChatsStore.focus({ sessionId });
    else navigationStore.navigate(activityDeepLink({ sessionId }));
  };
  return (
    <a
      className={className}
      href={activityDeepLink({ sessionId })}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </a>
  );
}
