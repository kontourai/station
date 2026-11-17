/**
 * Station's own independent review of each new pull request head
 * (`reviewEachHead`, behind the `pull-request-head-review` preview).
 *
 * When an owned pull request has a head that has held still (seen on two
 * reads, or a turn finished after it was first seen) and the owning agent is
 * idle with nothing waiting for it, Station runs its existing independent
 * review (`ReviewEvidenceModule`) once for that head, against the Project's
 * own checkout. Task worktrees share the Project's object store, so a head
 * the agent committed here is local; a head that is not (pushed from
 * elsewhere) is never fetched: it reads "head-not-local" and is tried again
 * on a later read.
 *
 * - Range: base is the merge base of the head with the observed base commit
 *   (when local), else `origin/<base branch>`, else the Task's recorded base
 *   commit. A head whose previous reviewed head is its ancestor, and whose
 *   receipt had 1 to 100 findings, is a delta review from that head; a
 *   force-push starts an initial review again.
 * - Once per head: the request id is derived from the pull request and the
 *   head, the row is written before the review starts, and the review
 *   module's own submission store answers a repeated id with its record. A
 *   review left running by a restart reads "unknown" and never runs again by
 *   itself; Review again uses a new id.
 * - Bounded: one review per Project at a time, at most 10 per Project in 24
 *   hours, the module's own 10-minute reviewer window and 2 concurrent
 *   reviewers.
 * - Never writes to the forge: this module has no pull request provider;
 *   it only runs the review and reads its result. Required findings reach
 *   the agent through pull request feedback delivery (`review-findings`),
 *   under its caps.
 */
import { createHash } from 'node:crypto';
import type {
  PullRequestFeedbackObservation,
  PullRequestHeadReview,
  PullRequestHeadReviewFinding,
} from '@kontourai/station-contracts/pull-request-feedback';
import type {
  IndependentReviewReceipt,
  IndependentReviewRequest,
  IndependentReviewRequestStatus,
  ReviewFinding,
} from '@kontourai/station-contracts/review-evidence';
import { errorMessage } from '../../utils/error-message.js';
import { execGit } from '../../utils/git-exec.js';
import { readReviewRepositoryIdentity } from '../evidence/git-review-workspace-source.js';
import type { ReviewEvidenceModule } from '../evidence/review-evidence-module.js';
import type { StartOwnerAttribution } from '../orchestration/session-owner-attribution.js';
import { ownRepositoryGitArgs } from '../projects/git-read-repository.js';
import type { FeedbackSessionState } from './pull-request-feedback-delivery.js';
import type {
  PullRequestFeedbackClaim,
  PullRequestFeedbackStore,
  StoredHeadReview,
  StoredHeadReviewFinding,
} from './pull-request-feedback-store.js';

const REQUEST_PREFIX = 'prh-';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PER_PROJECT_PER_DAY = 10;
const MAX_STORED_FINDINGS = 100;
const GIT_TIMEOUT_MS = 30_000;
const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const REQUIRED_SEVERITY = new Set(['critical', 'high']);
const REQUIRED_CONFIDENCE = new Set(['high', 'medium']);
const CARRIED_OUTCOMES = new Set(['still-present', 'regressed']);

/** What a reviewer found that goes to the agent; the rest stays in Station. */
function requiredHeadReviewFinding(
  finding: Pick<ReviewFinding, 'severity' | 'confidence'>,
): boolean {
  return (
    REQUIRED_SEVERITY.has(finding.severity) &&
    REQUIRED_CONFIDENCE.has(finding.confidence)
  );
}

/** The owning chat as a head review needs it, read when one starts. */
export interface HeadReviewChat {
  projectSlug?: string;
  /** The agent that wrote the change; it never reviews its own work. */
  implementerAgentSlug?: string;
  ownerUserId?: string;
  ownerAttribution?: StartOwnerAttribution;
  /** The chat's Task's recorded base commit, the base of last resort. */
  taskBaseCommit?: string;
}

