import { createHash, randomUUID } from 'node:crypto';
import {
  type OwnerIdentity,
  type OwnerLiveness,
  ownerLivenessFromProbe,
} from '@kontourai/monument';
import type { IPullRequestProvider } from '@kontourai/station-contracts/pull-request-provider';
import type {
  WorktreeOutputSettlement,
  WorktreeOutputSettlementEvidence,
  WorktreeOutputSettlementRefusal,
  WorktreeOutputSettlementRequest,
  WorktreeSessionMetadata,
} from '@kontourai/station-contracts/workspace-isolation';
import {
  exactProcessIdentity,
  probeExactProcessIdentity,
} from '@kontourai/station-shared/process-identity';
import { createKeyedSerialQueue } from '../../utils/keyed-serial-queue.js';
import type {
  StoredWorktreeOutputSettlement,
  WorktreeOutputSettlementStore,
} from '../orchestration/worktree-output-settlement-store.js';
import { readPullRequestByIdentity } from '../pull-requests/pull-request-identity-read.js';
import {
  type SessionWorktreeDiscard,
  type SessionWorktreeInspection,
  sessionExitWorktreeMetadata,
  type WorktreeProvisioningService,
  type WorktreeTerminalState,
} from './worktree-provisioning-service.js';

export type WorktreeOutputSettlementResult =
  /** This request's own record. */
  | { kind: 'recorded'; settlement: WorktreeOutputSettlement }
  /**
   * A record made earlier: a replay of the same request, or an earlier
   * discard this request found half done and completed as it was recorded.
   */
  | { kind: 'existing'; settlement: WorktreeOutputSettlement }
  | {
      kind: 'refused';
      reason: WorktreeOutputSettlementRefusal;
      detail: string;
      /** The record that stands in the way, when one does. */
      settlement?: WorktreeOutputSettlement;
    };

type SettlementWorktrees = Pick<
  WorktreeProvisioningService,
  | 'isSessionWorktreeIntact'
  | 'inspectSessionWorktree'
  | 'baseContainment'
  | 'discardSessionWorktree'
  | 'readSessionBranchHead'
  | 'sessionWorktreeRemovalProblem'
  | 'finalize'
>;

interface SettleInput {
  sessionId: string;
  metadata: WorktreeSessionMetadata;
  /** Derived by the caller from the request's authenticated principal. */
  actor: { kind: 'person'; id: string };
  request: WorktreeOutputSettlementRequest;
  /**
   * The caller's authority over the Session, asked again after Station's
   * Git and forge reads and immediately before anything is recorded or
   * removed.
   */
  stillAuthorized: () => boolean;
}

/** The request key every cleanup-policy record carries; one per Session. */
const CLEANUP_REQUEST_KEY = 'cleanup-policy';

/**
 * How long a `released` request waits for the forge. Operations on one
 * Session are serialized, so Session-exit cleanup can wait behind this read.
 */
const DEFAULT_FORGE_DEADLINE_MS = 30_000;

const refused = (
  reason: WorktreeOutputSettlementRefusal,
  detail: string,
  settlement?: WorktreeOutputSettlement,
): WorktreeOutputSettlementResult => ({
  kind: 'refused',
  reason,
  detail,
  ...(settlement ? { settlement } : {}),
});

const lower = (value: string) => value.toLowerCase();

const AUTHORITY_CHANGED = refused(
  'authority-changed',
  'Your access to this Session changed; nothing was recorded or removed.',
);

const INSPECTION_REFUSAL: Record<
  Extract<SessionWorktreeInspection, { kind: 'refused' }>['reason'],
  WorktreeOutputSettlementRefusal
> = {
  'unsafe-config': 'unsafe-repository-config',
  'not-a-directory': 'worktree-path-not-a-directory',
  replaced: 'worktree-replaced',
  'repository-missing': 'repository-missing',
};

const DISCARD_REFUSAL: Record<
  Extract<SessionWorktreeDiscard, { kind: 'refused' }>['reason'],
  WorktreeOutputSettlementRefusal
