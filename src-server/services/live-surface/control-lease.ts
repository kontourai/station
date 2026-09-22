import type {
  LiveSurfaceControlLease,
  LiveSurfaceController,
  LiveSurfaceLeaseResult,
} from '@kontourai/station-contracts/live-surface';

/**
 * One controller, N viewers, epochs (#90).
 *
 * Every change of holder — claim, takeover, release, expiry — advances the
 * epoch. That is the fence: an operation that captured epoch E before it
 * started checks `isCurrent(E, controller)` before and after each step, and a
 * human who reached for the surface in between has moved the epoch on, so the
 * operation aborts rather than acting on a page it no longer owns.
 *
 * Rules:
 * - A human's input auto-claims (`claimForHumanInput`) when the viewer's
 *   observed epoch is current. A human never has to ask first, and a human
 *   takeover always wins over an agent.
 * - An agent claims explicitly (`claimForAgent`). It never preempts a live
 *   human (refused `human-controlling`: a human holder is live until
 *   `humanHoldMs` after their last input or claim), and is refused
 *   `held-by-other` while a different agent holds an unexpired lease. The agent's identity comes
 *   from the caller's VERIFIED session, supplied by the server-side caller;
 *   nothing on the HTTP seam can claim as an agent.
 * - Viewing never needs the lease.
 * - Expiry is evaluated lazily against the injected clock, and advances the
 *   epoch like any other holder change, so an expired holder is fenced too.
 */

/**
 * How long a human stays "live" in control after their last input or claim.
 * Every input renews it. While it runs an agent claim is refused as
 * `human-controlling`; once it lapses the lease expires and an agent may
 * claim. Configurable per registry.
 */
export const LIVE_SURFACE_HUMAN_HOLD_MS = 30_000;
export const LIVE_SURFACE_AGENT_LEASE_TTL_MS = 60_000;

export interface LiveSurfaceControlLeaseOptions {
  now?: () => number;
  humanHoldMs?: number;
  agentTtlMs?: number;
}

export type LiveSurfaceLeaseCheck =
  | { ok: true; lease: LiveSurfaceControlLease }
  | {
      ok: false;
      code: 'stale-epoch' | 'not-holder';
      lease: LiveSurfaceControlLease;
    };

function sameController(
  a: LiveSurfaceController | null,
  b: LiveSurfaceController | null,
): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind || a.principal !== b.principal) return false;
  return (
    a.kind === 'human' || (b.kind === 'agent' && a.sessionId === b.sessionId)
  );
}

export class LiveSurfaceControlLeaseState {
  private epoch = 0;
  private holder: LiveSurfaceController | null = null;
  private expiresAt: number | null = null;
  private readonly listeners = new Set<
    (lease: LiveSurfaceControlLease) => void
  >();
  private readonly now: () => number;
  private readonly humanHoldMs: number;
  private readonly agentTtlMs: number;

  constructor(
    readonly surfaceId: string,
    options: LiveSurfaceControlLeaseOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.humanHoldMs = options.humanHoldMs ?? LIVE_SURFACE_HUMAN_HOLD_MS;
    this.agentTtlMs = options.agentTtlMs ?? LIVE_SURFACE_AGENT_LEASE_TTL_MS;
  }

  /** Current lease, after applying any pending expiry. */
  snapshot(): LiveSurfaceControlLease {
    this.expireIfDue();
    return this.view();
  }

  /** Subscribe to holder/epoch changes (not to plain renewals). */
  onChange(listener: (lease: LiveSurfaceControlLease) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * The fence. `controller` omitted checks only the epoch; passed, it also
   * requires that controller to be the current holder.
   */
  isCurrent(
    epoch: number,
    controller?: LiveSurfaceController,
  ): LiveSurfaceLeaseCheck {
    this.expireIfDue();
    if (epoch !== this.epoch)
      return { ok: false, code: 'stale-epoch', lease: this.view() };
    if (controller && !sameController(controller, this.holder))
      return { ok: false, code: 'not-holder', lease: this.view() };
    return { ok: true, lease: this.view() };
  }

  /**
   * A human acted on the surface having last observed `observedEpoch`.
   * Refused as `stale-epoch` if the view is stale (the surface changed hands
   * since the human last saw it); otherwise the human holds the lease — a
   * takeover advances the epoch, a continuing holder only renews.
   */
  claimForHumanInput(
    principal: string,
    observedEpoch: number,
  ): LiveSurfaceLeaseResult {
    this.expireIfDue();
    if (observedEpoch !== this.epoch)
      return { ok: false, code: 'stale-epoch', lease: this.view() };
    return this.claimHuman(principal);
  }

  /** An explicit human claim (the "take control" button): no epoch needed. */
  claimHuman(principal: string): LiveSurfaceLeaseResult {
    this.expireIfDue();
    const controller: LiveSurfaceController = { kind: 'human', principal };
    if (sameController(controller, this.holder)) {
      this.expiresAt = this.now() + this.humanHoldMs;
      return { ok: true, lease: this.view() };
    }
    this.transfer(controller, this.now() + this.humanHoldMs);
    return { ok: true, lease: this.view() };
  }

  /**
   * An agent's explicit claim. `principal`/`sessionId` must come from the
   * verified calling session, never from tool arguments.
   */
  claimForAgent(principal: string, sessionId: string): LiveSurfaceLeaseResult {
    this.expireIfDue();
    const controller: LiveSurfaceController = {
      kind: 'agent',
      principal,
      sessionId,
    };
    if (sameController(controller, this.holder)) {
      this.expiresAt = this.now() + this.agentTtlMs;
      return { ok: true, lease: this.view() };
    }
    if (this.holder?.kind === 'human')
      return { ok: false, code: 'human-controlling', lease: this.view() };
    if (this.holder)
      return { ok: false, code: 'held-by-other', lease: this.view() };
    this.transfer(controller, this.now() + this.agentTtlMs);
    return { ok: true, lease: this.view() };
  }

  /** Extend the holder's lease. Refused when the epoch or holder moved. */
  renew(
    controller: LiveSurfaceController,
    epoch: number,
  ): LiveSurfaceLeaseResult {
    const check = this.isCurrent(epoch, controller);
    if (!check.ok) return check;
    this.expiresAt =
      this.now() +
      (controller.kind === 'human' ? this.humanHoldMs : this.agentTtlMs);
    return { ok: true, lease: this.view() };
  }

  /** Give the lease up. Advances the epoch, fencing the releaser's own stragglers. */
  release(
    controller: LiveSurfaceController,
    epoch: number,
  ): LiveSurfaceLeaseResult {
    const check = this.isCurrent(epoch, controller);
    if (!check.ok) return check;
    this.transfer(null, null);
    return { ok: true, lease: this.view() };
  }

  private transfer(
    holder: LiveSurfaceController | null,
    expiresAt: number | null,
  ): void {
    this.epoch += 1;
    this.holder = holder;
    this.expiresAt = expiresAt;
    const lease = this.view();
    for (const listener of [...this.listeners]) listener(lease);
  }

  private expireIfDue(): void {
    if (this.holder && this.expiresAt !== null && this.now() >= this.expiresAt)
      this.transfer(null, null);
  }

  private view(): LiveSurfaceControlLease {
    return {
      surfaceId: this.surfaceId,
      epoch: this.epoch,
      holder: this.holder ? { ...this.holder } : null,
      expiresAt: this.expiresAt,
    };
  }
}
