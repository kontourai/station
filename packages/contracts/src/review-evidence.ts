/**
 * Independent review evidence is reviewer-authored input to a later decision.
 * It is deliberately not a gate verdict and cannot represent pass/fail.
 */

export const REVIEW_EVIDENCE_SCHEMA_VERSION = 1 as const;

export const REVIEW_EVIDENCE_OPERATOR_OPERATIONS = [
  'run',
  'status',
  'list',
  'read',
] as const;
export type ReviewEvidenceOperatorOperation =
  (typeof REVIEW_EVIDENCE_OPERATOR_OPERATIONS)[number];

/** One vocabulary shared by API, SDK, CLI, UI queries, and station-control. */
export const REVIEW_EVIDENCE_OPERATOR_SURFACE: Readonly<
  Record<
    ReviewEvidenceOperatorOperation,
    Readonly<{ cli: string; mcp: string; method: string; path: string }>
  >
> = {
  run: {
    cli: 'run',
    mcp: 'run_independent_review',
    method: 'POST',
    path: '/api/projects/:projectSlug/reviews',
  },
  status: {
    cli: 'status',
    mcp: 'get_review_request',
    method: 'GET',
    path: '/api/projects/:projectSlug/reviews/requests/:requestId',
  },
  list: {
    cli: 'list',
    mcp: 'list_review_receipts',
    method: 'GET',
    path: '/api/projects/:projectSlug/reviews',
  },
  read: {
    cli: 'read',
    mcp: 'get_review_receipt',
    method: 'GET',
    path: '/api/projects/:projectSlug/reviews/:receiptId',
  },
};

export const REVIEW_FINDING_SEVERITIES = [
  'critical',
  'high',
  'medium',
  'low',
] as const;
export type ReviewFindingSeverity = (typeof REVIEW_FINDING_SEVERITIES)[number];

export const REVIEW_FINDING_CONFIDENCE = ['high', 'medium', 'low'] as const;
export type ReviewFindingConfidence =
  (typeof REVIEW_FINDING_CONFIDENCE)[number];

export const REVIEW_FINDING_BASES = [
  'reproduced',
  'reasoned-from-code',
] as const;
export type ReviewFindingBasis = (typeof REVIEW_FINDING_BASES)[number];

export const REVIEW_DELTA_OUTCOMES = [
  'closed',
  'still-present',
  'regressed',
  'not-verified',
] as const;
export type ReviewDeltaOutcome = (typeof REVIEW_DELTA_OUTCOMES)[number];

export interface ReviewActorIdentity {
  /** Stable host-authoritative identity of the reviewer occurrence's actor. */
  actorId: string;
  displayName?: string;
}

export interface ReviewLens {
  id: string;
  /** Bounded reviewer-facing focus; never interpreted as a verdict rule. */
  instructions: string;
}

export interface ReviewReviewerDeclaration {
  /** Unique occurrence identity within this review request. */
  reviewerId: string;
  /** Station Agent slug selected to execute this reviewer occurrence. */
  executorAgentSlug: string;
  lens: ReviewLens;
}

/** Server-selected review routing. Callers cannot supply paths or reviewers. */
export interface RepoMapReviewSelection {
  kind: 'repo-map';
}

/** Immutable policy identity recorded when Station resolves repo-map lenses. */
export interface ReviewRoutingBinding {
  kind: 'repo-map';
  policyRevision: string;
  repoMapSha256: string;
  registrySha256: string;
  routerVersion: 1;
  affectedNodes: string[];
}

export interface ReviewGitTargetInput {
  kind: 'git-range';
  projectSlug: string;
  baseRevision: string;
  headRevision: string;
}

export interface ReviewGitTarget extends ReviewGitTargetInput {
  repositoryId: string;
  baseSha: string;
  headSha: string;
  diffSha256: string;
}

export interface ReviewDeltaInput {
  priorReceiptId: string;
  claimedFindingIds: string[];
}

export interface IndependentReviewRequest {
  /** Caller-generated idempotency identity, stable across transport retries. */
  requestId: string;
  mode: 'initial' | 'delta';
  target: ReviewGitTargetInput;
  /** Declared implementing Agent; the server resolves its actor identity. */
  implementerAgentSlug: string;
  /** Explicit reviewer declarations retain the #2901 operator surface. */
  reviewers: ReviewReviewerDeclaration[];
  /** Ask Station to derive lenses from the trusted Repo Map. */
  selection?: RepoMapReviewSelection;
  delta?: ReviewDeltaInput;
  /** Optional Flow attachment. Findings remain non-verdict evidence. */
  flow?: { runId: string; gate: string };
}

