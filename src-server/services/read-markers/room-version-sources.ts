import type { ProjectRoomBrowserView } from '@kontourai/station-contracts/project-room-browser';
import type { ProjectTaskRoomReadOutcome } from '@kontourai/station-contracts/project-task-room';
import { FileStorageNotFoundError } from '../../domain/project-file-transactions.js';
import { InvalidPathSegmentError } from '../../knowledge-index/path-safety.js';
import { ProjectMembershipRefusal } from '../projects/project-membership-store.js';
import { ProjectRoomRefusal } from '../projects/project-room-store.js';
import type { RoomVersion, RoomVersionSource } from './read-marker-service.js';

/**
 * Project room versions for read markers (#3075), read through the room
 * service's own `view` admission. The marker is keyed by the room id the
 * store already assigns. Each named channel is its own room (#4792), so the
 * room id is addressed as a channel; `#general`'s id addresses the default
 * room. A `roomId` that is not one of this Project's channels reads as
 * unavailable, exactly like a Project the caller cannot see.
 */
export function projectRoomVersionSource(rooms: {
  discover(
    request: Request,
    slug: string,
    channelId?: string,
  ): Promise<{ data: Pick<ProjectRoomBrowserView, 'roomId' | 'checkpoint'> }>;
}): RoomVersionSource<{ projectSlug: string; roomId: string }> {
  return {
    async latest({ projectSlug, roomId }, request) {
      try {
        const { data } = await rooms.discover(request, projectSlug, roomId);
        if (data.roomId !== roomId) return undefined;
        return {
          key: `project-room:${data.roomId}`,
          latestVersion: data.checkpoint.lastSeq,
        };
      } catch (error) {
        // The same answer for "no such Project", "not this Project's room"
        // and "not yours", so a summary is never an existence oracle. Any
        // other failure is not a refusal and propagates.
        if (
          error instanceof ProjectRoomRefusal ||
          error instanceof ProjectMembershipRefusal ||
          error instanceof FileStorageNotFoundError ||
          error instanceof InvalidPathSegmentError
        )
          return undefined;
        throw error;
      }
    },
  };
}

/**
 * Task room versions for read markers (#3075), read through the runtime's
 * own `history-read` grant with a one-record page: only the checkpoint is
 * used. Keyed by the room's channel and epoch, so a re-homed room (a new
 * epoch, whose sequence restarts) starts a fresh marker rather than
 * inheriting one from a sequence it no longer has. A room that has never
 * been opened is unavailable; reading markers never opens one.
 */
export function taskRoomVersionSource(runtime: {
  history(input: {
    taskId: string;
    request: Request;
    limit?: number;
  }): Promise<
    ProjectTaskRoomReadOutcome | { readonly kind: 'not-found' | 'unavailable' }
  >;
}): RoomVersionSource<{ taskId: string }> {
  return {
    async latest({ taskId }, request): Promise<RoomVersion | undefined> {
      const result = await runtime.history({ taskId, request, limit: 1 });
      const checkpoint =
        result.kind === 'available' || result.kind === 'gap'
          ? result.checkpoint
          : result.kind === 'stale'
            ? result.checkpoint
            : undefined;
      if (!checkpoint) return undefined;
      return {
        key: `task-room:${checkpoint.channelId}:${checkpoint.epoch}`,
        latestVersion: checkpoint.throughSeq,
      };
    },
  };
}
