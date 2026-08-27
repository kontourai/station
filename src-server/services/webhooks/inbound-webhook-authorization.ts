import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type {
  InboundWebhookConfiguration,
  InboundWebhookStartGrant,
  InboundWebhookToken,
} from '@kontourai/station-contracts/inbound-webhook';
import {
  type InboundWebhookAuditReason,
  InboundWebhookAuditStore,
  InboundWebhookConfigurationError,
  InboundWebhookConfigurationStore,
  InboundWebhookReplayStore,
} from './inbound-webhook-store.js';

/**
 * Five minutes absorbs ordinary CI/tunnel delivery delay while keeping a
 * captured request useful for only one short, named interval.
 */
export const INBOUND_WEBHOOK_REPLAY_WINDOW_MS = 5 * 60_000;

/**
 * Review L1: everything needed for the checks that never touch the request
 * body — the off switch, token existence/revocation, and timestamp/nonce
 * format/freshness. The route can run these, and refuse, before it ever
 * reads a byte of the body.
 */
export interface InboundWebhookHeaderAuthorizationRequest {
  tokenId?: string;
  timestamp?: string;
  nonce?: string;
}

export type InboundWebhookHeaderAuthorizationResult =
  | {
      allowed: true;
      token: InboundWebhookToken;
      timestamp: string;
      nonce: string;
    }
  | {
      allowed: false;
      reason: InboundWebhookAuditReason;
      /** 401 means the named token is unknown; 403 means it is known but forbidden. */
      status: 400 | 401 | 403;
    };

/** Review L1: the remaining checks, which need the raw bytes only for the HMAC. */
export interface InboundWebhookBodyAuthorizationRequest {
  token: InboundWebhookToken;
  timestamp: string;
  nonce: string;
  signature?: string;
  body: Uint8Array;
  agentId?: string;
  projectSlug?: string;
}

export type InboundWebhookAuthorizationResult =
  | { allowed: true; token: InboundWebhookToken }
  | {
      allowed: false;
      reason: InboundWebhookAuditReason;
      /** 401 means the named token is unknown; 403 means it is known but forbidden. */
      status: 400 | 401 | 403;
    };

