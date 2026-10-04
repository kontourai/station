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

import { resolve } from 'node:path';
import {
  type StationControlDispatchTarget,
  type StationControlScope,
  stationControlSessionScope,
} from '../../tools/station-control-policy.js';
import {
  canonicalPath,
  isCanonicalPathWithin,
} from '../../utils/path-containment.js';
import { expandTilde } from '../../utils/paths.js';
import type { StationControlCallerRecordResolver } from './station-control-caller.js';

/**
 * The Project action a scoped call needs from the session's owner: `view` to
 * read a conversation (`read_conversation`, #3159), `execute` to dispatch,
 * `approve` to answer a worker's request.
 */
export type StationControlProjectAction = 'view' | 'execute' | 'approve';

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
  /**
   * Every session of a conversation's lineage, oldest first, reserved but
   * unstarted successors included (the conversation id itself may be absent).
   */
  conversationSessionIds(conversationId: string): readonly string[];
  /**
   * Where a session with no workspace runs: the directory the session start
   * defaults to (`resolveStartSessionCwd`: the home directory, never the
   * server's own working directory). `undefined` when there is none.
   */
  defaultSessionDirectory(): string | undefined;
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
      /**
       * The `cwd` the body names: a plain folder's (its scope is the folder's
       * Project), or a Project workspace's (it must lie inside that Project).
       */
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

/**
 * A target as the scope rule reads it, plus, for a new session with a
 * folder, the canonical path the check decided on. The route dispatches this
 * resolved path rather than the original alias.
 */
export type StationControlResolvedDispatchTarget =
  StationControlDispatchTarget & { readonly canonicalCwd?: string };

