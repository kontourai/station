/**
 * #4774: whether a confined Claude start would find a credential, answered
 * before any start from the same check the start makes
 * (`confinedClaudeCredentialCheck`, which `confinedClaudeDecision` calls)
 * over the inputs a fresh start without an explicit credential profile
 * assembles in `ClaudeAdapter.prepareSeatbeltStart`: the spawn environment,
 * then the connection's environment, then the app-home environment of the
 * connection's active credential profile (or its app-home opt-in), and
 * Station's runtime home.
 *
 * A start that names a credential profile of its own, adopts a session or
 * resumes one pinned to the global configuration root assembles different
 * inputs; this answers for none of those, and says so in `appliesTo`.
 */
import type {
  ConfinementPreflightCredential,
  ConfinementPreflightCredentialScope,
} from '@kontourai/station-contracts/execution-confinement';
import {
  CredentialProfileEnvironmentError,
  type ResolvedAppHome,
} from '../app-home/app-home-profiles.js';
import {
  CONFINED_CLAUDE_CREDENTIAL_SETUP,
  confinedClaudeCredentialCheck,
} from './claude-seatbelt.js';

/** The starts this answer covers: no credential profile of their own. */
const APPLIES_TO: ConfinementPreflightCredentialScope =
  'starts-without-own-credential-profile';

interface ClaudeConfinedCredentialPreflightInput {
  /** The spawn environment before the connection and app-home layers. */
  baseEnv: () => Promise<Readonly<Record<string, string | undefined>>>;
  /** The connection's spawn environment (the adapter's `getConnectionLaunch`). */
  connectionEnv: () => Promise<Record<string, string> | undefined>;
  /**
   * The app home a start without its own credential profile gets (the
   * adapter's `getAppHomeEnv(undefined)`, read without creating it).
   */
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
      appliesTo: APPLIES_TO,
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
        appliesTo: APPLIES_TO,
      };
    appHomeEnv = undefined;
  }
  const { credential } = confinedClaudeCredentialCheck({
    appHomeEnv,
    env: { ...(await input.baseEnv()), ...connectionEnv, ...appHomeEnv },
    stationHome: input.stationHome,
  });
  return credential.available
    ? { state: 'available', source: credential.source, appliesTo: APPLIES_TO }
    : {
        state: 'unavailable',
        fallback: 'confined-credential-unavailable',
        remedy: CONFINED_CLAUDE_CREDENTIAL_SETUP,
        appliesTo: APPLIES_TO,
      };
}
