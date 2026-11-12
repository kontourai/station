import { readProjectRoomMessageActionsCapability } from '@kontourai/station-sdk/project-rooms';
import { useQuery } from '@tanstack/react-query';

/**
 * Whether this room's host takes reactions, edits, deletes and files on its
 * messages (`projectRoomMessageActions`). False until the handshake answers,
 * so a room never offers an action its host would answer 404.
 */
export function useProjectRoomMessageActions(apiBase: string): boolean {
  const query = useQuery({
    queryKey: ['project-room-message-actions-capability', apiBase],
    queryFn: () => readProjectRoomMessageActionsCapability(apiBase),
    staleTime: 5 * 60_000,
    retry: false,
  });
  return query.data === true;
}
