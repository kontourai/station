import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { platform } from 'node:process';
import {
  redactDeep,
  sanitizeFreeText,
} from '@kontourai/station-shared/redaction';
import packageJson from '../../../package.json' with { type: 'json' };
import {
  collectDoctorReport,
  type DoctorDeps,
  type DoctorReport,
} from '../../../packages/cli/src/commands/lifecycle-doctor.js';
import {
  type BuildProvenanceSnapshot,
  readBuildProvenanceSnapshot,
} from '../../routes/system/build-provenance.js';
import type { SystemBuildProvenance } from '../../routes/system/system-route-types.js';
import {
  diagnosticsBundleErrors,
  diagnosticsBundlesGenerated,
} from '../../telemetry/metrics.js';

export const MAX_DIAGNOSTIC_LOG_BYTES = 256 * 1024;
export const LOGS_NOT_CONFIGURED_REASON =
  'no log file configured (start with --log or service mode)';

export interface DiagnosticsBundle {
  schemaVersion: 1;
  generatedAt: string;
  doctor: DoctorReport;
  app: {
    version: string;
    nodeVersion: string;
    platform: string;
    build?: SystemBuildProvenance;
  };
  config: unknown;
  logs: string | null;
  logsUnavailableReason?: string;
}

export interface DiagnosticsServiceDeps {
  collectDoctor: (deps?: Partial<DoctorDeps>) => Promise<DoctorReport>;
  now: () => Date;
  readConfig: (path: string) => Promise<unknown>;
  readInstanceLogPath: (
    statePath: string,
    instanceId?: string,
    bootId?: string,
  ) => Promise<string | undefined>;
  readLogTail: (path: string, maxBytes: number) => Promise<string>;
  logPath?: string;
  instanceStatePath?: string;
  instanceId?: string;
  bootId?: string;
  appVersion: string;
  nodeVersion: string;
  platform: string;
  buildProvenanceSnapshot?: BuildProvenanceSnapshot;
}

async function readConfig(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return {};
  }
}

async function readInstanceLogPath(
  statePath: string,
  instanceId?: string,
  bootId?: string,
): Promise<string | undefined> {
  try {
    const record = JSON.parse(await readFile(statePath, 'utf8')) as Record<
      string,
      unknown
    >;
    if (instanceId && record.instanceId !== instanceId) return undefined;
    if (bootId && record.bootId !== bootId) return undefined;
    return typeof record.logFile === 'string' && record.logFile.trim()
      ? record.logFile
      : undefined;
  } catch {
    return undefined;
  }
}

export async function readLogTail(
  path: string,
  maxBytes = MAX_DIAGNOSTIC_LOG_BYTES,
): Promise<string> {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    let text = buffer.toString('utf8');
    while (Buffer.byteLength(text) > maxBytes) text = text.slice(1);
    return text;
  } finally {
    await file.close();
  }
}

export class DiagnosticsService {
  private readonly deps: DiagnosticsServiceDeps;

  constructor(
    private readonly projectHome: string,
    deps: Partial<DiagnosticsServiceDeps> = {},
  ) {
    this.deps = {
      collectDoctor: collectDoctorReport,
      now: () => new Date(),
      readConfig,
      readInstanceLogPath,
      readLogTail,
      logPath: process.env.STATION_LOG_FILE,
      instanceStatePath: process.env.STATION_INSTANCE_STATE_PATH,
      instanceId: process.env.STATION_INSTANCE_ID,
      bootId: process.env.STATION_BOOT_ID,
      appVersion: packageJson.version,
      nodeVersion: process.version,
      platform,
      ...deps,
    };
  }

  async generateBundle(): Promise<DiagnosticsBundle> {
    try {
      const [doctor, config] = await Promise.all([
        this.deps.collectDoctor({ projectHome: this.projectHome }),
        this.deps.readConfig(join(this.projectHome, 'config', 'app.json')),
      ]);
      const logPath =
        this.deps.logPath ??
        (this.deps.instanceStatePath
          ? await this.deps.readInstanceLogPath(
              this.deps.instanceStatePath,
              this.deps.instanceId,
              this.deps.bootId,
            )
          : undefined);
      let logs: string | null = null;
      let logsUnavailableReason: string | undefined;
      if (logPath) {
        try {
          logs = sanitizeFreeText(
            await this.deps.readLogTail(logPath, MAX_DIAGNOSTIC_LOG_BYTES),
          );
        } catch {
          logsUnavailableReason = 'configured log file could not be read';
        }
      } else {
        logsUnavailableReason = LOGS_NOT_CONFIGURED_REASON;
      }

      const build = readBuildProvenanceSnapshot(
        this.deps.buildProvenanceSnapshot,
        this.deps.now().getTime(),
      );
      const bundle: DiagnosticsBundle = {
        schemaVersion: 1,
        generatedAt: this.deps.now().toISOString(),
        doctor: redactDeep(doctor),
        app: {
          version: this.deps.appVersion,
          nodeVersion: this.deps.nodeVersion,
          platform: this.deps.platform,
          // Redacted like every sibling field. `branch` and `channel` are
          // free text this process was handed by its supervisor, so the one
          // field in the bundle that skipped the sanitizer would be the one
          // carrying an operator-supplied string (station#2010 review).
          ...(build ? { build: redactDeep(build) } : {}),
        },
        config: redactDeep(config),
        logs,
        ...(logsUnavailableReason ? { logsUnavailableReason } : {}),
      };
      diagnosticsBundlesGenerated.add(1);
      return bundle;
    } catch (error) {
      diagnosticsBundleErrors.add(1);
      throw error;
    }
  }
}