> = {
  ...INSPECTION_REFUSAL,
  'uncommitted-changes': 'uncommitted-changes',
  'branch-moved': 'branch-moved',
  'branch-checked-out-elsewhere': 'branch-checked-out-elsewhere',
};

/**
 * What a replay must repeat exactly: the outcome and every input that
 * decides it. The request key itself is compared separately.
 */
function requestDigest(request: WorktreeOutputSettlementRequest): string {
  const canonical =
    request.outcome === 'discarded'
      ? [request.outcome, request.acceptUncommittedLoss === true]
      : request.outcome === 'kept'
        ? [request.outcome]
        : [
            request.outcome,
            request.pullRequest.provider,
            lower(request.pullRequest.host),
            lower(request.pullRequest.repository.owner),
            lower(request.pullRequest.repository.name),
            request.pullRequest.ref,
          ];
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

/**
 * The worktree a Session started in, from its own `session.started` record:
 * Session-owned, Task-owned (#4507, shared by the Task's Sessions and
 * settled with the Task, not here), or none.
 */
export function sessionWorktreeForSettlement(
  events: unknown[],
  sessionId: string,
):
  | { kind: 'session'; metadata: WorktreeSessionMetadata }
  | { kind: 'task-owned' }
  | { kind: 'none' } {
  for (const event of events) {
    const started = event as {
      method?: unknown;
      sessionId?: unknown;
      metadata?: { worktree?: { owner?: unknown } };
    } | null;
    if (
      started?.method === 'session.started' &&
      started.sessionId === sessionId &&
      started.metadata?.worktree?.owner !== undefined
    )
      return { kind: 'task-owned' };
  }
  const metadata = sessionExitWorktreeMetadata(events, sessionId);
  return metadata ? { kind: 'session', metadata } : { kind: 'none' };
}

/** `undefined` once `deadlineMs` passes; a late answer is dropped. */
function withinDeadline<T>(
  pending: Promise<T>,
  deadlineMs: number,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), deadlineMs);
    timer.unref?.();
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * #4771: records what became of a worktree Session's output, at most once.
 *
 * Settlement is a recorded fact. The only Git effect is a discard removing
 * the worktree and branch Station created; `kept` and `released` are
 * derived from what Git and the forge say now, never from the caller's
 * word. A discard writes its intent (`pending`) before the Git effect, so a
 * crash between the two converges on retry. Operations on one Session run
 * one at a time in this process. Across processes, a pending intent names
 * the process that wrote it, and another process abandons or completes it
 * only once that process is provably gone; a retry with the intent's own
 * request key always completes it.
 */
export class WorktreeOutputSettlementService {
  private readonly queue = createKeyedSerialQueue();
  private readonly now: () => Date;
  private readonly ownerId = randomUUID();
  private owner?: OwnerIdentity;
  private readonly liveness: OwnerLiveness;

  constructor(
    private readonly deps: {
      store: WorktreeOutputSettlementStore;
      worktrees: SettlementWorktrees;
      pullRequestProviders: () => IPullRequestProvider[];
      /** Whether a Session has a running turn in this directory. */
      isWorkspaceBusy?: (path: string) => boolean;
      now?: () => Date;
      forgeDeadlineMs?: number;
      /** Process liveness; the exact pid-and-birth probe by default. */
      liveness?: OwnerLiveness;
    },
  ) {
    this.now = deps.now ?? (() => new Date());
    // This instance's own earlier intent is never in flight when a new
    // request runs: the per-Session queue finished it first.
    this.liveness =
      deps.liveness ??
      ownerLivenessFromProbe(probeExactProcessIdentity, {
        isReleased: (id) => id === this.ownerId,
      });
  }

  read(sessionId: string): WorktreeOutputSettlement | undefined {
    return this.deps.store.read(sessionId)?.record;
  }

