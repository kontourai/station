import {
  LIVE_SURFACE_STREAM_PARAM_BOUNDS,
  type LiveSurfaceFrameHeader,
  type LiveSurfaceRecord,
  type LiveSurfaceStreamParams,
  type LiveSurfaceStreamState,
} from '@kontourai/station-contracts/live-surface';
import type { LiveSurfaceControlLeaseState } from './control-lease.js';
import type { LiveSurfaceProducer } from './producer.js';

/**
 * Fan-out of one producer to N viewers (#90).
 *
 * LATEST-FRAME-WINS, end to end. There is no frame queue anywhere:
 * - the hub holds at most one not-yet-published frame (the fps throttle's
 *   trailing slot), and a newer frame replaces it;
 * - every viewer holds at most one undelivered frame, and a newer frame
 *   replaces it.
 * A slow viewer therefore sees fewer frames, never older ones. That is the
 * only honest behaviour over the remote relay, which is stop-and-wait with
 * 16 KB chunks (~5 fps): a queued frame is by definition a stale one.
 *
 * Backpressure: every frame is acked to the producer exactly once — when a
 * viewer first takes it, or when a newer frame supersedes it undelivered. A
 * producer that honours acks (CDP screencast) is thereby paced by the
 * fastest viewer, and paused entirely while every viewer is still busy
 * sending the previous frame.
 *
 * Adaptive params: when a viewer's slot is overwritten while that viewer is
 * still busy with its previous frame `downgradeAfter` times in a row, the
 * hub halves its fps (floor 1) and tells the producer if it can listen
 * (`updateParams`); otherwise the throttle enforces it. After
 * `recoverAfterMs` with no such overwrite it doubles back toward what the
 * viewers asked for.
 *
 * Lifecycle: the producer starts when the first viewer attaches and stops
 * when the last one leaves (after `idleStopMs`, default 0). Start/stop are
 * serialized, and a frame from a stopped run is discarded.
 */

export interface LiveSurfaceHubOptions {
  now?: () => number;
  /** A state record is sent after this long without any record. */
  heartbeatMs?: number;
  downgradeAfter?: number;
  recoverAfterMs?: number;
  idleStopMs?: number;
  onError?: (message: string, error: unknown) => void;
}

export interface LiveSurfaceViewerStats {
  delivered: number;
  /** Frames replaced in this viewer's slot before it took them. */
  overwritten: number;
}

export interface LiveSurfaceViewer {
  /**
   * The next record for this viewer: a pending state record first, else the
   * latest frame, else a heartbeat state record after `heartbeatMs`. Resolves
   * `null` once the viewer is closed (by `close`, the signal, or the hub).
   */
  next(signal?: AbortSignal): Promise<LiveSurfaceRecord | null>;
  close(): void;
  readonly stats: Readonly<LiveSurfaceViewerStats>;
  readonly closed: boolean;
}

interface HubFrame {
  header: LiveSurfaceFrameHeader;
  body: Uint8Array;
  acked: boolean;
}

const FPS_CEILING = LIVE_SURFACE_STREAM_PARAM_BOUNDS.maxFps.max;
const FPS_FLOOR = LIVE_SURFACE_STREAM_PARAM_BOUNDS.maxFps.min;

class HubViewer implements LiveSurfaceViewer {
  slot: HubFrame | null = null;
  statePending = true;
  closed = false;
  /** True between handing out a record and the next `next()` call. */
  busy = false;
  consecutiveSlowOverwrites = 0;
  readonly stats: LiveSurfaceViewerStats = { delivered: 0, overwritten: 0 };
  private wake: (() => void) | null = null;

  constructor(
    readonly hub: LiveSurfaceHub,
    readonly requested: LiveSurfaceStreamParams,
  ) {}

  notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  async next(signal?: AbortSignal): Promise<LiveSurfaceRecord | null> {
    this.busy = false;
    if (signal?.aborted) this.close();
    while (!this.closed) {
      const record = this.take();
      if (record) return record;
      const timedOut = await new Promise<boolean>((resolve) => {
        const onAbort = () => this.close();
        const timer = setTimeout(() => {
          this.wake = null;
          signal?.removeEventListener('abort', onAbort);
          resolve(true);
        }, this.hub.heartbeatMs);
        signal?.addEventListener('abort', onAbort, { once: true });
        this.wake = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(false);
        };
      });
      if (timedOut) this.statePending = true;
    }
    return null;
  }

  private take(): LiveSurfaceRecord | null {
    if (this.statePending) {
      this.statePending = false;
      this.busy = true;
      return { kind: 'state', state: this.hub.state() };
    }
    const frame = this.slot;
    if (!frame) return null;
    this.slot = null;
    this.busy = true;
    this.consecutiveSlowOverwrites = 0;
    this.stats.delivered += 1;
    this.hub.ackOnce(frame);
    return { kind: 'frame', header: { ...frame.header }, body: frame.body };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.slot = null;
    this.notify();
    this.hub.detach(this);
  }
}