export interface ReviewFindingLocation {
  /** Repository-relative POSIX path. */
  file: string;
  /** One-based line in the reviewed head revision. */
  line: number;
}

export interface ReviewFailureScenario {
  /** Concrete input or state that triggers the defect. */
  stateOrInput: string;
  /** Concrete externally wrong result. */
  wrongOutcome: string;
}

export interface ReviewFinding {
  findingId: string;
  reviewerId: string;
  lensId: string;
  location: ReviewFindingLocation;
  scenario: ReviewFailureScenario;
  severity: ReviewFindingSeverity;
  confidence: ReviewFindingConfidence;
  basis: ReviewFindingBasis;
  summary: string;
}

export interface ReviewDeltaAssessment {
  reviewerId: string;
  lensId: string;
  priorFindingId: string;
  outcome: ReviewDeltaOutcome;
  explanation: string;
}

export type ReviewExecutionStatus =
  | 'completed'
  | 'failed'
  | 'timed-out'
  | 'invalid-output';

export interface ReviewExecutionRecord {
  reviewerId: string;
  executorAgentSlug: string;
  actor: ReviewActorIdentity;
  lens: ReviewLens;
  status: ReviewExecutionStatus;
  startedAt: string;
  completedAt: string;
  findings: ReviewFinding[];
  deltaAssessments: ReviewDeltaAssessment[];
  /** Stable public reason; raw provider diagnostics are not receipt data. */
  failureReason?: string;
}

export interface IndependentReviewReceipt {
  schemaVersion: typeof REVIEW_EVIDENCE_SCHEMA_VERSION;
  receiptId: string;
  requestId: string;
  mode: 'initial' | 'delta';
  target: ReviewGitTarget;
  /** Authenticated host identity that requested this review. */
  requestedBy: ReviewActorIdentity;
  /** Declared author of the reviewed change; distinct from requester. */
  implementer: ReviewActorIdentity;
  delta?: ReviewDeltaInput;
  /** Absent for explicit reviewer declarations and historical receipts. */
  routing?: ReviewRoutingBinding;
  startedAt: string;
  completedAt: string;
  executions: ReviewExecutionRecord[];
  findings: ReviewFinding[];
  deltaAssessments: ReviewDeltaAssessment[];
  interpretation: {
    kind: 'review-findings';
    decision: 'input-only';
    gateVerdict: null;
  };
}

export interface IndependentReviewRunResult {
  receipt: IndependentReviewReceipt;
  attachment:
    | { status: 'not-requested' }
    | { status: 'attached'; evidenceId: string }
    | { status: 'unavailable'; reason: string };
  cleanup:
    | { status: 'completed' }
    | { status: 'retained'; reason: string }
    | { status: 'unavailable'; reason: string };
}

export const REVIEW_EVIDENCE_UNAVAILABLE_REASONS = [
  /** The project workspace path exists in config but cannot be read (ENOENT, symlink, identity change). */
  'workspace-unreadable',
  /** The cross-process receipt coordination lock could not be acquired in time. */
  'lock-unavailable',
  /** A receipt or index under the workspace failed integrity or shape checks. */
  'receipts-unreadable',
] as const;
export type ReviewEvidenceUnavailableReason =
  (typeof REVIEW_EVIDENCE_UNAVAILABLE_REASONS)[number];

export interface ReviewEvidenceUnavailableProject {
  projectSlug: string;
  reason: ReviewEvidenceUnavailableReason;
}

/**
 * Cross-Project aggregate: total over the project inventory. A project whose
 * receipts cannot be read contributes zero receipts plus one
 * `unavailableProjects` entry instead of failing the whole read. A project
 * with no configured workspace contributes nothing at all — that is a normal
 * configured state, not an unavailability.
 */
export interface ReviewEvidenceAggregate {
  receipts: IndependentReviewReceipt[];
  unavailableProjects: ReviewEvidenceUnavailableProject[];
}

export function parseReviewEvidenceAggregate(
  value: unknown,
): ReviewEvidenceAggregate {
  const input = record(value, 'review evidence aggregate');
  exactKeys(
    input,
    ['receipts', 'unavailableProjects'],
    'review evidence aggregate',
  );
  if (
    !Array.isArray(input.receipts) ||
    !Array.isArray(input.unavailableProjects)
  ) {
    throw new Error('review evidence aggregate collections are invalid');
  }
  return {
    receipts: input.receipts.map(parseIndependentReviewReceipt),
    unavailableProjects: input.unavailableProjects.map((entry, index) => {
      const project = record(
        entry,
        `review evidence aggregate unavailableProjects[${index}]`,
      );
      exactKeys(
        project,
        ['projectSlug', 'reason'],
        `review evidence aggregate unavailableProjects[${index}]`,
      );
      if (
        !REVIEW_EVIDENCE_UNAVAILABLE_REASONS.includes(
          project.reason as ReviewEvidenceUnavailableReason,
        )
      ) {
        throw new Error(
          `review evidence aggregate unavailableProjects[${index}].reason is invalid`,
        );
      }
      return {
        projectSlug: id(
          project.projectSlug,
          `review evidence aggregate unavailableProjects[${index}].projectSlug`,
        ),
        reason: project.reason as ReviewEvidenceUnavailableReason,
      };
    }),
  };
}

