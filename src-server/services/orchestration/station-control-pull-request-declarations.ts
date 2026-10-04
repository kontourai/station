/**
 * #3161: a pull request an EXTERNAL engine (Claude Code, Codex, an ACP agent)
 * declares through the `declare_pull_request` Station Control tool.
 *
 * Station's own engine declares an output with a native tool call whose
 * authority is a grant bound to its turn (`native-output-turn-grant.ts`). An
 * external engine has no such call, so this is the second admission
 * authority: the SAME grant authority and declaration operation, instantiated
 * for Station Control. The authority is the verified caller's own session and
 * that session's active turn, never a model argument, and the call id is
 * minted here. Everything after admission is the existing path:
 *
 * - the declaration waits as an opaque pending handle;
 * - it lands in the durable event store in the savepoint of that turn's
 *   `turn.completed`, and is dropped when the turn aborts, errors, is
 *   interrupted or the session is replaced (the grant's lease no longer
 *   holds, so `takeTerminalAdmissions` never admits it);
 * - the Task-incarnation fence (#3106) applies where a person keeps the
 *   declaration onto a Task, which is unchanged.
 *
 * A declaration is a candidate only. It never links, keeps or completes
 * anything by itself.
 */
import { randomUUID } from 'node:crypto';
import { servicePrincipal } from '@kontourai/station-contracts/principal';
import type { DeclaredOutputDescriptor } from '@kontourai/station-contracts/session-output-declaration';
import {
  createNativeOutputDeclarationOperation,
  type NativeOutputDeclarationOperation,
  type NativeOutputTerminalAdmission,
} from '../../runtime/native-output-declaration.js';
import {
  createNativeOutputGrantAuthority,
  type NativeOutputCallFacts,
  type NativeOutputGrantAuthority,
} from '../../runtime/native-output-turn-grant.js';

export type StationControlPullRequestDeclarationOutcome =
  | 'declared'
  | 'already-declared'
  | 'no-active-turn';

/** The pull request could not be read, or could not be admitted, as asked. */
export class StationControlPullRequestUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StationControlPullRequestUnavailableError';
  }
}

type PullRequestDescriptor = Extract<
  DeclaredOutputDescriptor,
  { kind: 'pull-request' }
>;

/** The pull request a caller names: the link store's identity, parsed. */
export interface StationControlPullRequestIdentity {
  provider: string;
  host: string;
  owner: string;
  repository: string;
  ref: string;
}

/** A session's running turn, as the lease for everything declared in it. */
export interface StationControlActiveTurn {
  turnId: string;
  adapterId: string;
  /** True while this exact turn on this exact adapter is still the live one. */
  isCurrent(): boolean;
}

interface StationControlPullRequestDeclarationDeps {
  /** The session's running turn; `undefined` when it has none. */
  activeTurn(sessionId: string): StationControlActiveTurn | undefined;
  workspaceRoot(sessionId: string): string | undefined;
  /**
   * Every pull request already declared in the session, durable; `null` when
   * there are more than the reader will compare (the caller refuses rather
   * than guess).
   */
  declaredPullRequests(sessionId: string): PullRequestDescriptor[] | null;
  resolver: {
    read(
      input: StationControlPullRequestIdentity & {
        nativeId: string;
        facts: NativeOutputCallFacts;
      },
    ): Promise<PullRequestDescriptor | null>;
    readIdentity(
      input: StationControlPullRequestIdentity & { workingDirectory: string },
    ): Promise<PullRequestDescriptor | null>;
  };
}

export interface StationControlPullRequestDeclarations {
  declare(input: {
    sessionId: string;
    pullRequest: StationControlPullRequestIdentity;
    label?: string;
  }): Promise<StationControlPullRequestDeclarationOutcome>;
  takeTerminalAdmissions(
    sessionId: string,
    turnId: string,
    eventId: string,
  ): NativeOutputTerminalAdmission[];
  commit(handles: readonly string[]): void;
  rollback(handles: readonly string[]): void;
  retireTerminal(sessionId: string, turnId: string): void;
  /** Revoke every turn of a session now: an interrupt, a replacement. */
  retireSession(sessionId: string): void;
  dispose(): void;
}

/**
 * Two identities name one pull request when every component agrees. The host
 * and repository are case-insensitive on every forge Station reads (and the
 * link store lowercases the host); the ref is an integer string compared
 * exactly. Components are compared one by one, never as one joined string, so
 * `owner/repo-2` cannot be taken for `owner/repo`.
 */
function samePullRequest(
  a: StationControlPullRequestIdentity,
  b: StationControlPullRequestIdentity,
): boolean {
  return (
    a.provider === b.provider &&
    a.host.toLowerCase() === b.host.toLowerCase() &&
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repository.toLowerCase() === b.repository.toLowerCase() &&
    a.ref === b.ref
  );
}

const identityOf = (descriptor: PullRequestDescriptor) => ({
  provider: descriptor.provider,
  host: descriptor.host,
  owner: descriptor.repository.owner,
  repository: descriptor.repository.name,
  ref: descriptor.ref,
});