function safeTokenId(value: string | undefined): string | undefined {
  return value && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

function requestIsFresh(timestamp: string | undefined, now: number): boolean {
  if (!timestamp || !/^\d{10}$/.test(timestamp)) return false;
  const timestampMs = Number(timestamp) * 1000;
  return Math.abs(now - timestampMs) <= INBOUND_WEBHOOK_REPLAY_WINDOW_MS;
}

function canonicalSignatureInput(
  timestamp: string,
  nonce: string,
  body: Uint8Array,
): Buffer {
  return Buffer.concat([
    Buffer.from(timestamp),
    Buffer.from('\n'),
    Buffer.from(nonce),
    Buffer.from('\n'),
    Buffer.from(body),
  ]);
}

/** The only signature comparison. It checks equal lengths before Node's constant-time primitive. */
export function signatureMatches(
  secret: string,
  timestamp: string,
  nonce: string,
  body: Uint8Array,
  signature: string | undefined,
): boolean {
  const match = signature?.match(/^sha256=([a-f0-9]{64})$/i);
  if (!match) return false;
  const expected = createHmac('sha256', secret)
    .update(canonicalSignatureInput(timestamp, nonce, body))
    .digest();
  const received = Buffer.from(match[1], 'hex');
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

function grantAllows(
  grants: readonly InboundWebhookStartGrant[] | undefined,
  agentId: string | undefined,
  projectSlug: string | undefined,
): boolean {
  return (
    agentId !== undefined &&
    grants?.some(
      (grant) => grant.agentId === agentId && grant.projectSlug === projectSlug,
    ) === true
  );
}

function replayKey(tokenId: string, timestamp: string, nonce: string): string {
  // Persist only a digest: the nonce is caller input, not useful audit data.
  return createHash('sha256')
    .update(tokenId)
    .update('\0')
    .update(timestamp)
    .update('\0')
    .update(nonce)
    .digest('hex');
}

/**
 * One authorization seam for every inbound request. Config rereads make the
 * switch and per-token revocation immediate; failures are recorded by reason
 * without retaining request bodies, headers, nonces, or secrets.
 */
export class InboundWebhookAuthorizationService {
  private readonly config: InboundWebhookConfigurationStore;
  private readonly replay: InboundWebhookReplayStore;
  private readonly audit: InboundWebhookAuditStore;

  constructor(
    homeDir: string,
    private readonly now: () => number = Date.now,
    private readonly logger?: {
      warn?: (message: string, meta?: Record<string, unknown>) => void;
    },
  ) {
    this.config = new InboundWebhookConfigurationStore(homeDir);
    this.replay = new InboundWebhookReplayStore(homeDir);
    this.audit = new InboundWebhookAuditStore(homeDir);
  }

  /**
   * Review L1: off switch, token existence/revocation, timestamp/nonce
   * format, and freshness — every check that never needs the request body.
   * The route calls this BEFORE reading a single byte off the wire; only a
   * request that survives this phase causes a body read at all.
   */
  authorizeHeaders(
    request: InboundWebhookHeaderAuthorizationRequest,
  ): InboundWebhookHeaderAuthorizationResult {
    const tokenId = safeTokenId(request.tokenId);
    let configuration: InboundWebhookConfiguration;
    try {
      configuration = this.config.read();
    } catch (error) {
      if (!(error instanceof InboundWebhookConfigurationError)) throw error;
      // Review M1: the thrown message names the token and the violated rule
      // (e.g. the 32-char secret floor). Discarding it made a weak secret
      // indistinguishable from a corrupt config — same code, same log line,
      // same audit entry. Surface it; it carries no secret material.
      this.logger?.warn?.('Inbound webhook configuration rejected', {
        detail: error.message,
      });
      return this.refuse('policy_unavailable', 403, tokenId);
    }
    // Exact-true provides a durable, reversible off switch with a safe default.
    if (configuration.enabled !== true)
      return this.refuse('disabled', 403, tokenId);
    const token = configuration.tokens?.find(
      (candidate) => candidate.id === tokenId,
    );
    if (!token) return this.refuse('unknown_token', 401);
    if (token.revokedAt !== undefined)
      return this.refuse('revoked_token', 403, token.id);
    if (
      !request.timestamp ||
      !request.nonce ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(request.nonce)
    ) {
      return this.refuse('malformed_request', 400, token.id);
    }
    const now = this.now();
    if (!requestIsFresh(request.timestamp, now)) {
      return this.refuse('stale_timestamp', 403, token.id);
    }
    return {
      allowed: true,
      token,
      timestamp: request.timestamp,
      nonce: request.nonce,
    };
  }

  /**
   * Review L1: the remaining checks, run only once `authorizeHeaders` has
   * already passed. HMAC is the only one of these that actually needs the
   * raw bytes; grant and replay stay here (rather than moving earlier too)
   * because they run in this exact order today — replay claims a nonce only
   * AFTER a valid signature proves the caller who holds the secret sent it,
   * so an unauthenticated caller can never burn/replay-lock a nonce.
   */
  authorizeBody(
    request: InboundWebhookBodyAuthorizationRequest,
  ): InboundWebhookAuthorizationResult {
    const { token } = request;
    if (
      !signatureMatches(
        token.secret,
        request.timestamp,
        request.nonce,
        request.body,
        request.signature,
      )
    ) {
      return this.refuse('invalid_signature', 403, token.id);
    }
    if (!grantAllows(token.starts, request.agentId, request.projectSlug)) {
      return this.refuse('forbidden_start', 403, token.id);
    }
    const now = this.now();
    try {
      const claimed = this.replay.claim(
        replayKey(token.id, request.timestamp, request.nonce),
        // Anchor the claim's expiry to the SIGNED timestamp when it is ahead
        // of receipt time. Freshness tolerates future clock skew
        // (Math.abs(now - timestampMs) <= WINDOW), so a request signed at
        // T = now + skew stays fresh until T + WINDOW; expiring the claim at
        // receipt time + WINDOW evicted it skew-early, and a captured request
        // could be replayed into that gap with the ledger already empty —
        // eviction re-opening the replay window it exists to close.
        Math.max(now, Number(request.timestamp) * 1000) +
          INBOUND_WEBHOOK_REPLAY_WINDOW_MS,
        now,
      );
      if (claimed === 'replayed') return this.refuse('replay', 403, token.id);
    } catch (error) {
      if (!(error instanceof InboundWebhookConfigurationError)) throw error;
      return this.refuse('policy_unavailable', 403, token.id);
    }
    return { allowed: true, token };
  }

  /** Records a refusal that was rejected before a complete auth decision (for example body parsing). */
  recordFailure(reason: InboundWebhookAuditReason): void {
    this.audit.record(reason, undefined);
  }

  /** Review M3: the one durable record binding a webhook token id to the conversation it started. */
  recordSuccess(tokenId: string, conversationId: string): void {
    this.audit.recordSuccess(tokenId, conversationId);
  }

  private refuse(
    reason: InboundWebhookAuditReason,
    status: 400 | 401 | 403,
    tokenId?: string,
  ): {
    allowed: false;
    reason: InboundWebhookAuditReason;
    status: 400 | 401 | 403;
  } {
    this.audit.record(reason, tokenId);
    return { allowed: false, reason, status };
  }
}
