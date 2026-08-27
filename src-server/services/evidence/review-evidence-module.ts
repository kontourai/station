import {
  type IndependentReviewReceipt,
  type IndependentReviewRequest,
  type IndependentReviewRequestStatus,
  type IndependentReviewRunResult,
  parseIndependentReviewRequest,
  parseReviewerOutput,
  parseReviewGitTarget,
  parseReviewRoutingBinding,
  REVIEW_EVIDENCE_SCHEMA_VERSION,
  type ReviewActorIdentity,
  type ReviewEvidenceAggregate,
  type ReviewEvidenceUnavailableReason,
  type ReviewExecutionRecord,
  type ReviewFinding,
  type ReviewFindingLocation,
  type ReviewGitTarget,
  type ReviewGitTargetInput,
  type ReviewReviewerDeclaration,
  type ReviewRoutingBinding,
} from '@kontourai/station-contracts/review-evidence';
import { reviewEvidenceId } from './review-evidence-identity.js';

/**
 * A project with no configured `workingDirectory`. This is a normal state on
 * the Project contract (the field is optional), so the aggregate treats it as
 * "contributes no receipts", never as an unavailability or a failure — the
 * same posture flow reviews take (`survey-flow-review-service.ts` returns `[]`
 * for the identical condition).
 */
export class ReviewProjectWorkspaceMissingError extends Error {
  constructor(projectSlug: string) {
    super(`Project workspace not found: ${projectSlug}`);
    this.name = 'ReviewProjectWorkspaceMissingError';
  }
}

/** The cross-process receipt coordination lock could not be acquired. */
export class ReviewProjectLockUnavailableError extends Error {
  constructor(projectSlug: string, cause: unknown) {
    super(`Review evidence lock is unavailable for project: ${projectSlug}`, {
      cause,
    });
    this.name = 'ReviewProjectLockUnavailableError';
  }
}

export interface ReadOnlyReviewWorkspace {
  readonly root: string;
  readonly target: ReviewGitTarget;
  /** Refuses a model-authored location absent from the immutable head. */
  validateLocation(location: ReviewFindingLocation): Promise<void>;
  close(): Promise<void>;
}

/**
 * Produces an exact detached source tree. It has no mutation operation; the
 * execution Adapter separately enforces that the reviewer process receives a
 * read-only filesystem policy.
 */
export interface ReviewWorkspaceSource {
  open(
    input: IndependentReviewRequest['target'],
  ): Promise<ReadOnlyReviewWorkspace>;
}

export interface ReviewExecutionInput {
  requestId: string;
  reviewer: ResolvedReviewReviewer;
  workspace: ReadOnlyReviewWorkspace;
  prompt: string;
  signal: AbortSignal;
  context: ReviewExecutionContext;
}

export interface ResolvedReviewReviewer extends ReviewReviewerDeclaration {
  actor: ReviewActorIdentity;
}

export interface ReviewExecutionContext {
  requestedBy: { actorId: string; displayName?: string };
  userId?: string;
  tenantExecutionContext?: import('@kontourai/station-contracts/tenancy').TenantExecutionContext;
}

export type ReviewExecutionOutcome =
  | {
      kind: 'completed';
      output: unknown;
      workspaceRelease: 'safe' | 'retain';
    }
  | {
      kind: 'failed' | 'timed-out';
      reason: string;
      workspaceRelease: 'safe' | 'retain';
    };

/** Concrete Adapters must enforce this policy at the process/provider seam. */
export interface ReadOnlyReviewExecutor {
  readonly workspaceAccess: 'read-only';
  execute(input: ReviewExecutionInput): Promise<ReviewExecutionOutcome>;
}

export interface ReviewReceiptStore {
  write(
    receipt: Omit<IndependentReviewReceipt, 'receiptId'>,
  ): Promise<IndependentReviewReceipt>;
  read(
    receiptId: string,
    projectSlug: string,
  ): Promise<IndependentReviewReceipt | null>;
  list(projectSlug: string): Promise<IndependentReviewReceipt[]>;
  references(projectSlug: string): Promise<ReviewReceiptReference[]>;
}

export interface ReviewReceiptReference {
  receiptId: string;
  projectSlug: string;
  completedAt: string;
}

export type ReviewSubmissionAdmission =
  | { kind: 'acquired' }
  | { kind: 'existing'; status: IndependentReviewRequestStatus };

