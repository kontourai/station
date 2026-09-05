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
// `annotationMessage` is asserted directly as well as through the spawned
// script: the encoding boundary it owns is a property of the string, and a
// spawned run can only observe it through an excerpt long enough to truncate.
import { annotationMessage } from '../verification-gate-summary.mjs';
import {
  ORDINARY_SHARD_PHASE_ID,
  ORDINARY_SHARD_STDERR,
  ORDINARY_SHARD_STDOUT,
} from './fixtures/full-regression-shard-capture.mjs';

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

// The script reads the TEE'D STDOUT only -- `full-regression.stdout.log` is
// the right-hand side of `npm run full:regression | tee ...`, so stderr never
// reaches it. This fixture concatenates the two anyway, which is strictly
// harder than reality: it puts the tolerated warning lines directly in front
// of the parser, where the withdrawn fallback would have found them.
const passingLog = [passingStdout, passingStderr].join('\n');

const failingLog = [
  '> @kontourai/station-core@0.0.0 test:full:raw',
  ' FAIL  src-ui/src/features/actions/__tests__/ActionOperationsSection.reflow.test.tsx > reflows',
  'Error: useRegionModel must be used within RegionModelProvider',
  ' FAIL  src-ui/src/features/actions/__tests__/ActionOperationsHeader.test.tsx > renders',
  'AssertionError: expected header',
  'Tests 2 failed | 4211 passed',
].join('\n');

/** The terminal escape byte, spelled rather than embedded in source. */
const ESC = String.fromCharCode(27);