export function createStationControlPullRequestDeclarations(
  deps: StationControlPullRequestDeclarationDeps,
): StationControlPullRequestDeclarations {
  const authority: NativeOutputGrantAuthority =
    createNativeOutputGrantAuthority();
  const operation: NativeOutputDeclarationOperation =
    createNativeOutputDeclarationOperation({
      authority,
      workspaceForCall: (facts) => facts.workspaceRoot,
      readPullRequest: (input) => deps.resolver.read(input),
    });
  const principal = servicePrincipal('station-control', 'Station Control');
  const grants = new Map<
    string,
    {
      sessionId: string;
      turnId: string;
      grant: ReturnType<typeof authority.issue>;
    }
  >();
  const turnKey = (sessionId: string, turnId: string) =>
    JSON.stringify([sessionId, turnId]);
  // Turns revoked while still running (an interrupt): nothing more is
  // admitted for them even if the engine goes on to complete the turn.
  const revokedTurns = new Set<string>();
  // One declaration per session at a time, so two concurrent calls for one
  // pull request cannot both pass the repeat check.
  const queues = new Map<string, Promise<unknown>>();

  const grantFor = (sessionId: string, turn: StationControlActiveTurn) => {
    const key = turnKey(sessionId, turn.turnId);
    if (revokedTurns.has(key)) return null;
    const existing = grants.get(key);
    if (existing) return existing.grant;
    const workspaceRoot = deps.workspaceRoot(sessionId);
    const grant = authority.issue(
      {
        threadId: sessionId,
        turnId: turn.turnId,
        principal,
        adapterId: turn.adapterId,
        configurationLease: turn,
        ...(workspaceRoot ? { workspaceRoot } : {}),
      },
      { isCurrent: () => turn.isCurrent() },
    );
    if (grant) grants.set(key, { sessionId, turnId: turn.turnId, grant });
    return grant;
  };

  const run = async (
    input: Parameters<StationControlPullRequestDeclarations['declare']>[0],
  ): Promise<StationControlPullRequestDeclarationOutcome> => {
    const { sessionId, pullRequest } = input;
    const turn = deps.activeTurn(sessionId);
    if (!turn) return 'no-active-turn';
    const durable = deps.declaredPullRequests(sessionId);
    if (!durable)
      throw new StationControlPullRequestUnavailableError(
        'This session has too many declared outputs to compare against.',
      );
    const alreadyDeclared = () =>
      [
        ...durable,
        ...operation
          .pendingDescriptors(sessionId, turn.turnId)
          .filter(
            (descriptor): descriptor is PullRequestDescriptor =>
              descriptor.kind === 'pull-request',
          ),
      ].some((descriptor) =>
        samePullRequest(identityOf(descriptor), pullRequest),
      );
    if (alreadyDeclared()) return 'already-declared';

    const workspaceRoot = deps.workspaceRoot(sessionId);
    if (!workspaceRoot)
      throw new StationControlPullRequestUnavailableError(
        'This session has no workspace to read the pull request from.',
      );
    // The exact read: the provider answers for this identity in THIS
    // workspace's own repository, or the declaration is refused.
    const exact = await deps.resolver.readIdentity({
      ...pullRequest,
      workingDirectory: workspaceRoot,
    });
    if (!exact)
      throw new StationControlPullRequestUnavailableError(
        'The pull request could not be read at that exact identity in this session workspace.',
      );
    // The read took time: the turn may have ended, and a repeat may have
    // landed through the pending set.
    const still = deps.activeTurn(sessionId);
    if (!still || still.turnId !== turn.turnId) return 'no-active-turn';
    if (alreadyDeclared()) return 'already-declared';

    const grant = grantFor(sessionId, turn);
    // A server-minted call id: the model names no call, session or turn.
    const scope = grant ? authority.bindNativeCall(grant, randomUUID()) : null;
    if (!scope)
      throw new StationControlPullRequestUnavailableError(
        'This turn can no longer declare an output.',
      );
    try {
      await operation.declare(scope, {
        ...(input.label === undefined ? {} : { label: input.label }),
        pullRequest: {
          provider: exact.provider,
          host: exact.host,
          owner: exact.repository.owner,
          repository: exact.repository.name,
          ref: exact.ref,
          nativeId: exact.nativeId,
        },
      });
    } catch (error) {
      // The operation's text names its own seams; the caller gets one answer.
      if (!deps.activeTurn(sessionId)) return 'no-active-turn';
      throw new StationControlPullRequestUnavailableError(
        error instanceof Error
          ? error.message
          : 'The pull request could not be declared.',
      );
    }
    return 'declared';
  };

  return {
    declare(input) {
      const previous = queues.get(input.sessionId) ?? Promise.resolve();
      const next = previous.then(
        () => run(input),
        () => run(input),
      );
      const tail = next.catch(() => undefined);
      queues.set(input.sessionId, tail);
      void tail.then(() => {
        if (queues.get(input.sessionId) === tail)
          queues.delete(input.sessionId);
      });
      return next;
    },
    takeTerminalAdmissions: (sessionId, turnId, eventId) =>
      operation.takeTerminalAdmissions(sessionId, turnId, eventId),
    commit: (handles) => operation.commit(handles),
    rollback: (handles) => operation.rollback(handles),
    retireTerminal(sessionId, turnId) {
      revokedTurns.delete(turnKey(sessionId, turnId));
      grants.delete(turnKey(sessionId, turnId));
      authority.retireTerminal(sessionId, turnId);
    },
    retireSession(sessionId) {
      const running = deps.activeTurn(sessionId);
      if (running) revokedTurns.add(turnKey(sessionId, running.turnId));
      for (const [key, entry] of grants) {
        if (entry.sessionId !== sessionId) continue;
        grants.delete(key);
        authority.retireTerminal(entry.sessionId, entry.turnId);
      }
    },
    dispose() {
      revokedTurns.clear();
      grants.clear();
      authority.dispose();
    },
  };
}
