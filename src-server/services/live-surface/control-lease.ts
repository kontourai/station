import type {
  LiveSurfaceControlLease,
  LiveSurfaceController,
  LiveSurfaceLeaseResult,
} from '@kontourai/station-contracts/live-surface';

/**
 * One controller, N viewers, two counters (#90).
 *
 * - The FENCE advances on every change of holder: claim, takeover, release,
 *   expiry. It is what operations fence on: an operation that captured
 *   fence F checks `isCurrent(F, controller)` before and after each step.
 *   Any holder change in between — including this same controller
 *   releasing and reclaiming — moves the fence, so the earlier operation's
 *   stragglers are refused rather than landing inside a later one.
 * - The EPOCH is what viewers see and echo with their input. It advances
 *   only when control passes to a DIFFERENT controller than the last one to
 *   hold it. A lease that merely lapses (expiry or release) leaves no holder
 *   and does not advance it: nobody else has acted, so the last holder's
 *   view is not stale and its next input reclaims without a refusal.
 *
 * Rules:
 * - A human's input auto-claims (`claimForHumanInput`) when the epoch the
 *   viewer observed is current. The most recent human input takes control —
 *   from another person, from another device of the same person, and always
 *   from an agent.
 * - An agent claims explicitly (`claimForAgent`). It never preempts a live
 *   human (`human-controlling`: a human holder is live until `humanHoldMs`
 *   after their last input or claim) and is refused `held-by-other` while a
 *   different agent holds an unexpired lease. The agent's identity comes from
 *   the caller's VERIFIED session; the registry's `claimAgentControl`
 *   authorizes its acting-for principal before calling this.
 * - Viewing never needs the lease.
 * - Expiry is evaluated lazily against the injected clock.
 */

/**
 * How long a human stays "live" in control after their last input or claim.
 * Every input renews it. Configurable per registry.
 */
const LIVE_SURFACE_HUMAN_HOLD_MS = 30_000;
const LIVE_SURFACE_AGENT_LEASE_TTL_MS = 60_000;

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

/** Fired when control passes to a different controller (the epoch advanced). */
export type LiveSurfaceHandoffListener = (
  lease: LiveSurfaceControlLease,
  previous: LiveSurfaceController | null,
) => void;

export type HumanController = Extract<LiveSurfaceController, { kind: 'human' }>;
export type AgentController = Extract<LiveSurfaceController, { kind: 'agent' }>;

export function sameController(
  a: LiveSurfaceController | null,
  b: LiveSurfaceController | null,
): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind || a.principal !== b.principal) return false;
  if (a.kind === 'human' && b.kind === 'human') return a.device === b.device;
  return (
    a.kind === 'agent' && b.kind === 'agent' && a.sessionId === b.sessionId
  );
}

/** The read-only face of a lease: what automation and the hub may use. */
export interface LiveSurfaceLeaseReader {
  readonly surfaceId: string;
  snapshot(): LiveSurfaceControlLease;
  isCurrent(
    fence: number,
    controller?: LiveSurfaceController,
  ): LiveSurfaceLeaseCheck;
  onChange(listener: (lease: LiveSurfaceControlLease) => void): () => void;
}

export class LiveSurfaceControlLeaseState implements LiveSurfaceLeaseReader {
  private epoch = 0;
  private fence = 0;
  private holder: LiveSurfaceController | null = null;
  /** The most recent non-null holder; its reclaim does not advance the epoch. */
  private lastHolder: LiveSurfaceController | null = null;
  private expiresAt: number | null = null;
  private readonly listeners = new Set<
    (lease: LiveSurfaceControlLease) => void
  >();
  private readonly handoffListeners = new Set<LiveSurfaceHandoffListener>();
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

