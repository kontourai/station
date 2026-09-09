import { execFile } from 'node:child_process';

export interface CliDetectionOptions {
  /**
   * Cancels the probe. The locator child is killed and detection resolves
   * `false` — a probe nobody is waiting for any more is not an installation.
   * An already-aborted signal never spawns at all.
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
