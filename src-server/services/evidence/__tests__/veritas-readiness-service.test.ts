import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { execGitSync } from '../../../utils/git-exec.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  veritasReadinessRuns: { add: vi.fn() },
  veritasReadinessDuration: { record: vi.fn() },
  veritasReadinessInits: { add: vi.fn() },
}));

const {
  VeritasReadinessService,
  VeritasCliError,
  VeritasNotConfiguredError,
  parseTrailingJson,
} = await import('../veritas-readiness-service.js');

// ── Fixtures (trimmed from real @kontourai/veritas@1.5.0 output) ──────────

/** Real CLI stdout shape: evidence-check passthrough noise before the JSON. */
function cliStdout(overrides: Record<string, unknown> = {}): string {
  const json = {
    mode: 'report-and-draft',
    evidenceCheckLabels: ['npm test'],
    evidenceCheckResolutionSource: 'required',
    evidenceCheckRan: true,
    evidenceCheckFailure: null,
    reportArtifactPath: '.kontourai/veritas/evidence/veritas-123.json',
    draftArtifactPath:
      '.kontourai/veritas/standards-feedback-drafts/veritas-123.json',
    reportRunId: 'veritas-123',
    reportSourceKind: 'working-tree',
    message: 'Evidence Check, report, and standards feedback draft completed.',
    ...overrides,
  };
  return `\n> fixture@1.0.0 test\n> exit 0\n\n${JSON.stringify(json, null, 2)}\n`;
}

const TRUST_BUNDLE = {
  schemaVersion: 5,
  source: 'veritas:veritas-123',
  claims: [
    {
      id: 'fx.evidence-check.npm-test',
      subjectType: 'software-change',
      subjectId: 'fx:working-tree',
      facet: 'veritas.evidence-check',
      claimType: 'software-evidence-check',
      fieldOrBehavior: 'npm test',
      value: 'passed',
      createdAt: '2026-06-12T00:00:00.000Z',
      updatedAt: '2026-06-12T00:00:00.000Z',
    },
    {
      id: 'veritas.policy.fx.default.policy-changes-require-attestation',
      subjectType: 'repo-policy',
      subjectId: 'fx:policy-changes-require-attestation',
      facet: 'veritas.policy-results',
      claimType: 'veritas-policy-result',
      fieldOrBehavior: 'policy-changes-require-attestation',
      value: 'warn',
      createdAt: '2026-06-12T00:00:00.000Z',
      updatedAt: '2026-06-12T00:00:00.000Z',
    },
  ],
  evidence: [
    {
      id: 'veritas-123.evidence-check.required-evidence-check.evidence',
      claimId: 'fx.evidence-check.npm-test',
      evidenceType: 'command-output',
      method: 'validation',
      sourceRef: 'command:npm test',
      excerptOrSummary: 'npm test exited 0',
      observedAt: '2026-06-12T00:00:00.000Z',
      collectedBy: 'veritas',
      passing: true,
      blocking: true,
    },
  ],
  policies: [],
  events: [],
};

