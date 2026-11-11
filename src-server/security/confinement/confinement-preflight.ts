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
import {
  type CredentialProfileAppHomeEnvOptions,
  createCredentialProfileAppHomeEnvPeek,
} from '../../providers/app-home/credential-profile-env.js';
import { inheritedSpawnEnv } from '../../providers/auth/cli-auth.js';
import type { ConfinementProvider } from './confinement-provider.js';
import { DEFAULT_CONFINEMENT_PROVIDERS } from './default-confinement-providers.js';
import { canonicalPath } from './seatbelt.js';

/**
 * The fallbacks a preflight cannot decide: each depends on the start's
 * workspace or conversation, and is decided when the Session starts.
 */
const CONFINEMENT_DECIDED_AT_START: readonly ConfinementFallbackReason[] = [
  'workspace-too-broad',
  'config-root-pinned',
  'resume-bound-elsewhere',
];

interface ConfinementPreflightInput {
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

/**
 * #4769: whether `provider` can restrict a confined start's network on this
 * host: it must be able to (`restrictsNetwork`) and be available here.
 */
function restrictedNetworkFor(
  provider: ConfinementProvider,
  availability: ReturnType<ConfinementProvider['availability']>,
): EngineConfinementPreflight['restrictedNetwork'] {
  if (provider.restrictsNetwork !== true)
    return {
      state: 'unavailable',
      reason: reasonText(
        provider.networkRestrictionUnavailable ??
          `${provider.mechanism} cannot restrict the network`,
      ),
    };
  return availability.available
    ? {
        state: 'available',
        reason:
          "A restricted start reaches only Station's egress broker, which admits the engine's model endpoint and the allowed hosts.",
      }
    : {
        state: 'unavailable',
        reason: reasonText(
          `${provider.mechanism} is unavailable here: ${availability.reason}`,
        ),
      };
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
        restrictedNetwork: restrictedNetworkFor(provider, availability),
      });
    }
  }
  return { engines, decidedAtStart: [...CONFINEMENT_DECIDED_AT_START] };
}

type SpawnEnv = Readonly<Record<string, string | undefined>>;

/**
 * What the running Station hands {@link createStationConfinementPreflight}:
 * the raw inputs the Claude adapter's start reads. The factory, not the
 * caller, chooses the forms of the readers that create and write nothing.
 */
interface StationConfinementPreflightResolvers {
  /** Defaults to the providers a start resolves from. */
  providers?: readonly ConfinementProvider[];
  claude: {
    /** The environment a start inherits (`process.env`). */
    processEnv: () => SpawnEnv;
    /** The adapter's `getConnectionLaunch`. */
    connectionLaunch: () => Promise<{
      env: Record<string, string> | undefined;
    }>;
    /** The Claude connection's stored settings, which `getAppHomeEnv` reads. */
    loadConnectionSettings: CredentialProfileAppHomeEnvOptions['loadConnectionSettings'];
    /** Station's runtime home (`resolveHomeDir`). */
    stationHome: () => string;
    /**
     * Replaces the inherited-environment read; tests use it to make that
     * read fail. Defaults to `inheritedSpawnEnv(processEnv())`.
     */
    spawnEnv?: () => SpawnEnv;
  };
}

/**
 * #4774: the preflight a running Station serves, assembled here so the
 * runtime holds no logic of its own. The two readers a start uses to act
 * are replaced by forms that do not: `inheritedSpawnEnv` in place of
 * `augmentedSpawnEnv` (which may spawn a login shell and creates the spawn
 * TMPDIR; neither key decides a credential), and
 * `createCredentialProfileAppHomeEnvPeek` in place of the adapter's
 * `getAppHomeEnv` (which creates the profile home). So no app-home profile
 * and no spawn TMPDIR is created. The other inputs are read as a start
 * reads them: `loadConnectionSettings` and `connectionLaunch` are the
 * ordinary app config load, which, as any config read does, may write a
 * default `config/app.json` when none exists and may rewrite an existing
 * one when it normalizes it (for example filling missing defaults or
 * removing legacy, internal or retired keys). On macOS the first call may run the Seatbelt provider's
 * once-per-process probe (a synchronous spawn of up to 10 s that blocks the
 * server meanwhile); its result, a failure included, is cached on the
 * provider and is the one later starts use.
 *
 * Known gap: the layering here (inherited environment, else `process.env`;
 * then the connection's environment; then the app-home environment of a
 * start that names no credential profile; Station's canonical home) mirrors
 * `ClaudeAdapter.startSession` and `prepareSeatbeltStart`; it is not shared
 * with them. The credential step itself is shared
 * (`confinedClaudeCredentialCheck`), but a change to the adapter's layering
 * is not seen here or by the tests of this factory.
 */
export function createStationConfinementPreflight(
  resolvers: StationConfinementPreflightResolvers,
): () => Promise<ConfinementPreflight> {
  const claude = resolvers.claude;
  const spawnEnv =
    claude.spawnEnv ?? (() => inheritedSpawnEnv({ ...claude.processEnv() }));
  return () =>
    confinementPreflight({
      providers: resolvers.providers ?? DEFAULT_CONFINEMENT_PROVIDERS,
      credentialChecks: {
        claude: () => {
          const stationHome = claude.stationHome();
          return claudeConfinedCredentialPreflight({
            baseEnv: async () => {
              // As the adapter's `resolveAugmentedSpawnEnv`, whose failure
              // leaves the spawn on `process.env`.
              try {
                return spawnEnv();
              } catch {
                return claude.processEnv();
              }
            },
            connectionEnv: async () => (await claude.connectionLaunch()).env,
            appHomeEnv: () =>
              createCredentialProfileAppHomeEnvPeek({
                engine: 'claude',
                homeDir: stationHome,
                loadConnectionSettings: claude.loadConnectionSettings,
              })(undefined),
            stationHome: canonicalPath(stationHome),
          });
        },
      },
    });
}
