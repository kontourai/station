/**
 * #2966: a credential profile is an isolated engine home plus an optional,
 * non-secret env overlay. This module owns turning a selected profile into
 * the spawn env the Claude/Codex/Muse adapters receive from `getAppHomeEnv`, and
 * the routing fingerprint automatic recovery compares between profiles.
 *
 * Merge ownership lives here (not in the adapters) so later layers, such as
 * secret env references resolved through the secret-bindings store, join the
 * overlay in one place. The adapters' existing merges then give the full
 * precedence: ambient < connection env < profile overlay < profile home key
 * < Station-owned TMPDIR.
 *
 * Deliberately NOT applied by this module's callers: model discovery (it
 * lists the connection's catalog, not a profile's), adoption and
 * source-affinity resumes (they must run under the source home; a Codex
 * source home that is a profile's gets that profile's overlay through
 * `credentialProfileEnvForHome` instead), source-home maintenance, readiness checks (a read must not create profile homes), and
 * login/enrolment children (they only write the profile home's own
 * credentials).
 */

import { realpathSync } from 'node:fs';
import {
  appHomeActive,
  type ConnectionEnvEngine,
  connectionSpawnEnv,
  validateCredentialProfileEnv,
} from '../../services/connections/connection-env.js';
import { errorMessage } from '../../utils/error-message.js';
import { isCanonicalPathStrictlyWithin } from '../../utils/path-containment.js';
import {
  appHomeProfileDir,
  appHomesRootDir,
  CredentialProfileEnvironmentError,
  claudeAppHomeEnv,
  codexAppHomeEnv,
  ensureAppHomeProfile,
  locateAppHomeProfile,
  museAppHomeEnv,
  type ResolvedAppHome,
} from './app-home-profiles.js';
import {
  credentialProfileStorageId,
  ensureCredentialProfileAppHome,
  locateCredentialProfileAppHome,
  normalizeCredentialProfileRegistry,
  persistedCredentialProfile,
} from './credential-profile-registry.js';

/**
 * A selected credential profile could not be turned into a spawn env. The
 * adapters rethrow this type even when the profile was the connection's
 * configured active profile rather than an explicit per-call ref: running on
 * global credentials instead would bill or route through an account nobody
 * selected. The message carries no ref, path, or env value.
 */
export class CredentialProfileEnvUnavailableError extends CredentialProfileEnvironmentError {
  /**
   * Offending overlay variable NAMES when the saved overlay is invalid; for
   * server-side diagnostics only (never values, never the ref).
   */
  readonly invalidVariableNames?: readonly string[];

  constructor(invalidVariableNames?: readonly string[]) {
    super();
    this.name = 'CredentialProfileEnvUnavailableError';
    if (invalidVariableNames) this.invalidVariableNames = invalidVariableNames;
  }
}

/**
 * The selected profile's validated overlay. Normalization turns an invalid
 * saved overlay (persisted marker or a raw hand edit alike) into the
 * value-free `envInvalid` marker; a marked profile fails closed here
 * instead of silently un-routing the session.
 */
function credentialProfileOverlayEnv(
  credentialRecovery: unknown,
  ref: string,
): Record<string, string> {
  const profile = persistedCredentialProfile(credentialRecovery, ref);
  if (profile?.envInvalid)
    throw new CredentialProfileEnvUnavailableError(profile.envInvalid.names);
  return { ...profile?.env };
}

/**
 * Where a profile's sessions are routed, as a comparable string: its sorted
 * literal env entries. Automatic recovery only switches between profiles
 * with equal fingerprints, so an exhausted account is never replaced by one
 * that talks to a different endpoint. `undefined` for an invalid saved
 * overlay (an `envInvalid` marker or an env that fails validation): it
 * matches nothing, not even another invalid overlay.
 */
export function credentialProfileRoutingFingerprint(
  profile: { env?: unknown; envInvalid?: unknown } | undefined,
): string | undefined {
  if (profile?.envInvalid !== undefined && profile.envInvalid !== null)
    return undefined;
  const validation = validateCredentialProfileEnv(profile?.env);
  if (!validation.ok) return undefined;
  const entries = Object.entries(validation.env).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return JSON.stringify({ env: entries });
}

/** True only when both profiles have valid overlays with equal routing. */
export function credentialProfilesRouteAlike(
  left: { env?: unknown; envInvalid?: unknown } | undefined,
  right: { env?: unknown; envInvalid?: unknown } | undefined,
): boolean {
  const fingerprint = credentialProfileRoutingFingerprint(left);
  return (
    fingerprint !== undefined &&
    fingerprint === credentialProfileRoutingFingerprint(right)
  );
}

/**
 * The engines with a credential-profile home. Wider than
 * {@link ConnectionEnvEngine}: Muse (#1942) has an app home but no
 * per-connection env layer (`connectionSpawnEnv`), so its config-home key is
 * not one the connection env refuses or expands.
 */
