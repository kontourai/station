import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';

/** Source bytes only. None of these fields authorize a learning lifecycle action. */
export type KnowledgeRecordObservation =
  | {
      state: 'observed';
      source: {
        rootId: string;
        recordId: string;
        adapterId: 'kit-default-store';
        type: string;
        title: string;
        category: string;
        body: string;
        provenance: {
          agent: string;
          source_ids?: string[];
          session_id?: string;
          note?: string;
        };
        created_at: string;
        updated_at: string;
        /** Omitted source status stays omitted; it is never learning activation. */
        status?: 'active' | 'implemented' | 'retired';
      };
      observation: {
        observedAt: string;
        contentDigest: string;
        ownerRevision: 'unknown';
        consistency: 'non-atomic';
        transactionState: 'unknown';
      };
    }
  | {
      state:
        | 'restricted'
        | 'unsupported'
        | 'missing'
        | 'busy'
        | 'corrupt'
        | 'unavailable'
        | 'invalid-input'
        | 'over-budget';
    };

export interface KnowledgeRootObservation {
  roots: KnowledgeStoreRoot[];
  /** A Station observation fingerprint, not an owner revision. */
  digest: string;
}

/**
 * Server composition only. No HTTP/UI caller is wired to this policy yet.
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
