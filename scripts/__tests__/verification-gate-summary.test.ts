import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { summarizeVerificationOutput } from '../lib/verification-reporter.mjs';
// The fixtures below are rendered by the REAL producers this script consumes in
// CI, not by a hand-written idea of their shape: `summarizeVerificationOutput`
// builds the summary and `renderBounded` builds the envelope
// `run-verification.mjs` prints. A hand-written fixture would prove only that
// the script parses the fixture (#1715's fixture-vs-reality gap).
import { renderBounded } from '../run-verification.mjs';

const script = resolve(import.meta.dirname, '../verification-gate-summary.mjs');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'gate-summary-'));
  roots.push(root);
  return root;
}

const requestKey = 'd1f4c0a3'.repeat(8);
const cleanup = { status: 'passed', survivingOwnedChildren: 0 };

/** The envelope `run-verification.mjs` prints, produced by its own renderer. */
function verdictDocument({
  stdout,
  stderr = '',
  status,
  exitCode,
  counts,
  passed,
  extraSummary = {},
}: {
  stdout: string;
  stderr?: string;
  status: string;
  exitCode: number;
  counts: Record<string, number>;
  passed: boolean;
  extraSummary?: Record<string, unknown>;
}): string {
  const summary = summarizeVerificationOutput({
    stdout,
    stderr,
    terminal: { status, exitCode, truncated: false },
    counts,
    cleanup,
    maxBytes: 4096,
  });
  const rendered = renderBounded({
    disposition: 'executed',
    request: { key: requestKey, laneId: 'full-regression' },
    summary,
    receipt: {
      terminal: { status, exitCode, passed },
      counts,
      cleanup,
      artifacts: [],
      request: { key: requestKey },
    },
  });
  if (Object.keys(extraSummary).length === 0) return rendered;
  // `failedCheckTestFiles` and `failedCheckRedactedStdoutTail` are added by
  // `renderBounded` only when it can read the run's on-disk artifacts, which a
  // unit fixture has none of. They are merged in here with the exact shapes
  // that renderer writes so the rendering of those two sections is exercised.
  const document = JSON.parse(rendered);
  document.summary = { ...document.summary, ...extraSummary };
  return JSON.stringify(document, null, 2);
}

/** A capture shaped like the real step log: npm banners, output, then JSON. */
function capturedStdout(log: string, document: string): string {
  return [
    '> @kontourai/station-core@0.0.0 full:regression',
    '> node scripts/run-verification.mjs request full-regression',
    '',
    log,
    document,
    '',
  ].join('\n');
}

function runSummary(
  root: string,
  args: string[],
): { status: number | null; stdout: string; summary: string } {
  const summaryFile = join(root, 'step-summary.md');
  const result = spawnSync(
    process.execPath,
    [script, '--summary-file', summaryFile, ...args],
    { encoding: 'utf8', windowsHide: true },
  );
  let summary = '';
  try {
    summary = readFileSync(summaryFile, 'utf8');
  } catch {
    summary = '';
  }
  return { status: result.status, stdout: result.stdout ?? '', summary };
}

function errorAnnotations(stdout: string): string[] {
  return stdout.split('\n').filter((line) => line.startsWith('::error'));
}

const passingStdout = [
  '> @kontourai/station-core@0.0.0 lint:check',
  '> biome check .',
  '',
  '> @kontourai/station-core@0.0.0 test:full:raw',
  'Tests 4213 passed | 12 skipped',
].join('\n');

// `lint:check` tolerates warnings (it exits 0 with three of them today) and
// Biome writes diagnostics to STDERR, which carries no npm step headers. Every
// GREEN hosted run therefore ends with these lines eligible as a "cause": run
// 33886817593 passed and reported exactly this one.
const passingStderr = [
  'scripts/literal-swap-gate.mjs:58:11 lint/suspicious/noAssignInExpressions ━━━━━━━━━━',
  '  ! The assignment should not be in an expression.',
  'Checked 5565 files. Found 3 warnings.',
].join('\n');

// The runner interleaves both streams into one step log, which is what the
// summary script actually reads.
const passingLog = [passingStdout, passingStderr].join('\n');

const failingLog = [
  '> @kontourai/station-core@0.0.0 test:full:raw',
  ' FAIL  src-ui/src/features/actions/__tests__/ActionOperationsSection.reflow.test.tsx > reflows',
  'Error: useRegionModel must be used within RegionModelProvider',
  ' FAIL  src-ui/src/features/actions/__tests__/ActionOperationsHeader.test.tsx > renders',
  'AssertionError: expected header',
  'Tests 2 failed | 4211 passed',
].join('\n');

