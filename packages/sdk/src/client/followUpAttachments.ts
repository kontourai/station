import { hasCapability } from './capability.js';
import { fetchPublicStationCapabilities } from './publicStationCapabilities.js';

/**
 * Whether the host holds a busy conversation's follow-up together with its
 * files (`followUpAttachments`). `false` also covers a handshake that could
 * not be read: a client then keeps such a draft until the turn ends, which is
 * what a host without the flag needs.
 */
export async function readFollowUpAttachmentsCapability(
  apiBase: string,
): Promise<boolean> {
  const handshake = await fetchPublicStationCapabilities(apiBase);
  return handshake ? hasCapability(handshake, 'followUpAttachments') : false;
}
