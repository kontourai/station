/**
 * #2377 slices C1 and C2a: what the server's own records say about the
 * session a station-control call aims at — a steer, an adoption, a new
 * dispatch, a follow-up, an answer to a worker's request — for the ONE scope
 * rule (`stationControlScopeRefusal`, `tools/station-control-policy.ts`).
 *
 * Every fact comes from a record Station wrote itself, never from the
 * request: the session's recorded owner (the `metadata.userId` its start
 * stamped, the same owner every session read and command compares against),
 * its session-record Project (the same resolver the caller's own session is
 * read through), and whether any session of its conversation runs `host`.
 */
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  type StationControlDispatchTarget,
  type StationControlScope,
  stationControlSessionScope,
} from '../../tools/station-control-policy.js';
import { expandTilde } from '../../utils/paths.js';
import type { StationControlCallerRecordResolver } from './station-control-caller.js';

/** The Project action a scoped call needs from the session's owner. */
export type StationControlProjectAction = 'execute' | 'approve';

export interface StationControlDispatchScopeSources {
  /** Owner and Project records of a session (the caller resolver's reader). */
  readonly resolveRecord: StationControlCallerRecordResolver;
  /** The owner a session's start recorded (`metadata.userId`). */
  sessionOwnerId(threadId: string): string | undefined;
  /** Whether Station has a start record for this session at all. */
  sessionExists(threadId: string): boolean;
  /** Start stamp `host` or a recorded `never`, as its next turn reads it. */
  sessionRunsHost(threadId: string): boolean;
  /** Every session of the thread's conversation (the thread itself at least). */
  conversationThreads(threadId: string): readonly string[];
  /** The conversation's current session (the conversation id when none). */
  currentConversationSessionId(conversationId: string): string;
  /** `ProjectConfig.id` for a slug; `undefined` or a throw when none. */
  projectIdForSlug(slug: string): string | undefined;
  /** Every Project with its working directory, for a folder's scope. */
  projectDirectories(): readonly {
    readonly id: string;
    readonly workingDirectory?: string;
  }[];
  /** The working directory Station recorded for a session, if any. */
  sessionCwd(threadId: string): string | undefined;
  /** Whether `ownerId` holds `action` in the Project `localProjectId`. */
  ownerMay(
    ownerId: string,
    localProjectId: string,
    action: StationControlProjectAction,
  ): boolean;
}

/** What a scoped call names. */
export type StationControlDispatchTargetRef =
  /** A new session, owned by `ownerId`, in the Project the body names. */
  | {
      readonly kind: 'new';
      readonly ownerId: string;
      readonly projectSlug?: string;
      /** A plain-folder target's `cwd`: its scope is the folder's Project. */
      readonly directory?: string;
      readonly remote: boolean;
    }
  | {
      readonly kind: 'thread';
      readonly threadId: string;
      readonly remote: boolean;
    }
  | {
      readonly kind: 'conversation';
      readonly conversationId: string;
      readonly remote: boolean;
    }
  | {
      readonly kind: 'task';
      readonly taskId: string;
      readonly remote: boolean;
    };

export interface StationControlDispatchScope {
  /**
   * The target a reference names, checked for `action` in its Project;
   * `undefined` when Station cannot read it (which refuses).
   */
  target(
    ref: StationControlDispatchTargetRef,
    action?: StationControlProjectAction,
  ): StationControlDispatchTarget | undefined;
  /** Whether a conversation already has a session (a follow-up, not a start). */
  conversationExists(conversationId: string): boolean;
}

/**
 * #2377 slice C2a (owner decision: a global agent never reaches into a
 * Project implicitly): the scope of a folder is the Project whose working
 * directory contains it, the deepest when Projects nest, else `global`.
 *
 * Paths are compared canonically (`realpath`: symlinks resolved, trailing
 * separators gone) and by whole path segments, so `/a/proj-2` is not inside
 * `/a/proj`. A folder that cannot be resolved is `unreadable`, which
 * refuses. A Project whose own directory cannot be resolved contains no
 * folder that can: a resolved folder's canonical path exists, and any path
 * inside a directory resolves only if that directory does.
 */
