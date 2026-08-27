import { createHash } from 'node:crypto';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { ExecutionTarget } from '@kontourai/station-contracts/execution-target';
import { Hono } from 'hono';
import { RuntimeAuthFailureLimiter } from '../../security/runtime-request-security.js';
import { CriticalResourcePostureError } from '../../services/infra/resource-posture.js';
import { InboundWebhookAuthorizationService } from '../../services/webhooks/inbound-webhook-authorization.js';
import {
  type InboundWebhookAuditReason,
  InboundWebhookAuditStore,
} from '../../services/webhooks/inbound-webhook-store.js';
import { inboundWebhookRequests } from '../../telemetry/metrics.js';
import type { Logger } from '../../utils/logger.js';

export const INBOUND_WEBHOOK_PATH = '/inbound';
export const INBOUND_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
export const INBOUND_WEBHOOK_RATE_WINDOW_MS = 60_000;
export const INBOUND_WEBHOOK_MAX_ATTEMPTS_PER_WINDOW = 60;
export const INBOUND_WEBHOOK_MAX_TRACKED_PRINCIPALS = 1_024;
/**
 * Review M2: a GLOBAL budget of unauthenticated attempts, independent of the
 * attacker-chosen token id. `InboundWebhookAttemptLimiter` below buckets on a
 * hash of the supplied token, so a rotating id gets a fresh bucket every
 * request and never trips it; every refusal until this budget trips still
 * costs one config read and one audit write. Once THIS budget trips,
 * refusal is nearly free — no config read, no per-request audit write (see
 * `InboundWebhookNoiseAggregator`).
 */
/**
 * Review H1 — this is an ADMISSION kill switch, not only a cost bound, and
 * that is a deliberate, disclosed availability trade: once tripped, EVERY
 * request is refused for the window's remainder, including a correctly
 * signed one from the legitimate caller. An unauthenticated attacker
 * sustaining ~5 requests/second can therefore deny the webhook surface for
 * as long as the flood lasts. The alternative (verifying signatures past the
 * trip) would either reintroduce the per-request config read the budget
 * exists to stop, or cache the config and violate the store's
 * read-on-every-request revocation invariant. Chosen: hard trip at a
 * threshold high enough that scanner noise cannot reach it, low enough that
 * a real flood trips within seconds. Pinned by the
 * 'valid signed request is refused once the budget trips' test so the trade
 * stays a recorded decision.
 */
export const INBOUND_WEBHOOK_UNAUTHENTICATED_BUDGET_MAX_ATTEMPTS = 300;
export const INBOUND_WEBHOOK_UNAUTHENTICATED_BUDGET_WINDOW_MS = 60_000;
/**
 * Review M2: how often a tripped budget's suppressed-refusal count may flush
 * to one aggregated audit entry. Bounding flushes to this cadence is what
 * stops a post-trip flood from evicting earlier, more diagnostically useful
 * entries out of the audit store's bounded 256-entry ring buffer.
 */
export const INBOUND_WEBHOOK_NOISE_FLUSH_INTERVAL_MS = 60_000;
/** Single, constant, attacker-independent key: this budget is global, never per-token. */
const UNAUTHENTICATED_BUDGET_KEY = 'unauthenticated';

type WebhookPayload = { agent: string; project?: string; message: string };

type TurnStarter = (input: {
  target: ExecutionTarget;
  message: string;
  ephemeral: true;
  /** Review M3: stamped into session-start metadata beside `sessionVisibility`. */
  webhookTokenId: string;
}) => Promise<{ conversationId: string; providerTurnId: string }>;

type AttemptWindow = { attempts: number; expiresAt: number };

/** Bounded, token-id-hashed inbound-attempt limiter. It never retains the supplied id. */
export class InboundWebhookAttemptLimiter {
  private readonly entries = new Map<string, AttemptWindow>();

  constructor(private readonly now: () => number = Date.now) {}

  retryAfterSeconds(tokenId: string | undefined): number | undefined {
    const now = this.now();
    this.prune(now);
    const entry = this.entries.get(this.key(tokenId));
    if (!entry || entry.attempts < INBOUND_WEBHOOK_MAX_ATTEMPTS_PER_WINDOW) {
      return undefined;
    }
    return Math.max(1, Math.ceil((entry.expiresAt - now) / 1000));
  }