export class LiveSurfaceHub {
  readonly heartbeatMs: number;
  private readonly viewers = new Set<HubViewer>();
  private readonly now: () => number;
  private readonly downgradeAfter: number;
  private readonly recoverAfterMs: number;
  private readonly idleStopMs: number;
  private readonly onError: (message: string, error: unknown) => void;
  private lifecycle: Promise<void> = Promise.resolve();
  private running = false;
  private runGeneration = 0;
  private startedParams: LiveSurfaceStreamParams | null = null;
  private adaptiveFps: number = FPS_CEILING;
  private lastSlowAt = 0;
  private pending: HubFrame | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPublishedAt = Number.NEGATIVE_INFINITY;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly unsubscribeLease: () => void;

  constructor(
    readonly producer: LiveSurfaceProducer,
    readonly lease: LiveSurfaceControlLeaseState,
    options: LiveSurfaceHubOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.heartbeatMs = options.heartbeatMs ?? 5_000;
    this.downgradeAfter = options.downgradeAfter ?? 3;
    this.recoverAfterMs = options.recoverAfterMs ?? 5_000;
    this.idleStopMs = options.idleStopMs ?? 0;
    this.onError = options.onError ?? (() => {});
    this.unsubscribeLease = lease.onChange(() => this.markStatePending());
  }

  get surfaceId(): string {
    return this.producer.surfaceId;
  }