export interface StationControlDispatchScope {
  /**
   * The target a reference names, checked for `action` in its Project;
   * `undefined` when Station cannot read it; the caller policy decides refusal.
   */
  target(
    ref: StationControlDispatchTargetRef,
    action?: StationControlProjectAction,
  ): StationControlResolvedDispatchTarget | undefined;
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
  let folder: string;
  try {
    folder = canonicalPath(cwd);
  } catch {
    return { kind: 'unreadable' };
  }
  let deepest: { id: string; root: string } | undefined;
  for (const project of projects) {
    // Stored tilde-literal (`~/dev/x`, station#3155): expanded at the read.
    const workingDirectory = project.workingDirectory
      ? resolve(expandTilde(project.workingDirectory))
      : undefined;
    if (workingDirectory === undefined) continue;
    let root: string;
    try {
      root = canonicalPath(workingDirectory);
    } catch {
      continue;
    }
    if (
      isCanonicalPathWithin(root, folder) &&
      (!deepest || root.length > deepest.root.length)
    )
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

  /**
   * A started session, scoped by its own records, with `host` read across
   * `lineage`: a decision or a follow-up reaches the whole conversation, so
   * any session of it that runs unconfined (including a reserved successor
   * a recorded `never` would start `host`) makes the target `host`.
   */
  const threadTarget = (
    threadId: string,
    lineage: readonly string[],
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
    const host = [threadId, ...lineage].some((thread) =>
      sources.sessionRunsHost(thread),
    );
    return {
      ...(ownerId ? { ownerId } : {}),
      scope,
      host,
      remote,
      ...mayAct(ownerId, scope, action),
    };
  };

  /** Every session of a conversation, the conversation id first. */
  const conversationThreadIds = (conversationId: string): string[] => [
    ...new Set([
      conversationId,
      ...sources.conversationSessionIds(conversationId),
    ]),
  ];

  /**
   * A conversation is scoped by its newest STARTED session: a reserved
   * successor has no records yet, and the executor continues the
   * conversation's binding, not a new session. Its `host` covers every
   * session, the reserved ones included. None started: unreadable.
   */
  const conversationTarget = (
    conversationId: string,
    remote: boolean,
    action: StationControlProjectAction,
  ): StationControlDispatchTarget | undefined => {
    const threads = conversationThreadIds(conversationId);
    const newestStarted = [...threads]
      .reverse()
      .find((thread) => sources.sessionExists(thread));
    return newestStarted
      ? threadTarget(newestStarted, threads, remote, action)
      : undefined;
  };

  const taskThread = (taskId: string): string | undefined => {
    // A delegated task's session id carries the `task:` prefix; a bare id is
    // the same task (`loadDelegatedTask` resolves it the same way).
    if (sources.sessionExists(taskId)) return taskId;
    const prefixed = taskId.startsWith('task:') ? taskId : `task:${taskId}`;
    return sources.sessionExists(prefixed) ? prefixed : undefined;
  };

  /** A Project named by slug, or `unreadable` when Station has none. */
  const projectScope = (slug: string): StationControlScope => {
    let id: string | undefined;
    try {
      id = sources.projectIdForSlug(slug);
    } catch {
      id = undefined;
    }
    return id ? { kind: 'project', id } : { kind: 'unreadable' };
  };

  /**
   * Where a new session runs, and so its scope:
   * - a Project workspace with a `cwd`: that Project, only while the `cwd`
   *   canonically lies inside it (else unreadable);
   * - a Project workspace: that Project;
   * - a plain folder: the Project that contains it, else global;
   * - no workspace: the default session directory's scope, for the same
   *   reason (it is global unless a Project contains it).
   */
  const newScope = (
    ref: Extract<StationControlDispatchTargetRef, { kind: 'new' }>,
  ): { scope: StationControlScope; canonicalCwd?: string } => {
    const projects = sources.projectDirectories();
    const canonical = (path: string): string | undefined => {
      try {
        return canonicalPath(path);
      } catch {
        return undefined;
      }
    };
    if (ref.projectSlug !== undefined) {
      const named = projectScope(ref.projectSlug);
      if (ref.directory === undefined || named.kind !== 'project')
        return { scope: named };
      const cwd = canonical(ref.directory);
      const project = projects.find((entry) => entry.id === named.id);
      // Stored tilde-literal (`~/dev/x`, station#3155): expanded at the read.
      const root = project?.workingDirectory
        ? resolve(expandTilde(project.workingDirectory))
        : undefined;
      const rootPath = root !== undefined ? canonical(root) : undefined;
      return cwd !== undefined &&
        rootPath !== undefined &&
        isCanonicalPathWithin(rootPath, cwd)
        ? { scope: named, canonicalCwd: cwd }
        : { scope: { kind: 'unreadable' } };
    }
    const directory = ref.directory ?? sources.defaultSessionDirectory();
    if (directory === undefined) return { scope: { kind: 'global' } };
    const scope = stationControlDirectoryScope(directory, projects);
    const cwd =
      ref.directory !== undefined ? canonical(ref.directory) : undefined;
    return cwd !== undefined ? { scope, canonicalCwd: cwd } : { scope };
  };

  const newTarget = (
    ref: Extract<StationControlDispatchTargetRef, { kind: 'new' }>,
    action: StationControlProjectAction,
  ): StationControlResolvedDispatchTarget => {
    const { scope, canonicalCwd } = newScope(ref);
    // A new session starts confined: no station-control caller carries the
    // full-access grant (`fullAccessGrantFor` refuses an agent).
    return {
      ownerId: ref.ownerId,
      scope,
      host: false,
      remote: ref.remote,
      ...mayAct(ref.ownerId, scope, action),
      ...(canonicalCwd !== undefined ? { canonicalCwd } : {}),
    };
  };

  return {
    target(ref, action = 'execute') {
      try {
        switch (ref.kind) {
          case 'new':
            return newTarget(ref, action);
          case 'thread':
            return threadTarget(
              ref.threadId,
              sources.conversationThreads(ref.threadId),
              ref.remote,
              action,
            );
          case 'conversation':
            return conversationTarget(ref.conversationId, ref.remote, action);
          case 'task': {
            const thread = taskThread(ref.taskId);
            return thread
              ? threadTarget(
                  thread,
                  sources.conversationThreads(thread),
                  ref.remote,
                  action,
                )
              : undefined;
          }
        }
      } catch {
        // A record that cannot be read is no scope: refuse.
        return undefined;
      }
    },
    conversationExists(conversationId) {
      // Any lineage (a reservation writes it before its session starts) or
      // a started root is an existing conversation, never a new session.
      try {
        return (
          sources.conversationSessionIds(conversationId).length > 0 ||
          sources.sessionExists(conversationId)
        );
      } catch {
        // Unknown is not "new": a follow-up that cannot be read refuses.
        return true;
      }
    },
  };
}
