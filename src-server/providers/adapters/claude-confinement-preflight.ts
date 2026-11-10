/**
 * #4774: whether a confined Claude start would find a credential, answered
 * before any start from the same check the start makes
 * (`confinedClaudeCredentialCheck`, which `confinedClaudeDecision` calls)
 * over the inputs a fresh start without an explicit credential profile
 * assembles in `ClaudeAdapter.prepareSeatbeltStart`: the augmented spawn
 * environment, then the connection's environment, then the default
 * credential profile's app-home environment, and Station's runtime home.
 *
 * A start that names a credential profile, adopts a session or resumes one
 * pinned to the global configuration root assembles different inputs; this
 * answers for none of those.
 */
import type { ConfinementPreflightCredential } from '@kontourai/station-contracts/execution-confinement';
import {
  CredentialProfileEnvironmentError,
  type ResolvedAppHome,
} from '../app-home/app-home-profiles.js';
import {
  CONFINED_CLAUDE_CREDENTIAL_SETUP,
  confinedClaudeCredentialCheck,
} from './claude-seatbelt.js';

export interface ClaudeConfinedCredentialPreflightInput {
  /** The spawn environment before the connection and app-home layers. */
  baseEnv: () => Promise<Readonly<Record<string, string | undefined>>>;
  /** The connection's spawn environment (the adapter's `getConnectionLaunch`). */
  connectionEnv: () => Promise<Record<string, string> | undefined>;
  /** The default credential profile's app home (the adapter's `getAppHomeEnv`). */
  appHomeEnv: () => Promise<ResolvedAppHome | undefined>;
  /** Station's runtime home, canonical, as the start resolves it. */
  stationHome: string;
}

export async function claudeConfinedCredentialPreflight(
  input: ClaudeConfinedCredentialPreflightInput,
): Promise<ConfinementPreflightCredential> {
  let connectionEnv: Record<string, string> | undefined;
  try {
    connectionEnv = await input.connectionEnv();
  } catch {
    // The start does not catch this either: it fails before confinement.
    return {
      state: 'unverified',
      reason:
        "The Claude connection's launch settings could not be resolved, so a start fails before confinement is decided.",
    };
  }
  let appHomeEnv: Record<string, string> | undefined;
  try {
    appHomeEnv = (await input.appHomeEnv())?.env;
  } catch (error) {
    // As `resolveAppHomeEnv` without a profile reference: only a profile
    // environment failure stops the start; anything else continues with
    // the global configuration.
    if (error instanceof CredentialProfileEnvironmentError)
      return {
        state: 'unverified',
        reason:
          "The Claude connection's credential profile could not be prepared, so a start fails before confinement is decided.",
      };
    appHomeEnv = undefined;
  }
  const { credential } = confinedClaudeCredentialCheck({
    appHomeEnv,
    env: { ...(await input.baseEnv()), ...connectionEnv, ...appHomeEnv },
    stationHome: input.stationHome,
  });
  return credential.available
    ? { state: 'available', source: credential.source }
    : {
        state: 'unavailable',
        fallback: 'confined-credential-unavailable',
        remedy: CONFINED_CLAUDE_CREDENTIAL_SETUP,
      };
}