  settle(input: SettleInput): Promise<WorktreeOutputSettlementResult> {
    return this.queue.run(input.sessionId, () => this.settleNow(input));
  }

  /**
   * The Session-exit cleanup policy, recorded: when it removes the worktree
   * and no decision exists, the record says exactly that, and whether the
   * worktree and branch are actually gone afterwards. A crash between the
   * removal and this record leaves no record (not a decision).
   */
  finalizeSessionExit(input: {
    sessionId: string;
    metadata: WorktreeSessionMetadata;
    terminalState: WorktreeTerminalState;
  }): Promise<'removed' | 'preserved'> {
    return this.queue.run(input.sessionId, async () => {
      const problem = await this.deps.worktrees.sessionWorktreeRemovalProblem(
        input.metadata,
      );
      if (problem) throw new Error(problem);
      const decided = this.deps.store.read(input.sessionId) !== undefined;
      const head = decided
        ? undefined
        : await this.deps.worktrees
            .readSessionBranchHead(input.metadata)
            .catch(() => undefined);
      const result = await this.deps.worktrees.finalize(input);
      if (result === 'removed' && !decided)
        await this.recordCleanup(input, head);
      return result;
    });
  }

  private async recordCleanup(
    input: {
      sessionId: string;
      metadata: WorktreeSessionMetadata;
      terminalState: WorktreeTerminalState;
    },
    head: string | undefined,
  ): Promise<void> {
    // Cleanup's `branch -D` is allowed to fail (a branch checked out
    // elsewhere), so what is gone is read back, not assumed.
    const branchLeft = await this.deps.worktrees
      .readSessionBranchHead(input.metadata)
      .catch(() => 'unknown');
    const worktreeLeft = await this.deps.worktrees
      .isSessionWorktreeIntact(input.metadata, input.sessionId)
      .catch(() => true);
    const at = this.now().toISOString();
    this.deps.store.insert({
      requestDigest: CLEANUP_REQUEST_KEY,
      record: {
        ...this.identity(input.sessionId, input.metadata),
        state: 'settled',
        outcome: 'cleaned-up-without-decision',
        actor: { kind: 'station', id: 'worktree-cleanup-policy' },
        requestKey: CLEANUP_REQUEST_KEY,
        ...(head ? { headCommit: head } : {}),
        evidence: {
          terminalState: input.terminalState,
          removedWorktree: !worktreeLeft,
          removedBranch: branchLeft === undefined,
        },
        requestedAt: at,
        settledAt: at,
      },
    });
  }

  private async settleNow(
    input: SettleInput,
  ): Promise<WorktreeOutputSettlementResult> {
    const digest = requestDigest(input.request);
    const existing = this.deps.store.read(input.sessionId);
    if (existing?.record.state === 'settled')
      return answerSettled(existing, input.request.requestKey, digest);
    if (this.deps.isWorkspaceBusy?.(input.metadata.path))
      return refused(
        'session-running',
        "A turn is running in the Session's worktree; settle it once the Session is idle.",
      );
    if (existing) {
      const pending = await this.resolvePending(input, existing, digest);
      if (pending) return pending;
    }
    switch (input.request.outcome) {
      case 'discarded':
        return this.discard(input, input.request, digest);
      case 'kept':
        return this.keep(input, digest);
      case 'released':
        return this.release(input, input.request, digest);
    }
  }

