import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { ExecutionTarget } from '@kontourai/station-contracts/execution-target';
import {
  FailureBudget,
  TelltaleHost,
  type UnauthenticatedBudget,
} from '@kontourai/telltale';
import { Hono } from 'hono';
import { readBoundedRequestBodyBytes } from '../../security/bounded-request-body.js';
import { managedApprovalCeilingFailureBody } from '../../security/managed-approval-ceiling.js';
import {
  managedCapabilityRefusalBody,
  webhookAutomationsAllowedByManagedPolicy,
} from '../../security/managed-capability-limits.js';
import {
  INBOUND_WEBHOOK_REPLAY_WINDOW_SECONDS,
  InboundWebhookAuthorizationService,
} from '../../services/webhooks/inbound-webhook-authorization.js';
import { inboundWebhookRequests } from '../../telemetry/metrics.js';
import type { Logger } from '../../utils/logger.js';

const INBOUND_WEBHOOK_PATH = '/inbound';
/** The Telltale source id; one webhook source per route instance. */
const INBOUND_WEBHOOK_SOURCE_ID = 'inbound';
const INBOUND_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
const INBOUND_WEBHOOK_MAX_ATTEMPTS_PER_WINDOW = 60;
/**
 * A request holds room in the unauthenticated budget until it authenticates
 * (Telltale counts requests in flight against it), so a sender that never
 * finishes its body must not hold that room. A real 256 KiB body arrives in
 * far less; past this the request is refused `malformed_request`.
 */
const INBOUND_WEBHOOK_BODY_DEADLINE_MS = 10_000;
/**
 * Review M2: a GLOBAL budget of unauthenticated attempts, independent of the
 * attacker-chosen token id. The per-token attempt limit buckets on a hash of
 * the supplied token, so a rotating id gets a fresh bucket every request and
 * never trips it; every refusal until this budget trips still costs one
 * config read and one audit write. Once THIS budget trips, refusal is nearly
 * free: no config read, no per-request audit write (Telltale aggregates the
 * suppressed refusals into one `unauthenticated_flood` entry a minute).
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
const INBOUND_WEBHOOK_UNAUTHENTICATED_BUDGET_WINDOW_MS = 60_000;

type WebhookPayload = { agent: string; project?: string; message: string };

type TurnStarter = (input: {
  target: ExecutionTarget;
  message: string;
  ephemeral: true;
  /** Review M3: stamped into session-start metadata beside `sessionVisibility`. */
  webhookTokenId: string;
}) => Promise<{ conversationId: string; providerTurnId: string }>;

/**
 * `outcome` is `accepted`, `managed_policy`, a Station refusal or one of
 * Telltale's closed refusal reasons, so the metric's label set stays bounded.
 */
function recordOutcome(outcome: string): void {
  try {
    inboundWebhookRequests.add(1, { outcome });
  } catch {
    // Observability must never alter webhook authorization.
  }
}

/**
 * The payload shape, on the body Telltale already decoded (strict UTF-8,
 * then JSON) after the signature held. A body that was not JSON arrives as
 * `{ text }` or `{ bytes }`, which this refuses like any other wrong shape.
 */
