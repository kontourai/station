import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  InboundWebhookConfiguration,
  InboundWebhookStartGrant,
} from '@kontourai/station-contracts/inbound-webhook';
import type {
  Clock,
  ReplayLedger,
  WebhookAudit,
  WebhookAuditEntry,
  WebhookCredentials,
  WebhookLookup,
} from '@kontourai/telltale';
import {
  type InboundWebhookAuditReason,
  InboundWebhookAuditStore,
  InboundWebhookConfigurationError,
  InboundWebhookConfigurationStore,
  InboundWebhookReplayStore,
} from './inbound-webhook-store.js';

/**
 * Five minutes absorbs ordinary CI/tunnel delivery delay while keeping a
 * captured request useful for only one short, named interval. Telltale's
 * webhook source applies it to freshness and keeps each replay key until the
 * first stale instant.
 */
export const INBOUND_WEBHOOK_REPLAY_WINDOW_SECONDS = 300;

/** Station's token-id format; Telltale's own check also admits `.`. */
function safeTokenId(value: string | undefined): string | undefined {
  return value && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
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

/**
 * What Station itself established about one request while Telltale verified
 * it. Telltale's emitted event carries the credential id through its secret
 * redaction, so it is not an identity; this is.
 */
export interface InboundWebhookRequest {
  /**
   * The exact token id Station's lookup returned for this request. Telltale
   * verifies the signature only with that credential, so once it accepted
   * the request this is the authenticated identity.
   */
  credentialId?: string;
}

const requests = new AsyncLocalStorage<InboundWebhookRequest>();

/** Wall-clock time from `now`, with unref'd timers so none holds the process open. */
function stationClock(now: () => number): Clock {
  return {
    now,
    setTimer(fn, ms) {
      const timer = setTimeout(fn, Math.max(0, ms));
      timer.unref?.();
      return timer;
    },
    clearTimer(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}

/**
 * Station's side of the inbound webhook. Telltale's webhook source verifies
 * a request (budget, attempts, credential, freshness, HMAC over the raw
 * bytes, replay); this service supplies its bindings over Station's stores,
 * and keeps what belongs to Station: the start grants and the receipts.
 *
 * The configuration is re-read on every request, so the off switch and a
 * revocation apply to the next request. Refusals are recorded by reason
 * without the body, headers, nonce or secret.
 */
export class InboundWebhookAuthorizationService {
  /** The clock Telltale's host runs on: freshness, replay expiry, rate windows. */
  readonly clock: Clock;
  readonly credentials: WebhookCredentials;
  readonly replay: ReplayLedger;
  readonly audit: WebhookAudit;
  private readonly config: InboundWebhookConfigurationStore;
  private readonly auditStore: InboundWebhookAuditStore;

  constructor(
    homeDir: string,
    now: () => number = Date.now,
    private readonly logger?: {
      warn?: (message: string, meta?: Record<string, unknown>) => void;
    },
  ) {
    this.clock = stationClock(now);
    this.config = new InboundWebhookConfigurationStore(homeDir);
    this.auditStore = new InboundWebhookAuditStore(homeDir);
    this.replay = new InboundWebhookReplayStore(homeDir);
    this.credentials = { lookup: (id) => this.lookup(id) };
    this.audit = { record: (entry) => this.recordAudit(entry) };
  }

  /**
   * Runs `work` (one `host.receive`) with its own request record, which the
   * credential lookup, the audit binding and the route share. Every Telltale
   * callback for that request runs inside it.
   */
  withRequest<T>(
    work: (request: InboundWebhookRequest) => Promise<T>,
  ): Promise<T> {
    const request: InboundWebhookRequest = {};
    return requests.run(request, () => work(request));
  }

  /** The request record of the request being verified, inside {@link withRequest}. */
  currentRequest(): InboundWebhookRequest | undefined {
    return requests.getStore();
  }

  /**
   * Telltale's credential lookup. The off switch is checked before the
   * token, so any token id is told `disabled`. A configuration that cannot
   * be read throws, which Telltale refuses as `policy_unavailable`.
   */
  lookup(presented: string): WebhookLookup {
    const request = requests.getStore();
    const tokenId = safeTokenId(presented);
    let configuration: InboundWebhookConfiguration;
    try {
      configuration = this.config.read();
    } catch (error) {
      if (error instanceof InboundWebhookConfigurationError) {
        // Review M1: the message names the token and the violated rule (for
        // example the 32-character secret floor), so a weak secret is not
        // indistinguishable from a corrupt file. It carries no secret.
        // Telltale logs only a fixed code, never an exception's text.
        this.logger?.warn?.('Inbound webhook configuration rejected', {
          detail: error.message,
        });
      }
      throw error;
    }
    // Exact-true provides a durable, reversible off switch with a safe default.
    if (configuration.enabled !== true) return { enabled: false };
    const token = configuration.tokens?.find(
      (candidate) => candidate.id === tokenId,
    );
    if (request && token) request.credentialId = token.id;
    return {
      enabled: true,
      ...(token
        ? {
            credential: {
              id: token.id,
              secret: token.secret,
              ...(token.revokedAt === undefined
                ? {}
                : { revokedAt: token.revokedAt }),
            },
          }
        : {}),
    };
  }

  /**
   * Authority, after Telltale accepted the request: may this token start
   * this Agent in this Project? The configuration is read again, so a grant
   * edit or a revocation made since verification applies.
   */
  startRefusal(
    tokenId: string,
    agentId: string,
    projectSlug: string | undefined,
  ): 'forbidden_start' | 'policy_unavailable' | undefined {
    let configuration: InboundWebhookConfiguration;
    try {
      configuration = this.config.read();
    } catch {
      return 'policy_unavailable';
    }
    const token =
      configuration.enabled === true
        ? configuration.tokens?.find((candidate) => candidate.id === tokenId)
        : undefined;
    return token &&
      token.revokedAt === undefined &&
      grantAllows(token.starts, agentId, projectSlug)
      ? undefined
      : 'forbidden_start';
  }

  /** Records a refusal Station made after Telltale accepted the request. */
  recordFailure(reason: InboundWebhookAuditReason, tokenId?: string): void {
    this.auditStore.record(reason, tokenId);
  }

  /** Review M3: the one durable record binding a webhook token id to the conversation it started. */
  recordSuccess(tokenId: string, conversationId: string): void {
    this.auditStore.recordSuccess(tokenId, conversationId);
  }

  /**
   * Telltale's audit entries name the credential as presented, unredacted
   * (only its emitted event is redacted), and only once it is known to exist
   * or for the off switch.
   */
  private recordAudit(entry: WebhookAuditEntry): void {
    if (entry.reason === 'unauthenticated_flood') {
      this.auditStore.recordAggregatedNoise(entry.count ?? 0);
      return;
    }
    this.auditStore.record(entry.reason, entry.credentialId);
  }
}
