/**
 * Wire shapes for reviewing, recalling and briefing from a person's private
 * memory (`/api/knowledge/memory/*`, behind the `private-memory` preview).
 *
 * These are Station's projection of the Knowledge Kit's memory-claim, routing
 * and review contracts, flattened so a client needs none of the Kit's types.
 * The Kit and Survey own what the words mean; this module only fixes how the
 * host reports them.
 */

/** Why a change needs a person. One entry per routing rule that fired. */
export type MemoryRoutingReason =
  | 'contested-by-accumulation'
  | 'contradicted-by-verification'
  | 'consequential-supersession'
  | 'entity-identity-change'
  | 'low-extraction-agreement'
  | 'visibility-widening';

/** `unreviewed` is the label a claim keeps until a person decides it. */
export type MemoryReviewLabel =
  | 'unreviewed'
  | 'in-review'
  | 'confirmed'
  | 'corrected';

export type MemoryPosture =
  | 'stated'
  | 'proposed'
  | 'hypothetical'
  | 'retracted';

/** One piece of evidence for a claim: the words it came from. */
export interface MemorySourceExcerpt {
  ref: string;
  excerpt: string;
  observedAt: string;
}

/** A claim as a reader sees it, in the Kit's own display wording. */
export interface MemoryClaimView {
  claimId: string;
  /** The review item a decision on this claim is recorded against. */
  itemId: string;
  /** The Corpus proposal that holds the claim. */
  proposalId: string;
  /** Display-ready, beginning with posture and review label. */
  text: string;
  subject: string;
  property: string;
  value: string;
  posture: MemoryPosture;
  speaker: string;
  source: MemorySourceExcerpt;
}

/** A routed change waiting for a person, with what they need to decide it. */
export interface MemoryQueueItem {
  /** Survey review item name; the decision route is keyed by it. */
  itemId: string;
  /** One short question in the owner's words. */
  question: string;
  reasons: { rule: MemoryRoutingReason; plain: string }[];
  /** The new claim. */
  proposed: MemoryClaimView;
  /** The claim it conflicts with or replaces, when there is one. */
  current: MemoryClaimView | null;
  /** `pending` until a human decides; agent decisions only annotate. */
  status: 'pending' | 'decided';
  /** The standing human decision, when there is one. */
  decision: {
    outcome: MemoryDecisionOutcome;
    reviewerKind: MemoryReviewerKind;
    reviewedAt: string;
  } | null;
  /** Decisions by an agent or rule: shown, never promoting. */
  annotations: number;
}

export interface MemoryQueue {
  items: MemoryQueueItem[];
  /** Claims no rule flagged: recallable as `proposed` without any review. */
  recallableWithoutReview: number;
}

export type MemoryDecisionOutcome = 'accept' | 'correct' | 'reject' | 'hold';

/** `human` is attested by the host from the authenticated request; never sent. */
export type MemoryReviewerKind = 'human' | 'agent';

export interface MemoryDecisionRequest {
  outcome: MemoryDecisionOutcome;
  /** Required with `correct`: the value the reviewer says is right. */
  correctedValue?: string;
  rationale?: string;
}

export interface MemoryDecisionResult {
  itemId: string;
  outcome: MemoryDecisionOutcome;
  reviewerKind: MemoryReviewerKind;
  /** True only when a human decision changed what recall and the brief show. */
  promoted: boolean;
  reviewSeconds: number | null;
}

export interface MemoryRecallEntry extends MemoryClaimView {
  review: {
    label: MemoryReviewLabel;
    routing: 'not-evaluated' | 'uncontested' | 'routed';
    reasons: MemoryRoutingReason[];
  };
  /** Claims this one replaces, oldest first. */
  replaces: { claimId: string; text: string }[];
  /** Claims that replace this one. */
  replacedBy: { claimId: string; text: string }[];
  /** Other claims in the same slot that disagree with it. */
  conflictsWith: { claimId: string; text: string }[];
}

export interface MemoryRecall {
  query: string;
  entries: MemoryRecallEntry[];
  /** Claims left out because review rejected them or they could not be read. */
  withheld: number;
  /** Notes in the memory root that are not structured claims. */
  notes: { proposalId: string; title: string }[];
}

/** The background block a new session starts with. */
export interface MemoryBrief {
  /** Null when nothing qualified; no block is injected then. */
  text: string | null;
  entries: string[];
  bytes: number;
  budgetBytes: number;
  /** Eligible claims that did not fit the budget. */
  omitted: number;
}

/**
 * One change's journey, in the form the evals lane scores. `escaped` is not
 * here: whether a defect escaped is the evals lane's judgement, not the host's.
 */
export interface MemoryLineageMeasurement {
  lineageId: string;
  routed: boolean;
  rules: MemoryRoutingReason[];
  outcome: MemoryDecisionOutcome | 'pending' | 'not-routed';
  reviewerKind: MemoryReviewerKind | null;
  firstReviewedAt: string | null;
  /** Seconds from opening the item to submitting; null when not measured. */
  reviewSeconds: number | null;
}

export interface MemoryMeasurement {
  schema: 'station.memory-measurement/1';
  runId: string;
  generatedAt: string;
  claimsProposed: number;
  uncontested: number;
  routed: number;
  /** Null when no claim has been routed or proposed. */
  routedShare: number | null;
  routedByRule: Record<string, number>;
  reviewer: {
    decisions: number;
    confirmed: number;
    corrected: number;
    rejected: number;
    held: number;
    pending: number;
    annotated: number;
    defectsCaught: number;
  };
  reviewSeconds: number | null;
  reviewTimedDecisions: number;
  reviewMinutes: number | null;
  lineages: MemoryLineageMeasurement[];
}
