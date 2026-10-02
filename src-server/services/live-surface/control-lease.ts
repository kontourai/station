import type {
  LiveSurfaceControlLease,
  LiveSurfaceController,
  LiveSurfaceLeaseResult,
} from '@kontourai/station-contracts/live-surface';

/**
 * One controller, many viewers, two counters (#90).
 * `fence` changes on takeover, release, and expiry so an old operation stays
 * invalid even when its controller reclaims. `epoch` changes only for a new
 * controller, so the same viewer can resume after a lapse without stale input.
 * Keep these separate: control-lease.test.ts covers both regressions (D2, S3).
 *
 * The registry authorizes before claiming; agent identity comes from the
 * verified calling session. Human input needs a current epoch, and an agent
 * cannot preempt a live human. Viewing does not require control.
 * Expiry runs on reads and on a timer so unwatched held input is also canceled.
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
  /**
   * The most a held press can keep a human live, measured from their last
   * input or claim (default 4 x humanHoldMs). A press that is never released
   * — the tab closed, the phone slept, the relay dropped, Cmd+Tab while
   * holding Meta — must not lock agents out forever.
   */
  maxHumanHoldMs?: number;
  agentTtlMs?: number;
}

/** A server-produced lease: `fence` is always present (optional on the wire). */
export type FencedLease = LiveSurfaceControlLease & { fence: number };

export type FencedLeaseResult =
  | { ok: true; lease: FencedLease }
  | {
      ok: false;
      code: Exclude<LiveSurfaceLeaseResult, { ok: true }>['code'];
      lease: FencedLease;
    };

export type LiveSurfaceLeaseCheck =
  | { ok: true; lease: FencedLease }
  | {
      ok: false;
      code: 'stale-fence' | 'not-holder';
      lease: FencedLease;
    };

/** Fired when control passes to a different controller (the epoch advanced). */
export type LiveSurfaceHandoffListener = (
  lease: LiveSurfaceControlLease,
  previous: LiveSurfaceController | null,
) => void;

export type HumanController = Extract<LiveSurfaceController, { kind: 'human' }>;
export type AgentController = Extract<LiveSurfaceController, { kind: 'agent' }>;

