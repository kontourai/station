import { activityDeepLink } from '@kontourai/station-contracts/surface-deep-link';
import type { MouseEvent, ReactNode } from 'react';
import { navigationStore } from '../../../contexts/navigation-store';
import { openChatsStore } from '../../../contexts/open-chats-store';

/** A copyable Session link. Chat reads records and retains bounded exact-message anchors. */
export function AgentSessionLink({
  sessionId,
  requestKey,
  direction,
  className,
  label,
  children,
}: {
  sessionId: string;
  requestKey?: string;
  direction?: 'sent' | 'received';
  className?: string;
  /** What the link says it opens, for a screen reader. */
  label: string;
  children: ReactNode;
}) {
  const messageAnchor =
    requestKey && direction ? { direction, requestKey } : undefined;
  const href = activityDeepLink({
    sessionId,
    ...(messageAnchor ? { messageAnchor } : {}),
  });
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
    if (isOpenChat && !messageAnchor) openChatsStore.focus({ sessionId });
    else navigationStore.navigate(href);
  };
  return (
    <a className={className} href={href} aria-label={label} onClick={onClick}>
      {children}
    </a>
  );
}