function evidenceRecord(overrides: Record<string, unknown> = {}) {
  return {
    record_schema_version: 1,
    run_id: 'veritas-123',
    governance_state: { state: 'missing' },
    selected_evidence_checks: [
      {
        id: 'required-evidence-check',
        runner: 'bash',
        label: 'npm test',
        summary: 'Evidence checks passed',
        evidence_check_result: { passed: true, exitCode: 0 },
      },
    ],
    policy_results: [
      {
        rule_id: 'required-veritas-artifacts',
        stage: 'block',
        passed: true,
        status: 'info',
        summary: 'All required repository artifacts are present.',
      },
      {
        rule_id: 'policy-changes-require-attestation',
        enforcementLevel: 'Guide',
        passed: false,
        status: 'warn',
        summary: 'No active attestation found; readiness is advisory.',
      },
    ],
    recommendations: [
      {
        kind: 'unmatched-files',
        severity: 'warn',
        message: 'Some files do not match a configured work area.',
      },
    ],
    override_or_bypass: false,
    trust: { bundle: TRUST_BUNDLE },
    ...overrides,
  };
}

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0, cleanupDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Create a temp workspace with .veritas/, a fake CLI binary, and a record. */
function makeWorkspace(
  options: {
    veritasDir?: boolean;
    cliBin?: boolean;
    record?: Record<string, unknown> | null;
  } = {},
): string {
  const cwd = mkdtempSync(join(tmpdir(), 'veritas-readiness-'));
  cleanupDirs.push(cwd);
  if (options.veritasDir !== false) {
    mkdirSync(join(cwd, '.veritas'), { recursive: true });
    mkdirSync(join(cwd, '.kontourai', 'veritas', 'evidence'), {
      recursive: true,
    });
  }
  if (options.cliBin !== false) {
    const binDir = join(cwd, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    const binName = process.platform === 'win32' ? 'veritas.cmd' : 'veritas';
    writeFileSync(join(binDir, binName), '#!/bin/sh\nexit 0\n');
  }
  const record =
    options.record === undefined ? evidenceRecord() : options.record;
  if (record) {
    writeFileSync(
      join(cwd, '.kontourai', 'veritas', 'evidence', 'veritas-123.json'),
      JSON.stringify(record, null, 2),
    );
  }
  return cwd;
}

function stubRunner(
  result: { stdout: string; stderr?: string; exitCode?: number | null },
  calls?: Array<{ cwd: string; binPath: string; args: string[] }>,
) {
  return vi.fn(async (cwd: string, binPath: string, args: string[]) => {
    calls?.push({ cwd, binPath, args });
    return {
      stdout: result.stdout,
      stderr: result.stderr ?? '',
      exitCode: result.exitCode ?? 0,
    };
  });
}

describe('parseTrailingJson', () => {
  test('extracts the trailing JSON object from noisy stdout', () => {
    const parsed = parseTrailingJson(cliStdout());
    expect(parsed?.reportRunId).toBe('veritas-123');
    expect(parsed?.reportArtifactPath).toBe(
      '.kontourai/veritas/evidence/veritas-123.json',
    );
  });

  test('returns null when stdout carries no JSON', () => {
    expect(parseTrailingJson('Usage:\n  veritas init [--root <path>]')).toBe(
      null,
    );
  });
});

describe('VeritasReadinessService.detectWorkspace', () => {
  test('not configured without a .veritas directory', () => {
    const cwd = makeWorkspace({ veritasDir: false, record: null });
    const service = new VeritasReadinessService({
      runCli: stubRunner({ stdout: '' }),
    });
    expect(service.detectWorkspace(cwd)).toEqual({
      configured: false,
      reason: 'no-veritas-dir',
    });
  });

  test('not configured without a resolvable veritas CLI', () => {
    const cwd = makeWorkspace({ cliBin: false, record: null });
    const service = new VeritasReadinessService({
      runCli: stubRunner({ stdout: '' }),
    });
    expect(service.detectWorkspace(cwd)).toEqual({
      configured: false,
      reason: 'no-cli',
    });
  });

  test('configured when .veritas and a local CLI binary are present', () => {
    const cwd = makeWorkspace({ record: null });
    const service = new VeritasReadinessService({
      runCli: stubRunner({ stdout: '' }),
    });
    const status = service.detectWorkspace(cwd);
    expect(status.configured).toBe(true);
    expect(status.cliPath).toContain(join('node_modules', '.bin'));
  });
});

describe('VeritasReadinessService.initWorkspace', () => {
  test('runs `veritas init` against a workspace that lacks .veritas', async () => {
    // No .veritas dir, but a resolvable CLI bin is present.
    const cwd = makeWorkspace({ veritasDir: false, record: null });
    const calls: Array<{ cwd: string; binPath: string; args: string[] }> = [];
    const service = new VeritasReadinessService({
      runCli: stubRunner({ stdout: 'initialized', exitCode: 0 }, calls),
    });
    const result = await service.initWorkspace(cwd);
    expect(result.outcome).toBe('created');
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['init', '--root', cwd, '--non-interactive']);
  });

  test('is idempotent — already-initialized workspace does not shell out', async () => {
    const cwd = makeWorkspace({ record: null }); // .veritas present
    const runCli = stubRunner({ stdout: '', exitCode: 0 });
    const service = new VeritasReadinessService({ runCli });
    const result = await service.initWorkspace(cwd);
    expect(result.outcome).toBe('already-initialized');
    expect(runCli).not.toHaveBeenCalled();
  });

  test('degrades to a copyable command when no CLI is resolvable', async () => {
    const cwd = makeWorkspace({
      veritasDir: false,
      cliBin: false,
      record: null,
    });
    const runCli = stubRunner({ stdout: '', exitCode: 0 });
    const service = new VeritasReadinessService({ runCli });
    const result = await service.initWorkspace(cwd);
    expect(result.outcome).toBe('no-cli');
    expect(result.command).toContain('veritas init');
    expect(runCli).not.toHaveBeenCalled();
  });

  test('a non-zero init exit surfaces a VeritasCliError', async () => {
    const cwd = makeWorkspace({ veritasDir: false, record: null });
    const service = new VeritasReadinessService({
      runCli: stubRunner({ stdout: '', stderr: 'boom', exitCode: 3 }),
    });
    await expect(service.initWorkspace(cwd)).rejects.toBeInstanceOf(
      VeritasCliError,
    );
  });
});

