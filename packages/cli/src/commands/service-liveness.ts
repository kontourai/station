import { existsSync } from 'node:fs';
import {
  type ClaimHostOwnerResult,
  claimHostOwner,
  entryOwnedByLiveProcess,
  type HostOwnerSummary,
  type InstanceConfig,
  readInstanceRegistry,
  resolveInstanceRegistryPath,
  updateOwnedInstance,
} from '@kontourai/station-shared/instance-registry';
import { lookupProcessBirthFingerprint } from '@kontourai/station-shared/process-identity';
import { ensureStationHomeSchemaSync } from '@kontourai/station-shared/station-home-schema';

/** The service registry entry a supervisor publishes its liveness on. */
export interface ServiceLivenessTarget {
  instanceName: string;
  home: string;
  serverPort: number;
  uiPort: number;
}

/**
 * ONE-OWNER SIGNAL (station#3064). Desktop's sidecar claim refuses a home a
 * live service owns, which it reads from a service-typed entry with a LIVE
 * pid. `service install` records policy without liveness (correctly — it is
 * not the running process), and the supervisor's inner start() is refused by
 * the CLI producer's protected-type guard, so the supervisor publishes that
 * pid itself.
 *
 * The supervisor is the right publisher: it is the process launchd or
 * systemd keeps alive, and it outlives the server children it restarts, so
 * the record does not flap. Publishing goes through the host-owner claim
 * (#2961) and builds from the existing record: the entry's
 * `env.ALLOWED_ORIGINS` is durable origin-policy authority (#1983) and must
 * survive every liveness write. A bare `service run` creates its own service
 * owner record without requiring installation. The retract stays identity-guarded.
 */
export function publishServiceLivenessRecord(
  target: ServiceLivenessTarget,
  live: boolean,
): void {
  try {
    if (live) {
      const claim = claimServiceHost(target, 'running');
      if (!claim.won) {
        throw new Error(
          claim.reason === 'host-owned'
            ? describeServiceHostRefusal(target, claim.owners)
            : `Station service '${target.instanceName}' lost its registry id.`,
        );
      }
      return;
    }
    const birth = lookupProcessBirthFingerprint(process.pid);
    updateOwnedInstance(
      target.instanceName,
      { home: target.home, ownTypes: ['service'] },
      (existing) => {
        // IDENTITY-GUARDED RETRACT. A retiring generation must never clear
        // a NEWER owner's record: reinstall-over-a-live-service is a path
        // this deliberately unblocks, so A's exit can overlap B's boot, and
        // during an update (#2675 D) the entry names the launcher. Clearing
        // it would tell Desktop that no service owns the home while one
        // does, and Desktop would spawn a second writer — the exact
        // condition this signal exists to prevent. It does not self-heal:
        // B publishes once, at readiness.
        if (
          existing.pid !== process.pid ||
          birth === null ||
          existing.birth !== birth
        )
          return null;
        return {
          ...existing,
          status: 'stopped',
          pid: undefined,
          birth: undefined,
        };
      },
    );
  } catch (error) {
    if (live) throw error;
    // Retraction is best-effort while the supervisor is already exiting.
    console.error(
      `Station service could not record its liveness in the home registry: ${(error as Error).message}`,
    );
  }
}

/** Read the same validated registry used by the atomic claim, without refreshing it. */
export function serviceHostIsOwned(target: ServiceLivenessTarget): boolean {
  const entry = readInstanceRegistry(target.home).instances[
    target.instanceName
  ];
  if (entry?.type !== 'service' || entry.pid !== process.pid) return false;
  const birth = lookupProcessBirthFingerprint(process.pid);
  if (birth === null) throw new Error('Supervisor process birth is unreadable');
  return entry.birth === birth;
}

/**
 * The service's half of the one host-owner claim (#2961, ADR 0020 D4). The
 * supervisor claims before it starts Station, so a live Desktop sidecar on
 * this home blocks the service instead of the two serving one home. A won
 * claim publishes this supervisor's pid, preserving installed service policy
 * when present. Without installation it creates only a service owner record,
 * so containers and foreground supervisors fence the home the same way.
 *
 * `starting` leaves a record another live process of this unit already holds
 * untouched: during an update (#2675 D) that is the fixed launcher, and a
 * trial that then fails must not have replaced the launcher's fence with a pid
 * its retract would clear. Recovery waits for a live replacement even at this
 * same id. `running` (readiness proven) always takes it.
 */
export function claimServiceHost(
  target: ServiceLivenessTarget,
  status: 'starting' | 'running',
  waitForLiveOwner = false,
): ClaimHostOwnerResult {
  // Probe OUTSIDE the mutation lock: the lookup spawns `ps` (or PowerShell
  // on Windows) with a 1.5s timeout, and holding the home-wide lock across
  // that stalls every other writer, including the Desktop sidecar claim.
  // A claim is bootstrap metadata, but the schema gate treats any markerless
  // registry as existing data. Initialize an absent registry's fresh home
  // before adding that metadata. The schema gate serializes initialization
  // and still refuses unknown data; only the atomic claim licenses startup.
  if (!existsSync(resolveInstanceRegistryPath(target.home))) {
    ensureStationHomeSchemaSync(target.home);
  }
  const birth = lookupProcessBirthFingerprint(process.pid) ?? undefined;
  let held: InstanceConfig | undefined;
  const claim = claimHostOwner(target.instanceName, {
    home: target.home,
    type: 'service',
    publish: (existing) => {
      const service = existing?.type === 'service' ? existing : undefined;
      if (
        status === 'starting' &&
        service &&
        (waitForLiveOwner || service.status !== 'installing') &&
        entryOwnedByLiveProcess(service, process.pid)
      ) {
        // Recovery may not adopt a live replacement generation of this unit.
        // Initial startup retains the update launcher's existing reservation.
        if (waitForLiveOwner) held = service;
        return null;
      }
      return {
        ...service,
        type: 'service',
        port: target.serverPort,
        uiPort: target.uiPort,
        status,
        pid: process.pid,
        birth,
      };
    },
  });
  return held ? { won: false, reason: 'id-held', existing: held } : claim;
}

/** Readable remediation for a service that another live host owner blocks. */
export function describeServiceHostRefusal(
  target: Pick<ServiceLivenessTarget, 'instanceName' | 'home'>,
  owners: readonly HostOwnerSummary[],
): string {
  const holders = owners
    .map((owner) =>
      owner.type === 'sidecar'
        ? `Station Desktop's built-in server (registry id '${owner.id}'${owner.pid === undefined ? '' : `, pid ${owner.pid}`})`
        : `the running Station service '${owner.id}'${owner.pid === undefined ? '' : ` (pid ${owner.pid})`}`,
    )
    .join(' and ');
  const remedy = owners.some((owner) => owner.type === 'sidecar')
    ? 'Quit Station Desktop so the background service can own this home'
    : `Stop or uninstall that service (\`station service uninstall --instance=${owners[0]?.id ?? '<id>'}\`)`;
  return `Station service '${target.instanceName}' cannot own Station home ${target.home}: it is in use by ${holders}. ${remedy}, or install the service for a different home.`;
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