/** Durable idempotency authority composed before any reviewer invocation. */
export interface ReviewSubmissionStore {
  begin(input: {
    request: IndependentReviewRequest;
    startedAt: string;
  }): Promise<ReviewSubmissionAdmission>;
  invoking(input: {
    request: IndependentReviewRequest;
    updatedAt: string;
  }): Promise<void>;
  complete(input: {
    request: IndependentReviewRequest;
    result: IndependentReviewRunResult;
    completedAt: string;
  }): Promise<IndependentReviewRequestStatus>;
  fail(input: {
    request: IndependentReviewRequest;
    state: 'rejected' | 'indeterminate' | 'not-verified';
    updatedAt: string;
    unavailableLenses?: string[];
    failureReason?: string;
  }): Promise<IndependentReviewRequestStatus>;
  status(
    requestId: string,
    projectSlug: string,
    currentOwnerActive?: boolean,
  ): Promise<IndependentReviewRequestStatus | null>;
}

/** Server-only resolver for the `selection: { kind: 'repo-map' }` contract. */
export interface ReviewSelectionResolver {
  resolve(
    request: IndependentReviewRequest,
    context: { prior?: IndependentReviewReceipt },
  ): Promise<
    | {
        kind: 'selected';
        reviewers: ReviewReviewerDeclaration[];
        routing?: ReviewRoutingBinding;
        target?: ReviewGitTarget;
      }
    | { kind: 'unavailable'; reason: string; unavailableLenses: string[] }
  >;
}

export interface ReviewPrincipalAuthority {
  resolveAgent(agentSlug: string): Promise<ReviewActorIdentity | null>;
}

export interface ReviewEvidenceObserver {
  record(input: {
    operation: string;
    outcome: string;
    durationMs?: number;
  }): void;
  diagnostic(input: {
    operation: string;
    error: unknown;
    requestId?: string;
    projectSlug?: string;
  }): void;
}

export interface ReviewEvidenceAttachment {
  attach(input: {
    projectSlug: string;
    runId: string;
    gate: string;
    receipt: IndependentReviewReceipt;
  }): Promise<{ evidenceId: string }>;
}

export interface ReviewEvidenceModuleOptions {
  source: ReviewWorkspaceSource;
  executor: ReadOnlyReviewExecutor;
  receipts: ReviewReceiptStore;
  submissions: ReviewSubmissionStore;
  principals: ReviewPrincipalAuthority;
  observer: ReviewEvidenceObserver;
  attachment?: ReviewEvidenceAttachment;
  selectionResolver?: ReviewSelectionResolver;
  now?: () => Date;
  timeoutMs?: number;
  maxConcurrentReviewers?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_CONCURRENT_REVIEWERS = 2;
const MAX_REVIEW_PROJECTS = 256;
const MAX_AGGREGATE_RECEIPTS = 512;
const MAX_DELTA_ANCESTRY = 32;

/**
 * Runs independent reviews and emits durable evidence. It never evaluates a
 * gate and never turns findings or closure assessments into a verdict.
 */
export class ReviewEvidenceModule {
  readonly #source: ReviewWorkspaceSource;
  readonly #executor: ReadOnlyReviewExecutor;
  readonly #receipts: ReviewReceiptStore;
  readonly #submissions: ReviewSubmissionStore;
  readonly #principals: ReviewPrincipalAuthority;
  readonly #observer: ReviewEvidenceObserver;
  readonly #attachment?: ReviewEvidenceAttachment;
  readonly #selectionResolver?: ReviewSelectionResolver;
  readonly #now: () => Date;
  readonly #timeoutMs: number;
  readonly #maxConcurrentReviewers: number;
  readonly #inflight = new Map<
    string,
    Promise<IndependentReviewRequestStatus>
  >();

  constructor(options: ReviewEvidenceModuleOptions) {
    if (options.executor.workspaceAccess !== 'read-only') {
      throw new Error(
        'review executor must enforce read-only workspace access',
      );
    }
    this.#source = options.source;
    this.#executor = options.executor;
    this.#receipts = options.receipts;
    this.#submissions = options.submissions;
    this.#principals = options.principals;
    this.#observer = options.observer;
    this.#attachment = options.attachment;
    this.#selectionResolver = options.selectionResolver;
    this.#now = options.now ?? (() => new Date());
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxConcurrentReviewers =
      options.maxConcurrentReviewers ?? DEFAULT_MAX_CONCURRENT_REVIEWERS;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1_000) {
      throw new Error('review timeout must be at least one second');
    }
    if (
      !Number.isInteger(this.#maxConcurrentReviewers) ||
      this.#maxConcurrentReviewers < 1 ||
      this.#maxConcurrentReviewers > 8
    ) {
      throw new Error('review concurrency must be between one and eight');
    }
  }

