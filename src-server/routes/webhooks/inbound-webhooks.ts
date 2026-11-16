import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { ExecutionTarget } from '@kontourai/station-contracts/execution-target';
import {
  FailureBudget,
  type SourceApi,
  type SourceType,
  TelltaleHost,
  type UnauthenticatedBudget,
  type WebhookBindings,
  webhookSourceType,
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
  type InboundWebhookRequest,
} from '../../services/webhooks/inbound-webhook-authorization.js';
import { inboundWebhookRequests } from '../../telemetry/metrics.js';
import type { Logger } from '../../utils/logger.js';

const INBOUND_WEBHOOK_PATH = '/inbound';
/** The Telltale source id; one webhook source per route instance. */
const INBOUND_WEBHOOK_SOURCE_ID = 'inbound';
/** Telltale's `webhook` type with Station's decision before delivery (below). */
const INBOUND_WEBHOOK_SOURCE_TYPE = 'station-inbound-webhook';
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
  // On the deadline the stream is cancelled and the request refused, so it
  // returns its budget room and holds no reader.
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(),
    INBOUND_WEBHOOK_BODY_DEADLINE_MS,
  );
  timer.unref?.();
  try {
    const result = await readBoundedRequestBodyBytes(
      request,
      INBOUND_WEBHOOK_MAX_BODY_BYTES,
      deadline.signal,
    );
    if (result.status === 'no-body') return new Uint8Array();
    return result.status === 'ok' ? result.bytes : null;
  } finally {
    clearTimeout(timer);
  }
}

/** What Station decided about an authenticated request, before delivery. */
type InboundWebhookDecision =
  | {
      kind: 'start';
      credentialId: string;
      payload: WebhookPayload;
      target: ExecutionTarget;
    }
  | {
      kind: 'refuse';
      reason: 'malformed_request' | 'forbidden_start' | 'policy_unavailable';
      /** Recorded with the refusal; absent for a malformed payload, as before Telltale. */
      tokenId?: string;
    };

/** Thrown from `emit` so Telltale releases the replay reservation. */
class InboundWebhookStationRefusal extends Error {
  constructor() {
    super('inbound webhook refused by Station before delivery');
    this.name = 'InboundWebhookStationRefusal';
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
  // Station decides before Telltale commits the replay key: the payload
  // shape, the target and the token's start grant. A refusal throws from
  // `emit`, and Telltale releases the reservation, so the same signed
  // request is accepted once the grant is fixed (as before Telltale). Only
  // the fields Station uses are emitted: Telltale redacts the whole emitted
  // payload, and an unused, deeply nested field of the body must not decide
  // the request. The decision runs on the body Telltale parsed after the
  // signature held, and binds the identity Station's own lookup returned,
  // never the event's redacted copy.
  const decisions = new WeakMap<
    InboundWebhookRequest,
    InboundWebhookDecision
  >();
  const decide = (body: unknown): InboundWebhookDecision => {
    const credentialId = authorization.currentRequest()?.credentialId;
    if (credentialId === undefined)
      return { kind: 'refuse', reason: 'policy_unavailable' };
    const payload = payloadFrom(body);
    if (!payload) return { kind: 'refuse', reason: 'malformed_request' };
    let target: ExecutionTarget;
    try {
      target = targetFor(payload);
    } catch {
      return { kind: 'refuse', reason: 'malformed_request' };
    }
    const refusal = authorization.startRefusal(
      credentialId,
      payload.agent,
      payload.project,
    );
    if (refusal)
      return { kind: 'refuse', reason: refusal, tokenId: credentialId };
    return { kind: 'start', credentialId, payload, target };
  };
  const stationWebhook: SourceType<WebhookBindings> = {
    ...webhookSourceType,
    start(api) {
      const deciding: SourceApi<WebhookBindings> = Object.create(api);
      deciding.emit = (name, delivered, meta) => {
        const request = authorization.currentRequest();
        const decision = decide((delivered as { body?: unknown }).body);
        if (request) decisions.set(request, decision);
        if (decision.kind === 'refuse')
          return Promise.reject(new InboundWebhookStationRefusal());
        return api.emit(
          name,
          {
            credentialId: decision.credentialId,
            body: decision.payload,
            headers: (delivered as { headers?: unknown }).headers,
          },
          meta,
        );
      };
      return webhookSourceType.start(deciding);
    },
  };
  host.registerType(INBOUND_WEBHOOK_SOURCE_TYPE, stationWebhook);
  host.add({
    id: INBOUND_WEBHOOK_SOURCE_ID,
    type: INBOUND_WEBHOOK_SOURCE_TYPE,
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

    // A refusal Station makes (before or after Telltale): charged once to the
    // same budget, audit and metric as Telltale's own refusals.
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

    // Review L1: Telltale runs every header-only check (budget, attempts,
    // off switch, token, revocation, timestamp/nonce format, freshness)
    // before it calls the body reader, then verifies the HMAC over the raw
    // received bytes, and only then reserves the replay key.
    let request: InboundWebhookRequest | undefined;
    let result: Awaited<ReturnType<typeof host.receive>>;
    try {
      result = await authorization.withRequest((current) => {
        request = current;
        return host.receive(INBOUND_WEBHOOK_SOURCE_ID, {
          headers: c.req.raw.headers,
          body: () => readBoundedBody(c.req.raw),
        });
      });
    } catch {
      const decision = request ? decisions.get(request) : undefined;
      if (decision?.kind === 'refuse')
        return refuse(
          decision.reason,
          decision.reason === 'malformed_request' ? 400 : 403,
          decision.tokenId,
        );
      // Telltale failed inside an authenticated request (for example while
      // redacting what it would emit) instead of answering. Its reservation
      // was released and nothing was charged: refuse it once, as malformed.
      options.logger.warn('Inbound webhook intake failed on a request');
      return refuse('malformed_request', 400);
    }
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
    const decision = request ? decisions.get(request) : undefined;
    if (decision?.kind !== 'start') {
      // Telltale delivered only what `emit` decided to start.
      options.logger.warn('Inbound webhook delivered without a decision');
      return refuse('policy_unavailable', 403);
    }
    const { credentialId, payload, target } = decision;
    try {
      const started = await options.startTurn({
        target,
        // As Telltale emitted it: a webhook secret quoted in it is redacted.
        message: host.secrets.text(payload.message),
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
