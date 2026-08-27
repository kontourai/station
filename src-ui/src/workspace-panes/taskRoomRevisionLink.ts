import type {
  ProjectTaskRoomBrowserLink,
  ProjectTaskRoomBrowserRecord,
} from '@kontourai/station-contracts/project-task-room-browser';

/** UI seam for #3546; resolution remains unavailable until its durable store lands. */
export type TaskRoomRevisionLink =
  | { readonly state: 'available'; readonly link: ProjectTaskRoomBrowserLink }
  | { readonly state: 'unavailable'; readonly reason: string };

export function taskRoomRevisionLink(
  record: ProjectTaskRoomBrowserRecord,
  revisionLinksAvailable: boolean,
): TaskRoomRevisionLink {
  const revision =
    record.body.kind === 'live-work-finished'
      ? record.body.revision
      : record.body.kind === 'outcome-link' &&
          record.body.link.kind === 'revision'
        ? record.body.link
        : undefined;
  if (!revisionLinksAvailable)
    return {
      state: 'unavailable',
      reason:
        'Revision evidence will be available after durable resolution is installed.',
    };
  if (revision?.kind !== 'revision')
    return {
      state: 'unavailable',
      reason: 'This update has no revision evidence.',
    };
  return { state: 'available', link: revision };
}