function payloadFrom(value: unknown): WebhookPayload | null {
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), INBOUND_WEBHOOK_BODY_DEADLINE_MS);
    timer.unref?.();
  });
  try {
    // On the deadline the request is refused and its budget room returned;
    // the abandoned read ends with the connection.
    const result = await Promise.race([
      readBoundedRequestBodyBytes(request, INBOUND_WEBHOOK_MAX_BODY_BYTES),
      deadline,
    ]);
    if (!result) return null;
    if (result.status === 'no-body') return new Uint8Array();
    return result.status === 'ok' ? result.bytes : null;
  } finally {
    clearTimeout(timer);
  }
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
 * The one public webhook leaf. Telltale's `webhook` source verifies the
 * request (named HMAC tokens, freshness, replay, rate budgets) and stamps it
 * `untrusted`: trust comes from the route it entered by, never from its
 * content. Station keeps the authority (the token's start grants) and the
 * action: the turn goes through the same foreground execution seam as
 * UI/CLI/MCP callers.
 */
export function createInboundWebhookRoutes(options: {
  homeDir: string;
  startTurn: TurnStarter;
  logger: Pick<Logger, 'warn'>;
  authorization?: InboundWebhookAuthorizationService;
  /**
   * Shared by Telltale (admission and its own refusals) and by this route
   * (refusals after Telltale accepted), so every refusal spends one budget.
   */
  unauthenticatedBudget?: UnauthenticatedBudget;
}): Hono {
  const app = new Hono();
  const authorization =
    options.authorization ??
    new InboundWebhookAuthorizationService(
      options.homeDir,
      undefined,
      options.logger,
    );
  const budget =
    options.unauthenticatedBudget ??
    new FailureBudget(
      INBOUND_WEBHOOK_UNAUTHENTICATED_BUDGET_MAX_ATTEMPTS,
      INBOUND_WEBHOOK_UNAUTHENTICATED_BUDGET_WINDOW_MS,
    );
  const host = new TelltaleHost({
    clock: authorization.clock,
    // Telltale redacts every line and never logs request content.
    logger: {
      info: () => undefined,
      warn: (message, meta) => options.logger.warn(message, meta),
    },
  });
  host.add({
    id: INBOUND_WEBHOOK_SOURCE_ID,
    type: 'webhook',
    // A signature proves who sent the request, not who wrote what is in it.
    trust: 'untrusted',
    options: {
      scheme: 'signed-timestamp',
      headers: {
        token: 'x-station-webhook-token',
        timestamp: 'x-station-webhook-timestamp',
        nonce: 'x-station-webhook-nonce',
        signature: 'x-station-webhook-signature',
      },
      windowSeconds: INBOUND_WEBHOOK_REPLAY_WINDOW_SECONDS,
      maxBodyBytes: INBOUND_WEBHOOK_MAX_BODY_BYTES,
      perCredentialPerMinute: INBOUND_WEBHOOK_MAX_ATTEMPTS_PER_WINDOW,
    },
    bindings: {
      credentials: authorization.credentials,
      replay: authorization.replay,
      audit: authorization.audit,
      budget,
    },
  });
  // An unsubscribed source accepts nothing. Station acts on the accepted
  // result below, after delivery, so the subscriber only takes the event.
  const listening = host.subscribe(INBOUND_WEBHOOK_SOURCE_ID, () => undefined);
  listening.catch(() => {
    options.logger.warn('Inbound webhook intake failed to start');
  });

  app.post(INBOUND_WEBHOOK_PATH, async (c) => {
    // #4521: the managed policy turned webhook automations off. Refused
    // before anything else: no configuration read, no body read, no limiter
    // or audit state, so neither the off switch in the file nor a token can
    // bring them back. The configuration is kept, for editing or deleting.
    if (!webhookAutomationsAllowedByManagedPolicy()) {
      recordOutcome('managed_policy');
      return c.json(managedCapabilityRefusalBody('webhook automations'), 403);
    }
    try {
      await listening;
    } catch {
      recordOutcome('not_listening');
      return c.json(
        { success: false, code: 'not_listening', retryable: true },
        503,
      );
    }

    // Review L1: Telltale runs every header-only check (budget, attempts,
    // off switch, token, revocation, timestamp/nonce format, freshness)
    // before it calls the body reader, then verifies the HMAC over the raw
    // received bytes, and only then reserves the replay key.
    const result = await host.receive(INBOUND_WEBHOOK_SOURCE_ID, {
      headers: c.req.raw.headers,
      body: () => readBoundedBody(c.req.raw),
    });
    if (!result.accepted) {
      // Budget and audit were already charged by Telltale.
      recordOutcome(result.reason);
      if (result.retryAfterSeconds !== undefined)
        c.header('Retry-After', String(result.retryAfterSeconds));
      return c.json(
        { success: false, code: result.reason, retryable: result.retryable },
        result.status,
      );
    }

    // A refusal after Telltale accepted: charged to the same budget and
    // audit as Telltale's own refusals.
    const refuse = (
      reason: 'malformed_request' | 'forbidden_start' | 'policy_unavailable',
      status: 400 | 403,
      tokenId?: string,
    ) => {
      budget.fail(authorization.clock.now());
      authorization.recordFailure(reason, tokenId);
      recordOutcome(reason);
      options.logger.warn('Inbound webhook refused', { reason });
      return c.json({ success: false, code: reason, retryable: false }, status);
    };
    // The `received` payload Telltale documents for a webhook source; its
    // package exports no type for it yet. `credentialId` is the token the
    // request authenticated with, never a value from the body.
    const { credentialId, body } = result.event.payload as {
      credentialId: string;
      body: unknown;
    };
    const payload = payloadFrom(body);
    // A malformed payload records no token id, as before Telltale.
    if (!payload) return refuse('malformed_request', 400);
    let target: ExecutionTarget;
    try {
      target = targetFor(payload);
    } catch {
      return refuse('malformed_request', 400);
    }
    const startRefusal = authorization.startRefusal(
      credentialId,
      payload.agent,
      payload.project,
    );
    if (startRefusal) return refuse(startRefusal, 403, credentialId);
    try {
      const started = await options.startTurn({
        target,
        message: payload.message,
        ephemeral: true,
        webhookTokenId: credentialId,
      });
      // Review M3: the durable record an OTel counter alone cannot provide —
      // binds this token id to the conversation it started.
      authorization.recordSuccess(credentialId, started.conversationId);
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
      // #4518: a start the managed approval ceiling refused is settled and
      // will be refused again as sent: a definitive 403 with the managed
      // code and sentence, never a retryable 503.
      const ceilingRefusal = managedApprovalCeilingFailureBody(error);
      if (ceilingRefusal) {
        options.logger.warn('Inbound webhook turn refused by managed policy');
        return c.json({ ...ceilingRefusal, retryable: false }, 403);
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
