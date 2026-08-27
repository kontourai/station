/**
 * Admission control for `POST /api/environments/ssh/probe` (sol review
 * finding 4).
 *
 * The probe is the one route that starts a real outbound `ssh` process at a
 * hostname the CALLER names. Unbounded, an authenticated
 * `orchestration:operate` credential can use it two ways it was never meant
 * to support:
 *
 * - as an internal port-22 scanner — fire it at every address on the
 *   Station machine's networks and read the named failure code back
 *   (`connection-refused` vs `timeout` vs `auth-rejected` distinguishes a
 *   live sshd from a closed port from a filtered one), and
 * - as a process amplifier — every request holds processes for up to
 *   {@link SSH_PROBE_MAX_SECONDS}, so N concurrent requests hold N process
 *   groups on the operator's own machine.
 *
 * Two bounds, deliberately about CONCURRENCY rather than a rate window. A
 * rate window would still let one burst hold hundreds of live processes at
 * once, which is the resource that actually matters here; and a human
 * testing a connection in the Connections creator issues exactly one probe
 * at a time, so a concurrency bound costs the real user nothing.
 *
 * The per-principal key is the same server-established {@link BudgetPrincipal}
 * the mutation budget uses — a hash of the VERIFIED credential, never a
 * caller-supplied header, so a caller cannot mint itself extra slots by
 * choosing a transport or inventing an id.
 */

/** Slots held across the whole server, however many principals are calling. */
export const SSH_PROBE_GLOBAL_LIMIT = 3;
/** Slots held by any one credential. One human tests one connection. */
export const SSH_PROBE_PER_PRINCIPAL_LIMIT = 1;

export interface SshProbeAdmissionRefusal {
  /**
   * Seconds until a slot can free. Derived from the probe's own ceiling
   * rather than chosen: telling a caller to retry sooner than a probe can
   * finish sends them back into a slot that is still occupied.
   */
  retryAfterSeconds: number;
  /** Which bound refused — for the metric label and the operator's message. */
  scope: 'principal' | 'global';
}

export interface SshProbeAdmissionTicket {
  /** Idempotent: releasing twice frees one slot, not two. */
  release(): void;
}

export class SshProbeAdmission {
  readonly #inFlightByPrincipal = new Map<string, number>();
  readonly #retryAfterSeconds: number;
  readonly #globalLimit: number;
  readonly #perPrincipalLimit: number;
  #inFlight = 0;

  constructor(
    options: {
      retryAfterSeconds?: number;
      globalLimit?: number;
      perPrincipalLimit?: number;
    } = {},
  ) {
    this.#retryAfterSeconds = Math.max(1, options.retryAfterSeconds ?? 15);
    this.#globalLimit = Math.max(
      1,
      options.globalLimit ?? SSH_PROBE_GLOBAL_LIMIT,
    );
    this.#perPrincipalLimit = Math.max(
      1,
      options.perPrincipalLimit ?? SSH_PROBE_PER_PRINCIPAL_LIMIT,
    );
  }

  /** In-flight probes right now, for tests and telemetry. */
  get inFlight(): number {
    return this.#inFlight;
  }

  /**
   * Takes a slot, or refuses. The per-principal bound is checked FIRST so
   * one noisy credential is told it is the one over its own limit rather
   * than being blamed for a busy server.
   */
  admit(
    principalKey: string,
  ): SshProbeAdmissionTicket | SshProbeAdmissionRefusal {
    const held = this.#inFlightByPrincipal.get(principalKey) ?? 0;
    if (held >= this.#perPrincipalLimit) {
      return { retryAfterSeconds: this.#retryAfterSeconds, scope: 'principal' };
    }
    if (this.#inFlight >= this.#globalLimit) {
      return { retryAfterSeconds: this.#retryAfterSeconds, scope: 'global' };
    }
    this.#inFlightByPrincipal.set(principalKey, held + 1);
    this.#inFlight += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#inFlight -= 1;
        const remaining =
          (this.#inFlightByPrincipal.get(principalKey) ?? 1) - 1;
        // Delete at zero: the map must not grow one entry per credential
        // that ever probed, which is a slow leak on a long-lived server.
        if (remaining <= 0) this.#inFlightByPrincipal.delete(principalKey);
        else this.#inFlightByPrincipal.set(principalKey, remaining);
      },
    };
  }
}

export function isSshProbeAdmissionRefusal(
  result: SshProbeAdmissionTicket | SshProbeAdmissionRefusal,
): result is SshProbeAdmissionRefusal {
  return 'retryAfterSeconds' in result;
}
