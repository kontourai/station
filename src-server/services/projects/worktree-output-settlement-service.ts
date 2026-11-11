import { createHash } from 'node:crypto';
import type { IPullRequestProvider } from '@kontourai/station-contracts/pull-request-provider';
import type {
  WorktreeOutputSettlement,
  WorktreeOutputSettlementEvidence,
  WorktreeOutputSettlementRefusal,
  WorktreeOutputSettlementRequest,
  WorktreeSessionMetadata,
} from '@kontourai/station-contracts/workspace-isolation';
import { createKeyedSerialQueue } from '../../utils/keyed-serial-queue.js';
import type {
  StoredWorktreeOutputSettlement,
  WorktreeOutputSettlementStore,
} from '../orchestration/worktree-output-settlement-store.js';
import { readPullRequestByIdentity } from '../pull-requests/pull-request-identity-read.js';
import {
  type SessionWorktreeDiscard,
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
  | 'finalize'
>;

interface SettleInput {
  sessionId: string;
  metadata: WorktreeSessionMetadata;
  /** Derived by the caller from the request's authenticated principal. */
  actor: { kind: 'person'; id: string };
  request: WorktreeOutputSettlementRequest;
}

/** The request key every cleanup-policy record carries; one per Session. */
const CLEANUP_REQUEST_KEY = 'cleanup-policy';

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

/**
 * #4771: records what became of a worktree Session's output, at most once.
 *
 * Settlement is a recorded fact. The only Git effect is a discard removing
 * the worktree and branch Station created; `kept` and `released` are
 * derived from what Git and the forge say now, never from the caller's
 * word. A discard writes its intent (`pending`) before the Git effect, so a
 * crash between the two converges on retry. Operations on one Session run
 * one at a time in this process.
 */
export class WorktreeOutputSettlementService {
  private readonly queue = createKeyedSerialQueue();
  private readonly now: () => Date;

  constructor(
    private readonly deps: {
      store: WorktreeOutputSettlementStore;
      worktrees: SettlementWorktrees;
      pullRequestProviders: () => IPullRequestProvider[];
      now?: () => Date;
    },
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  read(sessionId: string): WorktreeOutputSettlement | undefined {
    return this.deps.store.read(sessionId)?.record;
  }

  settle(input: SettleInput): Promise<WorktreeOutputSettlementResult> {
    return this.queue.run(input.sessionId, () => this.settleNow(input));
  }

  /**
   * The Session-exit cleanup policy, recorded: when it removes the worktree
   * and no decision exists, the record says exactly that. A crash between
   * the removal and this record leaves no record (not a decision).
   */
  finalizeSessionExit(input: {
    sessionId: string;
    metadata: WorktreeSessionMetadata;
    terminalState: WorktreeTerminalState;
  }): Promise<'removed' | 'preserved'> {
    return this.queue.run(input.sessionId, async () => {
      const decided = this.deps.store.read(input.sessionId) !== undefined;
      const head = decided
        ? undefined
        : await this.deps.worktrees
            .readSessionBranchHead(input.metadata)
            .catch(() => undefined);
      const result = await this.deps.worktrees.finalize(input);
      if (result === 'removed' && !decided) {
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
              removedWorktree: true,
              removedBranch: true,
            },
            requestedAt: at,
            settledAt: at,
          },
        });
      }
      return result;
    });
  }

  private async settleNow(
    input: SettleInput,
  ): Promise<WorktreeOutputSettlementResult> {
    const digest = requestDigest(input.request);
    const existing = this.deps.store.read(input.sessionId);
    if (existing?.record.state === 'settled')
      return answerSettled(existing, input.request.requestKey, digest);
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
   * A pending discard: while its worktree is intact nothing was removed, so
   * the intent gives way to this request (`undefined`: proceed). Once the
   * removal has started, only completing that discard converges.
   */
  private async resolvePending(
    input: SettleInput,
    existing: StoredWorktreeOutputSettlement,
    digest: string,
  ): Promise<WorktreeOutputSettlementResult | undefined> {
    const { record } = existing;
    if (
      await this.deps.worktrees.isSessionWorktreeIntact(
        input.metadata,
        input.sessionId,
      )
    ) {
      this.deps.store.abandonPending(input.sessionId, record.requestKey);
      return undefined;
    }
    const sameKey = record.requestKey === input.request.requestKey;
    if (sameKey && existing.requestDigest !== digest)
      return refused(
        'request-key-mismatch',
        'This request key was used for a different settlement request.',
        record,
      );
    if (input.request.outcome !== 'discarded')
      return refused(
        'settlement-pending',
        'A discard of this worktree started and has not been recorded yet; only completing it can settle this Session.',
        record,
      );
    return this.completeDiscard(
      input.metadata,
      existing,
      sameKey ? 'recorded' : 'existing',
    );
  }

  private async discard(
    input: SettleInput,
    request: Extract<WorktreeOutputSettlementRequest, { outcome: 'discarded' }>,
    digest: string,
  ): Promise<WorktreeOutputSettlementResult> {
    const inspection = await this.inspect(input);
    if (inspection.kind === 'refused') return inspection.result;
    const accept = request.acceptUncommittedLoss === true;
    if (inspection.dirty && !accept)
      return refused(
        'uncommitted-changes',
        'The worktree has uncommitted or untracked changes; send acceptUncommittedLoss to discard them.',
      );
    const pending = this.deps.store.insert({
      requestDigest: digest,
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
      // Only an intact worktree proves nothing was removed; otherwise the
      // intent stays, so a retry can still complete it.
      if (
        await this.deps.worktrees.isSessionWorktreeIntact(
          metadata,
          record.sessionId,
        )
      )
        this.deps.store.abandonPending(record.sessionId, record.requestKey);
      return refused(discardRefusal(result.reason), result.detail);
    }
    const settled = this.deps.store.settlePending({
      sessionId: record.sessionId,
      requestKey: record.requestKey,
      evidence: {
        ...record.evidence,
        hadUncommittedChanges:
          record.evidence.hadUncommittedChanges === true ||
          result.hadUncommittedChanges,
        removedWorktree: result.removedWorktree,
        removedBranch: result.removedBranch,
        ...(result.branchMoved ? { branchMoved: true } : {}),
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
    if (containment.kind === 'unresolvable')
      return refused(
        'base-unresolvable',
        `${input.metadata.baseRef} does not resolve to a commit in the repository.`,
      );
    if (containment.kind === 'not-contained')
      return refused(
        'base-does-not-contain-head',
        `${input.metadata.baseRef} (${containment.baseTip}) does not contain ${inspection.head}. A squash or rebase merge does not contain the branch head; record such a merge as released with its pull request.`,
      );
    return this.recordSettled(input, digest, inspection.head, {
      containingCommit: containment.baseTip,
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
    const read = await readPullRequestByIdentity(
      this.deps.pullRequestProviders,
      request.pullRequest,
    );
    if (read.kind !== 'current')
      return refused(
        'pull-request-unavailable',
        'Station could not read that pull request from its forge.',
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
    | { kind: 'present'; head: string; dirty: boolean }
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
    if (inspection.kind === 'unsafe-config')
      return {
        kind: 'refused',
        result: refused('unsafe-repository-config', inspection.detail),
      };
    return inspection;
  }

  private recordSettled(
    input: SettleInput,
    digest: string,
    head: string,
    evidence: WorktreeOutputSettlementEvidence,
  ): WorktreeOutputSettlementResult {
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

function discardRefusal(
  reason: Extract<SessionWorktreeDiscard, { kind: 'refused' }>['reason'],
): WorktreeOutputSettlementRefusal {
  return reason === 'unsafe-config' ? 'unsafe-repository-config' : reason;
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