export type IndependentReviewRequestState =
  | 'running'
  | 'completed'
  | 'rejected'
  | 'indeterminate'
  /** Review was intentionally not invoked; human coverage remains required. */
  | 'not-verified';

/** Durable request projection used to recover an ambiguous long HTTP call. */
export interface IndependentReviewRequestStatus {
  requestId: string;
  projectSlug: string;
  state: IndependentReviewRequestState;
  startedAt: string;
  updatedAt: string;
  result?: IndependentReviewRunResult;
  /** Stable public reason; internal diagnostics never cross this boundary. */
  failureReason?: string;
  /** Repo-map lenses that could not receive an eligible read-only reviewer. */
  unavailableLenses?: string[];
  routing?: ReviewRoutingBinding;
}

const SHA_256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const SAFE_REPO_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\).+$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${label} contains unknown field: ${unknown}`);
}

function text(value: unknown, label: string, max = 4_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
  return value.trim();
}

function id(value: unknown, label: string): string {
  const parsed = text(value, label, 256);
  if (!SAFE_ID.test(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}

function iso(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  if (Number.isNaN(Date.parse(parsed))) throw new Error(`${label} is invalid`);
  return parsed;
}

function parseActor(value: unknown, label: string): ReviewActorIdentity {
  const input = record(value, label);
  exactKeys(input, ['actorId', 'displayName'], label);
  return {
    actorId: id(input.actorId, `${label}.actorId`),
    ...(input.displayName === undefined
      ? {}
      : { displayName: text(input.displayName, `${label}.displayName`, 256) }),
  };
}

function parseLens(value: unknown, label: string): ReviewLens {
  const input = record(value, label);
  exactKeys(input, ['id', 'instructions'], label);
  return {
    id: id(input.id, `${label}.id`),
    instructions: text(input.instructions, `${label}.instructions`, 2_000),
  };
}

/** Canonical server-selected Repo Map policy identity; never symbolic refs. */
export function parseReviewRoutingBinding(
  value: unknown,
  label: string,
): ReviewRoutingBinding {
  const input = record(value, label);
  exactKeys(
    input,
    [
      'kind',
      'policyRevision',
      'repoMapSha256',
      'registrySha256',
      'routerVersion',
      'affectedNodes',
    ],
    label,
  );
  if (
    input.kind !== 'repo-map' ||
    input.routerVersion !== 1 ||
    !SHA_256.test(String(input.repoMapSha256)) ||
    !SHA_256.test(String(input.registrySha256)) ||
    !Array.isArray(input.affectedNodes) ||
    !input.affectedNodes.length ||
    input.affectedNodes.length > 256
  ) {
    throw new Error(`${label} is invalid`);
  }
  const affectedNodes = input.affectedNodes.map((node, index) =>
    id(node, `${label}.affectedNodes[${index}]`),
  );
  if (new Set(affectedNodes).size !== affectedNodes.length) {
    throw new Error(`${label} is invalid`);
  }
  return {
    kind: 'repo-map',
    policyRevision: (() => {
      const revision = text(
        input.policyRevision,
        `${label}.policyRevision`,
        256,
      );
      if (!GIT_SHA.test(revision)) throw new Error(`${label} is invalid`);
      return revision;
    })(),
    repoMapSha256: String(input.repoMapSha256),
    registrySha256: String(input.registrySha256),
    routerVersion: 1,
    affectedNodes,
  };
}

/** Canonical immutable Git target used for a receipt or server selection. */
export function parseReviewGitTarget(
  value: unknown,
  label: string,
): ReviewGitTarget {
  const target = record(value, label);
  exactKeys(
    target,
    [
      'kind',
      'projectSlug',
      'baseRevision',
      'headRevision',
      'repositoryId',
      'baseSha',
      'headSha',
      'diffSha256',
    ],
    label,
  );
  if (
    target.kind !== 'git-range' ||
    !GIT_SHA.test(String(target.baseSha)) ||
    !GIT_SHA.test(String(target.headSha)) ||
    !SHA_256.test(String(target.diffSha256))
  ) {
    throw new Error(`${label} identity is invalid`);
  }
  const baseSha = String(target.baseSha);
  const headSha = String(target.headSha);
  return {
    kind: 'git-range',
    projectSlug: id(target.projectSlug, `${label} projectSlug`),
    baseRevision: text(target.baseRevision, `${label} baseRevision`, 256),
    headRevision: text(target.headRevision, `${label} headRevision`, 256),
    repositoryId: text(target.repositoryId, `${label} repositoryId`, 1_024),
    baseSha,
    headSha,
    diffSha256: String(target.diffSha256),
  };
}

export function parseIndependentReviewRequest(
  value: unknown,
): IndependentReviewRequest {
  const input = record(value, 'review request');
  exactKeys(
    input,
    [
      'requestId',
      'mode',
      'target',
      'implementerAgentSlug',
      'reviewers',
      'selection',
      'delta',
      'flow',
    ],
    'review request',
  );
  if (input.mode !== 'initial' && input.mode !== 'delta') {
    throw new Error('review request mode is invalid');
  }
  const targetInput = record(input.target, 'review target');
  exactKeys(
    targetInput,
    ['kind', 'projectSlug', 'baseRevision', 'headRevision'],
    'review target',
  );
  if (targetInput.kind !== 'git-range') {
    throw new Error('review target kind is unsupported');
  }
  const requestId = id(input.requestId, 'review request requestId');
  const implementerAgentSlug = id(
    input.implementerAgentSlug,
    'review implementer Agent slug',
  );
  let selection: RepoMapReviewSelection | undefined;
  if (input.selection !== undefined) {
    const raw = record(input.selection, 'review selection');
    exactKeys(raw, ['kind'], 'review selection');
    if (raw.kind !== 'repo-map') {
      throw new Error('review selection kind is unsupported');
    }
    selection = { kind: 'repo-map' };
  }
  if (!Array.isArray(input.reviewers)) {
    throw new Error('review request reviewers are invalid');
  }
  if (!selection && input.reviewers.length < 1) {
    throw new Error('review request requires reviewers or a selection');
  }
  if (selection && input.reviewers.length !== 0) {
    throw new Error('review request cannot mix reviewers with a selection');
  }
  if (input.reviewers.length > 8) {
    throw new Error('review request exceeds the reviewer limit');
  }
  const reviewerIds = new Set<string>();
  const reviewerActorIds = new Set<string>();
  const reviewers = input.reviewers.map((value, index) => {
    const reviewer = record(value, `reviewers[${index}]`);
    exactKeys(
      reviewer,
      ['reviewerId', 'executorAgentSlug', 'lens'],
      `reviewers[${index}]`,
    );
    const parsed: ReviewReviewerDeclaration = {
      reviewerId: id(reviewer.reviewerId, `reviewers[${index}].reviewerId`),
      executorAgentSlug: id(
        reviewer.executorAgentSlug,
        `reviewers[${index}].executorAgentSlug`,
      ),
      lens: parseLens(reviewer.lens, `reviewers[${index}].lens`),
    };
    if (reviewerIds.has(parsed.reviewerId)) {
      throw new Error('reviewer ids must be unique');
    }
    reviewerIds.add(parsed.reviewerId);
    if (parsed.executorAgentSlug === implementerAgentSlug) {
      throw new Error('the implementer cannot review their own change');
    }
    if (reviewerActorIds.has(parsed.executorAgentSlug)) {
      throw new Error('reviewer actors must be independent and unique');
    }
    reviewerActorIds.add(parsed.executorAgentSlug);
    return parsed;
  });

  let delta: ReviewDeltaInput | undefined;
  if (input.delta !== undefined) {
    const raw = record(input.delta, 'review delta');
    exactKeys(raw, ['priorReceiptId', 'claimedFindingIds'], 'review delta');
    if (
      !Array.isArray(raw.claimedFindingIds) ||
      raw.claimedFindingIds.length < 1 ||
      raw.claimedFindingIds.length > 100
    ) {
      throw new Error('delta review requires one to 100 claimed finding ids');
    }
    const claimedFindingIds = raw.claimedFindingIds.map((findingId, index) =>
      id(findingId, `review delta claimedFindingIds[${index}]`),
    );
    if (new Set(claimedFindingIds).size !== claimedFindingIds.length) {
      throw new Error('delta review finding ids must be unique');
    }
    delta = {
      priorReceiptId: id(raw.priorReceiptId, 'review delta priorReceiptId'),
      claimedFindingIds,
    };
  }
  if ((input.mode === 'delta') !== Boolean(delta)) {
    throw new Error('delta input must be present exactly for delta mode');
  }

  let flow: IndependentReviewRequest['flow'];
  if (input.flow !== undefined) {
    const raw = record(input.flow, 'review flow binding');
    exactKeys(raw, ['runId', 'gate'], 'review flow binding');
    flow = {
      runId: id(raw.runId, 'review flow runId'),
      gate: id(raw.gate, 'review flow gate'),
    };
  }

  return {
    requestId,
    mode: input.mode,
    target: {
      kind: 'git-range',
      projectSlug: id(targetInput.projectSlug, 'review target projectSlug'),
      baseRevision: text(
        targetInput.baseRevision,
        'review target baseRevision',
        256,
      ),
      headRevision: text(
        targetInput.headRevision,
        'review target headRevision',
        256,
      ),
    },
    implementerAgentSlug,
    reviewers,
    ...(selection ? { selection } : {}),
    ...(delta ? { delta } : {}),
    ...(flow ? { flow } : {}),
  };
}

export interface ReviewerOutput {
  findings: Omit<ReviewFinding, 'findingId' | 'reviewerId' | 'lensId'>[];
  deltaAssessments: Omit<ReviewDeltaAssessment, 'reviewerId' | 'lensId'>[];
}

export function parseReviewerOutput(value: unknown): ReviewerOutput {
  const input = record(value, 'reviewer output');
  exactKeys(input, ['findings', 'deltaAssessments'], 'reviewer output');
  if (
    !Array.isArray(input.findings) ||
    !Array.isArray(input.deltaAssessments)
  ) {
    throw new Error('reviewer output arrays are required');
  }
  if (input.findings.length > 100 || input.deltaAssessments.length > 100) {
    throw new Error('reviewer output exceeds the entry limit');
  }
  const findings = input.findings.map((value, index) => {
    const finding = record(value, `findings[${index}]`);
    exactKeys(
      finding,
      ['location', 'scenario', 'severity', 'confidence', 'basis', 'summary'],
      `findings[${index}]`,
    );
    const location = record(finding.location, `findings[${index}].location`);
    exactKeys(location, ['file', 'line'], `findings[${index}].location`);
    const file = text(location.file, `findings[${index}].location.file`, 1_024);
    if (!SAFE_REPO_PATH.test(file)) {
      throw new Error(`findings[${index}].location.file is unsafe`);
    }
    if (!Number.isInteger(location.line) || Number(location.line) < 1) {
      throw new Error(`findings[${index}].location.line is invalid`);
    }
    const scenario = record(finding.scenario, `findings[${index}].scenario`);
    exactKeys(
      scenario,
      ['stateOrInput', 'wrongOutcome'],
      `findings[${index}].scenario`,
    );
    if (!REVIEW_FINDING_SEVERITIES.includes(finding.severity as never)) {
      throw new Error(`findings[${index}].severity is invalid`);
    }
    if (!REVIEW_FINDING_CONFIDENCE.includes(finding.confidence as never)) {
      throw new Error(`findings[${index}].confidence is invalid`);
    }
    if (!REVIEW_FINDING_BASES.includes(finding.basis as never)) {
      throw new Error(`findings[${index}].basis is invalid`);
    }
    return {
      location: { file, line: Number(location.line) },
      scenario: {
        stateOrInput: text(
          scenario.stateOrInput,
          `findings[${index}].scenario.stateOrInput`,
        ),
        wrongOutcome: text(
          scenario.wrongOutcome,
          `findings[${index}].scenario.wrongOutcome`,
        ),
      },
      severity: finding.severity as ReviewFindingSeverity,
      confidence: finding.confidence as ReviewFindingConfidence,
      basis: finding.basis as ReviewFindingBasis,
      summary: text(finding.summary, `findings[${index}].summary`),
    };
  });
  const deltaAssessments = input.deltaAssessments.map((value, index) => {
    const assessment = record(value, `deltaAssessments[${index}]`);
    exactKeys(
      assessment,
      ['priorFindingId', 'outcome', 'explanation'],
      `deltaAssessments[${index}]`,
    );
    if (!REVIEW_DELTA_OUTCOMES.includes(assessment.outcome as never)) {
      throw new Error(`deltaAssessments[${index}].outcome is invalid`);
    }
    return {
      priorFindingId: id(
        assessment.priorFindingId,
        `deltaAssessments[${index}].priorFindingId`,
      ),
      outcome: assessment.outcome as ReviewDeltaOutcome,
      explanation: text(
        assessment.explanation,
        `deltaAssessments[${index}].explanation`,
      ),
    };
  });
  return { findings, deltaAssessments };
}

export function parseIndependentReviewReceipt(
  value: unknown,
): IndependentReviewReceipt {
  const input = record(value, 'review receipt');
  exactKeys(
    input,
    [
      'schemaVersion',
      'receiptId',
      'requestId',
      'mode',
      'target',
      'requestedBy',
      'implementer',
      'delta',
      'routing',
      'startedAt',
      'completedAt',
      'executions',
      'findings',
      'deltaAssessments',
      'interpretation',
    ],
    'review receipt',
  );
  if (input.schemaVersion !== REVIEW_EVIDENCE_SCHEMA_VERSION) {
    throw new Error('unsupported review receipt schema version');
  }
  if (!SHA_256.test(String(input.receiptId))) {
    throw new Error('review receipt id is invalid');
  }
  if (input.mode !== 'initial' && input.mode !== 'delta') {
    throw new Error('review receipt mode is invalid');
  }
  const target = parseReviewGitTarget(input.target, 'review receipt target');
  const interpretation = record(
    input.interpretation,
    'review receipt interpretation',
  );
  if (
    interpretation.kind !== 'review-findings' ||
    interpretation.decision !== 'input-only' ||
    interpretation.gateVerdict !== null
  ) {
    throw new Error('review receipt cannot claim a gate verdict');
  }
  if (
    !Array.isArray(input.executions) ||
    !Array.isArray(input.findings) ||
    !Array.isArray(input.deltaAssessments)
  ) {
    throw new Error('review receipt collections are invalid');
  }
  if (input.executions.length < 1 || input.executions.length > 8) {
    throw new Error('review receipt execution count is invalid');
  }
  if (input.findings.length > 800 || input.deltaAssessments.length > 800) {
    throw new Error('review receipt evidence count is invalid');
  }
  const requestedBy = parseActor(input.requestedBy, 'review receipt requester');
  const implementer = parseActor(
    input.implementer,
    'review receipt implementer',
  );
  const executions = input.executions.map((execution, index) =>
    parseExecutionRecord(execution, `review receipt executions[${index}]`),
  );
  if (
    new Set(executions.map((execution) => execution.reviewerId)).size !==
      executions.length ||
    new Set(executions.map((execution) => execution.actor.actorId)).size !==
      executions.length ||
    executions.some(
      (execution) => execution.actor.actorId === implementer.actorId,
    )
  ) {
    throw new Error('review receipt reviewer independence is invalid');
  }
  const findings = input.findings.map((finding, index) =>
    parseStoredFinding(finding, `review receipt findings[${index}]`),
  );
  const deltaAssessments = input.deltaAssessments.map((assessment, index) =>
    parseStoredDeltaAssessment(
      assessment,
      `review receipt deltaAssessments[${index}]`,
    ),
  );
  if (
    JSON.stringify(executions.flatMap((execution) => execution.findings)) !==
      JSON.stringify(findings) ||
    JSON.stringify(
      executions.flatMap((execution) => execution.deltaAssessments),
    ) !== JSON.stringify(deltaAssessments)
  ) {
    throw new Error('review receipt flattened evidence is inconsistent');
  }
  let delta: ReviewDeltaInput | undefined;
  if (input.delta !== undefined) {
    const candidate = record(input.delta, 'review receipt delta');
    exactKeys(
      candidate,
      ['priorReceiptId', 'claimedFindingIds'],
      'review receipt delta',
    );
    if (
      !Array.isArray(candidate.claimedFindingIds) ||
      candidate.claimedFindingIds.length < 1 ||
      candidate.claimedFindingIds.length > 100
    ) {
      throw new Error('review receipt delta finding ids are invalid');
    }
    delta = {
      priorReceiptId: id(
        candidate.priorReceiptId,
        'review receipt delta priorReceiptId',
      ),
      claimedFindingIds: candidate.claimedFindingIds.map((findingId, index) =>
        id(findingId, `review receipt delta claimedFindingIds[${index}]`),
      ),
    };
    if (
      new Set(delta.claimedFindingIds).size !== delta.claimedFindingIds.length
    ) {
      throw new Error('review receipt delta finding ids are invalid');
    }
  }
  if ((input.mode === 'delta') !== Boolean(delta)) {
    throw new Error('review receipt delta identity is inconsistent');
  }
  const routing =
    input.routing === undefined
      ? undefined
      : parseReviewRoutingBinding(input.routing, 'review receipt routing');
  const startedAt = iso(input.startedAt, 'review receipt startedAt');
  const completedAt = iso(input.completedAt, 'review receipt completedAt');
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    throw new Error('review receipt time range is invalid');
  }
  return {
    schemaVersion: REVIEW_EVIDENCE_SCHEMA_VERSION,
    receiptId: String(input.receiptId),
    requestId: id(input.requestId, 'review receipt requestId'),
    mode: input.mode,
    startedAt,
    completedAt,
    target,
    requestedBy,
    implementer,
    ...(delta ? { delta } : {}),
    ...(routing ? { routing } : {}),
    executions,
    findings,
    deltaAssessments,
    interpretation: {
      kind: 'review-findings',
      decision: 'input-only',
      gateVerdict: null,
    },
  };
}

export function parseIndependentReviewRunResult(
  value: unknown,
): IndependentReviewRunResult {
  const input = record(value, 'review run result');
  exactKeys(input, ['receipt', 'attachment', 'cleanup'], 'review run result');
  const attachment = record(input.attachment, 'review run attachment');
  const cleanup = record(input.cleanup, 'review run cleanup');
  if (
    !['not-requested', 'attached', 'unavailable'].includes(
      String(attachment.status),
    )
  ) {
    throw new Error('review run attachment is invalid');
  }
  exactKeys(
    attachment,
    attachment.status === 'attached'
      ? ['status', 'evidenceId']
      : attachment.status === 'unavailable'
        ? ['status', 'reason']
        : ['status'],
    'review run attachment',
  );
  if (
    !['completed', 'retained', 'unavailable'].includes(String(cleanup.status))
  ) {
    throw new Error('review run cleanup is invalid');
  }
  exactKeys(
    cleanup,
    cleanup.status === 'completed' ? ['status'] : ['status', 'reason'],
    'review run cleanup',
  );
  return {
    receipt: parseIndependentReviewReceipt(input.receipt),
    attachment:
      attachment.status === 'attached'
        ? {
            status: 'attached',
            evidenceId: id(
              attachment.evidenceId,
              'review run attachment evidenceId',
            ),
          }
        : attachment.status === 'unavailable'
          ? {
              status: 'unavailable',
              reason: text(attachment.reason, 'review run attachment reason'),
            }
          : { status: 'not-requested' },
    cleanup:
      cleanup.status === 'completed'
        ? { status: 'completed' }
        : {
            status: cleanup.status as 'retained' | 'unavailable',
            reason: text(cleanup.reason, 'review run cleanup reason'),
          },
  };
}

export function parseIndependentReviewRequestStatus(
  value: unknown,
): IndependentReviewRequestStatus {
  const input = record(value, 'review request status');
  exactKeys(
    input,
    [
      'requestId',
      'projectSlug',
      'state',
      'startedAt',
      'updatedAt',
      'result',
      'failureReason',
      'unavailableLenses',
      'routing',
    ],
    'review request status',
  );
  if (
    ![
      'running',
      'completed',
      'rejected',
      'indeterminate',
      'not-verified',
    ].includes(String(input.state))
  ) {
    throw new Error('review request status state is invalid');
  }
  const state = input.state as IndependentReviewRequestState;
  const startedAt = iso(input.startedAt, 'review request status startedAt');
  const updatedAt = iso(input.updatedAt, 'review request status updatedAt');
  if (
    (state === 'completed') !== (input.result !== undefined) ||
    (state === 'rejected' ||
      state === 'indeterminate' ||
      state === 'not-verified') !==
      (input.failureReason !== undefined) ||
    Date.parse(updatedAt) < Date.parse(startedAt)
  ) {
    throw new Error('review request status terminal truth is invalid');
  }
  let unavailableLenses: string[] | undefined;
  if (input.unavailableLenses !== undefined) {
    if (!Array.isArray(input.unavailableLenses)) {
      throw new Error('review request unavailable lenses are invalid');
    }
    unavailableLenses = input.unavailableLenses.map((lensId, index) =>
      id(lensId, `review request unavailableLenses[${index}]`),
    );
    if (
      unavailableLenses.length < 1 ||
      unavailableLenses.length > 8 ||
      new Set(unavailableLenses).size !== unavailableLenses.length
    ) {
      throw new Error('review request unavailable lenses are invalid');
    }
  }
  if ((state === 'not-verified') !== Boolean(unavailableLenses)) {
    throw new Error('review request unavailable lenses are invalid');
  }
  const routing =
    input.routing === undefined
      ? undefined
      : parseReviewRoutingBinding(
          input.routing,
          'review request status routing',
        );
  if (routing && state !== 'completed') {
    throw new Error('review request status routing is invalid');
  }
  return {
    requestId: id(input.requestId, 'review request status requestId'),
    projectSlug: id(input.projectSlug, 'review request status projectSlug'),
    state,
    startedAt,
    updatedAt,
    ...(input.result === undefined
      ? {}
      : { result: parseIndependentReviewRunResult(input.result) }),
    ...(input.failureReason === undefined
      ? {}
      : {
          failureReason: text(
            input.failureReason,
            'review request status failureReason',
          ),
        }),
    ...(unavailableLenses ? { unavailableLenses } : {}),
    ...(routing ? { routing } : {}),
  };
}

function parseStoredFinding(value: unknown, label: string): ReviewFinding {
  const input = record(value, label);
  exactKeys(
    input,
    [
      'findingId',
      'reviewerId',
      'lensId',
      'location',
      'scenario',
      'severity',
      'confidence',
      'basis',
      'summary',
    ],
    label,
  );
  if (!SHA_256.test(String(input.findingId))) {
    throw new Error(`${label}.findingId is invalid`);
  }
  const parsed = parseReviewerOutput({
    findings: [
      {
        location: input.location,
        scenario: input.scenario,
        severity: input.severity,
        confidence: input.confidence,
        basis: input.basis,
        summary: input.summary,
      },
    ],
    deltaAssessments: [],
  }).findings[0];
  return {
    ...parsed,
    findingId: String(input.findingId),
    reviewerId: id(input.reviewerId, `${label}.reviewerId`),
    lensId: id(input.lensId, `${label}.lensId`),
  };
}

function parseStoredDeltaAssessment(
  value: unknown,
  label: string,
): ReviewDeltaAssessment {
  const input = record(value, label);
  exactKeys(
    input,
    ['reviewerId', 'lensId', 'priorFindingId', 'outcome', 'explanation'],
    label,
  );
  const parsed = parseReviewerOutput({
    findings: [],
    deltaAssessments: [
      {
        priorFindingId: input.priorFindingId,
        outcome: input.outcome,
        explanation: input.explanation,
      },
    ],
  }).deltaAssessments[0];
  return {
    ...parsed,
    reviewerId: id(input.reviewerId, `${label}.reviewerId`),
    lensId: id(input.lensId, `${label}.lensId`),
  };
}

function parseExecutionRecord(
  value: unknown,
  label: string,
): ReviewExecutionRecord {
  const input = record(value, label);
  exactKeys(
    input,
    [
      'reviewerId',
      'executorAgentSlug',
      'actor',
      'lens',
      'status',
      'startedAt',
      'completedAt',
      'findings',
      'deltaAssessments',
      'failureReason',
    ],
    label,
  );
  if (
    !['completed', 'failed', 'timed-out', 'invalid-output'].includes(
      String(input.status),
    ) ||
    !Array.isArray(input.findings) ||
    !Array.isArray(input.deltaAssessments)
  ) {
    throw new Error(`${label} is invalid`);
  }
  const reviewerId = id(input.reviewerId, `${label}.reviewerId`);
  const lens = parseLens(input.lens, `${label}.lens`);
  const findings = input.findings.map((finding, index) =>
    parseStoredFinding(finding, `${label}.findings[${index}]`),
  );
  const deltaAssessments = input.deltaAssessments.map((assessment, index) =>
    parseStoredDeltaAssessment(
      assessment,
      `${label}.deltaAssessments[${index}]`,
    ),
  );
  if (
    findings.some(
      (finding) =>
        finding.reviewerId !== reviewerId || finding.lensId !== lens.id,
    ) ||
    deltaAssessments.some(
      (assessment) =>
        assessment.reviewerId !== reviewerId || assessment.lensId !== lens.id,
    )
  ) {
    throw new Error(`${label} evidence attribution is invalid`);
  }
  const status = input.status as ReviewExecutionStatus;
  if (
    (status === 'completed' && input.failureReason !== undefined) ||
    (status !== 'completed' &&
      (findings.length > 0 ||
        deltaAssessments.length > 0 ||
        input.failureReason === undefined))
  ) {
    throw new Error(`${label} terminal truth is invalid`);
  }
  return {
    reviewerId,
    executorAgentSlug: id(
      input.executorAgentSlug,
      `${label}.executorAgentSlug`,
    ),
    actor: parseActor(input.actor, `${label}.actor`),
    lens,
    status,
    startedAt: iso(input.startedAt, `${label}.startedAt`),
    completedAt: iso(input.completedAt, `${label}.completedAt`),
    findings,
    deltaAssessments,
    ...(input.failureReason === undefined
      ? {}
      : { failureReason: text(input.failureReason, `${label}.failureReason`) }),
  };
}
