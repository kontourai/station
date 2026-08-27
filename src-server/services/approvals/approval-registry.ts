/**
 * Shared registry for pending tool approval requests.
 * Used by both VoltAgent elicitation and ACP permission requests.
 */

import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import {
  type ApprovalStatus,
  SERVER_EVENTS,
} from '@kontourai/station-contracts/runtime-events';
import {
  isHostedSessionReadAuthority,
  type SessionReadAuthority,
  type TenantExecutionContext,
} from '@kontourai/station-contracts/tenancy';
import { MS_PER_MINUTE } from '@kontourai/station-contracts/time';
import { approvalDuration, approvalOps } from '../../telemetry/metrics.js';
import type { EventBus } from '../orchestration/event-bus.js';

export interface ApprovalRequestMetadata {
  agentName?: string;
  agentSlug?: string;
  conversationId?: string;
  conversationTitle?: string;
  description?: string;
  server?: string | null;
  source: 'acp' | 'runtime';
  title: string;
  tool?: string;
  toolName?: string;
}

export interface ApprovalRegisterOptions {
  /**
   * Private, server-owned context for a registry approval. It is deliberately
   * never copied into lifecycle events or notification metadata.
   */
  authority?: SessionReadAuthority;
  metadata?: ApprovalRequestMetadata;
  /** Explicit backing session; never infer this from public event consumers. */
  sessionId?: string;
  timeoutMs?: number;
}

// Lifecycle frames can carry the session identity needed for hosted SSE even
// when a programmatic registry caller supplied only `sessionId`, rather than
// a complete UI-facing approval metadata object.
type ApprovalLifecycleMetadata = Partial<ApprovalRequestMetadata>;

interface ApprovalBinding {
  /** The Station-owned session that admitted this hosted approval. */
  sessionId: string;
  tenantExecutionContext: TenantExecutionContext;
}

/**
 * Private runtime callbacks. Route composition installs them after the
 * registry is bootstrapped, before hosted approvals can be registered.
 */
export interface HostedApprovalAuthorization {
  /** Runtime composition declares when tenant-safe binding is required. */
  isHosted: () => boolean;
  /** Validates a session binding before a hosted approval is registered. */
  resolveSessionTenant: (
    sessionId: string,
  ) => TenantExecutionContext | undefined;
  /** Reauthorizes a bound session at every hosted approval read/resolve. */
  canReadSession: (
    sessionId: string,
    authority: SessionReadAuthority,
  ) => boolean;
}

/**
 * How a pending approval finished — the same vocabulary the registry already
 * emits on {@link SERVER_EVENTS.APPROVAL_RESOLVED}, plus the one ending that
 * emits nothing because nobody was ever asked: a hosted registration refused
 * for want of a validated session binding.
 *
 * This exists because the boolean `register()` returns cannot tell a person
 * saying no from a person never answering. Both arrive as `false`, and a
 * caller reporting that to a user has to describe two situations with two
 * different next actions ("someone rejected this" / "nobody was there") in
 * one sentence. The registry knows which it was — it already logs and emits
 * the difference — so the difference now survives to the caller.
 */
export type ApprovalOutcome = ApprovalStatus | 'unbound';

interface PendingApproval {
  binding?: ApprovalBinding;
  metadata?: ApprovalLifecycleMetadata;
  resolve: (outcome: ApprovalOutcome) => void;
  reject: (error: Error) => void;
  createdAt: number;
}

export class ApprovalRegistry {
  private pending = new Map<string, PendingApproval>();
  private logger: any;
  private eventBus?: EventBus;

  constructor(
    logger: any,
    options?: {
      eventBus?: EventBus;
    } & Partial<HostedApprovalAuthorization>,
  ) {
    this.logger = logger;
    this.eventBus = options?.eventBus;
    if (
      options?.isHosted &&
      options.resolveSessionTenant &&
      options.canReadSession
    ) {
      this.setHostedAuthorization({
        isHosted: options.isHosted,
        resolveSessionTenant: options.resolveSessionTenant,
        canReadSession: options.canReadSession,
      });
    }
  }

  private hostedAuthorization?: HostedApprovalAuthorization;

  /**
   * Installs the request/session authority bridge after runtime bootstrap.
   * This changes no pending binding and never stores tenant data in events.
   */
  setHostedAuthorization(options: HostedApprovalAuthorization): void {
    this.hostedAuthorization = options;
  }

