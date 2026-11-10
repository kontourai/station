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
import { claudeConfinedCredentialPreflight } from '../../providers/adapters/claude-confinement-preflight.js';
import type { ResolvedAppHome } from '../../providers/app-home/app-home-profiles.js';
import type { ConfinementProvider } from './confinement-provider.js';
import { DEFAULT_CONFINEMENT_PROVIDERS } from './default-confinement-providers.js';
import { canonicalPath } from './seatbelt.js';

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
      ? { ...credential, reason: reasonText(credential.reason) }
      : credential;
  } catch {
    return {
      state: 'unverified',
      reason: `The ${engine} confined-credential check could not run.`,
      // The one scope a check answers for today (Claude's).
      appliesTo: 'starts-without-own-credential-profile',
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

type SpawnEnv = Readonly<Record<string, string | undefined>>;

/**
 * What the running Station hands {@link createStationConfinementPreflight}:
 * the same resolvers the Claude adapter's start reads, each in a form that
 * creates and writes nothing.
 */
export interface StationConfinementPreflightResolvers {
  /** Defaults to the providers a start resolves from. */
  providers?: readonly ConfinementProvider[];
  claude: {
    /**
     * The inherited spawn environment (`inheritedSpawnEnv`): what
     * `augmentedSpawnEnv` returns for every key a credential check reads,
     * without its PATH augmentation or TMPDIR creation.
     */
    spawnEnv: () => SpawnEnv | Promise<SpawnEnv>;
    /** Used when `spawnEnv` throws, as the adapter falls back to `process.env`. */
    fallbackEnv: () => SpawnEnv;
    /** The adapter's `getConnectionLaunch`. */
    connectionLaunch: () => Promise<{
      env: Record<string, string> | undefined;
    }>;
    /**
     * The adapter's `getAppHomeEnv` in its non-creating form
     * (`createCredentialProfileAppHomeEnvPeek`), asked for a start that names
     * no credential profile.
     */
    appHomeEnv: (
      credentialProfileRef?: string,
    ) => Promise<ResolvedAppHome | undefined>;
    /** Station's runtime home (`resolveHomeDir`), canonicalized here. */
    stationHome: () => string;
  };
}

/**
 * #4774: the preflight a running Station serves, assembled from its
 * resolvers so the runtime holds no logic of its own.
 *
 * Known gap: the layering here (spawn environment, else `process.env`; then
 * the connection's environment; then the app-home environment; Station's
 * canonical home) mirrors `ClaudeAdapter.startSession` and
 * `prepareSeatbeltStart`; it is not shared with them. The credential step
 * itself is shared (`confinedClaudeCredentialCheck`), but a change to the
 * adapter's layering is not seen here or by the tests of this factory.
 */
export function createStationConfinementPreflight(
  resolvers: StationConfinementPreflightResolvers,
): () => Promise<ConfinementPreflight> {
  const claude = resolvers.claude;
  return () =>
    confinementPreflight({
      providers: resolvers.providers ?? DEFAULT_CONFINEMENT_PROVIDERS,
      credentialChecks: {
        claude: () =>
          claudeConfinedCredentialPreflight({
            baseEnv: async () => {
              try {
                return await claude.spawnEnv();
              } catch {
                return claude.fallbackEnv();
              }
            },
            connectionEnv: async () => (await claude.connectionLaunch()).env,
            appHomeEnv: () => claude.appHomeEnv(undefined),
            stationHome: canonicalPath(claude.stationHome()),
          }),
      },
    });
}
