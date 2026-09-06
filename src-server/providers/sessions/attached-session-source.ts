import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';

/**
 * Provider-neutral boundary for discovering external transcripts. Source handles
 * are opaque implementation tokens and must never cross into API or telemetry
 * payloads.
 */
export interface AttachedSessionDescriptor {
  provider: string;
  sessionId: string;
  threadId: string;
  cwd: string;
  createdAt: string;
  sourceHandle: string;
}

export type AttachedSessionSourceOutcome =
  | 'ok'
  | 'missing_root'
  | 'candidate_limit'
  | 'byte_limit'
  | 'line_limit'
  | 'malformed_record'
  | 'incomplete_tail'
  | 'rejected_candidate'
  | 'unknown_source';

export interface AttachedSessionDiscoveryResult {
  outcome: AttachedSessionSourceOutcome;
  sessions: AttachedSessionDescriptor[];
}

export interface AttachedSessionReadResult {
  outcome: AttachedSessionSourceOutcome;
  events: CanonicalRuntimeEvent[];
  /** Opaque, bounded continuation position within the source transcript. */
  cursor: AttachedSessionCursor;
}

export type AttachedSessionCursor =
  | number
  | {
      offset: number;
      eventIndex?: number;
      turnId?: string;
      /** Written by sources that persist turn-usage aggregation state. */
      usageAggregationVersion?: 1;
      /** Claude transcript usage held until its enclosing turn closes. */
      usage?: AttachedSessionUsageAccumulator;
      /** A legacy/byte-window cursor began inside an unknown turn. */
      usageDeferred?: boolean;
    };

export interface AttachedSessionUsageAccumulator {
  turnId: string;
  promptTokens?: number;
  completionTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWriteTokens5m?: number;
  cacheWriteTokens1h?: number;
  serviceTier?: string;
  serviceTierConflict?: boolean;
}

export interface AttachedSessionSource {
  readonly provider: string;
  /**
   * Stable source-owned identifier persisted with a read-only attachment and
   * used for diagnostics. The common follower does not infer it from the
   * provider name.
   */
  readonly kind: string;
  discover(): Promise<AttachedSessionDiscoveryResult>;
  read(
    session: AttachedSessionDescriptor,
    cursor?: AttachedSessionCursor,
  ): Promise<AttachedSessionReadResult>;
}
