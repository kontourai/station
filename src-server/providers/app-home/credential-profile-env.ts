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
import type { CredentialProfile } from '@kontourai/station-contracts/connection-recovery';
import {
  appHomeActive,
  type ConnectionEnvEngine,
  validateCredentialProfileEnv,
} from '../../services/connections/connection-env.js';
import { errorMessage } from '../../utils/error-message.js';
import {
  claudeAppHomeEnv,
  codexAppHomeEnv,
  ensureAppHomeProfile,
} from './app-home-profiles.js';
import {
  ensureCredentialProfileAppHome,
  normalizeCredentialProfileRegistry,
  persistedCredentialProfileEnv,
} from './credential-profile-registry.js';

/**
 * A selected credential profile could not be turned into a spawn env. The
 * adapters rethrow this type even when the profile was the connection's
 * configured active profile rather than an explicit per-call ref: running on
 * global credentials instead would bill or route through an account nobody
 * selected. The message carries no ref, path, or env value.
 */
export class CredentialProfileEnvUnavailableError extends Error {
  constructor() {
    super('Credential profile environment could not be prepared.');
    this.name = 'CredentialProfileEnvUnavailableError';
  }
}

/**
 * The selected profile's validated overlay. Validation runs on the persisted
 * value, not the normalized registry: normalization drops an invalid overlay
 * whole, and applying "no overlay" for a profile configured with one would
 * silently un-route the session. Invalid persisted state fails closed.
 */
export function credentialProfileOverlayEnv(
  credentialRecovery: unknown,
  ref: string,
): Record<string, string> {
  const validation = validateCredentialProfileEnv(
    persistedCredentialProfileEnv(credentialRecovery, ref),
  );
  if (!validation.ok) throw new CredentialProfileEnvUnavailableError();
  return validation.env;
}

/**
 * Where a profile's sessions are routed, as a comparable string: its sorted
 * literal env entries. Automatic recovery only switches between profiles
 * with equal fingerprints, so an exhausted account is never replaced by one
 * that talks to a different endpoint.
 */
export function credentialProfileRoutingFingerprint(
  profile: Pick<CredentialProfile, 'env'> | undefined,
): string {
  const entries = Object.entries(profile?.env ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return JSON.stringify({ env: entries });
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
}): (
  credentialProfileRef?: string,
) => Promise<Record<string, string> | undefined> {
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
        return { ...overlay, ...homeEnvFor(dir) };
      }
      if (!appHomeActive(settings?.config)) return undefined;
      const { dir } = await ensureAppHomeProfile(
        options.engine,
        options.homeDir ? { homeDir: options.homeDir } : {},
      );
      return homeEnvFor(dir);
    } catch (error) {
      if (selectedProfileRef) throw new CredentialProfileEnvUnavailableError();
      options.warn?.(
        `App home profile: failed to resolve the ${options.engine} app-home env; continuing with the global engine config: ${errorMessage(error)}`,
      );
      return undefined;
    }
  };
}
