import { readFollowUpAttachmentsCapability } from '@kontourai/station-sdk/client';
import { useQuery } from '@tanstack/react-query';

/**
 * Whether a follow-up sent with files during a running turn can be queued on
 * this Station (`followUpAttachments`). Only the connected host holds one: a
 * route to another Station sends the draft after the turn, as before. False
 * until the handshake answers, so the composer never offers what the host
 * would refuse.
 */
export function useFollowUpAttachmentsSupport(
  apiBase: string | undefined,
  hostRoute: boolean,
): boolean {
  const query = useQuery({
    queryKey: ['follow-up-attachments-capability', apiBase],
    queryFn: () => readFollowUpAttachmentsCapability(apiBase!),
    enabled: Boolean(apiBase) && hostRoute,
    staleTime: 5 * 60_000,
    retry: false,
  });
  return hostRoute && query.data === true;
}
