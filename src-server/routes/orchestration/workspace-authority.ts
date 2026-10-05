/**
 * Choosing a working folder takes the same authority as running commands
 * there. A session start that names a plain folder (`target.workspace`
 * `{ kind: 'directory' }`) starts an engine in that folder, so a paired
 * device needs what `POST /api/projects` needs to set a Project's folder:
 * `coding:exec` (`mayChooseWorkingDirectory`, security/coding-authority.ts).
 * A Project target is confined to that Project's folder and needs no more
 * than the route's own tier. Callers that are not paired devices keep their
 * own rules; a station-control tool call is confined by `scopeDispatch`.
 *
 * Every route that reads `target.workspace` from a request body calls this:
 * foreground send, engine handoff and task delegation.
 */
import type { Context } from 'hono';
import {
  pairedDeviceMayNotChooseDirectory,
  WORKING_DIRECTORY_NOT_GRANTED_CODE,
} from '../../security/coding-authority.js';
import { grantedPairingScope } from '../../security/pairing-route-scopes.js';

/** A 403 when `target` names a plain folder this device may not choose. */
export function refuseUngrantedDirectoryWorkspace(
  c: Context,
  target: { readonly workspace?: { readonly kind: string } },
): Response | undefined {
  if (target.workspace?.kind !== 'directory') return undefined;
  if (!pairedDeviceMayNotChooseDirectory(c.req.raw, grantedPairingScope(c)))
    return undefined;
  return c.json(
    {
      success: false,
      code: WORKING_DIRECTORY_NOT_GRANTED_CODE,
      error:
        "Only this Station's operator, or a device the operator allowed to run commands, can choose a working folder. Nothing was started.",
    },
    403,
  );
}