function sameController(
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
  snapshot(): FencedLease;
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
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** Whether the holder has anything pressed right now (the registry). */
  private holding: (holder: LiveSurfaceController) => boolean = () => false;
  private readonly listeners = new Set<
    (lease: LiveSurfaceControlLease) => void
  >();
  private readonly handoffListeners = new Set<LiveSurfaceHandoffListener>();
  private readonly now: () => number;
  private readonly humanHoldMs: number;
  private readonly maxHumanHoldMs: number;
  /** When the current human holder last claimed or sent input. */
  private lastHumanActivityAt = 0;
  private readonly agentTtlMs: number;

  constructor(
    readonly surfaceId: string,
    options: LiveSurfaceControlLeaseOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.humanHoldMs = options.humanHoldMs ?? LIVE_SURFACE_HUMAN_HOLD_MS;
    this.maxHumanHoldMs = options.maxHumanHoldMs ?? this.humanHoldMs * 4;
    this.agentTtlMs = options.agentTtlMs ?? LIVE_SURFACE_AGENT_LEASE_TTL_MS;
  }

  /** Current lease, after applying any pending expiry. */
  snapshot(): FencedLease {
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
      return { ok: false, code: 'stale-fence', lease: this.view() };
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
  ): FencedLeaseResult {
    if (this.disposed)
      return { ok: false, code: 'surface-closed', lease: this.view() };
    this.expireIfDue();
    if (observedEpoch !== this.epoch)
      return { ok: false, code: 'stale-epoch', lease: this.view() };
    return this.claimHuman(human);
  }

  /** An explicit human claim (the "take control" button): no epoch needed. */
  claimHuman(human: HumanController): FencedLeaseResult {
    if (this.disposed)
      return { ok: false, code: 'surface-closed', lease: this.view() };
    this.expireIfDue();
    this.lastHumanActivityAt = this.now();
    this.setHolder({ ...human }, this.now() + this.humanHoldMs);
    return { ok: true, lease: this.view() };
  }

  /**
   * An agent's explicit claim. `principal`/`sessionId` must come from the
   * verified calling session, never from tool arguments. Callers go through
   * the registry's `claimAgentControl`, which authorizes first.
   */
  claimForAgent(principal: string, sessionId: string): FencedLeaseResult {
    if (this.disposed)
      return { ok: false, code: 'surface-closed', lease: this.view() };
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

  /**
   * A person's keep-alive (not input): extend THEIR current hold, observed
   * at `observedEpoch`, while they are shown something that needs them. It
   * never claims and never preempts: anyone else holding, or a stale epoch,
   * is refused. It cannot outlast the cap measured from their LAST REAL
   * input (`maxHumanHoldMs`), and does not move that point: with no real
   * input, control lapses at the cap as it would without keep-alives.
   */
  keepHumanAlive(
    human: HumanController,
    observedEpoch: number,
  ): FencedLeaseResult {
    if (this.disposed)
      return { ok: false, code: 'surface-closed', lease: this.view() };
    this.expireIfDue();
    if (!sameController(human, this.holder))
      return { ok: false, code: 'not-holder', lease: this.view() };
    if (observedEpoch !== this.epoch)
      return { ok: false, code: 'stale-epoch', lease: this.view() };
    // The cap is enforced by the hold itself: a renewal never reaches past
    // it, and a hold that reached it has expired above (so the next
    // keep-alive finds no holder and is refused `not-holder`).
    const ceiling = this.lastHumanActivityAt + this.maxHumanHoldMs;
    this.expiresAt = Math.min(this.now() + this.humanHoldMs, ceiling);
    this.scheduleExpiry();
    return { ok: true, lease: this.view() };
  }

  /** Extend the holder's lease. Refused when the fence or holder moved. */
  renew(controller: LiveSurfaceController, fence: number): FencedLeaseResult {
    const check = this.isCurrent(fence, controller);
    if (!check.ok) return check;
    this.expiresAt =
      this.now() +
      (controller.kind === 'human' ? this.humanHoldMs : this.agentTtlMs);
    this.scheduleExpiry();
    return { ok: true, lease: this.view() };
  }

  /**
   * Give the lease up. Only the holder, presenting either its fence
   * (automation) or the viewer epoch it last observed (a human's button).
   */
  release(
    controller: LiveSurfaceController,
    stamp: { fence: number } | { epoch: number },
  ): FencedLeaseResult {
    this.expireIfDue();
    if ('fence' in stamp ? stamp.fence !== this.fence : false)
      return { ok: false, code: 'stale-fence', lease: this.view() };
    if ('epoch' in stamp ? stamp.epoch !== this.epoch : false)
      return { ok: false, code: 'stale-epoch', lease: this.view() };
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
    this.scheduleExpiry();
    if (!changed) return;
    const lease = this.view();
    if (handoff)
      for (const listener of [...this.handoffListeners])
        listener(lease, previousHolder);
    for (const listener of [...this.listeners]) listener(lease);
  }

  /**
   * Expiry is also applied on a timer, not only when someone reads the
   * lease: a lapse must reach its listeners (which cancel held input) even
   * on a surface nobody is watching or driving.
   */
  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (this.disposed || this.expiresAt === null) return;
    const delay = Math.max(0, this.expiresAt - this.now());
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.expireIfDue();
      if (this.holder && this.expiresAt !== null) this.scheduleExpiry();
    }, delay);
    this.expiryTimer.unref?.();
  }

  /**
   * Whether `holder` has anything pressed that IT dispatched. A human
   * holding a button or key stays live, so the lease does not lapse
   * mid-drag or mid-long-press — up to `maxHumanHoldMs` after their last
   * input, when it lapses and the press is cancelled. The probe answers
   * false while the surface is wedged.
   */
  setHoldProbe(probe: (holder: LiveSurfaceController) => boolean): void {
    this.holding = probe;
  }

  /** Stop the expiry timer and refuse further claims (unregister/dispose). */
  dispose(): void {
    this.disposed = true;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }

  private expireIfDue(): void {
    if (!this.holder || this.expiresAt === null || this.now() < this.expiresAt)
      return;
    const ceiling = this.lastHumanActivityAt + this.maxHumanHoldMs;
    if (
      this.holder.kind === 'human' &&
      this.now() < ceiling &&
      this.holding(this.holder)
    ) {
      // Still pressing: still live — but never past the ceiling.
      this.expiresAt = Math.min(this.now() + this.humanHoldMs, ceiling);
      this.scheduleExpiry();
      return;
    }
    this.setHolder(null, null);
  }

  private view(): FencedLease {
    return {
      surfaceId: this.surfaceId,
      epoch: this.epoch,
      holder: this.holder ? { ...this.holder } : null,
      expiresAt: this.expiresAt,
      fence: this.fence,
    };
  }
}
