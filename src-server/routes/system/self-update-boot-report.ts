import { resolveInstallProvenance } from './install-provenance.js';
import {
  classifyRestartRecordAtBoot,
  readSelfUpdateRestartRecord,
  restartStateFilePath,
} from './self-update-restart-state.js';

/**
 * The other half of `updateRestartState` in system-update-routes.ts
 * (station#1903): that write existed for years with nothing on the read
 * side, so a self-update that killed the host stayed silent until a human
 * happened to notice. Called once at boot; a source-checkout install with a
 * `failed` or long-`pending` restart record gets a warning instead of quiet
 * unreadiness.
 */
export function reportSelfUpdateRestartAtBoot(
  moduleDir: string,
  log: Pick<Console, 'warn'> = console,
  {
    resolveProvenance = resolveInstallProvenance,
    now = Date.now,
  }: {
    resolveProvenance?: typeof resolveInstallProvenance;
    now?: () => number;
  } = {},
): void {
  const provenance = resolveProvenance(moduleDir);
  if (provenance.installKind !== 'source-checkout') return;

  const path = restartStateFilePath(provenance.gitRoot);
  const record = readSelfUpdateRestartRecord(path);
  const finding = classifyRestartRecordAtBoot(record, now());

  if (finding.kind === 'failed' && finding.record.status === 'failed') {
    log.warn(
      `Self-update restart ${finding.record.hash} failed verification (${finding.record.failureCode}; pid ${finding.record.pid}). Station is running on its previous build.`,
    );
    return;
  }
  if (finding.kind === 'stale-pending') {
    log.warn(
      `Self-update restart ${finding.record.hash} (pid ${finding.record.pid}, started ${finding.record.startedAt}) never resolved; its verification watchdog may have stopped before confirmation.`,
    );
  }
}
