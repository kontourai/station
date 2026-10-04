import {
  type ForegroundMessageInput,
  type ForegroundMessageReceipt,
  sendExecutionMessageWithInventory,
} from './execution';
import type { ClientRequestOptions } from './http';
import { fetchSkillExperienceInventory } from './skill-experiences';

/**
 * Sends a foreground message, reading installed inventory first when it
 * carries a visual skill start. Kept apart from `./execution` so a bundle
 * that sends through `sendExecutionMessageWithInventory` from first paint
 * does not also pull the canonical validator into that chunk (#3209).
 */
export function sendExecutionMessage(
  apiBase: string,
  input: ForegroundMessageInput,
  opts?: ClientRequestOptions,
): Promise<ForegroundMessageReceipt> {
  return sendExecutionMessageWithInventory(
    apiBase,
    input,
    fetchSkillExperienceInventory,
    opts,
  );
}
