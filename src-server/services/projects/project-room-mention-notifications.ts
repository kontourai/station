import { createHash } from 'node:crypto';
import type { NotificationEnvelopeV1 } from '@kontourai/station-contracts/notification';
import { principalIdMatchesKind } from '@kontourai/station-contracts/principal';
import type { NotificationService } from '../notifications/notification-service.js';
import type { ProjectRoomMentionEvent } from './project-room-service.js';

/** Source and dedupe namespace of a Project-room mention (#4799). */
const PROJECT_ROOM_MENTION_SOURCE = 'project-room';
/** Longest excerpt of the message a notification carries. */
const EXCERPT_LENGTH = 140;

/**
 * Where a mention opens: the Project's room, at the channel, scrolled to the
 * message. The query names the same `section`/`channel` the room's own
 * navigation writes, plus the message to bring into view.
 */
function projectRoomMessagePath(
  slug: string,
  channelId: string | undefined,
  messageId: string,
) {
  const query = new URLSearchParams({ section: 'room' });
  if (channelId) query.set('channel', channelId);
  query.set('message', messageId);
  return `/projects/${encodeURIComponent(slug)}?${query.toString()}`;
}

/**
 * One notification per newly named person, in their private feed only
 * (#4799, reusing #4140's principal audience). The notification service
 * re-checks that person's membership of the Project at delivery, so someone
 * who lost access before it lands is not told. A repeated send of the same
 * message updates its one record rather than adding another.
 */
export async function notifyProjectRoomMention(
  notificationService: Pick<NotificationService, 'scheduleEnveloped'>,
  event: ProjectRoomMentionEvent,
) {
  const where = event.channelName
    ? `#${event.channelName}`
    : 'the Project room';
  const excerpt =
    event.message.text.length > EXCERPT_LENGTH
      ? `${event.message.text.slice(0, EXCERPT_LENGTH - 1)}…`
      : event.message.text;
  const path = projectRoomMessagePath(
    event.slug,
    event.channelId,
    event.message.messageId,
  );
  for (const principalId of event.recipients) {
    // The principal audience addresses people only.
    if (!principalIdMatchesKind(principalId, 'human')) continue;
    const envelope: NotificationEnvelopeV1 = {
      v: 1,
      source: { kind: 'system', subsystem: PROJECT_ROOM_MENTION_SOURCE },
      audience: {
        kind: 'principal',
        principalId,
        projectId: event.scope.localProjectId,
      },
      urgency: 'attention',
      target: { kind: 'path', path },
      interrupt: 'default',
    };
    await notificationService.scheduleEnveloped(
      PROJECT_ROOM_MENTION_SOURCE,
      {
        category: 'room-mention',
        title: `${event.message.actor.displayName} mentioned you in ${where}`,
        body: excerpt,
        // One record per message and person; a tag holds neither id raw
        // (a principal id is longer than a tag and has other characters).
        dedupeTag: `${PROJECT_ROOM_MENTION_SOURCE}:${createHash('sha256')
          .update(JSON.stringify([event.message.messageId, principalId]))
          .digest('hex')
          .slice(0, 40)}`,
        metadata: {
          projectSlug: event.slug,
          roomId: event.message.roomId,
          messageId: event.message.messageId,
        },
      },
      envelope,
    );
  }
}
