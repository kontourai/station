import { updateOwnedInstance } from '@kontourai/station-shared/instance-registry';
import { lookupProcessBirthFingerprint } from '@kontourai/station-shared/process-identity';

/** The service registry entry a supervisor publishes its liveness on. */
export interface ServiceLivenessTarget {
  instanceName: string;
  home: string;
  serverPort: number;
  uiPort: number;
}

/**
 * ONE-OWNER SIGNAL (station#3064). Desktop refuses to spawn its own sidecar
 * onto a home a live service owns — `decide_home_ownership` selects on a
 * service-typed entry with a LIVE pid. Nothing ever wrote one: `service
 * install` records policy without liveness (correctly — it is not the
 * running process), and the supervisor's inner start() is refused by the CLI
 * producer's protected-type guard. So the branch was unreachable and Desktop
 * spawned a second server onto a service-owned home, which is the
 * multi-writer condition #2904 exists to prevent.
 *
 * The supervisor is the right publisher: it is the process launchd or
 * systemd keeps alive, and it outlives the server children it restarts, so
 * the record does not flap. An UPDATE, never a claim: the entry's
 * `env.ALLOWED_ORIGINS` is durable origin-policy authority (#1983) and must
 * survive every liveness write. Own-type only, so a bare `service run` with
 * no install does not mint an entry the installer owns (disclosed limit: such
 * a run stays invisible home-wide).
 */
export function publishServiceLivenessRecord(
  target: ServiceLivenessTarget,
  live: boolean,
): void {
  try {
    // Probe OUTSIDE the mutation lock: the lookup spawns `ps` (or
    // powershell on Windows) with a 1.5s timeout, and holding the home-wide
    // lock across that stalls every other writer, including the Desktop
    // sidecar claim. Every sibling producer resolves its fingerprint before
    // taking the lock.
    const birth = live
      ? (lookupProcessBirthFingerprint(process.pid) ?? undefined)
      : undefined;
    updateOwnedInstance(
      target.instanceName,
      { home: target.home, ownTypes: ['service'] },
      (existing) => {
        if (!live) {
          // IDENTITY-GUARDED RETRACT. A retiring generation must never clear
          // a NEWER owner's record: reinstall-over-a-live-service is a path
          // this deliberately unblocks, so A's exit can overlap B's boot, and
          // during an update (#2675 D) the entry names the launcher. Clearing
          // it would tell Desktop that no service owns the home while one
          // does, and Desktop would spawn a second writer — the exact
          // condition this signal exists to prevent. It does not self-heal:
          // B publishes once, at readiness.
          if (existing.pid !== process.pid) return null;
          return {
            ...existing,
            status: 'stopped',
            pid: undefined,
            birth: undefined,
          };
        }
        return {
          ...existing,
          port: target.serverPort,
          uiPort: target.uiPort,
          status: 'running',
          pid: process.pid,
          birth,
        };
      },
    );
  } catch (error) {
    // Best-effort, exactly like the CLI producer: a registry that cannot be
    // written must never take down a supervised unit.
    console.error(
      `Station service could not record its liveness in the home registry: ${(error as Error).message}`,
    );
  }
}

/**
 * During an update (#2675 D, correction 8) the service is between versions,
 * not gone: the entry keeps naming a live process — the fixed launcher, which
 * outlives both — so a desktop app never reads the home as unowned and
 * starts a second writer while it is backed up and trialled. Only this
 * supervisor's own entry is handed over, like the retract above; the version
 * that comes up next publishes its own pid at readiness. Throws when the
 * registry cannot be written: the caller reports it and the update proceeds
 * (the launcher stops this supervisor either way).
 */
export function handOffServiceLivenessToLauncher(
  target: ServiceLivenessTarget,
  launcherPid: number,
): void {
  const birth = lookupProcessBirthFingerprint(launcherPid) ?? undefined;
  updateOwnedInstance(
    target.instanceName,
    { home: target.home, ownTypes: ['service'] },
    (existing) =>
      existing.pid === process.pid
        ? { ...existing, status: 'running', pid: launcherPid, birth }
        : null,
  );
}