export type CredentialProfileAppHomeEngine = ConnectionEnvEngine | 'muse';

const APP_HOME_ENV_FOR: Record<
  CredentialProfileAppHomeEngine,
  (dir: string) => Record<string, string>
> = {
  claude: claudeAppHomeEnv,
  codex: codexAppHomeEnv,
  muse: museAppHomeEnv,
};

/**
 * Builds an adapter's `getAppHomeEnv`. Resolution order: an explicit
 * per-call ref, then the connection's active profile, then the legacy
 * `useAppHome` opt-in, else `undefined` (global engine config). Any failure
 * once a profile is selected throws {@link CredentialProfileEnvUnavailableError};
 * failures before selection or on the legacy opt-in degrade to global with a
 * warning, as before.
 */
export function createCredentialProfileAppHomeEnvResolver(
  options: CredentialProfileAppHomeEnvOptions,
): (credentialProfileRef?: string) => Promise<ResolvedAppHome | undefined> {
  const homeOptions = options.homeDir ? { homeDir: options.homeDir } : {};
  return appHomeEnvResolver(options, {
    profileHome: (profileRef) =>
      ensureCredentialProfileAppHome(options.engine, profileRef, homeOptions),
    legacyHome: () => ensureAppHomeProfile(options.engine, homeOptions),
  });
}

/**
 * #4774: the env {@link createCredentialProfileAppHomeEnvResolver} would
 * return for the same settings, by the same selection, refusals and
 * degradation, without creating or writing anything: a profile home that
 * does not exist yet is named by the directory the resolver would create
 * (its path is derived, not discovered), so the env is the one a start
 * gets. It cannot see a failure of the resolver's own writes. For reads
 * that must not create profile homes (the confinement preflight).
 */
export function createCredentialProfileAppHomeEnvPeek(
  options: CredentialProfileAppHomeEnvOptions,
): (credentialProfileRef?: string) => Promise<ResolvedAppHome | undefined> {
  const homeOptions = options.homeDir ? { homeDir: options.homeDir } : {};
  return appHomeEnvResolver(options, {
    profileHome: (profileRef) =>
      locateCredentialProfileAppHome(options.engine, profileRef, homeOptions),
    legacyHome: () => locateAppHomeProfile(options.engine, homeOptions),
  });
}

const CONFIG_HOME_ENV_KEY: Record<ConnectionEnvEngine, string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
};

/**
 * Every engine home Station itself points this engine's sessions at, beyond
 * the default (`CODEX_HOME`/`~/.codex`): the connection's own config home,
 * the legacy app home when `useAppHome` is on, and each saved credential
 * profile's home. Paths only, located without creating anything; a home
 * that cannot be located is left out. Read by transcript discovery, which
 * must find sessions wherever Station started them.
 */
export async function configuredEngineHomes(
  options: Pick<
    CredentialProfileAppHomeEnvOptions,
    'loadConnectionSettings' | 'homeDir'
  > & { engine: ConnectionEnvEngine },
): Promise<string[]> {
  const settings = await options.loadConnectionSettings();
  const homeOptions = options.homeDir ? { homeDir: options.homeDir } : {};
  const homes: string[] = [];
  const connectionHome = connectionSpawnEnv(settings?.config, options.engine)?.[
    CONFIG_HOME_ENV_KEY[options.engine]
  ];
  if (connectionHome) homes.push(connectionHome);
  if (appHomeActive(settings?.config)) {
    try {
      homes.push((await locateAppHomeProfile(options.engine, homeOptions)).dir);
    } catch {}
  }
  for (const profile of normalizeCredentialProfileRegistry(
    settings?.credentialRecovery,
  ).profiles) {
    try {
      homes.push(
        (
          await locateCredentialProfileAppHome(
            options.engine,
            profile.ref,
            homeOptions,
          )
        ).dir,
      );
    } catch {}
  }
  return homes;
}

/**
 * The env overlay of the credential profile whose home is `canonicalHome`
 * (a real path), for running a session discovered in that home: the same
 * overlay a profile spawn applies, so the profile's credentials meet the
 * profile's endpoint. `undefined` (no overlay) for a home outside
 * Station's app homes, such as the default home (answered without reading
 * configuration), for the legacy app home, and for the connection's own
 * config home wherever it is placed, since the connection env already
 * applies there. Throws {@link CredentialProfileEnvUnavailableError} for an
 * invalid overlay, and for any other app home no current profile owns: a
 * deleted profile's home keeps its credentials, and running it without its
 * overlay would send them to the ambient endpoint.
 */
