import {
  findCliBinary,
  findCliBinaryAsync,
} from '../providers/auth/cli-auth.js';

export interface CliDetectionOptions {
  /**
   * Cancels the probe: detection resolves `false` at once, and an
   * already-aborted signal never starts a lookup at all.
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
   * Wall-clock ceiling for the lookup. Opt-in: an unbounded probe is
   * the status quo for callers that already discard a late answer, and giving
   * every caller a ceiling would silently turn a slow host into "not
   * installed" on paths nobody has measured.
   */
  timeoutMs?: number;
}

/**
 * The one "is this CLI installed" probe (archive#1575 review): system status
 * and native-engine adoption must agree on what "installed" means, so both
 * use this helper.
 *
 * #2663: it answers with `findCliBinaryAsync`, the SAME resolution the engine
 * spawns use (`codex-adapter-transport`, `muse-adapter`, `claude-adapter`)
 * and the ACP prerequisite probe uses: process PATH, then the user's
 * interactive-shell PATH, then the well-known install dirs. It used to be a
 * `which` that saw only the process PATH, which for an installed service is
 * the PATH frozen into its unit at install time — so a CLI in `~/.local/bin`
 * was ready for ACP and spawnable, yet never adopted. Adoption stores no
 * command (`{ kind: 'native' }`); the spawn re-resolves through the same
 * rule, which is what makes "found here" and "launched from there" agree.
 * `STATION_DISABLE_LOGIN_PATH_RESOLVE=1` still narrows both to the process
 * PATH.
 *
 * `true` is therefore always a host fact. `false` is only a host fact when
 * the probe was neither cancelled nor cut off by `timeoutMs`; see `signal`.
 *
 * station#1815 added `options`. Adoption WRITES what it finds into the agent
 * registry, so the runtime has to be able to stop waiting on a probe. The
 * lookup itself is `existsSync` over a directory list; the only child it can
 * involve is the once-per-process `$SHELL -ic` PATH capture, which
 * `resolveLoginShellPath` bounds and SIGKILLs itself and which other callers
 * share, so abandoning it here leaves nothing of this caller's running.
 */
export async function detectCliOnPath(
  command: string,
  options?: CliDetectionOptions,
): Promise<boolean> {
  // Checked before anything starts: the caller of an aborted probe is a
  // runtime that has begun shutting down, and the first lookup in a process
  // is what spawns the shared login-shell capture.
  if (options?.signal?.aborted) return false;
  // A hit needs no login-shell PATH, so it must not wait on one. The async
  // lookup awaits that capture (up to 5s) BEFORE searching, which let a cold
  // `/api/system/status` refresh, on a 2s budget, report a CLI sitting on
  // the process PATH as absent and cache that for a minute. Same rule, same
  // directories: `findCliBinary` is the sync read of what is known now.
  try {
    if (findCliBinary(command) !== null) return true;
  } catch {
    // Fall through to the awaited lookup, which has its own answer.
  }
  const lookup = findCliBinaryAsync(command).then(
    (binary) => binary !== null,
    () => false,
  );
  const signal = options?.signal;
  const timeoutMs = options?.timeoutMs ?? 0;
  if (!signal && timeoutMs <= 0) return lookup;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const givenUp = new Promise<boolean>((resolve) => {
    onAbort = () => resolve(false);
    signal?.addEventListener('abort', onAbort, { once: true });
    // `timeoutMs: 0` means "no ceiling", as Node's own `timeout: 0` did here.
    if (timeoutMs > 0) {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    }
  });
  try {
    return await Promise.race([lookup, givenUp]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}
