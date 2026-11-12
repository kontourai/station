import { readFollowUpAttachmentsCapability } from '@kontourai/station-sdk/client';
import { useQuery } from '@tanstack/react-query';

/**
 * Whether a follow-up sent with files during a running turn can be queued on
 * this Station (`followUpAttachments`). Only the connected host holds one: a
 * route to another Station sends the draft after the turn, as before. False
 * until the handshake answers, so the composer never offers what the host
 * would refuse. `needed` keeps the read off until a running turn's draft
 * holds files, the only time the answer changes anything.
 */
export function useFollowUpAttachmentsSupport(
  apiBase: string | undefined,
  hostRoute: boolean,
  needed: boolean,
): boolean {
  const query = useQuery({
    queryKey: ['follow-up-attachments-capability', apiBase],
    queryFn: () => readFollowUpAttachmentsCapability(apiBase!),
    enabled: Boolean(apiBase) && hostRoute && needed,
    staleTime: 5 * 60_000,
    retry: false,
  });
  return hostRoute && query.data === true;
}
