import { hasCapability } from './capability.js';
import { fetchPublicStationCapabilities } from './publicStationCapabilities.js';

/**
 * Whether this Station can continue a conversation on a paired Station
 * (`conversationStationHandoff`). `false` also covers a handshake that could
 * not be read: a client then offers only this Station's Agents. The paired
 * Station's own support is checked by this Station when it sends.
 */
export async function readConversationStationHandoffCapability(
  apiBase: string,
): Promise<boolean> {
  const handshake = await fetchPublicStationCapabilities(apiBase);
  return handshake
    ? hasCapability(handshake, 'conversationStationHandoff')
    : false;
}
