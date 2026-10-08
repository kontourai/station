/**
 * #2966: a credential profile is an isolated engine home plus an optional,
 * non-secret env overlay. This module owns turning a selected profile into
 * the spawn env the Claude/Codex adapters receive from `getAppHomeEnv`, and
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
 * source-affinity resumes (they must run under the source home), source-home
 * maintenance, readiness checks (a read must not create profile homes), and
 * login/enrolment children (they only write the profile home's own
 * credentials).
 */
import {
  appHomeActive,
  type ConnectionEnvEngine,
  validateCredentialProfileEnv,
} from '../../services/connections/connection-env.js';
import { errorMessage } from '../../utils/error-message.js';
import {
  CredentialProfileEnvironmentError,
  claudeAppHomeEnv,
  codexAppHomeEnv,
  ensureAppHomeProfile,
  type ResolvedAppHome,
} from './app-home-profiles.js';
import {
  credentialProfileStorageId,
  ensureCredentialProfileAppHome,
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

const APP_HOME_ENV_FOR: Record<
  ConnectionEnvEngine,
  (dir: string) => Record<string, string>
> = {
  claude: claudeAppHomeEnv,
  codex: codexAppHomeEnv,
};

/**
 * Builds an adapter's `getAppHomeEnv`. Resolution order: an explicit
 * per-call ref, then the connection's active profile, then the legacy
 * `useAppHome` opt-in, else `undefined` (global engine config). Any failure
 * once a profile is selected throws {@link CredentialProfileEnvUnavailableError};
 * failures before selection or on the legacy opt-in degrade to global with a
 * warning, as before.
 */
export function createCredentialProfileAppHomeEnvResolver(options: {
  engine: ConnectionEnvEngine;
  loadConnectionSettings: () => Promise<
    | { credentialRecovery?: unknown; config?: Record<string, unknown> }
    | undefined
  >;
  warn?: (message: string) => void;
  homeDir?: string;
}): (credentialProfileRef?: string) => Promise<ResolvedAppHome | undefined> {
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
        const { dir } = await ensureCredentialProfileAppHome(
          options.engine,
          profileRef,
          options.homeDir ? { homeDir: options.homeDir } : {},
        );
        // The profile's home key is last: the overlay can never redirect the
        // session away from the profile's own credentials.
        return { env: { ...overlay, ...homeEnvFor(dir) }, profileRef };
      }
      if (!appHomeActive(settings?.config)) return { profileRef: null };
      const { dir } = await ensureAppHomeProfile(
        options.engine,
        options.homeDir ? { homeDir: options.homeDir } : {},
      );
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