const INNOCENT_ECHOED_TEST_FILE = 'src-ui/src/__tests__/EchoesABanner.test.tsx';
/** Coloured exactly as vitest writes it on a runner. */
const ECHOED_FAIL_LINE = `${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m ${INNOCENT_ECHOED_TEST_FILE}${ESC}[2m > ${ESC}[22mechoes a captured banner`;

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

  test('names the failing test file for a shard whose FAIL block was on stderr (#1471)', () => {
    // The regression this closes: Nightly 33904147780 produced exactly one
    // annotation — "the completion gate reported failed with no causal
    // excerpt; read the full-regression artifact" — for a run whose failing
    // file was named in its own captured stderr. The two streams below are a
    // real phase capture, folded the way the completion collector folds a
    // phase's output into the parent's.
    const phase = `\n[completion:${ORDINARY_SHARD_PHASE_ID}]\n`;
    // An earlier PASSING phase region that echoes a FAIL banner of its own.
    // The parent capture folds every phase into one stream, so this region is
    // upstream of the failing one and a plain first-match reaches it first.
    const earlierPhase = '\n[completion:test-full-ordinary-1-of-8]\n';
    const root = workspace();
    const capture = join(root, 'full-regression.stdout.log');
    writeFileSync(
      capture,
      capturedStdout(
        failingLog,
        verdictDocument({
          stdout: `${earlierPhase}an earlier phase that passed${phase}${ORDINARY_SHARD_STDOUT}`,
          stderr: `${earlierPhase}${ECHOED_FAIL_LINE}${phase}${ORDINARY_SHARD_STDERR}`,
          status: 'failed',
          exitCode: 1,
          counts: {
            executed: 2959,
            passed: 2956,
            failed: 3,
            infrastructureErrors: 0,
          },
          passed: false,
        }),
      ),
    );

    const { status, stdout, summary } = runSummary(root, [
      '--stdout-file',
      capture,
    ]);

    expect(status).toBe(0);
    const annotations = errorAnnotations(stdout);
    expect(annotations).toHaveLength(1);
    expect(annotations[0].startsWith('::error title=full-regression::')).toBe(
      true,
    );
    // The failing FILE and the failing TEST NAME, which together are what let
    // a reader act without downloading the artifact.
    expect(annotations[0]).toContain(
      'scripts/__tests__/android-channel-release-generation.test.ts',
    );
    expect(annotations[0]).toContain(
      'uploads signed nightly artifacts before strict AAB signature verification',
    );
    // The earlier PASSING phase's banner is in the same folded stream and must
    // not be what the rail names.
    expect(annotations[0]).not.toContain(INNOCENT_ECHOED_TEST_FILE);
    expect(summary).not.toContain(INNOCENT_ECHOED_TEST_FILE);
    expect(summary).toContain('### Causal excerpts');
    expect(summary).toContain(
      'scripts/__tests__/android-channel-release-generation.test.ts',
    );
    // station#1471 review: the excerpt came off a stream carrying no step
    // marker for the failing step, and the rendering says so rather than
    // letting silence imply the stronger, scoped claim.
    expect(summary).toContain('Chosen from stderr, unscoped');
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

  // The report step declares `timeout-minutes: 2` and carries no
  // `continue-on-error`, so a slow reporter turns a GREEN gate's job red.
  // Unbounded, the balanced-object scan is quadratic on exactly this input --
  // every line-initial `{` scanning to the end of the text -- and a 1 MiB tail
  // took ~68 seconds. The deadline here is two orders of magnitude under the
  // step's own, so the assertion still discriminates on a loaded host.
  test('reports within seconds on a 1 MiB tail of unbalanced line-initial braces', () => {
    const root = workspace();
    const capture = join(root, 'full-regression.stdout.log');
    // 2 bytes per line, so ~524k candidate opens, none of which ever closes.
    writeFileSync(capture, '{\n'.repeat(512 * 1024));

    const startedAt = Date.now();
    const { status, stdout, summary } = runSummary(root, [
      '--stdout-file',
      capture,
    ]);
    const elapsedMs = Date.now() - startedAt;

    expect(status).toBe(0);
    // The unparseable path is the one taken: this asserts the scan gave up and
    // said so, not merely that it returned quickly.
    expect(summary).toContain('no JSON verdict document was found');
    expect(stdout).toContain('::warning title=full-regression::');
    expect(elapsedMs).toBeLessThan(5000);
  });

  // A gate that throws before printing a verdict writes to stderr and exits
  // non-zero (run-verification.mjs's own catch), so the tee'd stdout holds npm
  // banners and nothing else. `::warning` about parsing understates that.
  test('escalates to ::error when the gate step failed and left no verdict', () => {
    const root = workspace();
    const capture = join(root, 'full-regression.stdout.log');
    writeFileSync(
      capture,
      [
        '> @kontourai/station-core@0.0.0 full:regression',
        '> node scripts/run-verification.mjs request full-regression',
        'npm error code ELIFECYCLE',
      ].join('\n'),
    );

    const { status, stdout, summary } = runSummary(root, [
      '--stdout-file',
      capture,
      '--gate-outcome',
      'failure',
    ]);

    expect(status).toBe(0);
    const annotations = errorAnnotations(stdout);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toContain('"failure"');
    expect(annotations[0]).toContain('no verdict document');
    expect(annotations[0]).toContain('full-regression-*');
    // The tier moved; the reporter still never decides the verdict.
    expect(summary).toContain('unparseable');
  });

  // A stated verdict and the gate step's own outcome are two observations of
  // one run. The reachable disagreement is exit 0 beside `passed: false`
  // (run-verification.mjs prints false and exits 0 when the receipt's
  // `passed` is neither true nor false), which would otherwise render a red
  // summary on a job GitHub shows green with no annotation saying so.
  test('flags a verdict that disagrees with the gate outcome in either direction', () => {
    const root = workspace();
    const capture = join(root, 'full-regression.stdout.log');
    const counts = {
      executed: 4225,
      passed: 4213,
      failed: 0,
      infrastructureErrors: 0,
    };
    writeFileSync(
      capture,
      capturedStdout(
        passingStdout,
        verdictDocument({
          stdout: capturedStdout(passingStdout, ''),
          status: 'completed',
          exitCode: 0,
          counts,
          passed: false,
        }),
      ),
    );
    const disagree = runSummary(root, [
      '--stdout-file',
      capture,
      '--gate-outcome',
      'success',
    ]);
    expect(disagree.status).toBe(0);
    const flagged = errorAnnotations(disagree.stdout).filter((line) =>
      line.includes('disagree'),
    );
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toContain('"success"');
    expect(flagged[0]).toContain('passed=false');

    // The other direction: a failed step whose document claims a pass.
    writeFileSync(
      capture,
      capturedStdout(
        passingStdout,
        verdictDocument({
          stdout: capturedStdout(passingStdout, ''),
          status: 'completed',
          exitCode: 0,
          counts,
          passed: true,
        }),
      ),
    );
    const inverse = runSummary(root, [
      '--stdout-file',
      capture,
      '--gate-outcome',
      'failure',
    ]);
    expect(inverse.status).toBe(0);
    expect(
      errorAnnotations(inverse.stdout).filter((line) =>
        line.includes('disagree'),
      ),
    ).toHaveLength(1);

    // Agreement in both directions stays silent on this channel.
    const agree = runSummary(root, [
      '--stdout-file',
      capture,
      '--gate-outcome',
      'success',
    ]);
    expect(
      errorAnnotations(agree.stdout).filter((line) =>
        line.includes('disagree'),
      ),
    ).toEqual([]);
  });

  test('stays a ::warning for the same unparseable capture when the gate SUCCEEDED', () => {
    const root = workspace();
    const capture = join(root, 'full-regression.stdout.log');
    writeFileSync(
      capture,
      ['npm error code ELIFECYCLE', 'not json { at all', '}{'].join('\n'),
    );

    const { status, stdout } = runSummary(root, [
      '--stdout-file',
      capture,
      '--gate-outcome',
      'success',
    ]);

    expect(status).toBe(0);
    expect(errorAnnotations(stdout)).toEqual([]);
    expect(stdout).toContain('::warning title=full-regression::');
  });

  // A document whose every semantic field was dropped by its own byte cap is
  // parsable and truthy, and carries no verdict. Keying the annotation on the
  // document's ABSENCE left this case silent -- the exact silence #1459 exists
  // to remove.
  test('annotates a fully truncated document, which is present but states no verdict', () => {
    const root = workspace();
    const capture = join(root, 'full-regression.stdout.log');
    writeFileSync(
      capture,
      capturedStdout('', JSON.stringify({ truncated: true }, null, 2)),
    );

    const { status, stdout, summary } = runSummary(root, [
      '--stdout-file',
      capture,
    ]);

    expect(status).toBe(0);
    expect(stdout).toContain('::warning title=full-regression::');
    expect(stdout).toContain('stated no verdict');
    expect(summary).toContain('⚠️ verdict not stated in the captured document');
    expect(summary).toContain('truncated by its own byte cap');
  });

  // `renderBounded` falls back to the receipt's own fields when the result
  // carries no `summary` -- the shape a reused/joined disposition prints
  // (`boundedControlResult` in run-verification.mjs). `summary.terminal` is
  // then the terminal OBJECT rather than a status string.
  test('reads the terminal status from a receipt-shaped summary with no string terminal', () => {
    const root = workspace();
    const capture = join(root, 'full-regression.stdout.log');
    const counts = {
      executed: 4225,
      passed: 4225,
      failed: 0,
      infrastructureErrors: 0,
    };
    const document = renderBounded({
      disposition: 'reused',
      request: { key: requestKey, laneId: 'full-regression' },
      receipt: {
        terminal: { status: 'completed', exitCode: 0, passed: true },
        counts,
        cleanup,
        artifacts: [],
        request: { key: requestKey },
      },
    });
    // The precondition the branch exists for: no string terminal to read.
    expect(typeof JSON.parse(document).summary.terminal).toBe('object');
    writeFileSync(capture, capturedStdout('', document));

    const { status, stdout, summary } = runSummary(root, [
      '--stdout-file',
      capture,
    ]);

    expect(status).toBe(0);
    expect(errorAnnotations(stdout)).toEqual([]);
    expect(summary).toContain('✅ passed');
    expect(summary).toContain('Terminal status: `completed`');
    expect(summary).toContain('Disposition: `reused`');
  });

  // GitHub reads `%0A` as one newline; a cut landing inside it leaves a bare
  // `%` or `%0`, which is a malformed escape rather than the newline it
  // replaced. Truncating the plain text first is what makes that impossible.
  test('truncates an over-long excerpt before percent-encoding, never inside an escape', () => {
    const boundary = `${'a'.repeat(799)}\n${'b'.repeat(64)}`;

    const message = annotationMessage(boundary);

    expect(message.endsWith('…')).toBe(true);
    // Every `%` in the result introduces a complete two-digit escape.
    expect(message).not.toMatch(/%(?![0-9A-Fa-f]{2})/);
    expect(message).toContain('%0A');
    expect(message).not.toContain('b');
  });
});
