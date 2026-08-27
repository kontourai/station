import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { classifyReadinessEvidence } from '../veritas-readiness-evidence.mjs';

const wrapper = 'scripts/veritas-readiness-evidence.mjs';

function run(command: string, extraArgs: string[] = []) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        wrapper,
        '--check',
        'evidence',
        '--working-tree',
        '--evidence-check-command',
        command,
        '--run-id',
        `test-${Date.now()}`,
        ...extraArgs,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { exitCode: 0, payload: JSON.parse(stdout) };
  } catch (error: unknown) {
    const failure = error as { status?: number; stdout?: string | Buffer };
    return {
      exitCode: failure.status,
      payload: JSON.parse(String(failure.stdout)),
    };
  }
}

describe('Station Veritas readiness evidence boundary', () => {
  test('keeps a required report failure red ahead of NOT_VERIFIED evidence', () => {
    expect(
      classifyReadinessEvidence({
        evidenceCheckFailure: { exitCode: 2 },
        record: {
          policy_results: [
            { passed: false, enforcementLevel: 'Require', status: 'fail' },
          ],
        },
      }),
    ).toEqual({ status: 'FAIL', exitCode: 1, reason: 'readiness-failed' });
  });

  test('keeps a nested NOT_VERIFIED evidence check as JSON exit 2', () => {
    const result = run(`${process.execPath} -e "process.exit(2)"`);
    expect(result.exitCode).toBe(2);
    expect(result.payload).toMatchObject({
      schemaVersion: 1,
      status: 'NOT_VERIFIED',
      exitCode: 2,
      evidenceCheckFailure: { exitCode: 2 },
    });
  });

  test('keeps a failed evidence check red', () => {
    const result = run(`${process.execPath} -e "process.exit(1)"`);
    expect(result.exitCode).toBe(1);
    expect(result.payload).toMatchObject({
      status: 'FAIL',
      exitCode: 1,
      evidenceCheckFailure: { exitCode: 1 },
    });
  });

  test('reports a passing evidence check as JSON exit 0', () => {
    const result = run(`${process.execPath} -e "process.exit(0)"`);
    expect(result.exitCode).toBe(0);
    expect(result.payload).toMatchObject({ status: 'PASS', exitCode: 0 });
  });

  test('keeps a real required report failure red ahead of nested exit 2', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'station-readiness-policy-'));
    const standardsPath = join(fixtureDir, 'required-failure.json');
    const standards = JSON.parse(
      readFileSync(
        '.veritas/repo-standards/default.repo-standards.json',
        'utf8',
      ),
    );
    standards.rules.push({
      id: 'test-required-missing-artifact',
      kind: 'required-artifacts',
      enforcementLevel: 'Require',
      match: { artifacts: ['this-fixture-must-not-exist'] },
    });
    writeFileSync(standardsPath, `${JSON.stringify(standards)}\n`);
    try {
      const result = run(`${process.execPath} -e "process.exit(2)"`, [
        '--repo-standards',
        standardsPath,
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.payload).toMatchObject({
        status: 'FAIL',
        exitCode: 1,
        reason: 'readiness-failed',
        evidenceCheckFailure: { exitCode: 2 },
      });
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
