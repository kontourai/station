/**
 * The supervised half of the in-app git-pull update (#3851 handoff API).
 *
 * Unsupervised, the update spawns a replacement server and a detached
 * watchdog that marks the durable restart record `verified` or `failed`.
 * Under the process supervisor there is no replacement to watch: the update
 * asks the supervisor for a handoff, and the generation that handoff leaves
 * serving is told the outcome (`onHandoffOutcome`). That generation resolves
 * the record here, so the browser's `restart-status` poll reads the same
 * verdicts either way.
 */
import {
  type HandoffOutcomeReport,
  onHandoffOutcome,
} from '../../runtime/bootstrap/supervisor-link.js';
import { readBuildProvenance } from './build-provenance.js';
import { resolveInstallProvenance } from './install-provenance.js';
import {
  emitRestartDiagnostic,
  type RestartDiagnosticLogger,
  readSelfUpdateRestartRecord,
  restartStateFilePath,
  type SelfUpdateRestartRecord,
  writeSelfUpdateRestartRecord,
} from './self-update-restart-state.js';

export interface SupervisedRestartContext {
  restartStatePath: string;
  instanceId: string;
  /** This generation's short build sha, or null when it has none. */
  shortSha: string | null;
  pid: number;
  logger?: RestartDiagnosticLogger;
  writeRecord?: typeof writeSelfUpdateRestartRecord;
  now?: () => Date;
}

/**
 * Resolves a pending supervised restart from the outcome of the handoff that
 * left this generation serving. Only a handoff a core asked for resolves it
 * (`station restart` carries no request id), and only a pending record of
 * this instance. A committed handoff is verified only when this generation
 * runs the build the update produced; serving any other build is an identity
 * mismatch. Returns the record written, or null when nothing applied.
 */
export function resolveSupervisedRestart(
  report: HandoffOutcomeReport,
  context: SupervisedRestartContext,
): SelfUpdateRestartRecord | null {
  if (report.requestId === null) return null;
  const pending = readSelfUpdateRestartRecord(context.restartStatePath);
  if (
    pending?.status !== 'pending' ||
    pending.instanceId !== context.instanceId
  ) {
    return null;
  }
  const base = {
    instanceId: pending.instanceId,
    hash: pending.hash,
    pid: context.pid,
    port: pending.port,
    startedAt: pending.startedAt,
    resolvedAt: (context.now?.() ?? new Date()).toISOString(),
  };
  const record: SelfUpdateRestartRecord =
    report.outcome === 'committed' && context.shortSha === pending.hash
      ? { ...base, status: 'verified' }
      : {
          ...base,
          status: 'failed',
          failureCode:
            report.outcome === 'committed'
              ? 'identity-mismatch'
              : 'handoff-rolled-back',
        };
  const write = (context.writeRecord ?? writeSelfUpdateRestartRecord)(
    context.restartStatePath,
    record,
  );
  emitRestartDiagnostic(
    context.logger,
    record.status === 'verified' ? 'info' : 'warn',
    record.status === 'verified'
      ? 'Core restart: supervised handoff verified'
      : 'Core restart: supervised handoff did not produce the updated build',
    {
      hash: pending.hash,
      outcome: report.outcome,
      ...(report.reason !== undefined ? { reason: report.reason } : {}),
      durability: write.durability,
    },
  );
  return record;
}

/**
 * Listens, in this generation, for the outcome of the handoff that left it
 * serving, and resolves a pending supervised restart of this source
 * checkout. A no-op unless this process is supervised and runs from a source
 * checkout, the only install the git-pull update applies to.
 */
export function installSupervisedRestartResolver(
  moduleDir: string,
  logger: RestartDiagnosticLogger,
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  return onHandoffOutcome((report) => {
    try {
      const provenance = resolveInstallProvenance(moduleDir);
      if (provenance.installKind !== 'source-checkout') return;
      resolveSupervisedRestart(report, {
        restartStatePath: restartStateFilePath(provenance.gitRoot),
        instanceId: env.STATION_INSTANCE_ID || 'default',
        shortSha: readBuildProvenance(env)?.shortSha ?? null,
        pid: process.pid,
        logger,
      });
    } catch (error) {
      emitRestartDiagnostic(
        logger,
        'warn',
        'Core restart: could not record the supervised handoff outcome',
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  });
}
