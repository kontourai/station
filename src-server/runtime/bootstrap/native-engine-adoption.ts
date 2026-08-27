/**
 * Automatic adoption of detected native engines (#1575).
 *
 * A machine with the claude/codex CLI on PATH gets its engine connection and
 * same-ID default Agent created without a trip through the Providers UI.
 * Detection is retried on a short backoff because CLI probes race server
 * startup under load — the original defect was a one-shot bootstrap that
 * left `engineConnections: []` forever when detection lost the race.
 *
 * The registry stays the authority on restraint: adoption is idempotent and
 * `adoptNativeEngineConnection` settles as a no-op for existing connections,
 * recorded declines (the user deleted the engine before), and user-authored
 * agents squatting the id.
 */

import { ENGINE_CAPABILITY_MATRICES } from '@kontourai/station-contracts/engine-capability-matrix';
import {
  adoptNativeEngineConnection,
  loadOrCreateAgentRegistry,
  materializeEngineAgent,
  materializeStationAgent,
  type NativeEngineAdoptionOutcome,
} from '../../domain/agent-registry.js';
import type { ConfigLoader } from '../../domain/config-loader.js';
import { detectCliOnPath } from '../../utils/cli-detection.js';

export const NATIVE_ENGINE_CANDIDATES = [
  { id: 'claude', runtimeConnectionId: 'claude-runtime', cli: 'claude' },
  { id: 'codex', runtimeConnectionId: 'codex-runtime', cli: 'codex' },
  { id: 'muse', runtimeConnectionId: 'muse-runtime', cli: 'muse' },
] as const;

/** Backoff between detection attempts; ~2.2 minutes total window. */
const ADOPTION_ATTEMPT_DELAYS_MS = [0, 10_000, 30_000, 90_000] as const;

export interface NativeEngineAdoptionDeps {
  configLoader: ConfigLoader;
  logger: {
    info: (message: string, fields?: Record<string, unknown>) => void;
    /** Required: a swallowed adoption failure must never be invisible. */
    warn: (message: string, fields?: Record<string, unknown>) => void;
  };
  /** Timeout registry so shutdown can clear a pending attempt. */
  timers?: NodeJS.Timeout[];
  /**
   * Aborted on runtime shutdown: a pending inter-attempt delay resolves
   * immediately and the window closes, so the adoption promise always
   * settles instead of stranding on a cleared timer.
   */
  signal?: AbortSignal;
  detect?: (cli: string) => Promise<boolean>;
  delaysMs?: readonly number[];
}

export interface NativeEngineAdoptionSummary {
  outcomes: Record<string, NativeEngineAdoptionOutcome | 'absent' | 'error'>;
}

/**
 * Fire-and-forget from startup: never throws, never blocks initialization.
 * Resolves once every candidate settles or the attempt window closes.
 */
export async function adoptDetectedNativeEngines(
  deps: NativeEngineAdoptionDeps,
): Promise<NativeEngineAdoptionSummary> {
  const detect = deps.detect ?? detectCliOnPath;
  const delays = deps.delaysMs ?? ADOPTION_ATTEMPT_DELAYS_MS;
  const outcomes: NativeEngineAdoptionSummary['outcomes'] = {};
  // Station itself is an engine too. Persist its ordinary editable definition
  // at the same seam as detected engines, rather than projecting a special
  // locked row on every request — but WITHOUT an engine-connection binding,
  // because `station` is a reserved Agent identity the registry can never
  // accept as a connection (station#3662; see `materializeStationAgent`).
  // This is also where an older home is healed: the same call drops a
  // previously seeded `agentConnectionId: 'station'` on load.
  try {
    await loadOrCreateAgentRegistry(deps.configLoader);
  } catch (error) {
    for (const candidate of NATIVE_ENGINE_CANDIDATES) {
      outcomes[candidate.id] = 'error';
      deps.logger.warn('Native engine adoption failed', {
        engine: candidate.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { outcomes };
  }
  // station#3662 review MEDIUM-2: its OWN failure boundary. A home this
  // process cannot write is a real state (read-only mount, a filesystem that
  // refuses the atomic replace), and it must neither abort native-engine
  // detection — which is a separate question — nor pass silently. The record
  // stays stale on disk and is corrected at every read
  // (`withoutReservedStationBinding`), so dispatch works this boot either
  // way; what the operator needs is to know the file did not change.
  try {
    const station = await materializeStationAgent(deps.configLoader);
    if (station.healed) {
      deps.logger.info(
        "Removed the unresolvable 'station' engine binding from the Station Agent",
      );
    }
  } catch (error) {
    deps.logger.warn(
      "The Station Agent's stale 'station' engine binding could not be rewritten; it is ignored at read time, but the on-disk record stays stale until this home is writable",
      { error: error instanceof Error ? error.message : String(error) },
    );
  }
  const unresolved = new Set(NATIVE_ENGINE_CANDIDATES.map((c) => c.id));

  for (const delayMs of delays) {
    if (unresolved.size === 0) break;
    if (deps.signal?.aborted) break;
    if (delayMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          deps.signal?.removeEventListener('abort', onAbort);
          resolve();
        }, delayMs);
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        timer.unref?.();
        deps.timers?.push(timer);
        deps.signal?.addEventListener('abort', onAbort, { once: true });
      });
      if (deps.signal?.aborted) break;
    }
    for (const candidate of NATIVE_ENGINE_CANDIDATES) {
      if (!unresolved.has(candidate.id)) continue;
      try {
        if (!(await detect(candidate.cli))) {
          // Not on PATH (yet): leave unresolved for the next attempt.
          outcomes[candidate.id] = 'absent';
          continue;
        }
        const outcome = await adoptNativeEngineConnection(
          deps.configLoader,
          candidate.id,
          candidate.runtimeConnectionId,
        );
        outcomes[candidate.id] = outcome;
        unresolved.delete(candidate.id);
        // Only a connection that IS this native engine may be materialized
        // under its brand. 'connection-collision' means the id is already
        // registered as something else — a user's own `claude` ACP command,
        // say — and folding that into 'exists' (as this did) had bootstrap
        // create an Agent named "Claude Code" pointed at a stranger's engine.
        if (outcome === 'adopted' || outcome === 'exists') {
          await materializeEngineAgent(
            deps.configLoader,
            candidate.id,
            ENGINE_CAPABILITY_MATRICES[candidate.id]?.displayName ??
              candidate.id,
          );
        }
        if (outcome === 'connection-collision') {
          deps.logger.warn(
            'Detected native engine shares its id with another connection; leaving both untouched',
            { engine: candidate.id },
          );
        }
        if (outcome === 'adopted') {
          deps.logger.info(
            'Adopted detected native engine into the agent registry',
            { engine: candidate.id },
          );
        }
      } catch (error) {
        // Registry contention or an unreadable home: settle as 'error' for
        // this run rather than looping — the next server start retries.
        outcomes[candidate.id] = 'error';
        unresolved.delete(candidate.id);
        deps.logger.warn('Native engine adoption failed', {
          engine: candidate.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  // An abort closes the retry window, but preserve the last observed absence
  // for every candidate so callers never mistake an interrupted probe for an
  // unknown result.
  for (const candidate of NATIVE_ENGINE_CANDIDATES) {
    if (!unresolved.has(candidate.id)) continue;
    outcomes[candidate.id] ??= 'absent';
  }
  return { outcomes };
}