describe('VeritasReadinessService.getReadiness', () => {
  test('runs the CLI, loads the evidence record, and derives the snapshot', async () => {
    const cwd = makeWorkspace();
    const calls: Array<{ cwd: string; binPath: string; args: string[] }> = [];
    const service = new VeritasReadinessService({
      runCli: stubRunner({ stdout: cliStdout() }, calls),
    });

    const snapshot = await service.getReadiness(cwd);

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([
      'readiness',
      '--working-tree',
      '--format',
      'json',
    ]);
    expect(snapshot.overall).toBe('ready');
    expect(snapshot.cli.runId).toBe('veritas-123');
    expect(snapshot.cli.reportArtifactPath).toBe(
      '.kontourai/veritas/evidence/veritas-123.json',
    );
    expect(
      existsSync(
        join(cwd, '.kontourai', 'veritas', 'evidence', 'veritas-123.json'),
      ),
    ).toBe(true);

    const byId = new Map(
      snapshot.requirements.map((requirement) => [requirement.id, requirement]),
    );
    expect(byId.get('evidence-check:required-evidence-check')?.status).toBe(
      'satisfied',
    );
    expect(
      byId.get('evidence-check:required-evidence-check')?.claimIds,
    ).toEqual(['fx.evidence-check.npm-test']);
    expect(byId.get('policy:required-veritas-artifacts')?.status).toBe(
      'satisfied',
    );
    expect(byId.get('policy:policy-changes-require-attestation')?.status).toBe(
      'advisory',
    );
    expect(byId.get('governance:attestation')?.status).toBe('missing');
    expect(byId.get('recommendation:unmatched-files')?.status).toBe('advisory');

    expect(snapshot.counts.satisfied).toBe(2);
    expect(snapshot.counts.advisory).toBe(2);
    expect(snapshot.counts.missing).toBe(1);
    expect(snapshot.counts.failing).toBe(0);

    expect(snapshot.trustReport).not.toBeNull();
    expect(snapshot.trustReport?.claims).toHaveLength(2);
  });

  test('maps a failed evidence check + exit 1 to not-ready/failing', async () => {
    const record = evidenceRecord({
      selected_evidence_checks: [
        {
          id: 'required-evidence-check',
          label: 'npm test',
          summary: 'Evidence checks failed with exit code 1',
          evidence_check_result: { passed: false, exitCode: 1 },
        },
      ],
    });
    const cwd = makeWorkspace({ record });
    const service = new VeritasReadinessService({
      runCli: stubRunner({
        stdout: cliStdout({
          evidenceCheckFailure: {
            id: 'required-evidence-check',
            label: 'npm test',
            message: 'Evidence Check command exited with 1',
            exitCode: 1,
          },
        }),
        exitCode: 1,
      }),
    });

    const snapshot = await service.getReadiness(cwd);
    expect(snapshot.overall).toBe('not-ready');
    expect(snapshot.cli.evidenceCheckFailure?.exitCode).toBe(1);
    expect(
      snapshot.requirements.find(
        (requirement) => requirement.kind === 'evidence-check',
      )?.status,
    ).toBe('failing');
  });

  test('maps a current (1.5.0) governance attestation to satisfied', async () => {
    const cwd = makeWorkspace({
      record: evidenceRecord({ governance_state: { state: 'current' } }),
    });
    const service = new VeritasReadinessService({
      runCli: stubRunner({ stdout: cliStdout() }),
    });
    const snapshot = await service.getReadiness(cwd);
    expect(
      snapshot.requirements.find(
        (requirement) => requirement.id === 'governance:attestation',
      )?.status,
    ).toBe('satisfied');
  });

  test('maps a failed Veritas 1.5 Require policy to failing without legacy stage', async () => {
    const cwd = makeWorkspace({
      record: evidenceRecord({
        policy_results: [
          {
            rule_id: 'policy-changes-require-attestation',
            enforcementLevel: 'Require',
            passed: false,
            status: 'fail',
            summary: 'Protected standards hashes drifted.',
          },
        ],
      }),
    });
    const service = new VeritasReadinessService({
      runCli: stubRunner({ stdout: cliStdout(), exitCode: 1 }),
    });

    const snapshot = await service.getReadiness(cwd);
    expect(
      snapshot.requirements.find(
        (requirement) =>
          requirement.id === 'policy:policy-changes-require-attestation',
      )?.status,
    ).toBe('failing');
  });

  test('retains read compatibility for a legacy .veritas evidence reference', async () => {
    const cwd = makeWorkspace({ record: null });
    const legacyDir = join(cwd, '.veritas', 'evidence');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, 'veritas-123.json'),
      JSON.stringify(evidenceRecord(), null, 2),
    );
    const service = new VeritasReadinessService({
      runCli: stubRunner({
        stdout: cliStdout({
          reportArtifactPath: '.veritas/evidence/veritas-123.json',
        }),
      }),
    });

    const snapshot = await service.getReadiness(cwd);
    expect(snapshot.cli.reportArtifactPath).toBe(
      '.kontourai/veritas/evidence/veritas-123.json',
    );
    expect(
      existsSync(
        join(cwd, '.kontourai', 'veritas', 'evidence', 'veritas-123.json'),
      ),
    ).toBe(true);
  });

  test('records an accepted exception when an override is recorded', async () => {
    const cwd = makeWorkspace({
      record: evidenceRecord({ override_or_bypass: true }),
    });
    const service = new VeritasReadinessService({
      runCli: stubRunner({ stdout: cliStdout() }),
    });
    const snapshot = await service.getReadiness(cwd);
    expect(snapshot.counts.accepted).toBe(1);
    expect(
      snapshot.requirements.find(
        (requirement) => requirement.kind === 'exception',
      )?.status,
    ).toBe('accepted');
  });

  test('degrades gracefully when the record carries no trust bundle', async () => {
    const cwd = makeWorkspace({ record: evidenceRecord({ trust: {} }) });
    const service = new VeritasReadinessService({
      runCli: stubRunner({ stdout: cliStdout() }),
    });
    const snapshot = await service.getReadiness(cwd);
    expect(snapshot.trustReport).toBeNull();
    expect(snapshot.requirements.length).toBeGreaterThan(0);
    for (const requirement of snapshot.requirements) {
      expect(requirement.claimIds).toEqual([]);
    }
  });

  test('throws a typed CLI error (exit code + stderr tail) on hard failure', async () => {
    const cwd = makeWorkspace({ record: null });
    const service = new VeritasReadinessService({
      runCli: stubRunner({
        stdout: '',
        stderr: 'Failed to load Repo Map at .veritas/repo-map.json',
        exitCode: 2,
      }),
    });
    const error = await service.getReadiness(cwd).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VeritasCliError);
    expect((error as InstanceType<typeof VeritasCliError>).exitCode).toBe(2);
    expect(
      (error as InstanceType<typeof VeritasCliError>).stderrTail,
    ).toContain('Repo Map');
  });

  test('throws not-configured instead of running in a bare workspace', async () => {
    const cwd = makeWorkspace({ veritasDir: false, record: null });
    const runCli = stubRunner({ stdout: cliStdout() });
    const service = new VeritasReadinessService({ runCli });
    await expect(service.getReadiness(cwd)).rejects.toBeInstanceOf(
      VeritasNotConfiguredError,
    );
    expect(runCli).not.toHaveBeenCalled();
  });

  test('caches the snapshot per workspace; refresh forces a re-run', async () => {
    const cwd = makeWorkspace();
    const runCli = stubRunner({ stdout: cliStdout() });
    const service = new VeritasReadinessService({ runCli });

    const first = await service.getReadiness(cwd);
    const second = await service.getReadiness(cwd);
    expect(runCli).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);

    const refreshed = await service.getReadiness(cwd, { refresh: true });
    expect(runCli).toHaveBeenCalledTimes(2);
    expect(refreshed).not.toBe(first);
  });

  test('single-flight: concurrent requests share one CLI run', async () => {
    const cwd = makeWorkspace();
    let resolveRun: (() => void) | undefined;
    const gate = new Promise<void>((resolvePromise) => {
      resolveRun = resolvePromise;
    });
    const runCli = vi.fn(async () => {
      await gate;
      return { stdout: cliStdout(), stderr: '', exitCode: 0 };
    });
    const service = new VeritasReadinessService({ runCli });

    const a = service.getReadiness(cwd);
    const b = service.getReadiness(cwd, { refresh: true });
    resolveRun?.();
    const [snapshotA, snapshotB] = await Promise.all([a, b]);
    expect(runCli).toHaveBeenCalledTimes(1);
    expect(snapshotA).toBe(snapshotB);
  });

  test('passes --check through to the CLI', async () => {
    const cwd = makeWorkspace();
    const calls: Array<{ cwd: string; binPath: string; args: string[] }> = [];
    const service = new VeritasReadinessService({
      runCli: stubRunner({ stdout: cliStdout() }, calls),
    });
    await service.getReadiness(cwd, { check: 'evidence' });
    expect(calls[0].args).toEqual([
      'readiness',
      '--check',
      'evidence',
      '--working-tree',
      '--format',
      'json',
    ]);
  });
});