  get viewerCount(): number {
    return this.viewers.size;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Resolves once queued start/stop transitions have settled (tests, shutdown). */
  settled(): Promise<void> {
    return this.lifecycle;
  }

  attach(requested: LiveSurfaceStreamParams): LiveSurfaceViewer {
    if (this.disposed) throw new Error('live surface hub is disposed');
    const viewer = new HubViewer(this, { ...requested });
    this.viewers.add(viewer);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.onTargetChanged();
    this.reconcile();
    return viewer;
  }

  /** @internal Called by a viewer's `close`. */
  detach(viewer: HubViewer): void {
    if (!this.viewers.delete(viewer)) return;
    if (this.viewers.size > 0) {
      this.onTargetChanged();
      return;
    }
    if (this.idleStopMs > 0) {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        this.reconcile();
      }, this.idleStopMs);
    } else {
      this.reconcile();
    }
  }

  /** Element-wise max of what attached viewers asked for. */
  targetParams(): LiveSurfaceStreamParams {
    let target: LiveSurfaceStreamParams | null = null;
    for (const viewer of this.viewers) {
      const r = viewer.requested;
      target = target
        ? {
            maxFps: Math.max(target.maxFps, r.maxFps),
            quality: Math.max(target.quality, r.quality),
            maxWidth: Math.max(target.maxWidth, r.maxWidth),
            maxHeight: Math.max(target.maxHeight, r.maxHeight),
          }
        : { ...r };
    }
    return (
      target ?? {
        maxFps: FPS_FLOOR,
        quality: LIVE_SURFACE_STREAM_PARAM_BOUNDS.quality.min,
        maxWidth: LIVE_SURFACE_STREAM_PARAM_BOUNDS.maxWidth.min,
        maxHeight: LIVE_SURFACE_STREAM_PARAM_BOUNDS.maxHeight.min,
      }
    );
  }

  effectiveParams(): LiveSurfaceStreamParams {
    const target = this.targetParams();
    return { ...target, maxFps: Math.min(target.maxFps, this.adaptiveFps) };
  }

  state(): LiveSurfaceStreamState {
    return {
      surfaceId: this.surfaceId,
      lease: this.lease.snapshot(),
      effectiveParams: this.effectiveParams(),
    };
  }

  /** @internal Ack a frame to the producer, exactly once. */
  ackOnce(frame: HubFrame): void {
    if (frame.acked) return;
    frame.acked = true;
    try {
      this.producer.ack(frame.header.seq);
    } catch (error) {
      this.onError('live surface producer ack failed', error);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.unsubscribeLease();
    for (const viewer of [...this.viewers]) viewer.close();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.reconcile();
    await this.lifecycle;
  }

  private markStatePending(): void {
    for (const viewer of this.viewers) {
      viewer.statePending = true;
      viewer.notify();
    }
  }

  private onTargetChanged(): void {
    this.markStatePending();
    this.pushParamsToProducer();
  }

  private pushParamsToProducer(): void {
    if (!this.running || !this.producer.updateParams) return;
    const params = this.effectiveParams();
    const started = this.startedParams;
    if (
      started &&
      started.maxFps === params.maxFps &&
      started.quality === params.quality &&
      started.maxWidth === params.maxWidth &&
      started.maxHeight === params.maxHeight
    )
      return;
    this.startedParams = params;
    const generation = this.runGeneration;
    this.lifecycle = this.lifecycle.then(async () => {
      if (!this.running || generation !== this.runGeneration) return;
      try {
        await this.producer.updateParams?.(params);
      } catch (error) {
        this.onError('live surface producer rejected new params', error);
      }
    });
  }

  private reconcile(): void {
    this.lifecycle = this.lifecycle.then(async () => {
      const wantRunning = this.viewers.size > 0 && !this.disposed;
      if (wantRunning && !this.running) {
        const generation = ++this.runGeneration;
        const params = this.effectiveParams();
        this.startedParams = params;
        this.running = true;
        try {
          await this.producer.start(params, (header, body) =>
            this.onFrame(generation, header, body),
          );
        } catch (error) {
          this.running = false;
          this.runGeneration += 1;
          this.onError('live surface producer failed to start', error);
          // Close the viewers so their streams end and clients reconnect
          // with backoff, rather than holding a connection to nothing.
          for (const viewer of [...this.viewers]) viewer.close();
        }
      } else if (!wantRunning && this.running) {
        this.running = false;
        this.runGeneration += 1;
        this.clearPending();
        this.adaptiveFps = FPS_CEILING;
        try {
          await this.producer.stop();
        } catch (error) {
          this.onError('live surface producer failed to stop', error);
        }
      }
    });
  }

  private clearPending(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pending = null;
  }

  private onFrame(
    generation: number,
    header: LiveSurfaceFrameHeader,
    body: Uint8Array,
  ): void {
    if (!this.running || generation !== this.runGeneration) return;
    if (header.surfaceId !== this.surfaceId) {
      this.onError(
        'live surface producer emitted a frame for another surface',
        header.surfaceId,
      );
      return;
    }
    const frame: HubFrame = { header: { ...header }, body, acked: false };
    // Trailing-edge throttle with a single slot: a newer frame supersedes
    // the held one (acking it), and the held frame is published when the
    // interval opens — so the LAST frame of a burst is never lost, which
    // matters because a screencast sends nothing more once a page is still.
    if (this.pending) this.ackOnce(this.pending);
    this.pending = frame;
    const interval = 1000 / this.effectiveParams().maxFps;
    const wait = this.lastPublishedAt + interval - this.now();
    if (wait <= 0) {
      this.publishPending();
    } else if (!this.pendingTimer) {
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        this.publishPending();
      }, wait);
    }
  }

  private publishPending(): void {
    const frame = this.pending;
    this.pending = null;
    if (!frame || !this.running) return;
    this.lastPublishedAt = this.now();
    frame.header.epoch = this.lease.snapshot().epoch;
    let slow = false;
    for (const viewer of this.viewers) {
      const previous = viewer.slot;
      if (previous) {
        // Superseded undelivered: this viewer skips it. Latest frame wins.
        this.ackOnce(previous);
        viewer.stats.overwritten += 1;
        if (viewer.busy) {
          viewer.consecutiveSlowOverwrites += 1;
          if (viewer.consecutiveSlowOverwrites >= this.downgradeAfter)
            slow = true;
        }
      }
      viewer.slot = frame;
      viewer.notify();
    }
    if (slow) this.downgrade();
    else this.maybeRecover();
  }

  private downgrade(): void {
    const current = Math.min(this.adaptiveFps, this.targetParams().maxFps);
    this.adaptiveFps = Math.max(FPS_FLOOR, Math.floor(current / 2));
    this.lastSlowAt = this.now();
    for (const viewer of this.viewers) viewer.consecutiveSlowOverwrites = 0;
    this.onTargetChanged();
  }

  private maybeRecover(): void {
    if (this.adaptiveFps >= this.targetParams().maxFps) return;
    if (this.now() - this.lastSlowAt < this.recoverAfterMs) return;
    this.adaptiveFps = Math.min(FPS_CEILING, this.adaptiveFps * 2);
    this.lastSlowAt = this.now();
    this.onTargetChanged();
  }
}