  async run(
    value: unknown,
    context: ReviewExecutionContext,
  ): Promise<IndependentReviewRequestStatus> {
    const request = parseIndependentReviewRequest(value);
    const startedAt = this.#now().toISOString();
    const key = `${request.target.projectSlug}\0${request.requestId}`;
    const inflight = this.#inflight.get(key);
    if (inflight) return inflight;
    const execution = this.#admitAndRun(request, context, startedAt).finally(
      () => this.#inflight.delete(key),
    );
    this.#inflight.set(key, execution);
    return execution;
  }

  async #admitAndRun(
    request: IndependentReviewRequest,
    context: ReviewExecutionContext,
    startedAt: string,
  ): Promise<IndependentReviewRequestStatus> {
    const admission = await this.#submissions.begin({ request, startedAt });
    if (admission.kind === 'existing') return admission.status;
    return this.#runAcquired(request, context, startedAt);
  }

  status(
    requestId: string,
    projectSlug: string,
  ): Promise<IndependentReviewRequestStatus | null> {
    return this.#submissions.status(
      requestId,
      projectSlug,
      this.#inflight.has(`${projectSlug}\0${requestId}`),
    );
  }

  async #runAcquired(
    request: IndependentReviewRequest,
    context: ReviewExecutionContext,
    startedAt: string,
  ): Promise<IndependentReviewRequestStatus> {
    const operationStarted = Date.now();
    let workspace: ReadOnlyReviewWorkspace | undefined;
    let reviewerBoundaryEntered = false;
    let retainWorkspace = false;
    let cleanup: IndependentReviewRunResult['cleanup'] = {
      status: 'completed',
    };
    try {
      const prior = await this.#resolvePrior(request);
      if (
        prior &&
        (prior.findings.length === 0 || prior.findings.length > 100)
      ) {
        const status = await this.#submissions.fail({
          request,
          state: 'not-verified',
          updatedAt: this.#now().toISOString(),
          unavailableLenses: ['human-review'],
          failureReason:
            'Prior review coverage is unavailable for automatic delta review.',
        });
        this.#record('run', 'not-verified', operationStarted);
        return status;
      }
      const selected = await this.#selectReviewers(request, prior);
      if (selected.kind === 'unavailable') {
        const status = await this.#submissions.fail({
          request,
          state: 'not-verified',
          updatedAt: this.#now().toISOString(),
          unavailableLenses: selected.unavailableLenses,
          failureReason: selected.reason,
        });
        this.#record('run', 'not-verified', operationStarted);
        return status;
      }
      const executableRequest: IndependentReviewRequest = {
        ...request,
        target: selected.target
          ? pinnedTarget(request.target, selected.target)
          : request.target,
        reviewers: selected.reviewers,
        selection: undefined,
        ...(prior && request.delta
          ? {
              delta: {
                priorReceiptId: request.delta.priorReceiptId,
                claimedFindingIds: prior.findings.map(
                  (finding) => finding.findingId,
                ),
              },
            }
          : {}),
      };
      const [implementer, reviewers] = await Promise.all([
        this.#resolvePrincipal(executableRequest.implementerAgentSlug),
        Promise.all(
          selected.reviewers.map(async (reviewer) => ({
            ...reviewer,
            actor: await this.#resolvePrincipal(reviewer.executorAgentSlug),
          })),
        ),
      ]);
      workspace = await this.#source.open(executableRequest.target);
      if (selected.target && !sameTarget(workspace.target, selected.target)) {
        throw new Error('review workspace target changed after routing');
      }
      if (
        executableRequest.mode === 'delta' &&
        prior &&
        workspace.target.baseSha !== prior.target.headSha
      ) {
        throw new Error(
          'delta review base must be the exact head of its prior receipt',
        );
      }
      await this.#submissions.invoking({
        request,
        updatedAt: this.#now().toISOString(),
      });
      reviewerBoundaryEntered = true;
      const reviewerOutcomes = await mapConcurrent(
        reviewers,
        this.#maxConcurrentReviewers,
        (reviewer) =>
          this.#executeReviewer({
            request: executableRequest,
            requestId: executableRequest.requestId,
            reviewer,
            workspace: workspace!,
            prior,
            context,
          }),
      );
      retainWorkspace = reviewerOutcomes.some(
        (outcome) => outcome.workspaceRelease === 'retain',
      );
      const executions = reviewerOutcomes.map((outcome) => outcome.record);
      const completedAt = this.#now().toISOString();
      const receipt = await this.#receipts.write({
        schemaVersion: REVIEW_EVIDENCE_SCHEMA_VERSION,
        requestId: executableRequest.requestId,
        mode: executableRequest.mode,
        target: workspace.target,
        requestedBy: context.requestedBy,
        implementer,
        ...(executableRequest.delta ? { delta: executableRequest.delta } : {}),
        ...(selected.routing ? { routing: selected.routing } : {}),
        startedAt,
        completedAt,
        executions,
        findings: executions.flatMap((execution) => execution.findings),
        deltaAssessments: executions.flatMap(
          (execution) => execution.deltaAssessments,
        ),
        interpretation: {
          kind: 'review-findings',
          decision: 'input-only',
          gateVerdict: null,
        },
      });
      const partialResult = {
        receipt,
        attachment: await this.#attach(executableRequest, receipt),
      };
      if (retainWorkspace) {
        cleanup = {
          status: 'retained',
          reason:
            'The isolated workspace was retained because a reviewer process did not confirm shutdown.',
        };
      } else {
        try {
          await workspace.close();
          workspace = undefined;
        } catch (error) {
          this.#diagnostic('workspace.close', error, request);
          cleanup = {
            status: 'unavailable',
            reason: 'The isolated review workspace could not be removed.',
          };
        }
      }
      const result: IndependentReviewRunResult = { ...partialResult, cleanup };
      const completed = await this.#submissions.complete({
        request,
        result,
        completedAt: this.#now().toISOString(),
      });
      this.#record('run', 'completed', operationStarted);
      return completed;
    } catch (error) {
      this.#diagnostic('run', error, request);
      if (workspace && !retainWorkspace && !reviewerBoundaryEntered) {
        try {
          await workspace.close();
        } catch (cleanupError) {
          this.#diagnostic('workspace.close', cleanupError, request);
        }
      }
      const state = reviewerBoundaryEntered ? 'indeterminate' : 'rejected';
      const status = await this.#submissions.fail({
        request,
        state,
        updatedAt: this.#now().toISOString(),
      });
      this.#record('run', state, operationStarted);
      return status;
    }
  }

  async #selectReviewers(
    request: IndependentReviewRequest,
    prior?: IndependentReviewReceipt,
  ): Promise<
    | {
        kind: 'selected';
        reviewers: ReviewReviewerDeclaration[];
        routing?: ReviewRoutingBinding;
        target?: ReviewGitTarget;
      }
    | { kind: 'unavailable'; reason: string; unavailableLenses: string[] }
  > {
    if (!request.selection) {
      if (!request.reviewers.length) {
        return {
          kind: 'unavailable',
          reason: 'The review request has no reviewer declarations.',
          unavailableLenses: ['human-review'],
        };
      }
      return { kind: 'selected', reviewers: request.reviewers };
    }
    if (!this.#selectionResolver) {
      return {
        kind: 'unavailable',
        reason: 'Repo Map review routing is unavailable.',
        unavailableLenses: ['human-review'],
      };
    }
    const result = await this.#selectionResolver.resolve(request, { prior });
    if (result.kind === 'unavailable') return result;
    if (!result.reviewers.length) {
      return {
        kind: 'unavailable',
        reason: 'Repo Map review routing did not select any reviewers.',
        unavailableLenses: ['human-review'],
      };
    }
    let target: ReviewGitTarget;
    let routing: ReviewRoutingBinding;
    try {
      if (!result.target || !result.routing) throw new Error('missing binding');
      target = parseReviewGitTarget(
        result.target,
        'Repo Map review routing target',
      );
      routing = parseReviewRoutingBinding(
        result.routing,
        'Repo Map review routing',
      );
      if (
        target.projectSlug !== request.target.projectSlug ||
        target.baseSha === target.headSha
      ) {
        throw new Error('target project does not match request');
      }
    } catch {
      return {
        kind: 'unavailable',
        reason:
          'Repo Map review routing did not provide a valid immutable target and policy binding.',
        unavailableLenses: ['human-review'],
      };
    }
    if (result.reviewers.length > 8) {
      return {
        kind: 'unavailable',
        reason: 'Repo Map review routing exceeded the reviewer limit.',
        unavailableLenses: ['human-review'],
      };
    }
    const agents = result.reviewers.map(
      (reviewer) => reviewer.executorAgentSlug,
    );
    if (new Set(agents).size !== agents.length) {
      return {
        kind: 'unavailable',
        reason:
          'Repo Map review routing could not allocate independent reviewers.',
        unavailableLenses: ['human-review'],
      };
    }
    return { ...result, target, routing };
  }

  read(
    receiptId: string,
    projectSlug: string,
  ): Promise<IndependentReviewReceipt | null> {
    return this.#receipts.read(receiptId, projectSlug);
  }

  list(projectSlug: string): Promise<IndependentReviewReceipt[]> {
    return this.#receipts.list(projectSlug);
  }

  /**
   * Total over the project inventory: one project's unreadable receipts never
   * fail the aggregate. A missing workspace contributes nothing silently (a
   * normal configured state); every other per-project failure contributes an
   * `unavailableProjects` entry with a stable reason class. The read path
   * still takes the store's coordination lock (the reference read can repair
   * a stale index, which is a write); on lock timeout the project is reported
   * unavailable rather than served a lock-free racy read, and the next
   * refresh retries. Nothing bounds how long the peer holds it: an index
   * repair reads every receipt in the project under the lock, so a slow
   * repair and a genuinely stuck peer are indistinguishable from here — which
   * is why the reason this reports must not promise the operator a second
   * process to go find. Write-path locking is unchanged.
   */
  async listAll(
    projectSlugs: readonly string[],
  ): Promise<ReviewEvidenceAggregate> {
    const uniqueProjectSlugs = [...new Set(projectSlugs)].sort();
    if (uniqueProjectSlugs.length > MAX_REVIEW_PROJECTS) {
      throw new Error('Review evidence Project inventory exceeds the limit.');
    }
    const unavailable = new Map<string, ReviewEvidenceUnavailableReason>();
    const markUnavailable = (projectSlug: string, error: unknown): void => {
      const reason = classifyProjectUnavailability(error);
      unavailable.set(projectSlug, reason);
      this.#record('listAll.project', reason);
      try {
        this.#observer.diagnostic({
          operation: 'listAll.project',
          error,
          projectSlug,
        });
      } catch {}
    };
    const missingWorkspaces = new Set<string>();
    const references: ReviewReceiptReference[] = [];
    for (const projectSlug of uniqueProjectSlugs) {
      try {
        references.push(...(await this.#receipts.references(projectSlug)));
      } catch (error) {
        if (error instanceof ReviewProjectWorkspaceMissingError) {
          missingWorkspaces.add(projectSlug);
          continue;
        }
        markUnavailable(projectSlug, error);
      }
    }
    const selected = references
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt))
      .slice(0, MAX_AGGREGATE_RECEIPTS);
    const receipts: IndependentReviewReceipt[] = [];
    for (const reference of selected) {
      if (
        unavailable.has(reference.projectSlug) ||
        missingWorkspaces.has(reference.projectSlug)
      ) {
        continue;
      }
      try {
        const receipt = await this.#receipts.read(
          reference.receiptId,
          reference.projectSlug,
        );
        if (!receipt) {
          throw new Error('Review receipt index references missing evidence.');
        }
        receipts.push(receipt);
      } catch (error) {
        // A workspace that vanishes from the resolver between the reference
        // read and this read is the same NORMAL missing-workspace state, not
        // an unavailability — keep the two phases classifying identically.
        if (error instanceof ReviewProjectWorkspaceMissingError) {
          missingWorkspaces.add(reference.projectSlug);
          continue;
        }
        markUnavailable(reference.projectSlug, error);
      }
    }
    return {
      // A project that failed mid-read contributes zero receipts, not a
      // partial slice that would misrepresent its evidence inventory.
      receipts: receipts.filter(
        (receipt) =>
          !unavailable.has(receipt.target.projectSlug) &&
          !missingWorkspaces.has(receipt.target.projectSlug),
      ),
      unavailableProjects: [...unavailable]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([projectSlug, reason]) => ({ projectSlug, reason })),
    };
  }

  async #resolvePrincipal(agentSlug: string): Promise<ReviewActorIdentity> {
    const actor = await this.#principals.resolveAgent(agentSlug);
    if (!actor || actor.actorId !== `agent:${agentSlug}`) {
      throw new Error('Review Agent identity is unavailable.');
    }
    return actor;
  }

  async #resolvePrior(
    request: IndependentReviewRequest,
  ): Promise<IndependentReviewReceipt | undefined> {
    if (!request.delta) return undefined;
    const prior = await this.#receipts.read(
      request.delta.priorReceiptId,
      request.target.projectSlug,
    );
    if (!prior) throw new Error('prior review receipt was not found');
    if (prior.target.projectSlug !== request.target.projectSlug) {
      throw new Error('delta review project does not match its prior receipt');
    }
    const findings = await this.#effectiveFindings(
      prior,
      request.target.projectSlug,
      new Set(),
      0,
    );
    if (findings.length > 100) {
      throw new Error(
        'delta review effective finding coverage exceeds the limit',
      );
    }
    const priorFindingIds = new Set(
      findings.map((finding) => finding.findingId),
    );
    const absent = request.delta.claimedFindingIds.find(
      (findingId) => !priorFindingIds.has(findingId),
    );
    if (absent) {
      throw new Error(
        `delta review references unknown prior finding: ${absent}`,
      );
    }
    return { ...prior, findings };
  }

  async #effectiveFindings(
    receipt: IndependentReviewReceipt,
    projectSlug: string,
    seen: Set<string>,
    depth: number,
  ): Promise<ReviewFinding[]> {
    if (depth >= MAX_DELTA_ANCESTRY || seen.has(receipt.receiptId)) {
      throw new Error('delta review receipt ancestry is invalid');
    }
    seen.add(receipt.receiptId);
    try {
      if (!receipt.delta) return receipt.findings;
      const parent = await this.#receipts.read(
        receipt.delta.priorReceiptId,
        projectSlug,
      );
      if (!parent || parent.target.projectSlug !== projectSlug) {
        throw new Error('delta review receipt ancestry is unavailable');
      }
      const effective = new Map(
        (
          await this.#effectiveFindings(parent, projectSlug, seen, depth + 1)
        ).map((finding) => [finding.findingId, finding]),
      );
      const assessments = new Map(
        receipt.deltaAssessments.map((assessment) => [
          `${assessment.reviewerId}\0${assessment.priorFindingId}`,
          assessment,
        ]),
      );
      if (
        assessments.size !== receipt.deltaAssessments.length ||
        receipt.delta.claimedFindingIds.some(
          (findingId) => !effective.has(findingId),
        ) ||
        [...assessments.values()].some(
          (assessment) =>
            !receipt.executions.some(
              (execution) => execution.reviewerId === assessment.reviewerId,
            ) ||
            !receipt.delta?.claimedFindingIds.includes(
              assessment.priorFindingId,
            ),
        )
      ) {
        throw new Error('delta review receipt ancestry is ambiguous');
      }
      // Assessments are disposition evidence, not identity deletion. Keeping a
      // closed finding lets a later reviewer name a concrete regression, and
      // avoids one closed assessment erasing conflicting evidence.
      for (const finding of receipt.findings) {
        if (effective.has(finding.findingId)) {
          throw new Error('delta review receipt ancestry is ambiguous');
        }
        effective.set(finding.findingId, finding);
      }
      return [...effective.values()];
    } finally {
      seen.delete(receipt.receiptId);
    }
  }

  async #executeReviewer(input: {
    request: IndependentReviewRequest;
    requestId: string;
    reviewer: ResolvedReviewReviewer;
    workspace: ReadOnlyReviewWorkspace;
    prior: IndependentReviewReceipt | undefined;
    context: ReviewExecutionContext;
  }): Promise<{
    record: ReviewExecutionRecord;
    workspaceRelease: 'safe' | 'retain';
  }> {
    const startedAt = this.#now().toISOString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    timeout.unref?.();
    try {
      const execution = Promise.resolve()
        .then(() =>
          this.#executor.execute({
            requestId: input.requestId,
            reviewer: input.reviewer,
            workspace: input.workspace,
            prompt: reviewPrompt(input),
            signal: controller.signal,
            context: input.context,
          }),
        )
        .then(
          (outcome) => ({ kind: 'settled' as const, outcome }),
          () => ({ kind: 'threw' as const }),
        );
      const deadline = new Promise<{ kind: 'deadline' }>((resolve) => {
        if (controller.signal.aborted) {
          resolve({ kind: 'deadline' });
          return;
        }
        controller.signal.addEventListener(
          'abort',
          () => resolve({ kind: 'deadline' }),
          { once: true },
        );
      });
      const settlement = await Promise.race([execution, deadline]);
      if (settlement.kind === 'deadline') {
        return failedExecution(input, startedAt, this.#now().toISOString(), {
          status: 'timed-out',
          workspaceRelease: 'retain',
        });
      }
      if (settlement.kind === 'threw') {
        return failedExecution(input, startedAt, this.#now().toISOString(), {
          status: 'failed',
          workspaceRelease: 'retain',
        });
      }
      const { outcome } = settlement;
      const completedAt = this.#now().toISOString();
      if (outcome.kind !== 'completed') {
        return {
          workspaceRelease: outcome.workspaceRelease,
          record: {
            reviewerId: input.reviewer.reviewerId,
            executorAgentSlug: input.reviewer.executorAgentSlug,
            actor: input.reviewer.actor,
            lens: input.reviewer.lens,
            status: outcome.kind,
            startedAt,
            completedAt,
            findings: [],
            deltaAssessments: [],
            failureReason: stableFailureReason(outcome.kind),
          },
        };
      }
      try {
        const parsed = parseReviewerOutput(outcome.output);
        this.#assertDeltaCoverage(input.request, parsed.deltaAssessments);
        const findings: ReviewFinding[] = [];
        for (const candidate of parsed.findings) {
          await input.workspace.validateLocation(candidate.location);
          findings.push({
            ...candidate,
            findingId: reviewEvidenceId({
              target: input.workspace.target,
              reviewerId: input.reviewer.reviewerId,
              lensId: input.reviewer.lens.id,
              finding: candidate,
            }),
            reviewerId: input.reviewer.reviewerId,
            lensId: input.reviewer.lens.id,
          });
        }
        return {
          workspaceRelease: outcome.workspaceRelease,
          record: {
            reviewerId: input.reviewer.reviewerId,
            executorAgentSlug: input.reviewer.executorAgentSlug,
            actor: input.reviewer.actor,
            lens: input.reviewer.lens,
            status: 'completed',
            startedAt,
            completedAt,
            findings,
            deltaAssessments: parsed.deltaAssessments.map((assessment) => ({
              ...assessment,
              reviewerId: input.reviewer.reviewerId,
              lensId: input.reviewer.lens.id,
            })),
          },
        };
      } catch {
        return {
          workspaceRelease: outcome.workspaceRelease,
          record: {
            reviewerId: input.reviewer.reviewerId,
            executorAgentSlug: input.reviewer.executorAgentSlug,
            actor: input.reviewer.actor,
            lens: input.reviewer.lens,
            status: 'invalid-output',
            startedAt,
            completedAt,
            findings: [],
            deltaAssessments: [],
            failureReason: stableFailureReason('invalid-output'),
          },
        };
      }
    } catch {
      return failedExecution(input, startedAt, this.#now().toISOString(), {
        status: controller.signal.aborted ? 'timed-out' : 'failed',
        workspaceRelease: 'retain',
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  #assertDeltaCoverage(
    request: IndependentReviewRequest,
    assessments: readonly { priorFindingId: string }[],
  ): void {
    if (!request.delta) {
      if (assessments.length) {
        throw new Error('initial review cannot assess prior findings');
      }
      return;
    }
    const actual = assessments.map((assessment) => assessment.priorFindingId);
    if (new Set(actual).size !== actual.length) {
      throw new Error('delta review contains duplicate assessments');
    }
    if (
      actual.length !== request.delta.claimedFindingIds.length ||
      request.delta.claimedFindingIds.some(
        (findingId) => !actual.includes(findingId),
      )
    ) {
      throw new Error(
        'delta review must assess every claimed finding exactly once',
      );
    }
  }

  async #attach(
    request: IndependentReviewRequest,
    receipt: IndependentReviewReceipt,
  ): Promise<IndependentReviewRunResult['attachment']> {
    if (!request.flow) return { status: 'not-requested' };
    if (!this.#attachment) {
      return {
        status: 'unavailable',
        reason: 'Review evidence attachment is unavailable.',
      };
    }
    try {
      const attached = await this.#attachment.attach({
        projectSlug: request.target.projectSlug,
        runId: request.flow.runId,
        gate: request.flow.gate,
        receipt,
      });
      return { status: 'attached', evidenceId: attached.evidenceId };
    } catch (error) {
      this.#diagnostic('attachment.attach', error, request);
      return {
        status: 'unavailable',
        reason: 'Review evidence could not be attached.',
      };
    }
  }

  #record(operation: string, outcome: string, startedAt?: number): void {
    try {
      this.#observer.record({
        operation,
        outcome,
        ...(startedAt === undefined
          ? {}
          : { durationMs: Math.max(0, Date.now() - startedAt) }),
      });
    } catch {}
  }

  #diagnostic(
    operation: string,
    error: unknown,
    request?: IndependentReviewRequest,
  ): void {
    try {
      this.#observer.diagnostic({
        operation,
        error,
        ...(request
          ? {
              requestId: request.requestId,
              projectSlug: request.target.projectSlug,
            }
          : {}),
      });
    } catch {}
  }
}

