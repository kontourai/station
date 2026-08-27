/**
 * Same-user local self-authorization (station#1715). Framework-agnostic by
 * design, matching every other module in `core/`: the desktop shell's native
 * `invoke` bridge is injected, so this file has no Tauri dependency and no
 * React dependency (`core/` never imports from `react/` — see
 * `./devicePairing`'s own doc for why the CLI needs that boundary held).
 *
 * The secret-read, HTTP exchange, credential storage, profile
 * `credentialRef` update, and `authorize_active` call all happen entirely
 * inside ONE native command, `station_local_self_provision`
 * (`src-desktop/src/lib.rs`) — the bearer never crosses IPC to the webview
 * at all, matching why `NativeStationProfileStorage.commitVerifiedPairing`
 * refuses a renderer-visible `credential` on desktop. This module is
 * therefore just a thin, testable, latched wrapper around that one command;
 * it holds no HTTP or completion logic of its own.
 */

export interface AttemptLocalSelfProvisionDeps {
  /** The native bridge's `invoke`, e.g. `@tauri-apps/api/core`'s `invoke`. */
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** The profile to provision — see `pendingLocalSelfProvisionProfileName`. */
  profileName: string;
}

/**
 * The host owns the details of a failed provision (in particular, a keyring
 * write failure).  Keep that opaque here so this framework-neutral package
 * does not learn Tauri's error wire format, while callers that can present an
 * actionable native error do not have to collapse it into `false`.
 */
export type LocalSelfProvisionAttempt =
  | { provisioned: true }
  | { provisioned: false; error?: unknown };

/**
 * One attempt at `station_local_self_provision`. Never throws: any failure
 * (no native bridge, the profile is not eligible, the exchange failed) is
 * reported as `false` so a caller can fall straight through to today's
 * pairing-ceremony UI with no special-casing.
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

/**
 * `attemptLocalSelfProvision`, latched to run at most once per module
 * lifetime (station#1715's "one attempt per app boot"). The bare function
 * above stays unlatched so tests can call it repeatedly; production wiring
 * uses this wrapper.
 */
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
 * station#1866: a SECOND, independent one-shot for the case the boot-time
 * attempt deliberately did not fire because the credential read back as
 * `Readable` — which proves only that the bytes are in the keychain, not
 * that the server will honour them. When the transport later observes a
 * coded auth rejection (401/403) for the active local-service profile,
 * that is positive evidence the stored grant is dead regardless of whether
 * it reads cleanly, and re-provisioning should be reachable.
 *
 * This guard is SEPARATE from `attemptedThisBoot` so the original latch's
 * "one attempt per app boot" semantics (and its pinned test) are
 * unchanged, and so a genuinely-rejecting server cannot cause an unbounded
 * mint loop: at most ONE retry per boot after the first observed
 * rejection.
 *
 * This latch is the ONLY thing bounding that retry. `NativeLocalServiceAuthRejection`
 * on the Rust side exposes `record` and `contains` and nothing that removes
 * an entry, so once an origin has answered 401/403 it is treated as rejected
 * for the rest of the process's life — minting a fresh credential does NOT
 * clear it. That is safe only because this latch prevents a second retry from
 * ever being requested; do not relax it on the assumption that the native
 * record self-heals (station#1867 review round).
 */
let retriedAfterRejectionThisBoot = false;

export async function retryLocalSelfProvisionAfterRejection(
  deps: AttemptLocalSelfProvisionDeps,
): Promise<boolean> {
  if (retriedAfterRejectionThisBoot) return false;
  retriedAfterRejectionThisBoot = true;
  return attemptLocalSelfProvision(deps);
}

/** Test-only: resets both per-boot latches. */
export function resetLocalSelfProvisionLatchForTests(): void {
  attemptedThisBoot = false;
  retriedAfterRejectionThisBoot = false;
}