  /**
   * A pending discard. Its own request key completes it. Another request
   * waits while the process that wrote it may still be running it; once that
   * process is gone, an intent whose worktree is intact had no effect and
   * gives way (`undefined`: proceed), and one whose removal started is
   * completed as it was recorded.
   */
  private async resolvePending(
    input: SettleInput,
    existing: StoredWorktreeOutputSettlement,
    digest: string,
  ): Promise<WorktreeOutputSettlementResult | undefined> {
    const { record } = existing;
    const sameKey = record.requestKey === input.request.requestKey;
    if (sameKey && existing.requestDigest !== digest)
      return refused(
        'request-key-mismatch',
        'This request key was used for a different settlement request.',
        record,
      );
    if (!sameKey && !this.ownerGone(existing))
      return refused(
        'settlement-pending',
        'Another settlement of this worktree may still be in progress.',
        record,
      );
    if (
      !sameKey &&
      (await this.deps.worktrees.isSessionWorktreeIntact(
        input.metadata,
        input.sessionId,
      ))
    ) {
      this.deps.store.abandonPending(input.sessionId, record.requestKey);
      return undefined;
    }
    if (input.request.outcome !== 'discarded')
      return refused(
        'settlement-pending',
        'A discard of this worktree started and has not been recorded yet; only completing it can settle this Session.',
        record,
      );
    if (!input.stillAuthorized()) return AUTHORITY_CHANGED;
    return this.completeDiscard(
      input.metadata,
      existing,
      sameKey ? 'recorded' : 'existing',
    );
  }

  /** Provably gone: this instance's own finished attempt, or a dead process. */
  private ownerGone(stored: StoredWorktreeOutputSettlement): boolean {
    return stored.owner !== undefined && this.liveness(stored.owner) === 'dead';
  }

  private processOwner(): OwnerIdentity {
    if (!this.owner) {
      const exact = exactProcessIdentity(process.pid);
      this.owner = exact
        ? {
            id: this.ownerId,
            pid: process.pid,
            identityKind: 'exact',
            birth: exact.start,
          }
        : { id: this.ownerId, pid: process.pid, identityKind: 'unverified' };
    }
    return this.owner;
  }

  private async discard(
    input: SettleInput,
    request: Extract<WorktreeOutputSettlementRequest, { outcome: 'discarded' }>,
    digest: string,
  ): Promise<WorktreeOutputSettlementResult> {
    const inspection = await this.inspect(input);
    if (inspection.kind === 'refused') return inspection.result;
    if (inspection.checkedOutElsewhere)
      return refused(
        'branch-checked-out-elsewhere',
        `Branch ${input.metadata.branch} is checked out in another checkout; nothing was removed.`,
      );
    const accept = request.acceptUncommittedLoss === true;
    if (inspection.dirty && !accept)
      return refused(
        'uncommitted-changes',
        'The worktree has uncommitted or untracked changes; send acceptUncommittedLoss to discard them.',
      );
    if (!input.stillAuthorized()) return AUTHORITY_CHANGED;
    const pending = this.deps.store.insert({
      requestDigest: digest,
      owner: this.processOwner(),
      record: {
        ...this.identity(input.sessionId, input.metadata),
        state: 'pending',
        outcome: 'discarded',
        actor: input.actor,
        requestKey: request.requestKey,
        headCommit: inspection.head,
        evidence: {
          hadUncommittedChanges: inspection.dirty,
          acceptedUncommittedLoss: accept,
        },
        requestedAt: this.now().toISOString(),
      },
    });
    if (pending.kind === 'exists')
      return answerExisting(pending.stored, request.requestKey, digest);
    return this.completeDiscard(input.metadata, pending.stored, 'recorded');
  }

  private async completeDiscard(
    metadata: WorktreeSessionMetadata,
    stored: StoredWorktreeOutputSettlement,
    kind: 'recorded' | 'existing',
  ): Promise<WorktreeOutputSettlementResult> {
    const { record } = stored;
    if (!record.headCommit)
      throw new Error('A pending discard has no recorded head commit.');
    const result = await this.deps.worktrees.discardSessionWorktree({
      metadata,
      sessionId: record.sessionId,
      expectedHead: record.headCommit,
      acceptUncommittedLoss: record.evidence.acceptedUncommittedLoss === true,
    });
    if (result.kind === 'refused') {
      // A refusal removed nothing. The intent goes only while its worktree
      // is intact and no other live process wrote it; otherwise a retry
      // can still complete it.
      if (
        this.ownerGone(stored) &&
        (await this.deps.worktrees.isSessionWorktreeIntact(
          metadata,
          record.sessionId,
        ))
      )
        this.deps.store.abandonPending(record.sessionId, record.requestKey);
      return refused(DISCARD_REFUSAL[result.reason], result.detail);
    }
    const settled = this.deps.store.settlePending({
      sessionId: record.sessionId,
      requestKey: record.requestKey,
      evidence: {
        ...record.evidence,
        hadUncommittedChanges:
          record.evidence.hadUncommittedChanges === true ||
          result.hadUncommittedChanges,
        ignoredEntries: result.ignoredEntries,
        removedWorktree: result.removedWorktree,
        removedBranch: result.removedBranch,
        ...(result.branchKept ? { branchKept: result.branchKept } : {}),
      },
      settledAt: this.now().toISOString(),
    });
    return { kind, settlement: settled.record };
  }

