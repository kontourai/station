/**
 * Automatic adoption of detected native engines (archive#1575).
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

import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
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
  { id: 'claude', cli: 'claude' },
  { id: 'codex', cli: 'codex' },
  { id: 'muse', cli: 'muse' },
] as const;

/** Gallery-only request to keep native host CLIs out of screenshot fixtures. */
export const SUPPRESS_NATIVE_ENGINE_ADOPTION_ENV =
  'STATION_E2E_SUPPRESS_NATIVE_ENGINE_ADOPTION';

/**
 * The runner-owned instance namespace for the screenshot suite.
 *
 * CROSS-FILE COUPLE — this pattern must match `scripts/run-e2e-suite.mjs`'s
 * `e2e-${suite}-${Date.now()}-${base36}` minting. As with the contained Muse
 * provider override, a mismatch fails safe by making the request inert.
 */
const SCREENSHOT_E2E_INSTANCE = /^e2e-screenshot-[a-z0-9]+-[a-z0-9]+$/;

/**
 * Keep the gallery determinism request inert outside its disposable E2E home.
 *
 * The explicit value alone is never authority. The conjunction mirrors the
 * containment shape used by `museProviderOverrideContained`: the CLI-spawned
 * server must carry both `--temp-home` provenance and the runner-minted
 * screenshot instance id. Directly launched dotenv servers retain the same
 * documented residual as that seam because neither marker is attested there.
 */
export function nativeEngineAdoptionSuppressed(
  env: NodeJS.ProcessEnv,
): boolean {
  return (
    env[SUPPRESS_NATIVE_ENGINE_ADOPTION_ENV] === '1' &&
    env.STATION_HOME_SOURCE === '--temp-home' &&
    SCREENSHOT_E2E_INSTANCE.test(env.STATION_INSTANCE_ID ?? '')
  );
}

export function nativeEngineAdoptionDetection(
  env: NodeJS.ProcessEnv,
  detect: (cli: string) => Promise<boolean>,
): {
  suppressed: boolean;
  detect: (cli: string) => Promise<boolean>;
} {
  if (!nativeEngineAdoptionSuppressed(env)) {
    return { suppressed: false, detect };
  }
  return { suppressed: true, detect: async () => false };
}

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
  /** Injectable only so containment is unit-testable without process globals. */
  env?: NodeJS.ProcessEnv;
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
  const detection = nativeEngineAdoptionDetection(
    deps.env ?? process.env,
    deps.detect ?? detectCliOnPath,
  );
  const detect = detection.detect;
  const delays = deps.delaysMs ?? ADOPTION_ATTEMPT_DELAYS_MS;
  const outcomes: NativeEngineAdoptionSummary['outcomes'] = {};
  // Station itself is an engine too. Persist its ordinary editable definition
  // at the same seam as detected engines, rather than projecting a special
  // locked row on every request — but WITHOUT an engine-connection binding,
  // because `station` is a reserved Agent identity the registry can never
  // accept as a connection (archive#3662; see `materializeStationAgent`).
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
  // archive#3662 review MEDIUM-2: its OWN failure boundary. A home this
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
  // #875: a screenshot runtime must not persist whatever native CLIs happen
  // to exist on its capture host. Keep the ordinary Station Agent setup above
  // intact, but close the adoption window before any host probe can run.
  if (detection.suppressed) {
    for (const candidate of NATIVE_ENGINE_CANDIDATES) {
      outcomes[candidate.id] = 'absent';
    }
    return { outcomes };
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
            engineDisplayLabel(candidate.id) ?? candidate.id,
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
