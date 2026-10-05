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
import { isDeepStrictEqual } from 'node:util';
import type { Context, MiddlewareHandler } from 'hono';
import {
  COMMAND_NOT_GRANTED_CODE,
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
  // Compared exactly as dispatched: the value is not trimmed here, because
  // the dispatch does not trim it, so " <folder>" is a different folder.
  if (typeof cwd !== 'string' || cwd === '') return undefined;
  if (
    projectFolder !== undefined &&
    projectFolder !== '' &&
    resolve(expandTilde(cwd)) === resolve(expandTilde(projectFolder))
  )
    return undefined;
  return refuseUngrantedWorkingDirectory(c);
}

/**
 * A 403 when this request may not choose a command Station will run. The same
 * decision as for a folder ({@link refusesWorkingDirectoryChoice}); only the
 * code and wording differ. Nothing has been saved or run when it answers.
 */
export function refuseUngrantedCommandChoice(c: Context): Response | undefined {
  if (!refusesWorkingDirectoryChoice(c.req.raw, grantedPairingScope(c)))
    return undefined;
  return c.json(
    {
      success: false,
      code: COMMAND_NOT_GRANTED_CODE,
      error:
        "Only this Station's operator, or a device the operator allowed to run commands (the coding:exec grant), can choose a command for Station to run. Nothing was saved.",
    },
    403,
  );
}

/** An empty value is the same as an absent one: `[]`, `''`, `null`. */
function normalized(value: unknown): unknown {
  if (value === null || value === '') return undefined;
  if (Array.isArray(value) && value.length === 0) return undefined;
  return value;
}

/**
 * Whether `body` sets any of `keys` to a value other than `current`'s. An
 * empty value (`[]`, `''`, `null`) and an absent one are the same.
 */
export function changesAny(
  body: object,
  current: object | undefined,
  keys: readonly string[],
): boolean {
  return keys.some(
    (key) =>
      Object.hasOwn(body, key) &&
      !isDeepStrictEqual(
        normalized(Reflect.get(body, key)),
        normalized(
          current === undefined ? undefined : Reflect.get(current, key),
        ),
      ),
  );
}

/** Whether `body` submits any value for any of the named map fields. */
export function submitsAnyEntry(
  body: object,
  keys: readonly string[],
): boolean {
  return keys.some((key) => {
    const value = Reflect.get(body, key);
    return (
      typeof value === 'object' &&
      value !== null &&
      Object.keys(value).length > 0
    );
  });
}

/**
 * {@link refuseUngrantedCommandChoice} as route middleware, for a route that
 * fetches or runs code (a plugin install or update): registered after the
 * route's own person check, ahead of body validation.
 */
export const commandChoiceOnly: MiddlewareHandler = async (c, next) => {
  const refused = refuseUngrantedCommandChoice(c);
  if (refused) return refused;
  await next();
};
