import { execFile } from 'node:child_process';

export interface CliDetectionOptions {
  /**
   * Cancels the probe. The locator child is killed and detection resolves
   * `false`; an already-aborted signal never spawns at all.
   *
   * That `false` is NOT a statement about the host. This function has one
   * answer channel and no way to widen it without changing every caller, so
   * "the locator said no" and "you cancelled me" arrive identically — and a
   * caller that needs to tell them apart must consult the signal it passed,
   * as `adoptDetectedNativeEngines` does after each probe.
   *
   * `/api/system/status` passes a signal (station#1815) and still needs no
   * such concept — not because it cannot reach the case, which an earlier
   * version of this sentence claimed in the same change that gave it a
   * signal, but because it commits the falsy answer on its own expired
   * budget regardless and caches it either way (station#1832).
   */
  signal?: AbortSignal;
  /**
   * Wall-clock ceiling for the locator child. Opt-in: an unbounded probe is
   * the status quo for callers that already discard a late answer, and giving
   * every caller a ceiling would silently turn a slow host into "not
   * installed" on paths nobody has measured.
   */
  timeoutMs?: number;
}

/**
 * The one "is this CLI on PATH" probe (archive#1575 review): system status and
 * native-engine adoption must agree on what "installed" means, so both use
 * this helper. Non-empty stdout is required — a locator exiting 0 with no
 * path (shell-wrapper edge cases) is not an installation.
 *
 * `true` is therefore always a host fact. `false` is only a host fact when
 * the probe was neither cancelled nor killed by `timeoutMs`; see `signal`.
 *
 * station#1815 added `options`. Adoption runs this against the host PATH and
 * then WRITES what it finds into the agent registry, so the runtime has to be
 * able to stop it: without a cancellation channel the only way to bound
 * shutdown was to stop waiting, which is what let a probe (and the write
 * behind it) outlive the home it was writing into.
 */
export function detectCliOnPath(
  command: string,
  options?: CliDetectionOptions,
): Promise<boolean> {
  // Checked before the spawn, not only inside the callback: `execFile` with an
  // already-aborted signal still creates the child before killing it, and the
  // caller of an aborted probe is a runtime that has begun shutting down.
  if (options?.signal?.aborted) return Promise.resolve(false);
  const locator = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    execFile(
      locator,
      [command],
      {
        windowsHide: true,
        signal: options?.signal,
        // `timeout: 0` is Node's own "no timeout", so an absent option and an
        // explicit zero mean the same thing here.
        timeout: options?.timeoutMs ?? 0,
      },
      (error, stdout) => resolve(!error && stdout.trim().length > 0),
    );
  });
}
