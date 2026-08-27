import { describe, expect, test, vi } from 'vitest';
import type { DoctorReport } from '../commands/lifecycle-doctor.js';
import { doctorJson } from '../commands/lifecycle-doctor.js';

function reportWithSecret(): DoctorReport {
  return {
    checks: [
      {
        label: 'Codex CLI',
        status: 'pass',
        detail: `configured with ghp_${'a'.repeat(36)}`,
      },
    ],
    recommendation: 'Ready',
    chatReady: true,
    runtimeReady: true,
    providerState: { configured: [], detected: [], effective: null },
    runtimeState: { configured: [], detected: [], effective: null },
    dependencyState: { exactPins: [], mismatches: [] },
    fixCommands: [],
  };
}

describe('doctorJson', () => {
  test('writes the stable schema as exactly one redacted JSON document', async () => {
    const write = vi.fn();
    const setExitCode = vi.fn();

    await doctorJson({
      collectReport: async () => reportWithSecret(),
      now: () => new Date('2026-07-20T12:34:56.000Z'),
      write,
      setExitCode,
    });

    expect(write).toHaveBeenCalledTimes(1);
    const document = JSON.parse(write.mock.calls[0][0]);
    expect(Object.keys(document)).toEqual([
      'schemaVersion',
      'generatedAt',
      'report',
      'exitReady',
    ]);
    expect(document.schemaVersion).toBe(1);
    expect(Object.keys(document.exitReady)).toEqual([
      'chatReady',
      'runtimeReady',
    ]);
    expect(JSON.stringify(document)).not.toContain('ghp_');
    expect(document.report.checks[0].detail).toContain('[REDACTED]');
    expect(setExitCode).not.toHaveBeenCalled();
  });

  test('uses the human-mode failure criteria for its exit code', async () => {
    const report = reportWithSecret();
    report.runtimeReady = false;
    const previousExitCode = process.exitCode;
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((() => true) as typeof process.stdout.write);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit must not be called');
    }) as typeof process.exit);

    try {
      await doctorJson({ collectReport: async () => report });

      expect(process.exitCode).toBe(1);
      expect(stdout).toHaveBeenCalledTimes(1);
      expect(stdout.mock.calls[0][0]).toMatch(/"schemaVersion":1/);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  test('additively reports exact-pin mismatches and exits non-zero', async () => {
    const report = reportWithSecret();
    report.checks.push({
      label: 'Kontour package pins',
      status: 'fail',
      detail: '@kontourai/flow-agents: pinned 5.2.0, installed 5.1.0',
    });
    report.dependencyState = {
      exactPins: [
        {
          name: '@kontourai/flow-agents',
          pinned: '5.2.0',
          installed: '5.1.0',
        },
      ],
      mismatches: [
        {
          name: '@kontourai/flow-agents',
          pinned: '5.2.0',
          installed: '5.1.0',
        },
      ],
    };
    const write = vi.fn();
    const setExitCode = vi.fn();

    await doctorJson({
      collectReport: async () => report,
      write,
      setExitCode,
    });

    const document = JSON.parse(write.mock.calls[0][0]);
    expect(document.report.dependencyState.mismatches).toEqual([
      {
        name: '@kontourai/flow-agents',
        pinned: '5.2.0',
        installed: '5.1.0',
      },
    ]);
    expect(setExitCode).toHaveBeenCalledWith(1);
  });
});
