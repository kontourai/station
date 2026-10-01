import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { DoctorReport } from '../../../../packages/cli/src/commands/lifecycle-doctor.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { captureBuildProvenance } from '../../../routes/system/build-provenance.js';
import { logFatalAndFlush } from '../../../runtime/bootstrap/crash-handlers.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  diagnosticsBundlesGenerated: { add: vi.fn() },
  diagnosticsBundleErrors: { add: vi.fn() },
}));

const { DiagnosticsService } = await import('../diagnostics-service.js');

const makeTempDir = trackTempDirs();

function doctorReport(secret: string): DoctorReport {
  return {
    checks: [{ label: 'CLI', status: 'pass', detail: secret }],
    recommendation: 'Ready',
    chatReady: true,
    runtimeReady: true,
    providerState: { configured: [], detected: [], effective: null },
    runtimeState: { configured: [], detected: [], effective: null },
    dependencyState: { exactPins: [], mismatches: [] },
    fixCommands: [],
  };
}

describe('DiagnosticsService', () => {
  test('composes and redacts the complete bundle', async () => {
    const projectHome = '/tmp/station-diagnostics-home';
    const seededSecret = `ghp_${'s'.repeat(36)}`;
    const collectDoctor = vi.fn(async () => doctorReport(seededSecret));
    const readConfig = vi.fn(async () => ({
      version: '1.2.3',
      apiKey: seededSecret,
    }));
    const service = new DiagnosticsService(projectHome, {
      collectDoctor,
      readConfig,
      readLogTail: async () =>
        `Authorization: Bearer ${seededSecret}\n` +
        "ENOENT: no such file or directory, open '/Users/me/station/private/logs.ts'\n" +
        'Cannot find module "C:\\Station Data\\private\\bundle.ts"\n' +
        'at collectLogs (/Users/me/Station Data/private/logs.ts:42:7)\n' +
        'at renderBundle (C:\\Station Data\\private\\bundle.ts:19:2)',
      logPath: '/tmp/station.log',
      now: () => new Date('2026-07-20T12:34:56.000Z'),
      appVersion: '0.1.0',
      nodeVersion: 'v24.4.0',
      platform: 'darwin',
      // The seeded secret goes in a PROVENANCE field on purpose: the
      // assertion below claims provenance does not bypass redaction, and
      // before archive#2010's review nothing put a secret there, so the claim
      // was never exercised while `build` genuinely skipped the sanitizer.
      buildProvenanceSnapshot: captureBuildProvenance({
        STATION_BUILD_SHA: 'abcdef0123456789abcdef0123456789abcdef01',
        STATION_BUILD_BRANCH: `main-${seededSecret}`,
      }),
    });

    const bundle = await service.generateBundle();

    expect(bundle).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-07-20T12:34:56.000Z',
      app: {
        version: '0.1.0',
        nodeVersion: 'v24.4.0',
        platform: 'darwin',
        build: {
          fullSha: 'abcdef0123456789abcdef0123456789abcdef01',
          shortSha: 'abcdef0',
          branch: 'main-[REDACTED]',
        },
      },
      config: { version: '1.2.3', apiKey: '[REDACTED]' },
    });
    expect(collectDoctor).toHaveBeenCalledWith({ projectHome });
    expect(readConfig).toHaveBeenCalledWith(
      join(projectHome, 'config', 'app.json'),
    );
    expect(
      JSON.stringify(bundle),
      'diagnostics provenance must not bypass redaction of the complete bundle',
    ).not.toContain(seededSecret);
    expect(bundle.doctor.checks[0].detail).toBe('[REDACTED]');
    expect(bundle.logs).toContain('Authorization: Bearer [REDACTED]');
    expect(bundle.logs).toContain('collectLogs');
    expect(bundle.logs).toContain('renderBundle');
    expect(bundle.logs).not.toContain('/Users/me');
    expect(bundle.logs).not.toContain('C:\\Station Data');
    expect(bundle.logs).not.toContain('Station Data\\private\\bundle.ts');
    expect(bundle.logs).toContain("open '[REDACTED_PATH]'");
    expect(bundle.logs).toContain('module "[REDACTED_PATH]"');
  });

  test('discovers the current instance log from its registry record', async () => {
    const dir = makeTempDir('station-diagnostics-record-');
    const logPath = join(dir, 'server.log');
    const statePath = join(dir, 'instance.json');
    writeFileSync(logPath, 'password=hunter2');
    writeFileSync(
      statePath,
      JSON.stringify({
        instanceId: 'agent-smoke',
        bootId: 'boot-123',
        logFile: logPath,
      }),
    );
    const service = new DiagnosticsService('/tmp/station-home', {
      collectDoctor: async () => doctorReport('safe'),
      readConfig: async () => ({}),
      logPath: undefined,
      instanceStatePath: statePath,
      instanceId: 'agent-smoke',
      bootId: 'boot-123',
    });

    expect(await service.generateBundle()).toMatchObject({
      logs: 'password=[REDACTED]',
    });
  });

  test('returns an explicit reason when no server log is configured', async () => {
    const service = new DiagnosticsService('/tmp/station-home', {
      collectDoctor: async () => doctorReport('safe'),
      readConfig: async () => ({}),
      logPath: undefined,
      instanceStatePath: undefined,
    });

    expect(await service.generateBundle()).toMatchObject({
      logs: null,
      logsUnavailableReason:
        'no log file configured (start with --log or service mode)',
    });
  });

  test('reports supervisor build provenance exactly, field by field', async () => {
    const service = new DiagnosticsService('/tmp/station-home', {
      collectDoctor: async () => doctorReport('safe'),
      readConfig: async () => ({}),
      logPath: undefined,
      now: () => new Date('2026-08-11T12:01:23.000Z'),
      buildProvenanceSnapshot: captureBuildProvenance({
        STATION_BUILD_SHA: 'abcdef0123456789abcdef0123456789abcdef01',
        STATION_BUILD_BRANCH: 'release/2010',
        STATION_BUILD_BUILT_AT: '2026-08-11T12:00:00.000Z',
        STATION_CHANNEL: 'stable',
      }),
    });

    const bundle = await service.generateBundle();
    expect(
      bundle,
      'diagnostics bundle must preserve exact supervisor build provenance',
    ).toMatchObject({
      app: {
        build: {
          fullSha: 'abcdef0123456789abcdef0123456789abcdef01',
          shortSha: 'abcdef0',
          branch: 'release/2010',
          builtAt: '2026-08-11T12:00:00.000Z',
          ageSeconds: 83,
          channel: 'stable',
        },
      },
    });
  });

  test('uses only baked fallback fields when supervisor build vars are absent', async () => {
    const service = new DiagnosticsService('/tmp/station-home', {
      collectDoctor: async () => doctorReport('safe'),
      readConfig: async () => ({}),
      logPath: undefined,
      now: () => new Date('2026-08-11T12:01:23.000Z'),
      buildProvenanceSnapshot: captureBuildProvenance(
        {},
        Date.parse('2026-08-11T12:01:23.000Z'),
        {
          sha: 'ba5ed00123456789abcdef0123456789abcdef01',
          builtAt: '2026-08-11T12:00:00.000Z',
          channel: 'preview',
          dirty: true,
        },
      ),
    });

    const bundle = await service.generateBundle();
    expect(
      bundle,
      'diagnostics bundle must use only available baked build provenance',
    ).toMatchObject({
      app: {
        build: {
          fullSha: 'ba5ed00123456789abcdef0123456789abcdef01',
          shortSha: 'ba5ed00',
          builtAt: '2026-08-11T12:00:00.000Z',
          ageSeconds: 83,
          channel: 'preview',
          dirty: true,
        },
      },
    });
  });

  test('preserves partial build provenance without fabricating absent fields', async () => {
    const service = new DiagnosticsService('/tmp/station-home', {
      collectDoctor: async () => doctorReport('safe'),
      readConfig: async () => ({}),
      logPath: undefined,
      buildProvenanceSnapshot: captureBuildProvenance({
        STATION_BUILD_BRANCH: 'release/2010',
      }),
    });

    const bundle = await service.generateBundle();
    expect(
      bundle.app.build,
      'diagnostics bundle must preserve partial build provenance without fabrication',
    ).toEqual({ branch: 'release/2010' });
    expect(
      bundle.app.build,
      'diagnostics bundle must omit unavailable build fields',
    ).not.toHaveProperty('fullSha');
    expect(
      bundle.app.build,
      'diagnostics bundle must omit unavailable build fields',
    ).not.toHaveProperty('builtAt');
  });

  test('keeps a bundle and crash record on the same captured build after env mutation', async () => {
    const originalSha = process.env.STATION_BUILD_SHA;
    const originalChannel = process.env.STATION_CHANNEL;
    const snapshot = captureBuildProvenance({
      STATION_BUILD_SHA: 'abcdef0123456789abcdef0123456789abcdef01',
      STATION_CHANNEL: 'stable',
      STATION_BUILD_BUILT_AT: '2026-08-11T12:00:00.000Z',
    });
    const now = new Date('2026-08-11T12:01:23.000Z');
    const service = new DiagnosticsService('/tmp/station-home', {
      collectDoctor: async () => doctorReport('safe'),
      readConfig: async () => ({}),
      logPath: undefined,
      now: () => now,
      buildProvenanceSnapshot: snapshot,
    });
    const logger = { fatal: vi.fn() };

    try {
      process.env.STATION_BUILD_SHA =
        'ba5ed00123456789abcdef0123456789abcdef01';
      process.env.STATION_CHANNEL = 'preview';
      const bundle = await service.generateBundle();
      logFatalAndFlush(
        logger,
        'Uncaught exception',
        { err: 'boom' },
        vi.fn(),
        snapshot,
      );

      const fatalContext = logger.fatal.mock.calls[0]?.[1];
      expect(fatalContext).toBeDefined();
      const crashBuild = (
        fatalContext as {
          build?: unknown;
        }
      ).build as Record<string, unknown>;
      const { ageSeconds: crashAgeSeconds, ...crashIdentity } = crashBuild;
      const { ageSeconds: bundleAgeSeconds, ...bundleIdentity } =
        bundle.app.build ?? {};
      expect(
        crashIdentity,
        'bundle and fatal line must retain the same bootstrap build after STATION_BUILD_SHA mutates',
      ).toEqual(bundleIdentity);
      expect(bundleAgeSeconds).toBe(83);
      expect(crashAgeSeconds).toEqual(expect.any(Number));
      expect(bundle.app.build).toMatchObject({
        fullSha: 'abcdef0123456789abcdef0123456789abcdef01',
        channel: 'stable',
      });
    } finally {
      if (originalSha === undefined) delete process.env.STATION_BUILD_SHA;
      else process.env.STATION_BUILD_SHA = originalSha;
      if (originalChannel === undefined) delete process.env.STATION_CHANNEL;
      else process.env.STATION_CHANNEL = originalChannel;
    }
  });
});