// Slow opt-in lane: drives a real `veritas readiness` run end-to-end inside a
// `veritas init` fixture workspace. Requires a Veritas 1.5-compatible binary
// path in VERITAS_READINESS_E2E_BIN.
describe.skipIf(!process.env.VERITAS_READINESS_E2E_BIN)(
  'VeritasReadinessService (real CLI, opt-in)',
  () => {
    test('produces a snapshot from a real veritas init workspace', async () => {
      const { execFileSync } = await import('node:child_process');
      const cwd = mkdtempSync(join(tmpdir(), 'veritas-readiness-e2e-'));
      cleanupDirs.push(cwd);
      const bin = process.env.VERITAS_READINESS_E2E_BIN as string;
      execGitSync(['init', '-q'], { cwd });
      writeFileSync(
        join(cwd, 'package.json'),
        JSON.stringify({
          name: 'fixture',
          version: '1.0.0',
          scripts: { test: 'exit 0' },
        }),
      );
      execFileSync(bin, ['init', '--project-name', 'fixture'], {
        cwd,
        windowsHide: true,
      });
      execGitSync(['add', '-A'], { cwd });

      const service = new VeritasReadinessService({
        runCli: async (runCwd, _binPath, args) => {
          const { execFile } = await import('node:child_process');
          return new Promise((resolvePromise) => {
            execFile(
              bin,
              args,
              { cwd: runCwd, windowsHide: true },
              (error, stdout, stderr) => {
                resolvePromise({
                  stdout: String(stdout),
                  stderr: String(stderr),
                  exitCode:
                    error &&
                    typeof (error as { code?: unknown }).code === 'number'
                      ? ((error as { code: number }).code as number)
                      : error
                        ? 1
                        : 0,
                });
              },
            );
          });
        },
      });
      // Bypass detectWorkspace's bin lookup by faking a local binary.
      const binDir = join(cwd, 'node_modules', '.bin');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, 'veritas'), '#!/bin/sh\nexit 0\n');

      const snapshot = await service.getReadiness(cwd);
      expect(snapshot.cli.runId).toMatch(/^veritas-/);
      expect(snapshot.requirements.length).toBeGreaterThan(0);
      expect(snapshot.trustReport).not.toBeNull();
    }, 120_000);
  },
);