function failedExecution(
  input: {
    reviewer: ResolvedReviewReviewer;
  },
  startedAt: string,
  completedAt: string,
  failure: {
    status: 'failed' | 'timed-out';
    workspaceRelease: 'safe' | 'retain';
  },
): { record: ReviewExecutionRecord; workspaceRelease: 'safe' | 'retain' } {
  return {
    workspaceRelease: failure.workspaceRelease,
    record: {
      reviewerId: input.reviewer.reviewerId,
      executorAgentSlug: input.reviewer.executorAgentSlug,
      actor: input.reviewer.actor,
      lens: input.reviewer.lens,
      status: failure.status,
      startedAt,
      completedAt,
      findings: [],
      deltaAssessments: [],
      failureReason: stableFailureReason(failure.status),
    },
  };
}

function pinnedTarget(
  input: ReviewGitTargetInput,
  target: ReviewGitTarget,
): ReviewGitTargetInput {
  return {
    ...input,
    baseRevision: target.baseSha,
    headRevision: target.headSha,
  };
}

function sameTarget(left: ReviewGitTarget, right: ReviewGitTarget): boolean {
  return (
    left.repositoryId === right.repositoryId &&
    left.baseSha === right.baseSha &&
    left.headSha === right.headSha &&
    left.diffSha256 === right.diffSha256
  );
}

