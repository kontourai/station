import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  classifyReadinessEvidence,
  resolveEvidenceCheckFailure,
} from '../veritas-readiness-evidence.mjs';

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

  test('derives the failure of a non-required check the engine only warns about', () => {
    // Veritas 1.6.0 records an explicit command's nonzero exit in the
    // per-check results without promoting it to evidenceCheckFailure.
    const explicit = {
      id: 'explicit-command-node-e-process-exit-2',
      runner: 'bash',
      label: 'node -e "process.exit(2)"',
      passed: false,
      exitCode: 2,
      signal: null,
    };
    const required = {
      id: 'repo-governance',
      runner: 'bash',
      label: 'npm run proof:repo-governance',
      passed: true,
      exitCode: 0,
      signal: null,
    };
    expect(
      resolveEvidenceCheckFailure({
        evidenceCheckFailure: null,
        evidenceCheckResults: [required, explicit],
      }),
    ).toEqual({
      phase: 'evidence-check',
      reason: 'failed',
      id: explicit.id,
      runner: 'bash',
      label: explicit.label,
      message: 'Evidence Check command exited with 2',
      exitCode: 2,
    });
    expect(
      resolveEvidenceCheckFailure({
        evidenceCheckFailure: null,
        evidenceCheckResults: [required],
      }),
    ).toBeNull();
    expect(
      resolveEvidenceCheckFailure({
        evidenceCheckFailure: null,
        evidenceCheckResults: [],
      }),
    ).toBeNull();
    expect(
      resolveEvidenceCheckFailure({
        evidenceCheckFailure: null,
        evidenceCheckResults: [
          { ...explicit, exitCode: null, signal: 'SIGKILL' },
        ],
      }),
    ).toEqual({
      phase: 'evidence-check',
      reason: 'failed',
      id: explicit.id,
      runner: 'bash',
      label: explicit.label,
      message: 'Evidence Check command exited with SIGKILL',
    });
  });

  test('keeps the engine-reported required failure ahead of a later explicit one', () => {
    const engineFailure = {
      phase: 'evidence-check',
      reason: 'failed',
      id: 'repo-governance',
      runner: 'bash',
      label: 'npm run proof:repo-governance',
      message: 'Evidence Check command exited with 1',
      exitCode: 1,
    };
    expect(
      resolveEvidenceCheckFailure({
        evidenceCheckFailure: engineFailure,
        evidenceCheckResults: [
          { id: 'repo-governance', passed: false, exitCode: 1 },
          { id: 'explicit', passed: false, exitCode: 2 },
        ],
      }),
    ).toBe(engineFailure);
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
