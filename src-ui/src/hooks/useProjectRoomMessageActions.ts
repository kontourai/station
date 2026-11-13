import { readProjectRoomMessageActionsCapability } from '@kontourai/station-sdk/project-rooms';
import { useQuery } from '@tanstack/react-query';

/**
 * Whether this room's host takes reactions, edits, deletes and files on its
 * messages (`projectRoomMessageActions`). False until the handshake answers,
 * so a room never offers an action its host would answer 404.
 *
 * Asked only once a room is open (`enabled`): a missing or unavailable room
 * has no actions to offer, so it reads nothing. The handshake itself is the
 * public, member-safe one: a native member device may read it without
 * account material (`nativeDeviceOnlyObservationRoute`).
 */
export function useProjectRoomMessageActions(
  apiBase: string,
  enabled: boolean,
): boolean {
  const query = useQuery({
    queryKey: ['project-room-message-actions-capability', apiBase],
    enabled,
    queryFn: () => readProjectRoomMessageActionsCapability(apiBase),
    staleTime: 5 * 60_000,
    retry: false,
  });
  return query.data === true;
}
