import {
  type ForegroundMessageInput,
  type KeyedForegroundMessageReceipt,
  sendExecutionMessageWithInventory,
} from './execution';
import type { ClientRequestOptions } from './http';
import { fetchSkillExperienceInventory } from './skill-experiences';

/**
 * Sends a foreground message, reading installed inventory first when it
 * carries a visual skill start. Kept apart from `./execution` so a bundle
 * that needs only the other execution calls does not also carry the
 * canonical validator (#3209).
 */
export function sendExecutionMessage(
  apiBase: string,
  input: ForegroundMessageInput,
  opts?: ClientRequestOptions,
): Promise<KeyedForegroundMessageReceipt> {
  return sendExecutionMessageWithInventory(
    apiBase,
    input,
    fetchSkillExperienceInventory,
    opts,
  );
}