async function mapConcurrent<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  operation: (input: Input) => Promise<Output>,
): Promise<Output[]> {
  const outputs = new Array<Output>(inputs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= inputs.length) return;
        outputs[index] = await operation(inputs[index]);
      }
    }),
  );
  return outputs;
}

const WORKSPACE_ERRNO_CODES = new Set([
  'ENOENT',
  'ENOTDIR',
  'EACCES',
  'ELOOP',
  'EPERM',
]);

function classifyProjectUnavailability(
  error: unknown,
): ReviewEvidenceUnavailableReason {
  if (error instanceof ReviewProjectLockUnavailableError) {
    return 'lock-unavailable';
  }
  const code = (error as NodeJS.ErrnoException)?.code;
  if (typeof code === 'string' && WORKSPACE_ERRNO_CODES.has(code)) {
    return 'workspace-unreadable';
  }
  const message = error instanceof Error ? error.message : '';
  if (
    message.includes('root must be a real directory') ||
    message.includes('root identity changed')
  ) {
    return 'workspace-unreadable';
  }
  return 'receipts-unreadable';
}

function stableFailureReason(
  status: 'failed' | 'timed-out' | 'invalid-output',
): string {
  switch (status) {
    case 'timed-out':
      return 'The reviewer did not finish within the bounded review window.';
    case 'invalid-output':
      return 'The reviewer did not produce the required evidence shape.';
    default:
      return 'The reviewer could not complete this review.';
  }
}