  record(tokenId: string | undefined): void {
    const now = this.now();
    this.prune(now);
    const key = this.key(tokenId);
    const current = this.entries.get(key);
    if (current) {
      current.attempts += 1;
      this.entries.delete(key);
      this.entries.set(key, current);
      return;
    }
    while (this.entries.size >= INBOUND_WEBHOOK_MAX_TRACKED_PRINCIPALS) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, {
      attempts: 1,
      expiresAt: now + INBOUND_WEBHOOK_RATE_WINDOW_MS,
    });
  }

  private key(tokenId: string | undefined): string {
    return createHash('sha256')
      .update(tokenId ?? '<missing>')
      .digest('hex');
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

/**
 * Review M2: batches refusal noise that arrives after the unauthenticated
 * budget has already tripped into at most one aggregated audit entry per
 * {@link INBOUND_WEBHOOK_NOISE_FLUSH_INTERVAL_MS}, instead of one entry per
 * refusal. A flood of rotating-token-id requests therefore cannot evict
 * earlier, more diagnostically useful entries out of the audit store's
 * bounded 256-entry ring buffer — the aggregate write itself is rare enough
 * to never approach that cap. Chosen over "write nothing, ever, once
 * tripped": an operator watching the audit log still sees that a flood
 * happened and roughly how large it was, just not one line per request.
 */
export class InboundWebhookNoiseAggregator {
  #count = 0;
  #windowStartAt: number;

  constructor(
    private readonly audit: InboundWebhookAuditStore,
    private readonly now: () => number = Date.now,
    private readonly flushIntervalMs = INBOUND_WEBHOOK_NOISE_FLUSH_INTERVAL_MS,
  ) {
    this.#windowStartAt = this.now();
  }

  #pendingFlush: ReturnType<typeof setTimeout> | undefined;

  /**
   * Notes one suppressed refusal. Review M2: flushing only from a later
   * `note()` meant a flood shorter than the interval never produced its
   * aggregate entry at all (tripping the budget takes 40 attempts; floods
   * need not outlast 60s), and a residual count flushed hours later was
   * stamped with the wrong moment. An `unref`'d timer flushes the window's
   * residual on schedule without holding the process open; an exit inside
   * the final window can still lose that window's count, which is the
   * remaining, disclosed bound.
   */
  note(): void {
    this.#count += 1;
    const now = this.now();
    if (now - this.#windowStartAt >= this.flushIntervalMs) {
      this.#flush(now);
      return;
    }
    if (this.#pendingFlush === undefined) {
      const delay = Math.max(
        1,
        this.flushIntervalMs - (now - this.#windowStartAt),
      );
      this.#pendingFlush = setTimeout(() => {
        this.#pendingFlush = undefined;
        if (this.#count > 0) this.#flush(this.now());
      }, delay);
      this.#pendingFlush.unref?.();
    }
  }

  #flush(now: number): void {
    if (this.#pendingFlush !== undefined) {
      clearTimeout(this.#pendingFlush);
      this.#pendingFlush = undefined;
    }
    if (this.#count === 0) return;
    this.audit.recordAggregatedNoise(this.#count);
    this.#count = 0;
    this.#windowStartAt = now;
  }
}

function recordOutcome(outcome: 'accepted' | InboundWebhookAuditReason): void {
  try {
    inboundWebhookRequests.add(1, { outcome });
  } catch {
    // Observability must never alter webhook authorization.
  }
}

function parsePayload(bytes: Uint8Array): WebhookPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.agent !== 'string' ||
    !candidate.agent.trim() ||
    typeof candidate.message !== 'string' ||
    !candidate.message.trim() ||
    candidate.message.length > 200_000 ||
    (candidate.project !== undefined &&
      (typeof candidate.project !== 'string' || !candidate.project.trim()))
  ) {
    return null;
  }
  return {
    agent: candidate.agent.trim(),
    message: candidate.message,
    ...(typeof candidate.project === 'string'
      ? { project: candidate.project.trim() }
      : {}),
  };
}

async function readBoundedBody(request: Request): Promise<Uint8Array | null> {
  const declared = request.headers.get('content-length');
  if (
    declared &&
    (!/^\d+$/.test(declared) ||
      Number(declared) > INBOUND_WEBHOOK_MAX_BODY_BYTES)
  ) {
    return null;
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > INBOUND_WEBHOOK_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(next.value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function targetFor(payload: WebhookPayload): ExecutionTarget {
  return {
    environment: { kind: 'current' },
    agent: agentId(payload.agent),
    ...(payload.project
      ? {
          workspace: { kind: 'project' as const, projectSlug: payload.project },
        }
      : {}),
  };
}

/**
 * The one public webhook leaf. Authentication is intentionally bespoke (named
 * HMAC tokens), while the actual turn goes through the same foreground
 * execution seam as UI/CLI/MCP callers.
 */
export function createInboundWebhookRoutes(options: {
  homeDir: string;
  startTurn: TurnStarter;
  logger: Pick<Logger, 'warn'>;
  authorization?: InboundWebhookAuthorizationService;
  limiter?: InboundWebhookAttemptLimiter;
  unauthenticatedBudget?: RuntimeAuthFailureLimiter;
  noiseAggregator?: InboundWebhookNoiseAggregator;
}): Hono {
  const app = new Hono();
  const authorization =
    options.authorization ??
    new InboundWebhookAuthorizationService(
      options.homeDir,
      undefined,
      options.logger,
    );
  const limiter = options.limiter ?? new InboundWebhookAttemptLimiter();
  const unauthenticatedBudget =
    options.unauthenticatedBudget ??
    new RuntimeAuthFailureLimiter({
      maxFailures: INBOUND_WEBHOOK_UNAUTHENTICATED_BUDGET_MAX_ATTEMPTS,
      windowMs: INBOUND_WEBHOOK_UNAUTHENTICATED_BUDGET_WINDOW_MS,
      // Exactly one key (UNAUTHENTICATED_BUDGET_KEY) is ever used: this is a
      // single global counter, never per-token, so a rotating id cannot buy
      // itself a fresh bucket.
      maxTrackedPeers: 1,
    });
  const noiseAggregator =
    options.noiseAggregator ??
    new InboundWebhookNoiseAggregator(
      new InboundWebhookAuditStore(options.homeDir),
    );

  app.post(INBOUND_WEBHOOK_PATH, async (c) => {
    const tokenId = c.req.header('x-station-webhook-token');

    // Review M2: checked first, before any disk I/O. Once this budget has
    // tripped, refusal costs no config read and (ordinarily) no audit write
    // — a rotating token id can no longer buy an unbounded number of config
    // reads or audit read-modify-rewrites merely by presenting a new id.
    if (
      unauthenticatedBudget.retryAfterSeconds(UNAUTHENTICATED_BUDGET_KEY) !==
      undefined
    ) {
      noiseAggregator.note();
      recordOutcome('rate_limited');
      return c.json(
        { success: false, code: 'rate_limited', retryable: true },
        429,
      );
    }

    const retryAfter = limiter.retryAfterSeconds(tokenId);
    if (retryAfter !== undefined) {
      unauthenticatedBudget.recordFailure(UNAUTHENTICATED_BUDGET_KEY);
      authorization.recordFailure('rate_limited');
      recordOutcome('rate_limited');
      c.header('Retry-After', String(retryAfter));
      return c.json(
        { success: false, code: 'rate_limited', retryable: true },
        429,
      );
    }
    limiter.record(tokenId);

    // Review L1: every header-only check (off switch, token
    // existence/revocation, timestamp/nonce format, freshness) runs BEFORE
    // the body is read. Only a request that survives this phase pays for a
    // body read at all.
    const headerResult = authorization.authorizeHeaders({
      tokenId,
      timestamp: c.req.header('x-station-webhook-timestamp'),
      nonce: c.req.header('x-station-webhook-nonce'),
    });
    if (!headerResult.allowed) {
      unauthenticatedBudget.recordFailure(UNAUTHENTICATED_BUDGET_KEY);
      recordOutcome(headerResult.reason);
      options.logger.warn('Inbound webhook refused', {
        reason: headerResult.reason,
      });
      return c.json(
        { success: false, code: headerResult.reason, retryable: false },
        headerResult.status,
      );
    }

    const body = await readBoundedBody(c.req.raw);
    if (!body) {
      unauthenticatedBudget.recordFailure(UNAUTHENTICATED_BUDGET_KEY);
      authorization.recordFailure('malformed_request');
      recordOutcome('malformed_request');
      return c.json({ success: false, code: 'malformed_request' }, 400);
    }
    const payload = parsePayload(body);
    if (!payload) {
      unauthenticatedBudget.recordFailure(UNAUTHENTICATED_BUDGET_KEY);
      authorization.recordFailure('malformed_request');
      recordOutcome('malformed_request');
      return c.json({ success: false, code: 'malformed_request' }, 400);
    }
    let target: ExecutionTarget;
    try {
      target = targetFor(payload);
    } catch {
      unauthenticatedBudget.recordFailure(UNAUTHENTICATED_BUDGET_KEY);
      authorization.recordFailure('malformed_request');
      recordOutcome('malformed_request');
      return c.json({ success: false, code: 'malformed_request' }, 400);
    }
    const decision = authorization.authorizeBody({
      token: headerResult.token,
      timestamp: headerResult.timestamp,
      nonce: headerResult.nonce,
      signature: c.req.header('x-station-webhook-signature'),
      body,
      agentId: payload.agent,
      projectSlug: payload.project,
    });
    if (!decision.allowed) {
      unauthenticatedBudget.recordFailure(UNAUTHENTICATED_BUDGET_KEY);
      recordOutcome(decision.reason);
      options.logger.warn('Inbound webhook refused', {
        reason: decision.reason,
      });
      return c.json(
        { success: false, code: decision.reason, retryable: false },
        decision.status,
      );
    }
    try {
      const started = await options.startTurn({
        target,
        message: payload.message,
        ephemeral: true,
        webhookTokenId: decision.token.id,
      });
      // Review M3: the durable record an OTel counter alone cannot provide —
      // binds this token id to the conversation it started.
      authorization.recordSuccess(decision.token.id, started.conversationId);
      recordOutcome('accepted');
      return c.json(
        {
          success: true,
          data: {
            conversationId: started.conversationId,
            providerTurnId: started.providerTurnId,
            ephemeral: true,
          },
        },
        202,
      );
    } catch (error) {
      if (
        error instanceof CriticalResourcePostureError ||
        (typeof error === 'object' &&
          error !== null &&
          (error as { code?: unknown }).code === 'resource_posture_critical')
      ) {
        recordOutcome('policy_unavailable');
        return c.json(
          {
            success: false,
            code: 'resource_posture_critical',
            retryable: true,
          },
          503,
        );
      }
      options.logger.warn('Inbound webhook turn start failed');
      return c.json(
        { success: false, code: 'turn_start_failed', retryable: true },
        503,
      );
    }
  });
  return app;
}
