import type { Notification } from '@kontourai/station-contracts/notification';
import {
  useMarkPersonNotificationReadMutation,
  usePersonNotificationsQuery,
} from '@kontourai/station-sdk';
import { readNotificationEnvelope } from '@kontourai/station-shared/notification-envelope';
import type { ReactNode } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { navigationStore } from '../../contexts/navigation-store';
import { CLIENT_DOCUMENT_SESSION_ID } from '../../hooks/clientDocumentSession';
import { Button } from '../Button';
import { roomShortTime } from '../room/groupRows';
import { ErrorState } from '../state';
import './PersonMentionsSection.css';

/** What a person mention record is stored under (#4799). */
const ROOM_MENTION_CATEGORY = 'room-mention';

/** The same-origin path a record opens, or undefined. */
function targetPath(notification: Notification) {
  const target = readNotificationEnvelope(notification)?.target;
  return target?.kind === 'path' && target.path.startsWith('/projects/')
    ? target.path
    : undefined;
}

/**
 * "For you" (#4799): the reader's own mentions, from their private feed
 * (#4140's principal audience). Opening one marks it read and goes to the
 * exact message. Nothing renders until there is something to show; a failed
 * read says so with a retry, so it is never mistaken for "no mentions".
 */
export function PersonMentionsSection({
  empty,
  loading,
}: {
  /**
   * The page's "nothing here" state, shown only once the feed has answered
   * with no mentions, so it never stands beside an unread one.
   */
  empty?: ReactNode;
  /** Shown while the feed has not answered yet, in place of `empty`. */
  loading?: ReactNode;
} = {}) {
  const base = useHostRequestAuthorityScope();
  // A host scope is always current while this page shows it.
  const scope = base ?? {
    apiBase: '',
    authorityKey: '',
    isCurrent: () => false,
  };
  const feed = usePersonNotificationsQuery(scope);
  const markRead = useMarkPersonNotificationReadMutation(scope);
  // Without a host scope there is no feed to read: claim nothing.
  if (!base) return null;
  if (feed.isError)
    return (
      <section className="person-mentions" aria-labelledby="person-mentions">
        <h2 id="person-mentions" className="person-mentions__title">
          For you
        </h2>
        <ErrorState
          variant="compact"
          title="Your mentions could not be loaded."
          action={<Button onClick={() => void feed.refetch()}>Retry</Button>}
        />
      </section>
    );
  const mentions = (feed.data ?? []).filter(
    (item) =>
      item.category === ROOM_MENTION_CATEGORY &&
      item.status === 'delivered' &&
      !!targetPath(item),
  );
  if (!mentions.length)
    return feed.isSuccess ? (empty ?? null) : (loading ?? null);
  const open = (item: Notification) => {
    const path = targetPath(item);
    if (!path) return;
    void markRead
      .mutateAsync({ id: item.id, clientSessionId: CLIENT_DOCUMENT_SESSION_ID })
      .catch(() => {});
    navigationStore.navigate(path);
  };
  return (
    <section className="person-mentions" aria-labelledby="person-mentions">
      <h2 id="person-mentions" className="person-mentions__title">
        For you
      </h2>
      <ul className="person-mentions__list">
        {mentions.map((item) => {
          const unread = !readNotificationEnvelope(item)?.readAt;
          return (
            <li key={item.id}>
              <button
                type="button"
                className={`person-mentions__row${unread ? ' person-mentions__row--unread' : ''}`}
                onClick={() => open(item)}
              >
                <span className="person-mentions__mark" aria-hidden="true" />
                <span className="person-mentions__text">
                  <span className="person-mentions__headline">
                    {item.title}
                    {unread && <span className="sr-only">, unread</span>}
                  </span>
                  {item.body && (
                    <span className="person-mentions__excerpt">
                      {item.body}
                    </span>
                  )}
                </span>
                <time
                  className="person-mentions__time"
                  dateTime={item.createdAt}
                >
                  {roomShortTime(item.createdAt)}
                </time>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
