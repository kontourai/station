import { isProjectRoomUuid } from '@kontourai/station-contracts/project-room';

export type ProjectDestination = 'overview' | 'room' | 'tasks' | 'sources';

/** Existing Starter Work links must still open their task creation handoff. */
export function projectDestination(search: string): ProjectDestination {
  const params = new URLSearchParams(search);
  const destination = params.get('section');
  if (
    destination === 'room' ||
    destination === 'tasks' ||
    destination === 'sources'
  ) {
    return destination;
  }
  if (!destination && params.get('starter') === 'start-task') return 'tasks';
  return 'overview';
}

/**
 * Where in the Project's room the route points (#4795): a channel (absent is
 * the default channel) and an open thread's root message. Anything that is
 * not a room id is ignored, so a mangled link opens `#general`.
 */
export function projectRoomAddress(search: string): {
  channelId: string | undefined;
  threadId: string | undefined;
} {
  const params = new URLSearchParams(search);
  const channel = params.get('channel');
  const thread = params.get('thread');
  return {
    channelId: isProjectRoomUuid(channel) ? channel : undefined,
    threadId: isProjectRoomUuid(thread) ? thread : undefined,
  };
}
