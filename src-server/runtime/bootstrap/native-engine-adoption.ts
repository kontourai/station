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
import {
  type CliDetectionOptions,
  detectCliOnPath,
} from '../../utils/cli-detection.js';
import { errorMessage } from '../../utils/error-message.js';

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
  detect: NativeEngineDetect,
): {
  suppressed: boolean;
  detect: NativeEngineDetect;
} {
  if (!nativeEngineAdoptionSuppressed(env)) {
    return { suppressed: false, detect };
  }
  return { suppressed: true, detect: async () => false };
}

/** Backoff between detection attempts; ~2.2 minutes total window. */
const ADOPTION_ATTEMPT_DELAYS_MS = [0, 10_000, 30_000, 90_000] as const;

/**
 * Ceiling for one candidate's PATH probe (station#1815).
 *
 * Sized against the first backoff step, not equal to an attempt's duration:
 * candidates are probed SEQUENTIALLY, so an attempt in which all three expire
 * takes three ceilings before the next delay even begins. What the ceiling
 * bounds is one locator, and what it is for is that a locator nobody will
 * read the answer of must not stay alive — that is what gave the adoption a
 * writer the runtime could not account for at shutdown.
 *
 * An expired probe settles as 'absent' for this attempt and is retried by the
 * next one. That is the one thing 'absent' cannot distinguish: the ceiling
 * kills the locator and `detectCliOnPath` reports the same `false` a locator
 * that genuinely said no reports, so this window has no way to tell them
 * apart. Recorded here rather than papered over — the retry is what limits
 * the cost, not the label.
 */
export const ADOPTION_PROBE_TIMEOUT_MS = 10_000;

export type NativeEngineDetect = (
  cli: string,
  options?: CliDetectionOptions,
) => Promise<boolean>;

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
  detect?: NativeEngineDetect;
  delaysMs?: readonly number[];
  /** Injectable only so containment is unit-testable without process globals. */
  env?: NodeJS.ProcessEnv;
}

export interface NativeEngineAdoptionSummary {
  /**
   * What the window OBSERVED per candidate.
   *
   * 'absent' means an UNCANCELLED probe came back falsy. It cannot separate
   * "the locator said no" from "the ceiling killed the locator", because
   * `detectCliOnPath` has one answer channel and collapses both into `false`;
   * `ADOPTION_PROBE_TIMEOUT_MS` records that limit. What it does exclude is a
   * probe the shutdown signal cancelled, whose `false` is not an answer about
   * the host at all.
   *
   * 'interrupted' is that case: the window closed before this candidate got a
   * usable answer, or got one and was stopped before it could act on it.
   * Added in station#1815, corrected in its second review round — the first
   * version consulted the signal only BEFORE the probe, which is a few
   * instructions, while the window an abort actually lands in is the probe's
   * whole duration.
   *
   * Two edges of that split, recorded rather than closed. An abort landing
   * between a probe RESOLVING and the loop reading the signal turns a genuine
   * uncancelled absence into 'interrupted', so the first sentence above
   * describes a superset: everything called 'absent' came from an uncancelled
   * falsy probe, but not every uncancelled falsy probe is called 'absent'.
   * That is the conservative direction — it withholds a claim, it never
   * invents one. And with an EMPTY delay list the loop never runs, so the
   * backfill's 'absent' branch is reachable with nothing having looked at the
   * host at all; no production caller passes one, and `deps.delaysMs` exists
   * only for tests.
   *
   * 'suppressed' is the screenshot containment: no probe was made, by policy.
   * It used to report 'absent' for a host nothing looked at.
   */
  outcomes: Record<
    string,
    | NativeEngineAdoptionOutcome
    | 'absent'
    | 'error'
    | 'interrupted'
    | 'suppressed'
  >;
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
        error: errorMessage(error),
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
      { error: errorMessage(error) },
    );
  }
  // #875: a screenshot runtime must not persist whatever native CLIs happen
  // to exist on its capture host. Keep the ordinary Station Agent setup above
  // intact, but close the adoption window before any host probe can run.
  if (detection.suppressed) {
    for (const candidate of NATIVE_ENGINE_CANDIDATES) {
      // 'suppressed', not 'absent' (station#1815 review round 2): `detect` is
      // called zero times here, so an absence would be a claim about a host
      // nothing looked at.
      outcomes[candidate.id] = 'suppressed';
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
      // Defence in depth, and deliberately untested — say so rather than let
      // a reader assume a case covers it (station#1815 round-4 verifier).
      //
      // What it covers is the one window neither the abort inside a probe nor
      // the check after one reaches: an abort landing during the PREVIOUS
      // candidate's registry write, so the loop arrives here already
      // cancelled. With the shipped detector that window is unobservable —
      // `detectCliOnPath` short-circuits on an aborted signal before it
      // spawns, so no locator child starts either way and the check below the
      // probe then breaks the loop with the same outcomes and the same call
      // count. The verifier ran both shapes against the real detector and got
      // byte-identical results.
      //
      // It is therefore a guard against an INJECTED detector that ignores its
      // signal, which is every test double in this file and no shipped path.
      // A case for it would assert a hypothetical, so there is none; what
      // keeps it here is that `deps.detect` is a public seam and the cost is
      // one comparison.
      if (deps.signal?.aborted) break;
      try {
        const found = await detect(candidate.cli, {
          signal: deps.signal,
          timeoutMs: ADOPTION_PROBE_TIMEOUT_MS,
        });
        // Consulted AFTER the probe, which is the correction the second
        // #1815 review round forced. `detectCliOnPath` resolves `false` on
        // abort rather than rejecting, so under an aborted signal `found` is
        // not an answer about the host — it is the cancellation arriving
        // through the answer channel. The guard above this `try` covers only
        // the few instructions between candidates; an abort lands inside the
        // `which` child for the probe's whole duration, which is where it
        // actually happens.
        if (deps.signal?.aborted) {
          // A `true` here IS an observation, and the window is stopping
          // before it can act on it — assigned rather than left to the
          // backfill, whose `??=` could not overwrite an 'absent' this
          // candidate was legitimately given on an earlier attempt. The later
          // observation is the authoritative one.
          //
          // A falsy `found` is no observation at all, so it writes nothing
          // and leaves any earlier attempt's genuine 'absent' standing.
          if (found) outcomes[candidate.id] = 'interrupted';
          break;
        }
        if (!found) {
          // An uncancelled falsy answer. Not "not on PATH" — see the summary
          // docblock: this window cannot tell a locator that said no from one
          // the ceiling killed. Left unresolved either way, so the next
          // attempt can still find it.
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
          error: errorMessage(error),
        });
      }
    }
  }
  // An abort closes the retry window. A candidate that WAS observed keeps
  // what was observed — `??=` never overwrites it, and the loop above already
  // assigned over a stale reading where a later probe contradicted it. What
  // is left for the backfill is a candidate this window never got a usable
  // answer for at all: one an abort guard stopped before its probe, and one
  // whose probe was cancelled in flight. Calling either 'absent' would report
  // a host fact nothing looked at, in the same field where 'absent' means an
  // uncancelled probe said no.
  const interrupted = deps.signal?.aborted === true;
  for (const candidate of NATIVE_ENGINE_CANDIDATES) {
    if (!unresolved.has(candidate.id)) continue;
    outcomes[candidate.id] ??= interrupted ? 'interrupted' : 'absent';
  }
  return { outcomes };
}
