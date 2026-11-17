/**
 * The reviewed vendor bindings, frozen. Adding a vendor is a reviewed change
 * here, in `REMOTE_TASK_VENDOR_IDS`, and in the managed-policy template.
 *
 * Considered and not bound: Factory's Sessions API, which its reference says
 * "is enabled for selected organizations only"
 * (https://docs.factory.com/api-reference/sessions.md).
 */
import type { RemoteTaskVendorId } from '@kontourai/station-contracts/remote-task-engine';
import type { RemoteTaskBinding } from '../binding.js';
import { cursorBinding } from './cursor.js';
import { devinBinding } from './devin.js';
import { githubCopilotBinding } from './github-copilot.js';

export const REMOTE_TASK_BINDINGS: Readonly<
  Record<RemoteTaskVendorId, RemoteTaskBinding>
> = Object.freeze({
  devin: devinBinding,
  'github-copilot': githubCopilotBinding,
  cursor: cursorBinding,
});