  private async keep(
    input: SettleInput,
    digest: string,
  ): Promise<WorktreeOutputSettlementResult> {
    const inspection = await this.inspect(input);
    if (inspection.kind === 'refused') return inspection.result;
    if (inspection.dirty)
      return refused(
        'uncommitted-changes',
        'The worktree has uncommitted or untracked changes, which the base cannot contain.',
      );
    if (input.metadata.baseCommit === inspection.head)
      return refused(
        'no-new-commits',
        'The worktree branch has no commit beyond the one it started from.',
      );
    const containment = await this.deps.worktrees.baseContainment(
      input.metadata,
      inspection.head,
    );
    if (containment.kind === 'detached')
      return refused(
        'base-detached',
        "The base is HEAD and the repository's checkout is detached, so it names no branch to keep onto.",
      );
    if (containment.kind === 'unresolvable')
      return refused(
        'base-unresolvable',
        `${input.metadata.baseRef} does not resolve to a commit in the repository.`,
      );
    if (containment.baseBranch === input.metadata.branch)
      return refused(
        'base-is-session-branch',
        `${input.metadata.baseRef} names the Session's own branch ${input.metadata.branch}, which trivially contains its head.`,
      );
    if (containment.kind === 'not-contained')
      return refused(
        'base-does-not-contain-head',
        `${containment.baseBranch ?? input.metadata.baseRef} (${containment.baseTip}) does not contain ${inspection.head}. A squash or rebase merge does not contain the branch head; record such a merge as released with its pull request.`,
      );
    return this.recordSettled(input, digest, inspection.head, {
      containingCommit: containment.baseTip,
      ...(containment.baseBranch ? { baseBranch: containment.baseBranch } : {}),
    });
  }

  private async release(
    input: SettleInput,
    request: Extract<WorktreeOutputSettlementRequest, { outcome: 'released' }>,
    digest: string,
  ): Promise<WorktreeOutputSettlementResult> {
    const inspection = await this.inspect(input);
    if (inspection.kind === 'refused') return inspection.result;
    if (inspection.dirty)
      return refused(
        'uncommitted-changes',
        'The worktree has uncommitted or untracked changes, which no pull request contains.',
      );
    const read = await withinDeadline(
      readPullRequestByIdentity(
        this.deps.pullRequestProviders,
        request.pullRequest,
      ),
      this.deps.forgeDeadlineMs ?? DEFAULT_FORGE_DEADLINE_MS,
    );
    if (read?.kind !== 'current')
      return refused(
        'pull-request-unavailable',
        read
          ? 'Station could not read that pull request from its forge.'
          : 'The forge did not answer in time.',
      );
    const pr = read.pullRequest;
    // The forge's own word, and exactly OPEN or MERGED (as Task close-out).
    if (pr.state !== 'OPEN' && pr.state !== 'MERGED')
      return refused(
        'pull-request-not-open-or-merged',
        `The pull request is ${pr.state}.`,
      );
    if (
      !sameIdentity(request.pullRequest, pr) ||
      pr.sourceBranch !== input.metadata.branch ||
      pr.headSha !== inspection.head
    )
      return refused(
        'pull-request-mismatch',
        `The pull request's head is not ${input.metadata.branch} at ${inspection.head}.`,
      );
    return this.recordSettled(input, digest, inspection.head, {
      pullRequest: {
        provider: pr.provider,
        host: pr.host,
        repository: pr.repository,
        ref: pr.ref,
        url: pr.url,
        state: pr.state,
        sourceBranch: pr.sourceBranch,
        targetBranch: pr.targetBranch,
        headSha: inspection.head,
      },
    });
  }