  /** Subscribe to any change of holder, including to no holder. */
  onChange(listener: (lease: LiveSurfaceControlLease) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Subscribe to handoffs: control passed to a different controller. */
  onHandoff(listener: LiveSurfaceHandoffListener): () => void {
    this.handoffListeners.add(listener);
    return () => {
      this.handoffListeners.delete(listener);
    };
  }

  /**
   * The fence check. `fence` is the token an operation captured (the
   * `fence` of the lease its claim returned). `controller` omitted checks
   * only the token; passed, it also requires that controller to hold.
   */
  isCurrent(
    fence: number,
    controller?: LiveSurfaceController,
  ): LiveSurfaceLeaseCheck {
    this.expireIfDue();
    if (fence !== this.fence)
      return { ok: false, code: 'stale-epoch', lease: this.view() };
    if (controller && !sameController(controller, this.holder))
      return { ok: false, code: 'not-holder', lease: this.view() };
    return { ok: true, lease: this.view() };
  }

  /**
   * A human acted having last observed `observedEpoch`. Refused as
   * `stale-epoch` if control passed to someone else since; otherwise the
   * human holds the lease — a takeover advances the epoch, a continuing (or
   * returning) holder only renews.
   */
  claimForHumanInput(
    human: HumanController,
    observedEpoch: number,
  ): LiveSurfaceLeaseResult {
    this.expireIfDue();
    if (observedEpoch !== this.epoch)
      return { ok: false, code: 'stale-epoch', lease: this.view() };
    return this.claimHuman(human);
  }

  /** An explicit human claim (the "take control" button): no epoch needed. */
  claimHuman(human: HumanController): LiveSurfaceLeaseResult {
    this.expireIfDue();
    this.setHolder({ ...human }, this.now() + this.humanHoldMs);
    return { ok: true, lease: this.view() };
  }

  /**
   * An agent's explicit claim. `principal`/`sessionId` must come from the
   * verified calling session, never from tool arguments. Callers go through
   * the registry's `claimAgentControl`, which authorizes first.
   */
  claimForAgent(principal: string, sessionId: string): LiveSurfaceLeaseResult {
    this.expireIfDue();
    const controller: AgentController = { kind: 'agent', principal, sessionId };
    if (!sameController(controller, this.holder)) {
      if (this.holder?.kind === 'human')
        return { ok: false, code: 'human-controlling', lease: this.view() };
      if (this.holder)
        return { ok: false, code: 'held-by-other', lease: this.view() };
    }
    this.setHolder(controller, this.now() + this.agentTtlMs);
    return { ok: true, lease: this.view() };
  }

  /** Extend the holder's lease. Refused when the fence or holder moved. */
  renew(
    controller: LiveSurfaceController,
    fence: number,
  ): LiveSurfaceLeaseResult {
    const check = this.isCurrent(fence, controller);
    if (!check.ok) return check;
    this.expiresAt =
      this.now() +
      (controller.kind === 'human' ? this.humanHoldMs : this.agentTtlMs);
    return { ok: true, lease: this.view() };
  }

  /**
   * Give the lease up. Only the holder, presenting either its fence
   * (automation) or the viewer epoch it last observed (a human's button).
   */
  release(
    controller: LiveSurfaceController,
    stamp: { fence: number } | { epoch: number },
  ): LiveSurfaceLeaseResult {
    this.expireIfDue();
    const current =
      'fence' in stamp
        ? stamp.fence === this.fence
        : stamp.epoch === this.epoch;
    if (!current) return { ok: false, code: 'stale-epoch', lease: this.view() };
    if (!sameController(controller, this.holder))
      return { ok: false, code: 'not-holder', lease: this.view() };
    this.setHolder(null, null);
    return { ok: true, lease: this.view() };
  }

  private setHolder(
    holder: LiveSurfaceController | null,
    expiresAt: number | null,
  ): void {
    const changed = !sameController(this.holder, holder);
    const previousHolder = this.lastHolder;
    const handoff = holder !== null && !sameController(holder, this.lastHolder);
    if (handoff) this.epoch += 1;
    if (changed) this.fence += 1;
    this.holder = holder;
    if (holder) this.lastHolder = holder;
    this.expiresAt = expiresAt;
    if (!changed) return;
    const lease = this.view();
    if (handoff)
      for (const listener of [...this.handoffListeners])
        listener(lease, previousHolder);
    for (const listener of [...this.listeners]) listener(lease);
  }

  private expireIfDue(): void {
    if (this.holder && this.expiresAt !== null && this.now() >= this.expiresAt)
      this.setHolder(null, null);
  }

  private view(): LiveSurfaceControlLease {
    return {
      surfaceId: this.surfaceId,
      epoch: this.epoch,
      holder: this.holder ? { ...this.holder } : null,
      expiresAt: this.expiresAt,
      fence: this.fence,
    };
  }
}
