/** Operator-only account projection. No password, session token or device credential. */
export interface LocalAccountView {
  accountId: string;
  name: string;
  email?: string;
  username?: string;
  emailVerified: boolean;
  disabled: boolean;
}
export type LocalAccountAdministrationView =
  | { kind: 'local'; accounts: readonly LocalAccountView[] }
  | { kind: 'external'; provider: string }
  | { kind: 'none' };
export type LocalAccountAction =
  | 'disable'
  | 'enable'
  | 'revoke-sessions'
  | 'create-recovery';
export type LocalAccountActionResult =
  | { changed: true }
  | { recoveryUrl: string };

/**
 * #4305: the operator's choice to run Project sharing with built-in local
 * accounts. There is deliberately no module path: a custom authentication
 * module is process configuration only.
 */
export type AccountSharingChoice =
  | { enabled: false }
  | { enabled: true; publicOrigin: string };
export interface AccountSharingLastApply {
  /** `withdrawn`: the restart never started, so the change was not tried. */
  outcome: 'applied' | 'rolled-back' | 'withdrawn';
  choice: AccountSharingChoice;
  at: string;
  reason?: string;
}
/** Where an offered sign-in origin came from. */
export type AccountSharingOriginSource =
  | 'allowed-origin'
  | 'station-loopback'
  | 'bound-host'
  | 'tailscale-serve';
export interface AccountSharingOriginOption {
  origin: string;
  sources: readonly AccountSharingOriginSource[];
  /** Why it cannot be chosen; absent when it can. */
  unavailable?: 'requires-https' | 'not-a-browser-origin';
}
export interface AccountSharingSettingView {
  /**
   * `deployment`: process configuration decides and Settings cannot change it.
   * `setting`: this Station's stored setting decides.
   */
  source: 'deployment' | 'setting';
  /** The process variables that lock it, when `source` is `deployment`. */
  lockedBy: readonly string[];
  /** What this running Station uses now. */
  active: {
    projectSharing: boolean;
    localAccounts: boolean;
    /** Another provider (a deployment module) supplies accounts. */
    externalProvider: boolean;
    publicOrigin?: string;
  };
  /** The stored choice; absent when the deployment decides. */
  stored?: AccountSharingChoice;
  /** The stored file exists but could not be read, so sharing is off. */
  storedUnreadable?: boolean;
  /** A staged choice remains on disk and requires reconciliation. */
  pending?: { choice: AccountSharingChoice; ready: boolean };
  /** Why the stored choice is not in effect since this Station started. */
  startupFailure?: string;
  lastApply?: AccountSharingLastApply;
  origins: readonly AccountSharingOriginOption[];
  /** Applying restarts through the process supervisor; unsupervised Stations cannot. */
  restart: 'supervised' | 'unavailable';
}
export type AccountSharingApplyResult =
  | { changed: false }
  | { changed: true; restarting: true; durabilityUncertain?: boolean };