export async function credentialProfileEnvForHome(
  options: Pick<
    CredentialProfileAppHomeEnvOptions,
    'loadConnectionSettings' | 'homeDir' | 'warn'
  > & { engine: CredentialProfileAppHomeEngine },
  canonicalHome: string,
): Promise<Record<string, string> | undefined> {
  let root: string;
  try {
    root = realpathSync(appHomesRootDir(options.homeDir));
  } catch {
    return undefined;
  }
  if (!isCanonicalPathStrictlyWithin(root, canonicalHome)) return undefined;
  const realOrNull = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  };
  if (
    realOrNull(appHomeProfileDir(options.engine, options.homeDir)) ===
    canonicalHome
  )
    return undefined;
  const settings = await options.loadConnectionSettings();
  if (options.engine !== 'muse') {
    const connectionHome = connectionSpawnEnv(
      settings?.config,
      options.engine,
    )?.[CONFIG_HOME_ENV_KEY[options.engine]];
    if (connectionHome && realOrNull(connectionHome) === canonicalHome)
      return undefined;
  }
  const homeOptions = options.homeDir ? { homeDir: options.homeDir } : {};
  for (const profile of normalizeCredentialProfileRegistry(
    settings?.credentialRecovery,
  ).profiles) {
    let dir: string;
    try {
      dir = realpathSync(
        (
          await locateCredentialProfileAppHome(
            options.engine,
            profile.ref,
            homeOptions,
          )
        ).dir,
      );
    } catch {
      continue;
    }
    if (dir !== canonicalHome) continue;
    try {
      return credentialProfileOverlayEnv(
        settings?.credentialRecovery,
        profile.ref,
      );
    } catch (error) {
      // Server-side diagnostic: the storage id hash and offending variable
      // names, never the raw ref or a value.
      const names =
        error instanceof CredentialProfileEnvUnavailableError
          ? (error.invalidVariableNames ?? [])
          : [];
      options.warn?.(
        `Credential profile ${credentialProfileStorageId(options.engine, profile.ref)} (${options.engine}): refusing to continue a session in its home: the saved env overlay is invalid${names.length > 0 ? ` (${names.join(', ')})` : ''}`,
      );
      throw error;
    }
  }
  throw new CredentialProfileEnvUnavailableError();
}

export interface CredentialProfileAppHomeEnvOptions {
  engine: CredentialProfileAppHomeEngine;
  loadConnectionSettings: () => Promise<
    | { credentialRecovery?: unknown; config?: Record<string, unknown> }
    | undefined
  >;
  warn?: (message: string) => void;
  homeDir?: string;
}

function appHomeEnvResolver(
  options: CredentialProfileAppHomeEnvOptions,
  homes: {
    profileHome: (profileRef: string) => Promise<{ dir: string }>;
    legacyHome: () => Promise<{ dir: string }>;
  },
): (credentialProfileRef?: string) => Promise<ResolvedAppHome | undefined> {
  const homeEnvFor = APP_HOME_ENV_FOR[options.engine];
  return async (credentialProfileRef) => {
    let selectedProfileRef = credentialProfileRef;
    try {
      const settings = await options.loadConnectionSettings();
      const profileRef =
        credentialProfileRef ??
        normalizeCredentialProfileRegistry(settings?.credentialRecovery)
          .activeProfileRef;
      selectedProfileRef = profileRef;
      if (profileRef) {
        // Validate the overlay before creating the profile home so a
        // refused overlay leaves no filesystem side effect.
        const overlay = credentialProfileOverlayEnv(
          settings?.credentialRecovery,
          profileRef,
        );
        const { dir } = await homes.profileHome(profileRef);
        // The profile's home key is last: the overlay can never redirect the
        // session away from the profile's own credentials.
        return { env: { ...overlay, ...homeEnvFor(dir) }, profileRef };
      }
      if (!appHomeActive(settings?.config)) return { profileRef: null };
      const { dir } = await homes.legacyHome();
      return { env: homeEnvFor(dir), profileRef: null };
    } catch (error) {
      if (selectedProfileRef) {
        // Server-side diagnostic: the storage id hash, never the raw ref, and
        // offending variable names, never values.
        let profileId = 'unidentified';
        try {
          profileId = credentialProfileStorageId(
            options.engine,
            selectedProfileRef,
          );
        } catch {}
        const reason =
          error instanceof CredentialProfileEnvUnavailableError &&
          error.invalidVariableNames
            ? `the saved env overlay is invalid${
                error.invalidVariableNames.length > 0
                  ? ` (${error.invalidVariableNames.join(', ')})`
                  : ''
              }`
            : errorMessage(error);
        options.warn?.(
          `Credential profile ${profileId} (${options.engine}): environment could not be prepared; refusing to start the session: ${reason}`,
        );
        throw error instanceof CredentialProfileEnvUnavailableError
          ? error
          : new CredentialProfileEnvUnavailableError();
      }
      options.warn?.(
        `App home profile: failed to resolve the ${options.engine} app-home env; continuing with the global engine config: ${errorMessage(error)}`,
      );
      return undefined;
    }
  };
}
