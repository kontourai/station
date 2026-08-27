import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  buildWindowsVitestDiagnosticCommand,
  runWindowsVitestDiagnostic,
} from '../run-windows-vitest-diagnostic.mjs';

const roots: string[] = [];

function root() {
  const value = mkdtempSync(join(tmpdir(), 'station-windows-vitest-'));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe('Windows Vitest diagnostic', () => {
  test('uses one serialized full corpus with a JSON output file', () => {
    expect(
      buildWindowsVitestDiagnosticCommand({
        root: 'C:\\station',
        outputFile: 'report.json',
      }),
    ).toEqual([
      expect.stringContaining('node_modules'),
      'run',
      '--maxWorkers=1',
      '--no-file-parallelism',
      '--reporter=json',
      '--outputFile=report.json',
    ]);
  });

  test('retains complete redacted failure JSON and returns the real failure', () => {
    const workspace = root();
    const result = runWindowsVitestDiagnostic({
      root: workspace,
      spawnSync: (_command, args) => {
        const output = String(
          args.find((arg) => String(arg).startsWith('--outputFile=')),
        ).slice('--outputFile='.length);
        writeFileSync(
          output,
          JSON.stringify({
            success: false,
            numTotalTests: 2,
            numPassedTests: 1,
            numFailedTests: 1,
            numPendingTests: 0,
            numTodoTests: 0,
            testResults: [
              { status: 'passed', name: 'passes' },
              {
                status: 'failed',
                name: 'fails',
                message: 'token=secret-value',
              },
            ],
          }),
        );
        return { status: 1, stdout: '', stderr: '' } as never;
      },
    });

    expect(result).toMatchObject({
      exitCode: 1,
      summary: {
        complete: true,
        counts: { total: 2, passed: 1, failed: 1 },
        files: { total: 2, failed: 1 },
      },
    });
    const report = readFileSync(
      join(workspace, '.kontourai/windows-vitest/vitest.json'),
      'utf8',
    );
    expect(report).toContain('[REDACTED]');
    expect(report).not.toContain('secret-value');
  });

  test('fails closed when Vitest exits without a complete report', () => {
    const workspace = root();
    expect(() =>
      runWindowsVitestDiagnostic({
        root: workspace,
        spawnSync: () => ({ status: 0, stdout: '', stderr: '' }) as never,
      }),
    ).toThrow('did not produce');
    expect(
      existsSync(join(workspace, '.kontourai/windows-vitest/vitest.json')),
    ).toBe(false);
  });
});