describe('bundled server log', () => {
  test('carries at most the last 256 KiB of the configured log', async () => {
    const dir = makeTempDir('station-diagnostics-');
    const logPath = join(dir, 'server.log');
    const limit = 256 * 1024;
    writeFileSync(logPath, `discard-${'x'.repeat(limit)}tail`);
    // Default dependencies read the log; only the unrelated sections are stubbed.
    const service = new DiagnosticsService(dir, {
      collectDoctor: async () => doctorReport('ok'),
      readConfig: async () => ({}),
      logPath,
    });

    const { logs } = await service.generateBundle();

    expect(Buffer.byteLength(logs ?? '')).toBe(limit);
    expect(logs?.endsWith('tail')).toBe(true);
    expect(logs?.startsWith('discard-')).toBe(false);
  });

  test('cuts the log on a character boundary', async () => {
    const dir = makeTempDir('station-diagnostics-');
    const logPath = join(dir, 'server.log');
    // 3-byte characters: the last 256 KiB (262144 = 3 * 87381 + 1) starts one
    // byte into a character, which must be dropped rather than mangled.
    writeFileSync(logPath, '\u20ac'.repeat(100_000));
    const service = new DiagnosticsService(dir, {
      collectDoctor: async () => doctorReport('ok'),
      readConfig: async () => ({}),
      logPath,
    });

    const { logs } = await service.generateBundle();

    expect(logs).toBe('\u20ac'.repeat(87_381));
  });
});
