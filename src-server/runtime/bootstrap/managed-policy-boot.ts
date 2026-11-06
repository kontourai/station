/**
 * The managed policy (#4515) as this server process loaded it: read once and
 * remembered, failure included. The OTel bootstrap (`telemetry.ts`) is
 * evaluated before `main()` and must honor `limits.telemetry` (#4521), so it
 * reads the policy first; `main()` then gets the same answer rather than a
 * second read that could disagree with it.
 */
import {
  type LoadedManagedPolicy,
  loadInstalledManagedPolicy,
} from '@kontourai/station-shared/managed-policy';

type BootLoad =
  | { ok: true; policy: LoadedManagedPolicy | null }
  | { ok: false; error: unknown };

let load: BootLoad | undefined;

/**
 * The installed policy, or null for none. Throws the load's error (a
 * `ManagedPolicyInvalidError`) on every call after a failed load.
 */
export function bootManagedPolicy(): LoadedManagedPolicy | null {
  if (!load) {
    try {
      load = { ok: true, policy: loadInstalledManagedPolicy() };
    } catch (error) {
      load = { ok: false, error };
    }
  }
  if (!load.ok) throw load.error;
  return load.policy;
}