export interface PullRequestHeadReviewPorts {
  /** Both previews on. */
  enabled(): boolean;
  store(): PullRequestFeedbackStore | undefined;
  session(conversationId: string): FeedbackSessionState;
  /** When the owning chat's newest turn started or ended. */
  lastTurnAt(conversationId: string): number | undefined;
  mayContinue(conversationId: string, userId: string): boolean;
  chat(conversationId: string): HeadReviewChat;
  /** The Project's folder, when it has one. */
  projectRoot(projectSlug: string): string | undefined;
  /**
   * Who reviews this request: Repo Map selection when it is available, else
   * one `correctness` reviewer; undefined when there is none.
   */
  reviewers(
    request: IndependentReviewRequest,
  ): Promise<
    Pick<IndependentReviewRequest, 'reviewers' | 'selection'> | undefined
  >;
  /** Bound once the review module is composed; undefined until then. */
  reviews(): Pick<ReviewEvidenceModule, 'run' | 'status' | 'read'> | undefined;
  delivery(): { deliver(conversationId: string): Promise<unknown> } | undefined;
  readonly logger: {
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  now?(): number;
}

export type HeadReviewStart =
  | 'started'
  | 'not-eligible'
  | 'project-busy'
  | 'daily-limit'
  | 'running'
  | StoredHeadReview['state'];

/** A review whose pull request, switch, head or owner changed under it. */
class HeadReviewSuperseded extends Error {
  constructor() {
    super('The pull request moved on before this review finished.');
    this.name = 'HeadReviewSuperseded';
  }
}

const short = (sha: string) => sha.slice(0, 7);
const keyOf = (prKey: string, headSha: string) => `${prKey}\u0000${headSha}`;

/** Submitted to the review module (or tried to be): final for its head. */
const submitted = (review: StoredHeadReview) => review.requestId !== undefined;

function requestIdFor(prKey: string, headSha: string, rerun: number): string {
  const base = `${REQUEST_PREFIX}${createHash('sha256')
    .update(`${prKey}\u0000${headSha}`)
    .digest('hex')
    .slice(0, 40)}`;
  return rerun > 0 ? `${base}:rerun:${rerun}` : base;
}

/** git in the Project's own repository: reads only, never a fetch. */
async function projectRepository(root: string) {
  const repository = await ownRepositoryGitArgs(root, root);
  const git = (args: string[]) =>
    execGit([...repository.args, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
    });
  const commit = async (revision: string) => {
    try {
      const sha = (
        await git(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`])
      ).stdout.trim();
      return SHA.test(sha) ? sha : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    identity: () => readReviewRepositoryIdentity(root),
    commit,
    mergeBase: async (a: string, b: string) => {
      try {
        const sha = (await git(['merge-base', a, b])).stdout.trim();
        return SHA.test(sha) ? sha : undefined;
      } catch {
        return undefined;
      }
    },
    isAncestor: async (ancestor: string, descendant: string) => {
      try {
        await git(['merge-base', '--is-ancestor', ancestor, descendant]);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function storedFinding(
  finding: ReviewFinding,
  required: boolean,
): StoredHeadReviewFinding {
  return {
    id: finding.findingId,
    file: finding.location.file,
    line: finding.location.line,
    severity: finding.severity,
    confidence: finding.confidence,
    basis: finding.basis,
    summary: finding.summary,
    stateOrInput: finding.scenario.stateOrInput,
    wrongOutcome: finding.scenario.wrongOutcome,
    required,
  };
}

export class PullRequestHeadReviewer {
  /** Heads whose review this process is running. */
  private readonly running = new Set<string>();
  /** Projects with a review starting or running: one at a time each. */
  private readonly busyProjects = new Set<string>();
  /** Pull requests being considered, so two triggers never both start one. */
  private readonly considering = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly ports: PullRequestHeadReviewPorts) {}

  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }

  /** Every review this process started has settled (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight]);
  }

  /**
   * After a read or a delivery decision: start a review for each of the
   * conversation's pull requests whose head is due one. Never throws.
   */
  async consider(conversationId: string): Promise<void> {
    try {
      if (!this.ports.enabled()) return;
      const store = this.ports.store();
      if (!store) return;
      await this.reconcile(store);
      for (const claim of store.claimsForConversation(conversationId)) {
        if (!claim.settings.reviewEachHead) continue;
        const stored = store.observation(claim.prKey);
        const observation = stored?.observation;
        if (
          !stored ||
          !observation ||
          observation.state !== 'OPEN' ||
          observation.draft ||
          claim.condition?.state === 'closed'
        )
          continue;
        const existing = store.headReview(claim.prKey, observation.headSha);
        if (existing && submitted(existing)) continue;
        // The head has held still: read twice, or a turn ended after it
        // was first seen.
        const first = Date.parse(stored.headFirstSeenAt ?? stored.observedAt);
        const lastTurn = this.ports.lastTurnAt(conversationId);
        if (
          !(Date.parse(stored.observedAt) > first) &&
          !(lastTurn !== undefined && lastTurn > first)
        )
          continue;
        if (!this.agentIdle(store, conversationId)) continue;
        await this.start(store, claim, observation, existing);
      }
    } catch (error) {
      this.ports.logger.warn('Pull request head review failed', {
        conversationId,
        error: errorMessage(error),
      });
    }
  }

  /** Idle, not waiting on a person, and nothing sent or waiting to be. */
  private agentIdle(store: PullRequestFeedbackStore, conversationId: string) {
    return (
      this.ports.session(conversationId).state === 'idle' &&
      !store.openBatch(conversationId) &&
      store.pendingDeliveries(conversationId).length === 0
    );
  }

  /**
   * A person's Review again: the current head, under a new request id when
   * it was already submitted. The agent need not be idle; every bound still
   * holds.
   */
  async reviewAgain(prKey: string): Promise<HeadReviewStart> {
    const store = this.ports.store();
    if (!store || !this.ports.enabled()) return 'not-eligible';
    await this.reconcile(store);
    const claim = store.claim(prKey);
    const observation = store.observation(prKey)?.observation;
    if (
      !claim?.settings.reviewEachHead ||
      !observation ||
      observation.state !== 'OPEN' ||
      observation.draft
    )
      return 'not-eligible';
    const existing = store.headReview(prKey, observation.headSha);
    if (this.running.has(keyOf(prKey, observation.headSha))) return 'running';
    return this.start(store, claim, observation, existing, true);
  }

  /**
   * A person's Send to agent: the current head's required findings go out
   * even with "Address review comments" off, under the same caps.
   */
  async sendFindings(prKey: string): Promise<'queued' | 'nothing'> {
    const store = this.ports.store();
    if (!store || !this.ports.enabled()) return 'nothing';
    const claim = store.claim(prKey);
    const head = store.observation(prKey)?.observation.headSha;
    const review = head ? store.headReview(prKey, head) : undefined;
    if (!claim || review?.state !== 'reviewed' || !review.requiredIds.length)
      return 'nothing';
    store.writeHeadReview({
      ...review,
      sendRequestedAt: new Date(this.now()).toISOString(),
    });
    await this.ports.delivery()?.deliver(claim.conversationId);
    return 'queued';
  }

  /** The newest head review, as a reader of the owning chat sees it. */
  view(prKey: string): PullRequestHeadReview | undefined {
    if (!this.ports.enabled()) return undefined;
    const store = this.ports.store();
    const review = store?.headReviews(prKey)[0];
    if (!store || !review) return undefined;
    const state: PullRequestHeadReview['state'] =
      review.state === 'running'
        ? this.running.has(keyOf(prKey, review.headSha))
          ? 'reviewing'
          : 'unknown'
        : review.state;
    const sent = store
      .deliveriesForPullRequest(prKey, 200)
      .find(
        (delivery) =>
          delivery.category === 'review-findings' &&
          delivery.headSha === review.headSha &&
          delivery.state !== 'superseded' &&
          delivery.state !== 'dismissed',
      );
    return {
      headSha: review.headSha,
      state,
      at: review.settledAt ?? review.startedAt,
      ...(review.mode ? { mode: review.mode } : {}),
      ...(review.state === 'reviewed'
        ? {
            findings: review.findings.map((finding) => ({
              file: finding.file,
              line: finding.line,
              severity:
                finding.severity as PullRequestHeadReviewFinding['severity'],
              confidence:
                finding.confidence as PullRequestHeadReviewFinding['confidence'],
              summary: finding.summary,
              required: finding.required,
              ...(finding.carried ? { carried: true as const } : {}),
            })),
            required: review.requiredIds.length,
            others: review.others,
          }
        : {}),
      ...(review.failureReason && state !== 'unknown'
        ? { failureReason: review.failureReason }
        : {}),
      ...(sent
        ? {
            delivery: {
              state:
                sent.state === 'sent'
                  ? ('sent' as const)
                  : sent.state === 'pending'
                    ? ('held' as const)
                    : ('queued' as const),
              at: sent.settledAt ?? sent.createdAt,
            },
          }
        : {}),
    };
  }

  /**
   * A review left running by an earlier process: its result if the review
   * module recorded one, otherwise unknown. Never run again by itself.
   */
  private async reconcile(store: PullRequestFeedbackStore): Promise<void> {
    for (const review of store.runningHeadReviews()) {
      if (this.running.has(keyOf(review.prKey, review.headSha))) continue;
      let status: IndependentReviewRequestStatus | null = null;
      try {
        status =
          review.requestId && review.projectSlug
            ? ((await this.ports
                .reviews()
                ?.status(review.requestId, review.projectSlug)) ?? null)
            : null;
      } catch {
        status = null;
      }
      if (this.running.has(keyOf(review.prKey, review.headSha))) continue;
      if (status && status.state !== 'running')
        this.settle(store, review, status);
      else
        store.writeHeadReview({
          ...review,
          state: 'unknown',
          settledAt: new Date(this.now()).toISOString(),
        });
    }
  }

  private async start(
    store: PullRequestFeedbackStore,
    claim: PullRequestFeedbackClaim,
    observation: PullRequestFeedbackObservation,
    existing: StoredHeadReview | undefined,
    manual = false,
  ): Promise<HeadReviewStart> {
    if (this.considering.has(claim.prKey)) return 'running';
    this.considering.add(claim.prKey);
    try {
      return await this.prepare(store, claim, observation, existing, manual);
    } finally {
      this.considering.delete(claim.prKey);
    }
  }

  private async prepare(
    store: PullRequestFeedbackStore,
    claim: PullRequestFeedbackClaim,
    observation: PullRequestFeedbackObservation,
    existing: StoredHeadReview | undefined,
    manual: boolean,
  ): Promise<HeadReviewStart> {
    const reviews = this.ports.reviews();
    if (!reviews) return 'not-eligible';
    const conversationId = claim.conversationId;
    const headSha = observation.headSha;
    const nowIso = new Date(this.now()).toISOString();
    const rerun = existing ? existing.rerun + (submitted(existing) ? 1 : 0) : 0;
    // A re-run of a head that was never submitted keeps the first id.
    if (!manual && existing && submitted(existing)) return 'not-eligible';
    const row: StoredHeadReview = {
      prKey: claim.prKey,
      headSha,
      state: 'running',
      findings: [],
      requiredIds: [],
      others: 0,
      startedAt: nowIso,
      rerun,
    };
    /** Not submitted: tried again on a later read. */
    const halt = (
      state: 'head-not-local' | 'no-reviewer' | 'not-verified',
      failureReason: string,
    ) => {
      store.writeHeadReview({
        ...row,
        state,
        failureReason,
        settledAt: nowIso,
      });
      return state;
    };
    const chat = this.ports.chat(conversationId);
    if (
      !chat.ownerUserId ||
      !this.ports.mayContinue(conversationId, chat.ownerUserId) ||
      !this.ports.mayContinue(conversationId, claim.enabledBy)
    )
      // Who turned it on may no longer send to this chat: nothing runs
      // for them, and the feedback line already says so.
      return 'not-eligible';
    if (!chat.projectSlug)
      return halt(
        'not-verified',
        'This chat has no Project, so Station has no checkout to review.',
      );
    if (!chat.implementerAgentSlug)
      return halt(
        'not-verified',
        "Station can't tell which agent wrote this change.",
      );
    const projectSlug = chat.projectSlug;
    if (this.busyProjects.has(projectSlug)) return 'project-busy';
    this.busyProjects.add(projectSlug);
    let handedOff = false;
    try {
      if (
        store.headReviewsStartedSince(
          projectSlug,
          new Date(this.now() - DAY_MS).toISOString(),
        ) >= MAX_PER_PROJECT_PER_DAY
      )
        return 'daily-limit';
      const root = this.ports.projectRoot(projectSlug);
      if (!root)
        return halt('not-verified', "This chat's Project has no folder.");
      let repository: Awaited<ReturnType<typeof projectRepository>>;
      try {
        repository = await projectRepository(root);
      } catch {
        return halt(
          'not-verified',
          "Station can't read this Project's git repository.",
        );
      }
      const { host, repository: repo } = claim.identity;
      const expected = `${host}/${repo.owner}/${repo.name}`.toLowerCase();
      if ((await repository.identity()) !== expected)
        return halt(
          'not-verified',
          `This Project's repository is not ${repo.owner}/${repo.name}.`,
        );
      const head = await repository.commit(headSha);
      if (head !== headSha)
        return halt(
          'head-not-local',
          `Head ${short(headSha)} isn't on this Station yet.`,
        );
      const range = await this.range(store, claim, observation, repository, {
        projectSlug,
        taskBaseCommit: chat.taskBaseCommit,
      });
      if (!range)
        return halt(
          'not-verified',
          "Station can't find this pull request's base branch here.",
        );
      const requestId = requestIdFor(claim.prKey, headSha, rerun);
      const request: IndependentReviewRequest = {
        requestId,
        mode: range.delta ? 'delta' : 'initial',
        target: {
          kind: 'git-range',
          projectSlug,
          baseRevision: range.baseSha,
          headRevision: headSha,
        },
        implementerAgentSlug: chat.implementerAgentSlug,
        reviewers: [],
        selection: { kind: 'repo-map' },
        ...(range.delta ? { delta: range.delta } : {}),
      };
      const who = await this.ports.reviewers(request);
      if (!who)
        return halt(
          'no-reviewer',
          'No reviewer agent can review this Project read-only.',
        );
      const { selection: _selection, ...rest } = request;
      const planned: IndependentReviewRequest = {
        ...rest,
        reviewers: who.reviewers,
        ...(who.selection ? { selection: who.selection } : {}),
      };
      const started: StoredHeadReview = {
        ...row,
        requestId,
        projectSlug,
        mode: planned.mode,
        baseSha: range.baseSha,
        ...(range.delta ? { priorReceiptId: range.delta.priorReceiptId } : {}),
      };
      store.writeHeadReview(started);
      const key = keyOf(claim.prKey, headSha);
      this.running.add(key);
      handedOff = true;
      const run = this.execute(store, claim, started, planned, chat)
        .catch((error) =>
          this.ports.logger.warn('Pull request head review failed', {
            conversationId,
            error: errorMessage(error),
          }),
        )
        .finally(() => {
          this.running.delete(key);
          this.busyProjects.delete(projectSlug);
          this.inFlight.delete(run);
        });
      this.inFlight.add(run);
      return 'started';
    } finally {
      if (!handedOff) this.busyProjects.delete(projectSlug);
    }
  }

  /**
   * The review range, never fetching. Delta from the previous reviewed
   * head when it is this head's ancestor and its receipt had 1 to 100
   * findings; otherwise from the merge base with the pull request's base.
   */
  private async range(
    store: PullRequestFeedbackStore,
    claim: PullRequestFeedbackClaim,
    observation: PullRequestFeedbackObservation,
    repository: Awaited<ReturnType<typeof projectRepository>>,
    input: { projectSlug: string; taskBaseCommit?: string },
  ): Promise<
    | {
        baseSha: string;
        delta?: { priorReceiptId: string; claimedFindingIds: string[] };
      }
    | undefined
  > {
    const headSha = observation.headSha;
    const prior = store
      .headReviews(claim.prKey)
      .find(
        (review) =>
          review.headSha !== headSha &&
          review.state === 'reviewed' &&
          review.receiptId &&
          review.projectSlug === input.projectSlug,
      );
    if (prior?.receiptId) {
      let receipt: IndependentReviewReceipt | null = null;
      try {
        receipt =
          (await this.ports
            .reviews()
            ?.read(prior.receiptId, input.projectSlug)) ?? null;
      } catch {
        receipt = null;
      }
      if (
        receipt &&
        receipt.findings.length >= 1 &&
        receipt.findings.length <= 100 &&
        receipt.target.headSha === prior.headSha &&
        (await repository.isAncestor(prior.headSha, headSha))
      )
        return {
          baseSha: prior.headSha,
          delta: {
            priorReceiptId: receipt.receiptId,
            claimedFindingIds: receipt.findings.map(
              (finding) => finding.findingId,
            ),
          },
        };
    }
    const candidates = [
      observation.baseSha,
      BRANCH.test(observation.baseRefName)
        ? `refs/remotes/origin/${observation.baseRefName}`
        : undefined,
      input.taskBaseCommit,
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const base = await repository.commit(candidate);
      if (!base) continue;
      const mergeBase = await repository.mergeBase(headSha, base);
      if (mergeBase && mergeBase !== headSha) return { baseSha: mergeBase };
    }
    return undefined;
  }

  private async execute(
    store: PullRequestFeedbackStore,
    claim: PullRequestFeedbackClaim,
    row: StoredHeadReview,
    request: IndependentReviewRequest,
    chat: HeadReviewChat,
  ): Promise<void> {
    const reviews = this.ports.reviews();
    const ownerUserId = chat.ownerUserId!;
    const assertCurrent = () => {
      const latest = store.claim(claim.prKey);
      const observation = store.observation(claim.prKey)?.observation;
      if (
        !this.ports.enabled() ||
        !latest ||
        latest.conversationId !== claim.conversationId ||
        latest.generation !== claim.generation ||
        !latest.settings.reviewEachHead ||
        observation?.state !== 'OPEN' ||
        observation.headSha !== row.headSha ||
        !this.ports.mayContinue(claim.conversationId, ownerUserId)
      )
        throw new HeadReviewSuperseded();
    };
    try {
      if (!reviews) throw new Error('The review module is unavailable.');
      const status = await reviews.run(request, {
        requestedBy: { actorId: ownerUserId },
        userId: ownerUserId,
        ...(chat.ownerAttribution
          ? { ownerAttribution: chat.ownerAttribution }
          : {}),
        assertCurrent,
      });
      this.settle(store, row, status);
    } catch (error) {
      let superseded = error instanceof HeadReviewSuperseded;
      if (!superseded)
        try {
          assertCurrent();
        } catch {
          superseded = true;
        }
      store.writeHeadReview({
        ...row,
        ...(superseded
          ? {
              state: 'not-verified',
              failureReason:
                'The pull request moved on before the review finished.',
            }
          : { state: 'unknown' }),
        settledAt: new Date(this.now()).toISOString(),
      });
      if (!superseded) throw error;
    } finally {
      await this.ports.delivery()?.deliver(claim.conversationId);
    }
  }

  /** Record how the review ended, and which findings go to the agent. */
  private settle(
    store: PullRequestFeedbackStore,
    row: StoredHeadReview,
    status: IndependentReviewRequestStatus,
  ): void {
    const settledAt = new Date(this.now()).toISOString();
    const receipt = status.result?.receipt;
    if (status.state !== 'completed' || !receipt) {
      store.writeHeadReview({
        ...row,
        ...(status.state === 'not-verified'
          ? {
              state: 'not-verified',
              failureReason:
                status.failureReason ?? 'Station could not review this head.',
            }
          : { state: 'unknown' }),
        settledAt,
      });
      return;
    }
    const own = receipt.findings.map((finding) =>
      storedFinding(finding, requiredHeadReviewFinding(finding)),
    );
    // Earlier heads' findings, by id, for a delta review's assessments.
    const known = new Map<string, StoredHeadReviewFinding>();
    for (const earlier of store.headReviews(row.prKey))
      for (const finding of earlier.findings)
        if (!known.has(finding.id)) known.set(finding.id, finding);
    const carried: StoredHeadReviewFinding[] = [];
    for (const assessment of receipt.deltaAssessments) {
      if (!CARRIED_OUTCOMES.has(assessment.outcome)) continue;
      const prior = known.get(assessment.priorFindingId);
      if (
        !prior ||
        !requiredHeadReviewFinding(
          prior as Pick<ReviewFinding, 'severity' | 'confidence'>,
        ) ||
        carried.some((finding) => finding.id === prior.id)
      )
        continue;
      carried.push({ ...prior, required: true, carried: true });
    }
    const required = [...own.filter((f) => f.required), ...carried];
    const others = own.filter((finding) => !finding.required);
    store.writeHeadReview({
      ...row,
      state: 'reviewed',
      receiptId: receipt.receiptId,
      findings: [...required, ...others].slice(0, MAX_STORED_FINDINGS),
      requiredIds: required.map((finding) => finding.id),
      others: others.length,
      settledAt,
    });
  }
}
