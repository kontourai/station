/**
 * Choosing a working folder takes the same authority as running commands
 * there. A request that names a folder an engine session will run in, or a
 * folder a Project will be bound to, needs what `POST /api/projects` needs to
 * set a Project's folder: the operator in person, or a device holding
 * `coding:exec` (`mayChooseWorkingDirectory`, security/coding-authority.ts).
 * A Project target is confined to that Project's folder and needs no more
 * than the route's own tier. A station-control tool call is confined by
 * `scopeDispatch` and Station's own server code is not decided here.
 *
 * The routes that call this, and nothing is claimed beyond them:
 * - session starts that name a plain folder: `POST /api/orchestration/chat`
 *   (and `/chat/delegated`, `/chat/background`), `/conversations/:id/handoff`
 *   and `/delegations`;
 * - `POST /api/tasks/:taskId/dispatch` and `POST /api/starter-work/launch`
 *   (`start-task`) with a `runtimeConfig.cwd` other than the Task Project's
 *   own folder;
 * - `POST /api/projects/attach` with a `workingDirectory` and `PUT
 *   /api/projects/:slug/identity/execution-root` with a path.
 */
import { resolve } from 'node:path';
import type { Context } from 'hono';
import {
  refusesWorkingDirectoryChoice,
  WORKING_DIRECTORY_NOT_GRANTED_CODE,
} from '../security/coding-authority.js';
import { grantedPairingScope } from '../security/pairing-route-scopes.js';
import { expandTilde } from '../utils/paths.js';

/**
 * A 403 when this request may not choose a folder. `outcome` names what did
 * not happen, for the caller's wording.
 */
export function refuseUngrantedWorkingDirectory(
  c: Context,
  outcome: 'started' | 'saved' = 'started',
): Response | undefined {
  if (!refusesWorkingDirectoryChoice(c.req.raw, grantedPairingScope(c)))
    return undefined;
  return c.json(
    {
      success: false,
      code: WORKING_DIRECTORY_NOT_GRANTED_CODE,
      error:
        `Only this Station's operator, or a device the operator allowed to run commands (the coding:exec grant), can choose a working folder. Nothing was ${outcome}.` +
        (outcome === 'started'
          ? " A Project's folder needs no grant: name a Project instead (--project)."
          : ''),
    },
    403,
  );
}

/** A 403 when `target` names a plain folder this caller may not choose. */
export function refuseUngrantedDirectoryWorkspace(
  c: Context,
  target: { readonly workspace?: { readonly kind: string } },
): Response | undefined {
  if (target.workspace?.kind !== 'directory') return undefined;
  return refuseUngrantedWorkingDirectory(c);
}

/**
 * A dispatch's `runtimeConfig.cwd`. The Task Project's own folder was chosen
 * when the Project was set up, under this same rule, so naming it is not a
 * choice (the Project page sends it); any other folder is.
 */
export function refuseUngrantedRuntimeCwd(
  c: Context,
  cwd: unknown,
  projectFolder: string | undefined,
): Response | undefined {
  if (typeof cwd !== 'string' || !cwd.trim()) return undefined;
  if (
    projectFolder !== undefined &&
    projectFolder.trim() !== '' &&
    resolve(expandTilde(cwd.trim())) ===
      resolve(expandTilde(projectFolder.trim()))
  )
    return undefined;
  return refuseUngrantedWorkingDirectory(c);
}