  private async inspect(
    input: SettleInput,
  ): Promise<
    | Extract<SessionWorktreeInspection, { kind: 'present' }>
    | { kind: 'refused'; result: WorktreeOutputSettlementResult }
  > {
    const inspection = await this.deps.worktrees.inspectSessionWorktree(
      input.metadata,
      input.sessionId,
    );
    if (inspection.kind === 'missing')
      return {
        kind: 'refused',
        result: refused(
          'worktree-missing',
          "The Session's worktree or its branch is no longer in place.",
        ),
      };
    if (inspection.kind === 'refused')
      return {
        kind: 'refused',
        result: refused(
          INSPECTION_REFUSAL[inspection.reason],
          inspection.detail,
        ),
      };
    return inspection;
  }

  private recordSettled(
    input: SettleInput,
    digest: string,
    head: string,
    evidence: WorktreeOutputSettlementEvidence,
  ): WorktreeOutputSettlementResult {
    if (!input.stillAuthorized()) return AUTHORITY_CHANGED;
    const at = this.now().toISOString();
    const inserted = this.deps.store.insert({
      requestDigest: digest,
      record: {
        ...this.identity(input.sessionId, input.metadata),
        state: 'settled',
        outcome: input.request.outcome,
        actor: input.actor,
        requestKey: input.request.requestKey,
        headCommit: head,
        evidence,
        requestedAt: at,
        settledAt: at,
      },
    });
    return inserted.kind === 'inserted'
      ? { kind: 'recorded', settlement: inserted.stored.record }
      : answerExisting(inserted.stored, input.request.requestKey, digest);
  }

  private identity(sessionId: string, metadata: WorktreeSessionMetadata) {
    return {
      sessionId,
      repoPath: metadata.repoPath,
      worktreePath: metadata.path,
      branch: metadata.branch,
      baseRef: metadata.baseRef,
      ...(metadata.baseCommit ? { baseCommit: metadata.baseCommit } : {}),
    };
  }
}

function answerSettled(
  existing: StoredWorktreeOutputSettlement,
  requestKey: string,
  digest: string,
): WorktreeOutputSettlementResult {
  if (existing.record.requestKey !== requestKey)
    return refused(
      'already-settled',
      `This Session's worktree output is already recorded as ${existing.record.outcome}.`,
      existing.record,
    );
  return existing.requestDigest === digest
    ? { kind: 'existing', settlement: existing.record }
    : refused(
        'request-key-mismatch',
        'This request key was used for a different settlement request.',
        existing.record,
      );
}

/** A row another writer inserted first. */
function answerExisting(
  existing: StoredWorktreeOutputSettlement,
  requestKey: string,
  digest: string,
): WorktreeOutputSettlementResult {
  return existing.record.state === 'settled'
    ? answerSettled(existing, requestKey, digest)
    : refused(
        'settlement-pending',
        'Another settlement of this worktree is in progress.',
        existing.record,
      );
}

function sameIdentity(
  named: Extract<
    WorktreeOutputSettlementRequest,
    { outcome: 'released' }
  >['pullRequest'],
  observed: {
    provider: string;
    host: string;
    repository: { owner: string; name: string };
    ref: string;
  },
): boolean {
  return (
    named.provider === observed.provider &&
    lower(named.host) === lower(observed.host) &&
    lower(named.repository.owner) === lower(observed.repository.owner) &&
    lower(named.repository.name) === lower(observed.repository.name) &&
    named.ref === observed.ref
  );
}
