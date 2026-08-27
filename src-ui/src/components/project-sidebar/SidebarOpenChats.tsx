import type { HomeWorkItem } from '../../views/home/home-view-model';
import { InboxRow } from '../chat-dock/ChatDockInboxRows';

/**
 * kontourai/station#3314: the sidebar's "Open chats" mini-inbox rows — the
 * SAME shared row anatomy as the chat-dock inbox and the mobile task
 * switcher (`ChatDockInboxRows.tsx`), in its compact host variant. No third
 * bespoke row style. Lazy-loaded by `ProjectSidebar` so the shared row
 * module (and its stylesheet) stays out of the entry chunk the sidebar
 * belongs to.
 *
 * No snooze/close actions here: this list comes straight from the
 * open-chats store, which snoozing does not filter — a control whose effect
 * is invisible where it is offered would be chrome, not a feature.
 */
export function SidebarOpenChats({
  items,
  now,
  onActivate,
}: {
  items: HomeWorkItem[];
  now: number;
  onActivate: (item: HomeWorkItem) => void;
}) {
  return (
    <>
      {items.map((item) => (
        <InboxRow
          key={item.id}
          item={item}
          isCurrent={false}
          isSnoozed={false}
          isOpenChat={false}
          now={now}
          onActivate={onActivate}
        />
      ))}
    </>
  );
}
