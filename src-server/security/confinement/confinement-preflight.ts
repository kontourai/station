/**
 * #4774: the host-level confinement facts a running Station can report
 * before any start, for `station doctor`. Each fact comes from the owner a
 * start consults: the provider's own `availability()` (the same instance,
 * so the same cached probe) and the engine's own confined-credential check.
 * Nothing here decides a start.
 */
import type {
  ConfinementFallbackReason,
  ConfinementPreflight,
  ConfinementPreflightCredential,
  EngineConfinementPreflight,
} from '@kontourai/station-contracts/execution-confinement';
import { MAX_CONFINEMENT_PREFLIGHT_REASON_LENGTH } from '@kontourai/station-contracts/execution-confinement';
import { sanitizeFreeText } from '@kontourai/station-shared/redaction';
import type { ConfinementProvider } from './confinement-provider.js';

/**
 * The fallbacks a preflight cannot decide: each depends on the start's
 * workspace or conversation, and is decided when the Session starts.
 */
export const CONFINEMENT_DECIDED_AT_START: readonly ConfinementFallbackReason[] =
  ['workspace-too-broad', 'config-root-pinned', 'resume-bound-elsewhere'];

export interface ConfinementPreflightInput {
  providers: readonly ConfinementProvider[];
  /** Each engine's own confined-credential check, keyed by engine id. */
  credentialChecks: Readonly<
    Record<string, () => Promise<ConfinementPreflightCredential>>
  >;
}

/** Provider text may name a path or echo an error; neither leaves the host. */
function reasonText(text: string): string {
  return sanitizeFreeText(text, MAX_CONFINEMENT_PREFLIGHT_REASON_LENGTH);
}

async function credentialFor(
  engine: string,
  checks: ConfinementPreflightInput['credentialChecks'],
): Promise<ConfinementPreflightCredential> {
  const check = Object.hasOwn(checks, engine) ? checks[engine] : undefined;
  if (!check)
    return {
      state: 'not-applicable',
      reason: `No confined-credential check applies to ${engine} starts.`,
    };
  try {
    const credential = await check();
    return credential.state === 'unverified' ||
      credential.state === 'not-applicable'
      ? { state: credential.state, reason: reasonText(credential.reason) }
      : credential;
  } catch {
    return {
      state: 'unverified',
      reason: `The ${engine} confined-credential check could not run.`,
    };
  }
}

/**
 * One entry per (engine, provider) a provider names. A provider that names
 * no engine is not reported: no start path engages one (`resolveConfinement`
 * refuses a spawn-wrapper without engines), and no current provider is one.
 */
export async function confinementPreflight(
  input: ConfinementPreflightInput,
): Promise<ConfinementPreflight> {
  const engines: EngineConfinementPreflight[] = [];
  for (const provider of input.providers) {
    for (const engine of provider.engines ?? []) {
      const availability = provider.availability();
      engines.push({
        engine,
        mechanism: provider.mechanism,
        level: provider.level,
        mechanismState:
          provider.engagement === 'engine-native'
            ? 'engine-reported'
            : availability.available
              ? 'available'
              : 'unavailable',
        mechanismReason: reasonText(availability.reason),
        confinedAuthentication: await credentialFor(
          engine,
          input.credentialChecks,
        ),
      });
    }
  }
  return { engines, decidedAtStart: [...CONFINEMENT_DECIDED_AT_START] };
}
