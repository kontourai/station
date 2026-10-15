/**
 * Same-user local self-authorization (archive#1715). The injected native
 * bridge keeps this core module independent of Tauri and React.
 * `station_local_self_provision` owns the secret exchange, credential
 * storage, profile update and authorization; bearer material never crosses
 * IPC into the WebView. Native code also owns replacement eligibility.
 */

export interface AttemptLocalSelfProvisionDeps {
  /** The native bridge's `invoke`, e.g. `@tauri-apps/api/core`'s `invoke`. */
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** The profile to provision — see `pendingLocalSelfProvisionProfileName`. */
  profileName: string;
}

/**
 * Keep host errors opaque here while allowing the native shell to explain
 * an actionable failure, such as a replacement credential write refusal.
 */
export type LocalSelfProvisionAttempt =
  | { provisioned: true }
  | { provisioned: false; error?: unknown };

/**
 * Returns false on native failure so the caller can retain ordinary pairing.
 */
export async function attemptLocalSelfProvision(
  deps: AttemptLocalSelfProvisionDeps,
): Promise<boolean> {
  return (await attemptLocalSelfProvisionWithOutcome(deps)).provisioned;
}

/** Same attempt as {@link attemptLocalSelfProvision}, retaining a host error. */
export async function attemptLocalSelfProvisionWithOutcome(
  deps: AttemptLocalSelfProvisionDeps,
): Promise<LocalSelfProvisionAttempt> {
  try {
    await deps.invoke('station_local_self_provision', {
      profileName: deps.profileName,
    });
    return { provisioned: true };
  } catch (error) {
    return { provisioned: false, error };
  }
}

let attemptedThisBoot = false;

/** One automatic attempt per module lifetime, consumed even after failure. */
export async function attemptLocalSelfProvisionOnce(
  deps: AttemptLocalSelfProvisionDeps,
): Promise<boolean> {
  return (await attemptLocalSelfProvisionOnceWithOutcome(deps)).provisioned;
}

/** The boot-latched attempt, retaining a native error for an owning shell. */
export async function attemptLocalSelfProvisionOnceWithOutcome(
  deps: AttemptLocalSelfProvisionDeps,
): Promise<LocalSelfProvisionAttempt> {
  if (attemptedThisBoot) return { provisioned: false };
  attemptedThisBoot = true;
  return attemptLocalSelfProvisionWithOutcome(deps);
}

/**
 * Auth rejection gets one additional attempt, independent of boot
 * provisioning (archive#1866). Both guards remain consumed after failure
 * to prevent repeated attempts. A rejection requests a native eligibility
 * check; it does not itself authorize replacing a grant.
 */
let retriedAfterRejectionThisBoot = false;

export async function retryLocalSelfProvisionAfterRejection(
  deps: AttemptLocalSelfProvisionDeps,
): Promise<boolean> {
  if (retriedAfterRejectionThisBoot) return false;
  retriedAfterRejectionThisBoot = true;
  return attemptLocalSelfProvision(deps);
}
