import type { AppConfig } from '@kontourai/station-contracts/config';
import type { BuiltinAgentEngineBinding } from '@kontourai/station-contracts/engine-capability-matrix';

/**
 * The write half of `resolveBuiltinAgentEngineBinding`'s unchosen default.
 *
 * The resolver answers "which engine runs the built-in agent right now" from
 * live readiness. For a home that has NEVER expressed a choice it may answer
 * with the single capable engine ("the sensible default") — and until this
 * recording existed, that answer was recomputed from scratch on every boot and
 * every reload. The moment a SECOND capable engine became ready the resolver's
 * ambiguity rule withdrew the first one and failed safe to Station's own
 * engine, so an assistant that was working on OpenCode stopped working because
 * the user repaired a different engine's credentials (2026-10-22: Claude Code
 * became ready at 16:03:02 and the OpenCode binding was gone in the same
 * reload).
 *
 * A person's engine must not change because readiness did. So an ADOPTION is
 * recorded once, in `AppConfig.builtinAgentEngineConnectionId` — the authority
 * `docs/design/agent-engine-unification.md` §7.1.1 names — and every later
 * resolution reads it back through the resolver's explicit-choice branch,
 * where nothing recomputes a "smarter" answer over it.
 *
 * Exactly one transition is recorded: absent -> the adopted connection.
 *
 *  - An explicit choice (a string) is never overwritten.
 *  - Explicit Station (`null`) is an authored choice and is never overwritten.
 *  - A null resolution (no capable engine, or genuine ambiguity) writes
 *    nothing; it is not an adoption.
 *
 * Convergence, by the same argument `materializeBuiltinIntegrations` makes for
 * its existence-gated writes (archive#3063/#1588): the write's own condition
 * is the key's ABSENCE, and a write removes it. So a reload can trigger at
 * most one write and the next resolution is a read. That is why a recording
 * here cannot become the reload-writes-its-own-inputs loop those comments
 * exist to prevent.
 */
export interface BuiltinEngineAdoptionRecorder {
  updateAppConfig(updates: Partial<AppConfig>): Promise<AppConfig>;
}

export async function recordAdoptedBuiltinEngine(options: {
  configLoader: BuiltinEngineAdoptionRecorder;
  /** `AppConfig.builtinAgentEngineConnectionId` verbatim. */
  explicitConnectionId: AppConfig['builtinAgentEngineConnectionId'];
  binding: BuiltinAgentEngineBinding | null;
  logger?: {
    warn?: (message: string, meta?: Record<string, unknown>) => void;
  };
}): Promise<void> {
  const { configLoader, explicitConnectionId, binding, logger } = options;
  if (!binding || explicitConnectionId !== undefined) return;
  try {
    await configLoader.updateAppConfig({
      builtinAgentEngineConnectionId: binding.connectionId,
    });
  } catch (error) {
    // A home the process cannot write (read-only mount, a refused atomic
    // replace) must still run on the binding readiness resolved. The adoption
    // stays implicit — the pre-existing behavior — instead of failing a boot
    // over a housekeeping write.
    logger?.warn?.(
      'Could not record the adopted built-in agent engine; running on the resolved binding',
      { error, connectionId: binding.connectionId },
    );
  }
}