function reviewPrompt(input: {
  request: IndependentReviewRequest;
  reviewer: ResolvedReviewReviewer;
  workspace: ReadOnlyReviewWorkspace;
  prior: IndependentReviewReceipt | undefined;
}): string {
  const priorFindings = input.request.delta
    ? input.prior?.findings.filter((finding) =>
        input.request.delta?.claimedFindingIds.includes(finding.findingId),
      )
    : undefined;
  return [
    'Independently review the exact Git range below.',
    `Base SHA: ${input.workspace.target.baseSha}`,
    `Head SHA: ${input.workspace.target.headSha}`,
    `Diff SHA-256: ${input.workspace.target.diffSha256}`,
    `Lens (${input.reviewer.lens.id}): ${input.reviewer.lens.instructions}`,
    'The workspace is read-only. Do not propose edits or make a merge decision.',
    'Report only concrete defects. Every finding must name a repository-relative file, a one-based line in the head revision, a specific triggering state/input, and the externally wrong outcome.',
    'Return one JSON object and no surrounding prose with this exact shape:',
    '{"findings":[{"location":{"file":"src/file.ts","line":1},"scenario":{"stateOrInput":"specific state","wrongOutcome":"specific wrong result"},"severity":"critical|high|medium|low","confidence":"high|medium|low","basis":"reproduced|reasoned-from-code","summary":"bounded summary"}],"deltaAssessments":[{"priorFindingId":"id","outcome":"closed|still-present|regressed|not-verified","explanation":"bounded explanation"}]}',
    ...(priorFindings
      ? [
          'Delta review must assess every prior finding below exactly once. It may also report newly introduced findings.',
          JSON.stringify(priorFindings),
        ]
      : ['This is an initial review; deltaAssessments must be empty.']),
  ].join('\n\n');
}
