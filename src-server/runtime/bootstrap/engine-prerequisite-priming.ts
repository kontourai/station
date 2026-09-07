/**
 * station#1586 (item 6): warm the engine prerequisite probes at boot, so the
 * first `startSession` of a process does not pay for them.
 *
 * The Claude adapter resolves its executable and probes `claude --version`
 * before it can launch a session (`resolveClaudeExecutable`), and that probe
 * is bounded by `runCliCommand`'s 10s timeout — on a cold mise/asdf shim it
 * really can take seconds. Nothing at boot reached it: readiness is resolved
 * lazily by the `/status` route (`resolveExternalEngineReadiness`), so a user
 * who starts a session before opening any surface that fetches status paid
 * the whole probe inside their first turn.
 *
 * This does not make the probe faster; it moves it off the session path. The
 * adapter memoizes one in-flight probe per `command + args`
 * (`ClaudeAdapter.versionProbe`), so a session that starts while this is
 * still running awaits the SAME probe rather than spawning a second one, and
 * a session that starts after it finished gets the cached answer.
 *
 * Fire-and-forget from startup: it never throws and never blocks
 * initialization. A failed probe is not cached (only a completed, zero-exit
 * result is), so nothing here can pin a transient failure — the next caller
 * re-probes exactly as it does today.
 */

export interface EnginePrerequisitePrimingTarget {
  provider: string;
  /**
   * Optional on `ProviderAdapterShape`, so an adapter that does not implement
   * it is skipped rather than assumed ready — priming observes, it never
   * derives a readiness claim of its own.
   */
  getPrerequisites?(options?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface EnginePrerequisitePrimingOptions {
  adapters: readonly EnginePrerequisitePrimingTarget[];
  logger?: { warn?: (message: string) => void };
  signal?: AbortSignal;
}

/**
 * Resolves once every prime attempt has settled. Never rejects: a probe
 * failure is a diagnostic, not a startup failure, and the caller has already
 * moved on.
 */
export async function primeEnginePrerequisites(
  options: EnginePrerequisitePrimingOptions,
): Promise<void> {
  const { adapters, logger, signal } = options;
  if (signal?.aborted) return;
  await Promise.all(
    adapters.map(async (adapter) => {
      if (typeof adapter.getPrerequisites !== 'function') return;
      try {
        await adapter.getPrerequisites(signal ? { signal } : undefined);
      } catch (error) {
        logger?.warn?.(
          `Engine prerequisite priming for '${adapter.provider}' did not complete: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }),
  );
}
