import type { TurnDispatchOrigin } from '@kontourai/station-contracts/runtime-events';

/**
 * How long after an unattended turn settles, or after the engine's last
 * event since, its engine is parked. Long enough for the engine's
 * own trailing events (a background task's notification, a late child-work
 * report) and for a delegator's immediate follow-up or a queued inbox entry
 * to arrive and keep the engine; short against the 30-minute idle park.
 */
export const FINISHED_SESSION_PARK_AFTER_MS = 15_000;

/**
 * Timers and event clocks disagree by milliseconds; the park is checked
 * against the full grace, so its timer runs this much longer.
 */
const PARK_TIMER_SLACK_MS = 500;

/**
 * Turn origins nobody is watching (#4512): a delegated child's turn, a
 * scheduled Automation run, a wake Station queued on a Task's Session. When
 * such a turn settles in a Session no person has sent into, the run has
 * reported (its result is read from the event log, not from the engine), and
 * only a later send needs the engine — which restarts it in place from its
 * resume cursor. A person's chat (an Automation queued into it, a Task room
 * someone typed in, a delegated Session a person took over) and anything
 * unclassified (`unknown`) keep the ordinary idle park.
 */
const UNATTENDED_TURN_ORIGINS: ReadonlySet<TurnDispatchOrigin> = new Set([
  'delegation',
  'automation',
  'task-dispatch',
]);

export interface FinishedSessionParkingPorts {
  /** Grace after the settle; `0` turns early parking off. */
  afterMs: number;
  /** The newest own turn's recorded origin; `undefined` when it has none. */
  latestTurnDispatchOrigin(threadId: string): TurnDispatchOrigin | undefined;
  /** Whether a person has sent any turn or steer into the Session. */
  hasPersonTurn(threadId: string): boolean;
  /**
   * Parks the Session if it is still parkable with nothing on it for
   * `afterMs` (the idle park's own checks, under its lifecycle lock).
   * Resolves whether it parked.
   */
  park(threadId: string, afterMs: number): Promise<boolean>;
  logger: {
    debug(message: string, data?: Record<string, unknown>): void;
    warn(message: string, data?: Record<string, unknown>): void;
  };
}

/**
 * Parks a finished-by-design Session's engine shortly after its unattended
 * turn settles, instead of after the idle threshold. Deciding nothing itself
 * about pending work: the park re-runs every idle-park refusal (open
 * request, running child work, engine-reported open work, an active turn,
 * no resume cursor, recent activity) when the timer fires. A refused park is
 * left to the idle sweep.
 */
export class FinishedSessionParking {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(private readonly ports: FinishedSessionParkingPorts) {}

  /** A turn on `threadId` reached its terminal event. */
  observeTurnSettled(threadId: string): void {
    // Any settle replaces an earlier pending park: only the newest turn's
    // origin decides.
    this.cancel(threadId);
    if (this.stopped || this.ports.afterMs <= 0 || !this.isUnattended(threadId))
      return;
    this.schedule(threadId);
  }

  /**
   * The engine reported something after the settle (a trailing tool event, a
   * subagent's progress): the grace starts again from now.
   */
  observeEngineActivity(threadId: string): void {
    if (this.stopped || !this.timers.has(threadId)) return;
    this.cancel(threadId);
    this.schedule(threadId);
  }

  private schedule(threadId: string): void {
    const timer = setTimeout(() => {
      this.timers.delete(threadId);
      // A person's turn that started and settled inside the grace replaced
      // this timer; this re-read covers a turn still open on it.
      if (this.stopped || !this.isUnattended(threadId)) return;
      void this.ports.park(threadId, this.ports.afterMs).then(
        (parked) => {
          if (parked)
            this.ports.logger.debug('Parked finished session engine', {
              threadId,
            });
        },
        (error: unknown) => {
          this.ports.logger.warn('Finished session was not parked', {
            threadId,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
    }, this.ports.afterMs + PARK_TIMER_SLACK_MS);
    timer.unref?.();
    this.timers.set(threadId, timer);
  }

  dispose(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private cancel(threadId: string): void {
    const timer = this.timers.get(threadId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(threadId);
  }

  private isUnattended(threadId: string): boolean {
    const origin = this.ports.latestTurnDispatchOrigin(threadId);
    return (
      origin !== undefined &&
      UNATTENDED_TURN_ORIGINS.has(origin) &&
      !this.ports.hasPersonTurn(threadId)
    );
  }
}
