import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';

/** Source bytes only. None of these fields authorize a learning lifecycle action. */
export type { LearningSourceObservation as KnowledgeRecordObservation } from '@kontourai/station-contracts/learning-review';

export interface KnowledgeRootObservation {
  roots: KnowledgeStoreRoot[];
  /** A Station observation fingerprint, not an owner revision. */
  digest: string;
}

/**
 * Server composition only. The production HTTP consumer passes its exact authenticated Request.
 * A caller's authority value is opaque and is NEVER itself an allow decision.
 * The host must re-evaluate the exact root/record on each synchronous call.
 */
export interface KnowledgeRecordObservationPolicy {
  /** Expected writer-home binding only; cannot select another lock namespace. */
  readonly stationHome: string;
  authorize(
    target: Readonly<{ rootId: string; recordId: string }>,
    authority: unknown,
  ): 'allowed' | 'restricted' | 'unavailable';
}