export function stationControlDirectoryScope(
  cwd: string,
  projects: readonly {
    readonly id: string;
    readonly workingDirectory?: string;
  }[],
): StationControlScope {
  const canonical = (path: string): string =>
    realpathSync.native(resolve(expandTilde(path)));
  const within = (root: string, candidate: string): boolean => {
    const rel = relative(root, candidate);
    return (
      rel === '' ||
      (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
    );
  };
  let folder: string;
  try {
    folder = canonical(cwd);
  } catch {
    return { kind: 'unreadable' };
  }
  let deepest: { id: string; root: string } | undefined;
  for (const project of projects) {
    if (!project.workingDirectory) continue;
    let root: string;
    try {
      root = canonical(project.workingDirectory);
    } catch {
      continue;
    }
    if (within(root, folder) && (!deepest || root.length > deepest.root.length))
      deepest = { id: project.id, root };
  }
  return deepest ? { kind: 'project', id: deepest.id } : { kind: 'global' };
}

export function createStationControlDispatchScope(
  sources: StationControlDispatchScopeSources,
): StationControlDispatchScope {
  // In a Project the owner must hold the action there. The global space has
  // no membership: dispatching there needs nothing more, and approving there
  // is the operator's (owner decision 2026-09-27), whom the rule already
  // admits as a bound operator caller.
  const mayAct = (
    ownerId: string | undefined,
    scope: StationControlScope,
    action: StationControlProjectAction,
  ): { ownerHoldsAction?: boolean } => {
    if (scope.kind === 'project')
      return {
        ownerHoldsAction:
          ownerId !== undefined && sources.ownerMay(ownerId, scope.id, action),
      };
    // An unreadable Project proves no action held there.
    if (scope.kind === 'unreadable') return { ownerHoldsAction: false };
    return action === 'approve' ? { ownerHoldsAction: false } : {};
  };

  const threadTarget = (
    threadId: string,
    remote: boolean,
    action: StationControlProjectAction,
  ): StationControlDispatchTarget | undefined => {
    if (!sources.sessionExists(threadId)) return undefined;
    const ownerId = sources.sessionOwnerId(threadId);
    const recorded = stationControlSessionScope(
      sources.resolveRecord(threadId) ?? {},
    );
    // A session with no Project record still runs in a folder; if that
    // folder is inside a Project, it is that Project's. Decided here, at
    // every check, rather than by stamping the session with the Project at
    // start: a stamp would make it a Project session everywhere else too
    // (membership reads, the Project's lists), which the owner did not ask
    // for, and the scope must hold for sessions started before this.
    const cwd =
      recorded.kind === 'global' ? sources.sessionCwd(threadId) : undefined;
    const scope =
      cwd !== undefined
        ? stationControlDirectoryScope(cwd, sources.projectDirectories())
        : recorded;
    // A decision or a follow-up reaches the whole conversation, so any
    // session of it that runs unconfined makes the target `host`.
    const host = [threadId, ...sources.conversationThreads(threadId)].some(
      (thread) => sources.sessionRunsHost(thread),
    );
    return {
      ...(ownerId ? { ownerId } : {}),
      scope,
      host,
      remote,
      ...mayAct(ownerId, scope, action),
    };
  };

  const taskThread = (taskId: string): string | undefined => {
    // A delegated task's session id carries the `task:` prefix; a bare id is
    // the same task (`loadDelegatedTask` resolves it the same way).
    if (sources.sessionExists(taskId)) return taskId;
    const prefixed = taskId.startsWith('task:') ? taskId : `task:${taskId}`;
    return sources.sessionExists(prefixed) ? prefixed : undefined;
  };

  const newTarget = (
    ref: Extract<StationControlDispatchTargetRef, { kind: 'new' }>,
    action: StationControlProjectAction,
  ): StationControlDispatchTarget => {
    let scope: StationControlScope =
      ref.directory !== undefined
        ? stationControlDirectoryScope(
            ref.directory,
            sources.projectDirectories(),
          )
        : { kind: 'global' };
    if (ref.projectSlug !== undefined) {
      let id: string | undefined;
      try {
        id = sources.projectIdForSlug(ref.projectSlug);
      } catch {
        id = undefined;
      }
      scope = id ? { kind: 'project', id } : { kind: 'unreadable' };
    }
    // A new session starts confined: no station-control caller carries the
    // full-access grant (`fullAccessGrantFor` refuses an agent).
    return {
      ownerId: ref.ownerId,
      scope,
      host: false,
      remote: ref.remote,
      ...mayAct(ref.ownerId, scope, action),
    };
  };

  return {
    target(ref, action = 'execute') {
      try {
        switch (ref.kind) {
          case 'new':
            return newTarget(ref, action);
          case 'thread':
            return threadTarget(ref.threadId, ref.remote, action);
          case 'conversation':
            return threadTarget(
              sources.currentConversationSessionId(ref.conversationId),
              ref.remote,
              action,
            );
          case 'task': {
            const thread = taskThread(ref.taskId);
            return thread
              ? threadTarget(thread, ref.remote, action)
              : undefined;
          }
        }
      } catch {
        // A record that cannot be read is no scope: refuse.
        return undefined;
      }
    },
    conversationExists(conversationId) {
      try {
        return sources.sessionExists(
          sources.currentConversationSessionId(conversationId),
        );
      } catch {
        // Unknown is not "new": a follow-up that cannot be read refuses.
        return true;
      }
    },
  };
}