  /**
   * Register a pending approval and wait for resolution.
   * Returns a Promise<boolean> that resolves when the user responds.
   *
   * Use {@link registerForOutcome} instead when the caller has to tell the
   * user why the call did not run: this boolean deliberately keeps the
   * gate-shaped contract its callers want, and collapses every non-approval
   * into `false`.
   */
  register(
    approvalId: string,
    options: ApprovalRegisterOptions | number = MS_PER_MINUTE,
  ): Promise<boolean> {
    return this.registerForOutcome(approvalId, options).then(
      (outcome) => outcome === 'approved',
    );
  }

  /**
   * Register a pending approval and wait for its {@link ApprovalOutcome} —
   * the same wait as {@link register}, without discarding which ending it was.
   */
  registerForOutcome(
    approvalId: string,
    options: ApprovalRegisterOptions | number = MS_PER_MINUTE,
  ): Promise<ApprovalOutcome> {
    const timeoutMs =
      typeof options === 'number'
        ? options
        : (options.timeoutMs ?? MS_PER_MINUTE);
    const metadata = typeof options === 'number' ? undefined : options.metadata;
    const binding =
      typeof options === 'number' ? undefined : this.bindApproval(options);

    // A registry approval has no durable public row of its own. In hosted
    // mode it must therefore be anchored to a session validated by runtime
    // composition, or to request authority already minted by ingress. Do not
    // emit an opened event for an unbound request: even its id is a disclosure.
    if (this.hostedAuthorization?.isHosted() === true && !binding) {
      this.logger.warn('[ApprovalRegistry] Rejected unbound hosted approval', {
        approvalId,
      });
      return Promise.resolve('unbound');
    }

    // In hosted mode, bind the public lifecycle frame to precisely the
    // immutable session that admission validated. This is intentionally not
    // tenant data: the event route reauthorizes this session for its current
    // request authority, including after the pending entry is deleted.
    const eventMetadata: ApprovalLifecycleMetadata | undefined = binding
      ? { ...metadata, conversationId: binding.sessionId }
      : metadata;

    return new Promise<ApprovalOutcome>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const entry = this.pending.get(approvalId);
        if (entry) {
          this.pending.delete(approvalId);
          this.logger.warn('[ApprovalRegistry] Timeout', { approvalId });
          // One value for both the emitted lifecycle status and the awaited
          // outcome, so the event and the caller can never disagree.
          const outcome: ApprovalOutcome = 'expired';
          this.emitResolved(approvalId, outcome, entry.metadata);
          resolve(outcome);
        }
      }, timeoutMs);

      const wrappedResolve = (value: ApprovalOutcome) => {
        clearTimeout(timeout);
        resolve(value);
      };

      this.pending.set(approvalId, {
        binding,
        metadata: eventMetadata,
        resolve: wrappedResolve,
        reject,
        createdAt: Date.now(),
      });
      approvalOps.add(1, { operation: 'request' });
      this.eventBus?.emit(SERVER_EVENTS.APPROVAL_OPENED, {
        approvalId,
        ...serializeMetadata(eventMetadata),
      });
    });
  }

  /**
   * Trusted internal settlement seam for an already-admitted pending entry.
   *
   * This is deliberately not an HTTP/public authorization API: external
   * callers must use `resolveAuthorized()` with a freshly minted request
   * authority. Hosted internal callers can settle only an entry carrying the
   * private session binding that was validated at registration time; they
   * cannot supply or select a tenant.
   */
  resolve(
    approvalId: string,
    approved: boolean,
    clientOrigin?: ClientOrigin,
  ): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry || !this.canSettleInternally(entry)) return false;
    return this.settle(approvalId, entry, approved, clientOrigin);
  }

  /**
   * Resolve only after checking the same immutable binding used by event and
   * attention consumers. A false result is intentionally indistinguishable
   * from an unknown approval to public callers.
   */
  resolveAuthorized(
    approvalId: string,
    approved: boolean,
    authority?: SessionReadAuthority,
    clientOrigin?: ClientOrigin,
  ): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry || !this.canRead(approvalId, authority)) return false;
    return this.settle(approvalId, entry, approved, clientOrigin);
  }

  has(approvalId: string): boolean {
    return this.pending.has(approvalId);
  }

  /** True only when the approval exists and the caller can read its binding. */
  canRead(approvalId: string, authority?: SessionReadAuthority): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry) return false;
    if (this.hostedAuthorization?.isHosted() !== true) return true;
    if (
      !authority ||
      !isHostedSessionReadAuthority(authority) ||
      !authority.tenantExecutionContext ||
      !entry.binding
    ) {
      return false;
    }
    if (
      entry.binding.tenantExecutionContext.tenantId !==
      authority.tenantExecutionContext.tenantId
    ) {
      return false;
    }
    return (
      this.hostedAuthorization.canReadSession(
        entry.binding.sessionId,
        authority,
      ) === true
    );
  }

  /**
   * Authorizes an emitted lifecycle frame without consulting the pending map.
   * Resolved and timed-out entries are removed before their event is emitted,
   * so hosted SSE must reauthorize the admitted session carried in immutable
   * event metadata rather than retain a settled-entry tombstone.
   */
  canReadEvent(data: unknown, authority?: SessionReadAuthority): boolean {
    if (this.hostedAuthorization?.isHosted() !== true) return true;
    if (
      !authority ||
      !isHostedSessionReadAuthority(authority) ||
      !authority.tenantExecutionContext
    ) {
      return false;
    }
    const conversationId =
      typeof data === 'object' && data !== null
        ? (data as Record<string, unknown>).conversationId
        : undefined;
    return (
      typeof conversationId === 'string' &&
      this.hostedAuthorization.canReadSession(conversationId, authority) ===
        true
    );
  }

  cancelAll(): number {
    let count = 0;
    for (const [approvalId, entry] of this.pending) {
      entry.resolve('cancelled');
      this.emitResolved(approvalId, 'cancelled', entry.metadata);
      count++;
    }
    this.pending.clear();
    return count;
  }

  /** Generate a unique approval ID */
  static generateId(prefix = 'approval'): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private emitResolved(
    approvalId: string,
    status: ApprovalStatus,
    metadata?: ApprovalLifecycleMetadata,
    clientOrigin?: ClientOrigin,
  ): void {
    this.eventBus?.emit(SERVER_EVENTS.APPROVAL_RESOLVED, {
      approvalId,
      status,
      ...serializeMetadata(metadata),
      ...(clientOrigin ? { clientOrigin } : {}),
    });
  }

  private canSettleInternally(entry: PendingApproval): boolean {
    // Personal mode preserves the legacy in-process registry contract.
    if (this.hostedAuthorization?.isHosted() !== true) return true;
    // Hosted mode has no tenant-taking internal API. An internal process can
    // settle only a pending request already admitted with a sound session
    // binding; no session-less authority binding is accepted or retained.
    return entry.binding?.sessionId !== undefined;
  }

  private settle(
    approvalId: string,
    entry: PendingApproval,
    approved: boolean,
    clientOrigin?: ClientOrigin,
  ): boolean {
    const elapsed = Date.now() - entry.createdAt;
    // A settlement is always somebody's decision; only the timeout path above
    // produces an outcome nobody chose.
    const outcome: ApprovalOutcome = approved ? 'approved' : 'denied';
    entry.resolve(outcome);
    this.pending.delete(approvalId);
    approvalOps.add(1, { operation: approved ? 'approve' : 'deny' });
    approvalDuration.record(elapsed, {
      action: approved ? 'approve' : 'deny',
    });
    this.emitResolved(approvalId, outcome, entry.metadata, clientOrigin);
    this.logger.info('[ApprovalRegistry] Resolved', { approvalId, approved });
    return true;
  }

  private bindApproval(
    options: ApprovalRegisterOptions,
  ): ApprovalBinding | undefined {
    const sessionId = options.sessionId ?? options.metadata?.conversationId;
    if (!sessionId) return undefined;
    const tenantExecutionContext =
      this.hostedAuthorization?.resolveSessionTenant(sessionId);
    if (tenantExecutionContext) return { sessionId, tenantExecutionContext };
    return undefined;
  }
}

function serializeMetadata(
  metadata?: ApprovalLifecycleMetadata,
): Record<string, string> {
  if (!metadata) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(metadata).flatMap(([key, value]) =>
      value == null ? [] : [[key, String(value)]],
    ),
  );
}