describe('verification gate summary', () => {
  test('writes a passing summary and emits no annotations for a green run', () => {
    const root = workspace();
    const capture = join(root, 'full-regression.stdout.log');
    writeFileSync(
      capture,
      capturedStdout(
        passingLog,
        verdictDocument({
          stdout: capturedStdout(passingStdout, ''),
          stderr: passingStderr,
          status: 'completed',
          exitCode: 0,
          counts: {
            executed: 4225,
            passed: 4213,
            failed: 0,
            infrastructureErrors: 0,
          },
          passed: true,
        }),
      ),
    );

    const { status, stdout, summary } = runSummary(root, [
      '--stdout-file',
      capture,
    ]);

    expect(status).toBe(0);
    expect(errorAnnotations(stdout)).toEqual([]);
    expect(summary).toContain('Hosted full regression');
    expect(summary).toContain('✅ passed');
    expect(summary).toContain('Terminal status: `completed`');
    expect(summary).toContain('| passed | 4213 |');
    expect(summary).toContain(requestKey);
    // The end-to-end half of the reporter fix: a run that passed reports no
    // cause at all, so the tolerated lint warning never reaches the summary.
    expect(summary).not.toContain('Causal excerpts');
    expect(summary).not.toContain('noAssignInExpressions');
  });

  test('emits one annotation per causal excerpt for a failing run and still exits 0', () => {
    const root = workspace();
    const capture = join(root, 'full-regression.stdout.log');
    writeFileSync(
      capture,
      capturedStdout(
        failingLog,
        verdictDocument({
          stdout: capturedStdout(failingLog, ''),
          status: 'failed',
          exitCode: 1,
          counts: {
            executed: 4213,
            passed: 4211,
            failed: 2,
            infrastructureErrors: 0,
          },
          passed: false,
          extraSummary: {
            failedCheckTestFiles: [
              'src-ui/src/features/actions/__tests__/ActionOperationsSection.reflow.test.tsx (1)',
              'src-ui/src/features/actions/__tests__/ActionOperationsHeader.test.tsx (1)',
            ],
            failedCheckRedactedStdoutTail: 'Tests 2 failed | 4211 passed',
          },
        }),
      ),
    );

    const { status, stdout, summary } = runSummary(root, [
      '--stdout-file',
      capture,
    ]);

    // The gate step's own exit status is the verdict; this reporter never
    // changes it in either direction.
    expect(status).toBe(0);
    const annotations = errorAnnotations(stdout);
    expect(annotations).toHaveLength(2);
    for (const annotation of annotations)
      expect(annotation.startsWith('::error title=full-regression::')).toBe(
        true,
      );
    expect(annotations[0]).toContain('ActionOperationsSection.reflow.test.tsx');
    expect(annotations[1]).toContain('ActionOperationsHeader.test.tsx');
    // One line each: an unescaped newline would end the workflow command and
    // leave the remainder to be read as further output.
    for (const annotation of annotations)
      expect(annotation).not.toContain('\r');
    expect(summary).toContain('❌ did not pass');
    expect(summary).toContain('### Causal excerpts');
    expect(summary).toContain('ActionOperationsSection.reflow.test.tsx');
    expect(summary).toContain('ActionOperationsHeader.test.tsx');
    expect(summary).toContain('### Failing test files');
    expect(summary).toContain('Redacted stdout tail');
  });

  test('states what it could not parse for garbage input rather than failing or staying silent', () => {
    const root = workspace();
    const capture = join(root, 'full-regression.stdout.log');
    writeFileSync(
      capture,
      ['npm error code ELIFECYCLE', 'not json { at all', '}{'].join('\n'),
    );

    const { status, stdout, summary } = runSummary(root, [
      '--stdout-file',
      capture,
    ]);

    expect(status).toBe(0);
    expect(errorAnnotations(stdout)).toEqual([]);
    expect(stdout).toContain('::warning title=full-regression::');
    expect(summary).toContain('unparseable');
    expect(summary).toContain('no JSON verdict document was found');
    // An unparseable capture must not be dressed up as a verdict.
    expect(summary).not.toContain('✅ passed');
    expect(summary).not.toContain('❌ did not pass');
  });

  test('states an absent capture instead of throwing, so an early job failure still reports', () => {
    const root = workspace();

    const { status, summary } = runSummary(root, [
      '--stdout-file',
      join(root, 'never-written.log'),
    ]);

    expect(status).toBe(0);
    expect(summary).toContain('unparseable');
    expect(summary).toContain('ENOENT');
  });

  test('reads the LAST JSON document, not an earlier one printed by a nested step', () => {
    const root = workspace();
    const capture = join(root, 'full-regression.stdout.log');
    const earlier = JSON.stringify(
      {
        disposition: 'status',
        summary: { terminal: 'completed', passed: true },
      },
      null,
      2,
    );
    writeFileSync(
      capture,
      [
        earlier,
        capturedStdout(
          failingLog,
          verdictDocument({
            stdout: capturedStdout(failingLog, ''),
            status: 'failed',
            exitCode: 1,
            counts: {
              executed: 4213,
              passed: 4211,
              failed: 2,
              infrastructureErrors: 0,
            },
            passed: false,
          }),
        ),
      ].join('\n'),
    );

    const { status, stdout, summary } = runSummary(root, [
      '--stdout-file',
      capture,
    ]);

    expect(status).toBe(0);
    expect(summary).toContain('❌ did not pass');
    expect(errorAnnotations(stdout)).toHaveLength(2);
  });
});
