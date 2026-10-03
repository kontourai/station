/**
 * #2377 slice C2a: dispatch is scoped at the dispatch ROUTE, the top of the
 * dispatch hop (the constraint recorded on the issue). A route handler runs
 * its later hops (SSH connect, a peer credential, Agent and Connection
 * reads) as Station's own server code, which the central guard lets through
 * whoever triggered the dispatch; so the scope is decided here, after the
 * route knows what the request aims at and before anything runs.
 *
 * Only a station-control tool call with a verified caller is decided: the
 * operator's UI, paired devices and Station's own server code keep their
 * own rules, and a caller-less internal request never reaches a dispatch
 * route (the guard refuses it). The rule is the one C1's steer and adopt
 * use (`stationControlScopeRefusal`).
 */
import type { Context } from 'hono';
import type {
  StationControlDispatchScope,
  StationControlDispatchTargetRef,
  StationControlProjectAction,
} from '../../runtime/mcp/station-control-dispatch-scope.js';
import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
import {
  stationControlRefusalBody,
  stationControlScopeRefusal,
} from '../../tools/station-control-policy.js';

/** A reference to what the request aims at, given the caller's owner. */
export type DispatchTargetFor = (
  ownerId: string | undefined,
) => StationControlDispatchTargetRef | undefined;

/**
 * The scope decision for one request: `refused` with the typed 403 when a
 * station-control caller aims outside its scope. Otherwise, for a caller
 * whose new session names a folder, `canonicalCwd` is the canonical path the
 * check decided on; the route dispatches that resolved path rather than the
 * original alias, and the session records it.
 *
 * Missing scope refuses non-operator callers. A bound operator remains subject
 * to the route's ordinary authorization. Non-station-control requests are not
 * decided here.
 */
export function scopeDispatch(
  c: Context,
  scope: StationControlDispatchScope | undefined,
  targetFor: DispatchTargetFor,
  /** The Project action the owner needs. */
  action: StationControlProjectAction = 'execute',
): { readonly refused: Response } | { readonly canonicalCwd?: string } {
  const authority = stationControlRequestAuthority(c.req.raw);
  if (authority?.kind !== 'caller') return {};
  const caller = authority.caller;
  const ref = targetFor(
    caller.principal?.elevationEligible ? caller.principal.id : undefined,
  );
  const target = ref ? scope?.target(ref, action) : undefined;
  const refusal = stationControlScopeRefusal(caller, target);
  if (refusal)
    return { refused: c.json(stationControlRefusalBody(refusal), 403) };
  return target?.canonicalCwd !== undefined
    ? { canonicalCwd: target.canonicalCwd }
    : {};
}

/** {@link scopeDispatch} where the route has no folder to dispatch. */
export function refuseOutOfScopeDispatch(
  c: Context,
  scope: StationControlDispatchScope | undefined,
  targetFor: DispatchTargetFor,
  action: StationControlProjectAction = 'execute',
): Response | undefined {
  const decided = scopeDispatch(c, scope, targetFor, action);
  return 'refused' in decided ? decided.refused : undefined;
}

/**
 * #2377 slice C2a (decision 3): another Station needs a bound operator. For
 * the routes that read or steer a task on a saved Environment
 * (`environmentId`), the same verdict the scope rule gives a remote target,
 * before the route resolves the Environment as Station's own server code.
 */
export function refuseRemoteForStationControlCaller(
  c: Context,
  remote: boolean,
): Response | undefined {
  if (!remote) return undefined;
  const authority = stationControlRequestAuthority(c.req.raw);
  if (authority?.kind !== 'caller') return undefined;
  const caller = authority.caller;
  const refusal = stationControlScopeRefusal(caller, {
    ...(caller.principal?.elevationEligible
      ? { ownerId: caller.principal.id }
      : {}),
    scope: { kind: 'global' },
    host: false,
    remote: true,
  });
  return refusal ? c.json(stationControlRefusalBody(refusal), 403) : undefined;
}

/**
 * The workspace a station-control caller dispatches: its `cwd` replaced by
 * the canonical path the scope check decided on, when there is one.
 */
export function withCanonicalCwd<
  T extends { readonly workspace?: { readonly kind: string } },
>(target: T, canonicalCwd: string | undefined): T {
  const workspace = target.workspace;
  if (
    canonicalCwd === undefined ||
    !workspace ||
    (workspace.kind !== 'directory' && workspace.kind !== 'project')
  )
    return target;
  return { ...target, workspace: { ...workspace, cwd: canonicalCwd } };
}

/** Whether an environment reference names another Station. */
export function namesAnotherStation(
  environment: { readonly kind: string } | undefined,
): boolean {
  return environment !== undefined && environment.kind !== 'current';
}

/**
 * What a foreground send (`/chat` and its siblings) aims at: an input reply
 * names its thread; a conversation that already has a session is a
 * follow-up; anything else starts a session, owned by the caller's owner,
 * in the Project the body names.
 */
export function foregroundDispatchTarget(
  scope: StationControlDispatchScope | undefined,
  send: {
    readonly ownerId: string | undefined;
    readonly projectSlug?: string;
    /** A plain-folder target's `cwd`. */
    readonly directory?: string;
    readonly conversationId?: string;
    readonly inputReplyThreadId?: string;
    readonly remote: boolean;
  },
): StationControlDispatchTargetRef | undefined {
  const { remote } = send;
  if (send.inputReplyThreadId !== undefined)
    return { kind: 'thread', threadId: send.inputReplyThreadId, remote };
  if (
    send.conversationId !== undefined &&
    scope?.conversationExists(send.conversationId) !== false
  )
    return {
      kind: 'conversation',
      conversationId: send.conversationId,
      remote,
    };
  if (send.ownerId === undefined) return undefined;
  return {
    kind: 'new',
    ownerId: send.ownerId,
    ...(send.projectSlug !== undefined
      ? { projectSlug: send.projectSlug }
      : {}),
    ...(send.directory !== undefined ? { directory: send.directory } : {}),
    remote,
  };
}

/**
 * What a dispatch body says about the session it would start: the Project
 * it names, the folder it names (a plain folder's, or a Project
 * workspace's `cwd`), and whether it lands on another Station (a saved
 * Environment, a portable Project, or the named Project's default
 * Environment).
 */
export function newSessionFacts(
  target: {
    readonly environment?: { readonly kind: string };
    readonly workspace?: {
      readonly kind: string;
      readonly projectSlug?: string;
      readonly cwd?: string;
    };
  },
  projectDefaultEnvironment?: (
    projectSlug: string,
  ) => { readonly kind: string } | undefined,
): { projectSlug?: string; directory?: string; remote: boolean } {
  const workspace = target.workspace;
  const projectSlug =
    workspace?.kind === 'project' ? workspace.projectSlug : undefined;
  const directory =
    workspace?.kind === 'directory' || workspace?.kind === 'project'
      ? workspace.cwd
      : undefined;
  const defaultEnvironment =
    !target.environment && projectSlug !== undefined
      ? projectDefaultEnvironment?.(projectSlug)
      : undefined;
  return {
    ...(projectSlug !== undefined ? { projectSlug } : {}),
    ...(directory !== undefined ? { directory } : {}),
    remote:
      namesAnotherStation(target.environment) ||
      namesAnotherStation(defaultEnvironment) ||
      workspace?.kind === 'project-portable' ||
      workspace?.kind === 'project-portable-prepared',
  };
}
