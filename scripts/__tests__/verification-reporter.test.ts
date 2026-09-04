import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { captureOwnedProcessOutput } from '../lib/owned-process.mjs';
import { executionEquivalenceKey } from '../lib/verification-coordinator.mjs';
import {
  createVerificationReceipt,
  createVerificationRequest,
} from '../lib/verification-receipt.mjs';
import {
  captureBoundedOutput,
  gcVerificationArtifacts,
  isContainedPathSuffix,
  MAX_REDACTED_ATTACHMENT_BYTES,
  persistPlaywrightAttachments,
  persistVerificationOutput,
  projectVerificationArtifacts,
  readVerifiedVerificationArtifact,
  summarizeVerificationOutput,
  sweepVerificationArtifactOrphans,
  verifyVerificationArtifacts,
} from '../lib/verification-reporter.mjs';
import { FIXTURE_TOOLCHAIN_IDENTITY } from './fixtures/verification-toolchain.mjs';

function privateKeyMarker(position: 'BEGIN' | 'END', kind: string): string {
  return ['-----', position, ' ', kind, ' PRIVATE', ' KEY', '-----'].join('');
}

const roots: string[] = [];
const requestKey = 'a'.repeat(64);
const otherRequestKey = 'b'.repeat(64);
const thirdRequestKey = 'c'.repeat(64);
const measured = {
  counts: { executed: 3, passed: 2, failed: 1, infrastructureErrors: 0 },
  cleanup: { status: 'passed', survivingOwnedChildren: 0 },
};
function root() {
  const value = mkdtempSync(join(tmpdir(), 'station-reporter-'));
  roots.push(value);
  return value;
}
function outputDirectory(workspace: string, key: string) {
  const path = join(workspace, '.kontourai/verification-output', key);
  mkdirSync(path, { recursive: true });
  utimesSync(path, new Date(1), new Date(1));
  return path;
}
function claimedInactive() {
  return {
    activityResolver: () => 'inactive' as const,
    withMutationClaim: (_key: string, callback: () => void) => callback(),
  };
}

const gcProvenance = {
  repositoryId: 'f'.repeat(64),
  worktree: '/fixture',
  headSha: 'e'.repeat(40),
  workspaceDigest: 'd'.repeat(64),
  environmentDigest: 'c'.repeat(64),
  dependencyDigest: 'b'.repeat(64),
  nodeVersion: 'v24.18.0',
  toolchain: 'npm@fixture',
  toolchainIdentity: FIXTURE_TOOLCHAIN_IDENTITY,
  platform: 'darwin',
  arch: 'arm64',
};

function writeOldGcDirectory(
  workspace: string,
  directory: string,
  key: string,
) {
  const path = join(workspace, directory, key);
  mkdirSync(path, { recursive: true });
  utimesSync(path, new Date(1), new Date(1));
  return path;
}

function writeCommittedReceipt(workspace: string) {
  const request = createVerificationRequest('ci-fast', gcProvenance);
  const key = request.key;
  const receipt = createVerificationReceipt({
    request,
    status: 'completed',
    exitCode: 0,
    counts: { executed: 1, passed: 1, failed: 0, infrastructureErrors: 0 },
    cleanup: { status: 'passed', survivingOwnedChildren: 0 },
    before: gcProvenance,
    after: gcProvenance,
  });
  const path = join(
    workspace,
    '.kontourai/verification-receipts',
    `${key}.canonical.json`,
  );
  mkdirSync(join(path, '..'), { recursive: true });
  const contents = `${JSON.stringify(receipt, null, 2)}\n`;
  writeFileSync(path, contents);
  writeFileSync(
    `${path}.commit.json`,
    JSON.stringify({
      requestKey: key,
      receiptDigest: createHash('sha256').update(contents).digest('hex'),
      committed: true,
    }),
  );
  return key;
}
afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe('verification reporter', () => {
  test('rejects Windows parent traversal and absolute path suffixes', () => {
    const windowsPathShape = { isAbsolute: win32.isAbsolute, sep: win32.sep };
    expect(isContainedPathSuffix('child\\artifact.txt', windowsPathShape)).toBe(
      true,
    );
    expect(isContainedPathSuffix('..\\outside.txt', windowsPathShape)).toBe(
      false,
    );
    expect(isContainedPathSuffix('C:\\outside.txt', windowsPathShape)).toBe(
      false,
    );
  });

  test.each([
    ['success', 'Tests 3 passed'],
    ['assertion', 'AssertionError'],
    ['type-error', 'TypeError'],
    ['timeout', 'timed out'],
    ['empty-suite', 'No test files'],
    ['sigterm', 'SIGTERM'],
    ['parser-error', '{not-valid-json'],
    ['cleanup-failure', 'cleanup failed'],
  ])(
    'summarizes the %s fixture with its causal semantic retained when it fits',
    (name, semantic) => {
      const fixture = readFileSync(
        fileURLToPath(
          new URL(
            `./fixtures/verification-output/${name}.txt`,
            import.meta.url,
          ),
        ),
        'utf8',
      );
      const summary = summarizeVerificationOutput({
        stdout: fixture,
        terminal: { status: name },
        ...measured,
        maxBytes: 512,
      });
      expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(
        512,
      );
      expect(summary).toMatchObject({ terminal: name, ...measured });
      expect(JSON.stringify(summary)).toContain(semantic);
    },
  );

  test('prefers the vitest FAIL line naming the file over ambient stderr noise (station#2591)', () => {
    const summary = summarizeVerificationOutput({
      stdout: [
        '2026-08-13T22:08:25.218Z app:api Failed to fetch historical events: SyntaxError: Unexpected end of JSON input',
        ' FAIL  src-ui/src/__tests__/SomeSuite.test.tsx > renders',
        'AssertionError: expected truth',
        'Tests 1 failed | 3 passed',
      ].join('\n'),
      terminal: { status: 'failed' },
      counts: { executed: 4, passed: 3, failed: 1, infrastructureErrors: 0 },
      cleanup: { status: 'passed', survivingOwnedChildren: 0 },
      maxBytes: 1024,
    });
    expect(summary.firstCausalExcerpt).toContain(
      'FAIL  src-ui/src/__tests__/SomeSuite.test.tsx',
    );
    expect(summary.firstCausalExcerpt).not.toContain('historical events');
  });

  // The stdout below is a verbatim capture of `npx biome check` on a file with
  // one unused suppression (a warning, line 1) and one redeclaration (an error,
  // line 4). Biome puts severity on the marker line AFTER the header, so the
  // header alone is unrankable -- which is why this fixture keeps both lines
  // rather than asserting against a header shape invented here.
  test('ranks an error above a warning that appears above it (station#1871)', () => {
    const summary = summarizeVerificationOutput({
      stdout: [
        '> station@0.1.0 lint:check',
        '> biome check src-ui/',
        'src-ui/src/probe.ts:1:1 suppressions/unused \u2501\u2501\u2501\u2501\u2501',
        '  ! Suppression comment has no effect. Remove the suppression or make sure you are suppressing the correct rule.',
        'src-ui/src/probe.ts:4:17 lint/suspicious/noRedeclare \u2501\u2501\u2501\u2501\u2501',
        "  \u00d7 'probeDupe' is redeclared in the same scope.",
        'Found 1 error.',
        'Found 1 warning.',
      ].join('\n'),
      terminal: { status: 'failed' },
      counts: { executed: 1, passed: 0, failed: 1, infrastructureErrors: 0 },
      cleanup: { status: 'passed', survivingOwnedChildren: 0 },
      maxBytes: 2048,
    });
    expect(summary.firstCausalExcerpt).toContain('noRedeclare');
    expect(summary.firstCausalExcerpt).not.toContain('suppressions/unused');
  });

  // The fallback matters as much as the ranking: a capture with nothing but
  // warnings must still name one, or a lane fails with no cause at all.
  test('still reports a warning when the capture holds no error (station#1871)', () => {
    const summary = summarizeVerificationOutput({
      stdout: [
        '> station@0.1.0 lint:check',
        'src-ui/src/probe.ts:1:1 suppressions/unused \u2501\u2501\u2501\u2501\u2501',
        '  ! Suppression comment has no effect.',
        'Found 1 warning.',
      ].join('\n'),
      terminal: { status: 'failed' },
      counts: { executed: 1, passed: 0, failed: 1, infrastructureErrors: 0 },
      cleanup: { status: 'passed', survivingOwnedChildren: 0 },
      maxBytes: 2048,
    });
    expect(summary.firstCausalExcerpt).toContain('suppressions/unused');
  });

  // A truncated capture is a PREFIX: the child kept running and its later
  // output was dropped, so the last header present belongs to a step that
  // finished fine. Naming it accuses a passing step (review of station#1871).
  test('omits failingStep when the capture was truncated (station#1871)', () => {
    const summary = summarizeVerificationOutput({
      stdout: [
        '> station@0.1.0 build:connect',
        'built.',
        '> station@0.1.0 proof:sdk-builds',
      ].join('\n'),
      stderr: '',
      terminal: { status: 'infrastructure_error', truncated: true },
      counts: { executed: 1, passed: 0, failed: 0, infrastructureErrors: 1 },
      cleanup: { status: 'passed', survivingOwnedChildren: 0 },
      maxBytes: 2048,
    });
    // Absent, not null: the field is omitted entirely rather than carrying a
    // placeholder, so a reader never sees a key named for a failure.
    expect(summary.failingStep).toBeUndefined();
  });

  // `completed` with a non-zero exit is a real non-pass. Testing the status
  // alone stayed silent on exactly the run the field exists for.
  test('reports failingStep for a completed status carrying a non-zero exit (station#1871)', () => {
    const summary = summarizeVerificationOutput({
      stdout: [
        '> station@0.1.0 lint:check',
        'ok',
        '> station@0.1.0 typecheck:scripts',
        'tsc failed',
      ].join('\n'),
      stderr: '',
      terminal: { status: 'completed', exitCode: 2 },
      counts: { executed: 1, passed: 0, failed: 1, infrastructureErrors: 0 },
      cleanup: { status: 'passed', survivingOwnedChildren: 0 },
      maxBytes: 2048,
    });
    expect(summary.failingStep).toBe('typecheck:scripts');
  });

  // The release lane reported `failingStep: test:full:ordinary:raw` and a
  // `[vitest-corpus] ordinary: FAIL` tally for eight consecutive tagged
  // releases whose real terminal status was `timed_out`. Nothing had failed;
  // a 45-minute phase deadline had expired, which is why no failing test name
  // appeared anywhere in the receipt. These two statuses had no coverage at
  // all, which is how the misattribution survived.
  test.each(['timed_out', 'canceled'])(
    'names the in-flight step without calling it failing when the status is %s',
    (status) => {
      const summary = summarizeVerificationOutput({
        stdout: [
          '> station@0.1.0 verify:static:raw',
          'ok',
          '> station@0.1.0 test:full:ordinary:raw',
          'partial transcript',
        ].join('\n'),
        stderr: '',
        terminal: { status, exitCode: null },
        counts: { executed: 1, passed: 0, failed: 0, infrastructureErrors: 0 },
        cleanup: { status: 'passed', survivingOwnedChildren: 0 },
        maxBytes: 2048,
      });
      expect(summary.inFlightStep).toBe('test:full:ordinary:raw');
      expect(summary.failingStep).toBeUndefined();
      expect(summary.terminal).toBe(status);
    },
  );

  test('keeps the in-flight step out of a truncated capture, as failingStep already does', () => {
    const summary = summarizeVerificationOutput({
      stdout: [
        '> station@0.1.0 verify:static:raw',
        'ok',
        '> station@0.1.0 test:full:ordinary:raw',
      ].join('\n'),
      stderr: '',
      terminal: { status: 'timed_out', exitCode: null, truncated: true },
      counts: { executed: 1, passed: 0, failed: 0, infrastructureErrors: 0 },
      cleanup: { status: 'passed', survivingOwnedChildren: 0 },
      maxBytes: 2048,
    });
    expect(summary.inFlightStep).toBeUndefined();
    expect(summary.failingStep).toBeUndefined();
  });

  test('a completed status with a non-zero exit stays a failure, not an in-flight step', () => {
    const summary = summarizeVerificationOutput({
      stdout: ['> station@0.1.0 typecheck:scripts', 'tsc failed'].join('\n'),
      stderr: '',
      terminal: { status: 'completed', exitCode: 2 },
      counts: { executed: 1, passed: 0, failed: 1, infrastructureErrors: 0 },
      cleanup: { status: 'passed', survivingOwnedChildren: 0 },
      maxBytes: 2048,
    });
    expect(summary.failingStep).toBe('typecheck:scripts');
    expect(summary.inFlightStep).toBeUndefined();
  });

  // Found by this batch's own gate. Biome's format diagnostics have no
  // line:col -- the header is `<path> format ━━━` -- so the matcher did not
  // recognise them, and a run whose only ERROR was a formatting error reported
  // a noUselessFragments WARNING from an untouched file as the cause.
  test('ranks a biome format error above a preceding warning (station#1871)', () => {
    const summary = summarizeVerificationOutput({
      stdout: '> station@0.1.0 lint:check',
      stderr: [
        'src-ui/src/__tests__/homeVariantRoster.test.tsx:60:5 suppressions/unused \u2501\u2501\u2501',
        '  ! Suppression comment has no effect.',
        'scripts/lib/verification-reporter.mjs format \u2501\u2501\u2501',
        '  \u00d7 Formatter would have printed the following content:',
        'Found 1 error.',
      ].join('\n'),
      terminal: { status: 'failed', exitCode: 1 },
      counts: { executed: 1, passed: 0, failed: 1, infrastructureErrors: 0 },
      cleanup: { status: 'passed', survivingOwnedChildren: 0 },
      maxBytes: 2048,
    });
    expect(summary.firstCausalExcerpt).toContain('format');
    expect(summary.firstCausalExcerpt).not.toContain('suppressions/unused');
  });

  // The half of station#1871 that survived two earlier fixes. npm writes its
  // step headers to STDOUT only (verified against npm 11.17 with the streams
  // captured to separate files), so concatenating stdout and stderr and then
  // scoping by an npm header scoped nothing: every step's stderr stayed
  // eligible. Here an ambient TypeError logged by a PASSING step outranked the
  // real failure from a later step, while failingStep correctly named the
  // later step -- two fields contradicting each other.
  test("does not report a passing step's stderr noise as the cause (station#1871)", () => {
    const summary = summarizeVerificationOutput({
      stdout: [
        '> station@0.1.0 test:full:raw',
        'Tests 4210 passed',
        '> station@0.1.0 proof:app-builds',
      ].join('\n'),
      stderr: [
        'TypeError: Cannot read properties of undefined (reading "socket")',
        'Error: ui bundle entry exceeded its ceiling: 257104 > 256983',
      ].join('\n'),
      terminal: { status: 'failed', exitCode: 1 },
      counts: { executed: 1, passed: 0, failed: 1, infrastructureErrors: 0 },
      cleanup: { status: 'passed', survivingOwnedChildren: 0 },
      maxBytes: 2048,
    });
    expect(summary.failingStep).toBe('proof:app-builds');
    expect(summary.firstCausalExcerpt).toContain('ui bundle entry exceeded');
    expect(summary.firstCausalExcerpt).not.toContain('TypeError');
    // stderr carries no step markers, so this excerpt was RANKED, not
    // attributed. Saying so is the honest half of the fix.
    expect(summary.causeStream).toBe('stderr');
  });

  // Absence of causeStream is itself a claim -- the stronger one. It must only
  // be absent when the excerpt really was scoped to the failing step.
  test('omits causeStream when the cause came from the scoped stdout (station#1871)', () => {
    const summary = summarizeVerificationOutput({
      stdout: [
        '> station@0.1.0 lint:check',
        'ok',
        '> station@0.1.0 test:full:raw',
        ' FAIL  src-ui/src/__tests__/Some.test.tsx > renders',
      ].join('\n'),
      stderr: 'Error: noise from an earlier step',
      terminal: { status: 'failed', exitCode: 1 },
      counts: { executed: 1, passed: 0, failed: 1, infrastructureErrors: 0 },
      cleanup: { status: 'passed', survivingOwnedChildren: 0 },
      maxBytes: 2048,
    });
    expect(summary.firstCausalExcerpt).toContain('Some.test.tsx');
    expect(summary.causeStream).toBeUndefined();
  });

  // causeStream is an enum. Truncated to 's' it is a value outside its own
  // vocabulary, and it was being truncated exactly that way while it sat among
  // the prose-truncating semantic classes.
  test('never emits a partial causeStream under a tight byte cap (station#1871)', () => {
    for (const maxBytes of [160, 200, 280, 400]) {
      const summary = summarizeVerificationOutput({
        stdout: '> station@0.1.0 lint:check',
        stderr: `Error: ${'x'.repeat(300)}`,
        terminal: { status: 'failed', exitCode: 1 },
        counts: { executed: 1, passed: 0, failed: 1, infrastructureErrors: 0 },
        cleanup: { status: 'passed', survivingOwnedChildren: 0 },
        maxBytes,
      });
      if (summary.causeStream !== undefined)
        expect(summary.causeStream).toBe('stderr');
    }
  });

  test('keeps mandatory truth and a UTF-8-safe first cause at a small cap', () => {
    const summary = summarizeVerificationOutput({
      stdout: 'AssertionError: café 😀 fixture cause\nTests 1 failed',
      terminal: { status: 'failed' },
      counts: { executed: 1, passed: 0, failed: 1, infrastructureErrors: 0 },
      cleanup: { status: 'passed', survivingOwnedChildren: 0 },
      maxBytes: 256,
    });
    expect(summary).toMatchObject({
      terminal: 'failed',
      firstCausalExcerpt: expect.stringContaining('AssertionError'),
    });
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(256);
  });

  test('keeps the longest causal prefix that fits the complete cap-149 summary', () => {
    const summary = summarizeVerificationOutput({
      stdout: `AssertionError: ${'cause '.repeat(100)}`,
      terminal: { status: 'failed' },
      counts: { executed: 1, passed: 0, failed: 1, infrastructureErrors: 0 },
      cleanup: { status: 'passed' },
      maxBytes: 149,
    });
    expect(summary.firstCausalExcerpt).toBeTruthy();
    expect(summary.firstCausalExcerpt).not.toBe('AssertionError: cause ');
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(149);
  });

  test('reserves tally and slow context before allocating a huge cap-149 cause', () => {
    const summary = summarizeVerificationOutput({
      stdout: `AssertionError: ${'x'.repeat(500)}\nTests 1 failed\nslow item 9.8s`,
      terminal: { status: 'failed' },
      counts: {},
      cleanup: {},
      maxBytes: 149,
    });
    expect(summary.firstCausalExcerpt).toContain('AssertionError:');
    expect(summary.finalTally).toBe('Tests 1 failed');
    expect(summary.slowItems?.[0]).toBe('slow item 9.8s');
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(149);
  });

  test('adds slow items in duration priority after cause and tally', () => {
    const summary = summarizeVerificationOutput({
      stdout:
        'AssertionError: first cause\nTests 1 failed\nslow quick 1.2s\nslow slowest 9.8s',
      terminal: { status: 'failed' },
      ...measured,
      maxBytes: 512,
    });
    expect(summary).toMatchObject({
      firstCausalExcerpt: 'AssertionError: first cause',
      finalTally: 'Tests 1 failed',
    });
    expect(summary.slowItems?.[0]).toContain('slowest 9.8s');
  });

  test('does not mistake a passing failure-path test title for the causal error', () => {
    const summary = summarizeVerificationOutput({
      stdout: [
        '[25/257] [chromium] › tests/agents.spec.ts:757:3 › Agents › lifecycle covers failed save',
        'Error: expect(locator).toBeVisible() failed',
        'Tests 1 failed',
      ].join('\n'),
      terminal: { status: 'failed' },
      ...measured,
      maxBytes: 512,
    });

    expect(summary.firstCausalExcerpt).toBe(
      'Error: expect(locator).toBeVisible() failed',
    );
  });

  test('prefers the measured failure section over an expected earlier error log', () => {
    const summary = summarizeVerificationOutput({
      stderr: [
        'stderr | expected rollback path',
        'Error: write failed',
        'Failed Tests 1',
        'FAIL src/example.test.ts > times out under contention',
        'Error: Test timed out in 5000ms.',
      ].join('\n'),
      terminal: { status: 'failed' },
      counts: { failed: 1 },
      cleanup: { status: 'not_required', survivingOwnedChildren: 0 },
    });
    expect(summary.firstCausalExcerpt).toBe(
      'FAIL src/example.test.ts > times out under contention',
    );
  });

  test('does not mistake Error text in a Playwright title for the cause', () => {
    const summary = summarizeVerificationOutput({
      stdout: [
        '[1/1] [chromium] › tests/example.spec.ts:1:1 › Error: boundary renders',
        'example.ts(4,7): error TS2322: Type string is not assignable',
        'Tests 1 failed',
      ].join('\n'),
      terminal: { status: 'failed' },
      ...measured,
      maxBytes: 512,
    });

    expect(summary.firstCausalExcerpt).toBe(
      'example.ts(4,7): error TS2322: Type string is not assignable',
    );
  });

  test('retains a Biome rule header as the causal diagnostic', () => {
    const diagnostic =
      'src-ui/src/example.tsx:64:9 lint/a11y/useSemanticElements ━━━━━━━━━━';
    const summary = summarizeVerificationOutput({
      stdout: `${diagnostic}\nChecked 1 file. Found 1 error.`,
      terminal: { status: 'failed' },
      ...measured,
      maxBytes: 512,
    });

    expect(summary.firstCausalExcerpt).toBe(diagnostic);
  });

  // station#3189: a real full:regression run's `verify-static` phase is one
  // captured process running the whole `npm run a && npm run b && ...` chain
  // (verify:static:raw, then typecheck's own sub-chain). lint:check passed
  // but printed a warning-shaped Biome line; several steps later
  // typecheck:scripts actually failed. The old unscoped scan reported the
  // passing step's warning as the "cause" and cost a real diagnosis session
  // about an hour on the wrong file.
  const CHAINED_GATE_FIXTURE = [
    '> @kontourai/station-core@0.0.0 verify:static:raw',
    '> npm run verify:static:bootstrap && npm run lint:check && npm run typecheck',
    '',
    '> @kontourai/station-core@0.0.0 lint:check',
    '> biome check src-server/ src-ui/ packages/ scripts/ tests/ examples/ src-shared/',
    '',
    'src-ui/src/__tests__/homeVariantRegistry.test.tsx:41:9 suppressions/unused ━━━━━━━━━━',
    'Checked 1913 files. Found 374 warnings.',
    '',
    '> @kontourai/station-core@0.0.0 typecheck',
    '> npm run dist:freshness && npm run typecheck:server && npm run typecheck:server-tests && npm run typecheck:scripts',
    '',
    '> @kontourai/station-core@0.0.0 dist:freshness',
    '> node scripts/check-dist-freshness.mjs',
    '',
    '> @kontourai/station-core@0.0.0 typecheck:server',
    '> tsc --noEmit',
    '',
    '> @kontourai/station-core@0.0.0 typecheck:server-tests',
    '> tsc -p tsconfig.tests.json --noEmit',
    '',
    '> @kontourai/station-core@0.0.0 typecheck:scripts',
    '> node scripts/scripts-typecheck-coverage.mjs',
    '',
    "scripts/__tests__/backlog-priority-policy.test.ts(92,9): error TS2322: Type '{ maxActionableP1: number; }' is not assignable to type 'Readonly<{ maxActionableP1: null; }>'.",
  ].join('\n');

  test('reports the excerpt from the step that actually failed, not an earlier passing step (station#3189)', () => {
    const summary = summarizeVerificationOutput({
      stdout: CHAINED_GATE_FIXTURE,
      terminal: { status: 'failed' },
      ...measured,
      maxBytes: 2048,
    });
    expect(summary.firstCausalExcerpt).toBe(
      "scripts/__tests__/backlog-priority-policy.test.ts(92,9): error TS2322: Type '{ maxActionableP1: number; }' is not assignable to type 'Readonly<{ maxActionableP1: null; }>'.",
    );
    expect(summary.firstCausalExcerpt).not.toContain('suppressions/unused');
    expect(summary.failingStep).toBe('typecheck:scripts');
  });

  test('omits the excerpt when the failing step has no parseable diagnostic, rather than reporting an earlier passing step (station#3189)', () => {
    const summary = summarizeVerificationOutput({
      stdout: [
        '> @kontourai/station-core@0.0.0 lint:check',
        '> biome check src-server/',
        '',
        'src-ui/src/__tests__/homeVariantRegistry.test.tsx:41:9 suppressions/unused ━━━━━━━━━━',
        'Checked 1913 files. Found 374 warnings.',
        '',
        '> @kontourai/station-core@0.0.0 proof:app-builds',
        '> node scripts/proof-app-builds.mjs',
        '',
        'the build step ended without producing an artifact',
        'see the build log for detail',
      ].join('\n'),
      terminal: { status: 'infrastructure_error' },
      ...measured,
      maxBytes: 2048,
    });
    expect(summary.firstCausalExcerpt).toBeUndefined();
    expect(JSON.stringify(summary)).not.toContain('suppressions/unused');
    expect(summary.failingStep).toBe('proof:app-builds');
  });

  // #1459. The capture below is the shape a GREEN hosted full-regression run
  // actually produces. This repo's `lint:check` tolerates warnings (it exits 0
  // with three of them today), and Biome writes its diagnostics to STDERR,
  // which carries no npm step headers and so is never scoped to a failing
  // step. The warnings-only fallback -- which exists so a FAILED warnings-only
  // capture still names a cause -- therefore reached them on runs that had no
  // cause at all: run 33886817593 passed and reported
  // `literal-swap-gate.mjs:58:11 lint/suspicious/noAssignInExpressions` as its
  // `firstCausalExcerpt`.
  test('reports no causal excerpt for a run that PASSED with tolerated lint warnings (#1459)', () => {
    const summary = summarizeVerificationOutput({
      stdout: [
        '> @kontourai/station-core@0.0.0 full:regression',
        '> npm run proof:repo-governance && npm run test:full:raw',
        '',
        '> @kontourai/station-core@0.0.0 lint:check',
        '> biome check .',
        '',
        '> @kontourai/station-core@0.0.0 test:full:raw',
        '> node scripts/run-vitest-corpus.mjs',
        '',
        'Tests 4213 passed | 12 skipped',
      ].join('\n'),
      stderr: [
        'scripts/literal-swap-gate.mjs:58:11 lint/suspicious/noAssignInExpressions ━━━━━━━━━━',
        '  ! The assignment should not be in an expression.',
        'Checked 5565 files. Found 3 warnings.',
      ].join('\n'),
      terminal: { status: 'completed', exitCode: 0, truncated: false },
      counts: {
        executed: 4225,
        passed: 4213,
        failed: 0,
        infrastructureErrors: 0,
      },
      cleanup: { status: 'passed', survivingOwnedChildren: 0 },
      maxBytes: 4096,
    });
    expect(summary.firstCausalExcerpt).toBeUndefined();
    expect(summary.causalExcerpts).toBeUndefined();
    expect(JSON.stringify(summary)).not.toContain('noAssignInExpressions');
    // The rest of the summary is untouched: this withdraws the cause, not the
    // measured record around it.
    expect(summary.finalTally).toContain('Tests 4213 passed');
  });

  // The withdrawal above is scoped to the WARNING tier and to a pass. An
  // error-tier diagnostic on a run that claims success is a contradiction a
  // reader needs to see, not noise to suppress.
  test('still reports an error-tier diagnostic present on a run that claims success (#1459)', () => {
    const summary = summarizeVerificationOutput({
      stdout: [
        '> @kontourai/station-core@0.0.0 typecheck:scripts',
        '> tsc -p tsconfig.scripts.json --noEmit',
        '',
        "scripts/probe.ts(9,3): error TS2322: Type 'string' is not assignable to type 'number'.",
      ].join('\n'),
      terminal: { status: 'completed', exitCode: 0, truncated: false },
      ...measured,
      maxBytes: 2048,
    });
    expect(summary.firstCausalExcerpt).toContain('error TS2322');
  });

  // The failed-run fallback is exactly what #1459 must not have disturbed:
  // the SAME capture -- byte-identical to the passing case above -- still
  // names its warning when the run failed. Only the terminal differs.
  test('keeps the warnings-only fallback for a run that FAILED (#1459 changes nothing here)', () => {
    const failed = summarizeVerificationOutput({
      stdout: [
        '> @kontourai/station-core@0.0.0 lint:check',
        '> biome check .',
      ].join('\n'),
      stderr: [
        'scripts/literal-swap-gate.mjs:58:11 lint/suspicious/noAssignInExpressions ━━━━━━━━━━',
        '  ! The assignment should not be in an expression.',
        'Checked 5565 files. Found 3 warnings.',
      ].join('\n'),
      terminal: { status: 'failed', exitCode: 1, truncated: false },
      counts: { executed: 1, passed: 0, failed: 1, infrastructureErrors: 0 },
      cleanup: { status: 'passed', survivingOwnedChildren: 0 },
      maxBytes: 2048,
    });
    expect(failed.firstCausalExcerpt).toContain('noAssignInExpressions');
    expect(failed.causalExcerpts).toEqual([failed.firstCausalExcerpt]);
  });

  // station#4249: `causalExcerpts` is the plural companion that lets a run
  // report every distinct failure it actually observed, not only the first.
  describe('causalExcerpts (station#4249)', () => {
    test('reports every distinct failing vitest FILE, not only the first', () => {
      const summary = summarizeVerificationOutput({
        stdout: [
          '> station@0.1.0 test:full:raw',
          ' FAIL  src-ui/src/__tests__/One.test.tsx > renders',
          'AssertionError: one',
          ' FAIL  src-ui/src/__tests__/Two.test.tsx > loads',
          'AssertionError: two',
          ' FAIL  src-ui/src/__tests__/Three.test.tsx > saves',
          'AssertionError: three',
          'Tests 3 failed | 10 passed',
        ].join('\n'),
        terminal: { status: 'failed', exitCode: 1 },
        ...measured,
        maxBytes: 2048,
      });
      expect(summary.causalExcerpts).toEqual([
        ' FAIL  src-ui/src/__tests__/One.test.tsx > renders',
        ' FAIL  src-ui/src/__tests__/Two.test.tsx > loads',
        ' FAIL  src-ui/src/__tests__/Three.test.tsx > saves',
      ]);
      // The head element is byte-identical to firstCausalExcerpt -- the same
      // excerpt described two ways, never two different values.
      expect(summary.causalExcerpts?.[0]).toBe(summary.firstCausalExcerpt);
    });

    test('a single failure keeps firstCausalExcerpt byte-identical to today and causalExcerpts as its singleton', () => {
      const stdout = [
        '2026-08-13T22:08:25.218Z app:api Failed to fetch historical events: SyntaxError: Unexpected end of JSON input',
        ' FAIL  src-ui/src/__tests__/SomeSuite.test.tsx > renders',
        'AssertionError: expected truth',
        'Tests 1 failed | 3 passed',
      ].join('\n');
      const summary = summarizeVerificationOutput({
        stdout,
        terminal: { status: 'failed' },
        counts: { executed: 4, passed: 3, failed: 1, infrastructureErrors: 0 },
        cleanup: { status: 'passed', survivingOwnedChildren: 0 },
        maxBytes: 1024,
      });
      // Exactly today's existing, already-tested behaviour -- unchanged.
      expect(summary.firstCausalExcerpt).toContain(
        'FAIL  src-ui/src/__tests__/SomeSuite.test.tsx',
      );
      expect(summary.firstCausalExcerpt).not.toContain('historical events');
      // The additive part: a single observed failure is a singleton list.
      expect(summary.causalExcerpts).toEqual([summary.firstCausalExcerpt]);
    });

    test('reports every ERROR-tier biome diagnostic, excluding warnings, when at least one error exists', () => {
      const summary = summarizeVerificationOutput({
        stdout: [
          '> station@0.1.0 lint:check',
          '> biome check src-ui/',
          'src-ui/src/probe.ts:1:1 suppressions/unused ━━━━━',
          '  ! Suppression comment has no effect.',
          'src-ui/src/probe.ts:4:17 lint/suspicious/noRedeclare ━━━━━',
          "  × 'probeDupe' is redeclared in the same scope.",
          'src-ui/src/other.ts:9:3 lint/suspicious/noDoubleEquals ━━━━━',
          '  × Use === instead of ==.',
          'Found 2 errors.',
          'Found 1 warning.',
        ].join('\n'),
        terminal: { status: 'failed' },
        counts: { executed: 1, passed: 0, failed: 1, infrastructureErrors: 0 },
        cleanup: { status: 'passed', survivingOwnedChildren: 0 },
        maxBytes: 4096,
      });
      expect(summary.causalExcerpts).toEqual([
        'src-ui/src/probe.ts:4:17 lint/suspicious/noRedeclare ━━━━━',
        'src-ui/src/other.ts:9:3 lint/suspicious/noDoubleEquals ━━━━━',
      ]);
      expect(JSON.stringify(summary.causalExcerpts)).not.toContain(
        'suppressions/unused',
      );
    });

    test('falls back to every warning when the capture holds no error, same fallback firstCausalExcerpt uses', () => {
      const summary = summarizeVerificationOutput({
        stdout: [
          '> station@0.1.0 lint:check',
          'src-ui/src/probe.ts:1:1 suppressions/unused ━━━━━',
          '  ! Suppression comment has no effect.',
          'src-ui/src/other.ts:2:1 suppressions/unused ━━━━━',
          '  ! Another suppression with no effect.',
          'Found 2 warnings.',
        ].join('\n'),
        terminal: { status: 'failed' },
        counts: { executed: 1, passed: 0, failed: 1, infrastructureErrors: 0 },
        cleanup: { status: 'passed', survivingOwnedChildren: 0 },
        maxBytes: 4096,
      });
      expect(summary.causalExcerpts).toEqual([
        'src-ui/src/probe.ts:1:1 suppressions/unused ━━━━━',
        'src-ui/src/other.ts:2:1 suppressions/unused ━━━━━',
      ]);
    });

    // Honesty requirement: a check behind a short-circuited step never ran, so
    // it must never appear as a "failure" here. The fixture below is a
    // fail-fast `&&` chain that died in typecheck:server-tests -- everything
    // after it (typecheck:scripts, :cli, ...) genuinely never executed, and
    // this asserts causalExcerpts contains ONLY the excerpt from the step that
    // actually ran and failed, never a fabricated entry for a later step.
    test('never fabricates an excerpt for a check that never executed because an earlier step short-circuited', () => {
      const summary = summarizeVerificationOutput({
        stdout: [
          '> @kontourai/station-core@0.0.0 typecheck',
          '> npm run typecheck:server && npm run typecheck:server-tests && npm run typecheck:scripts',
          '',
          '> @kontourai/station-core@0.0.0 typecheck:server',
          '> tsc --noEmit',
          '',
          '> @kontourai/station-core@0.0.0 typecheck:server-tests',
          '> tsc -p tsconfig.tests.json --noEmit',
          '',
          "scripts/probe.test.ts(9,3): error TS2322: Type 'string' is not assignable to type 'number'.",
        ].join('\n'),
        terminal: { status: 'failed', exitCode: 2 },
        ...measured,
        maxBytes: 2048,
      });
      expect(summary.failingStep).toBe('typecheck:server-tests');
      expect(summary.causalExcerpts).toEqual([
        "scripts/probe.test.ts(9,3): error TS2322: Type 'string' is not assignable to type 'number'.",
      ]);
      // typecheck:scripts never ran; nothing in the output could name it as a
      // failure, and nothing does.
      expect(JSON.stringify(summary.causalExcerpts)).not.toContain(
        'typecheck:scripts',
      );
    });

    // The shape a completion-mode aggregate runner (station#4249 slice 2)
    // produces: one `FAIL <lane>` marker per failing sub-lane, all present in
    // the SAME captured output because every lane ran to completion. This is
    // the scenario the whole field exists for -- a single execution whose
    // output genuinely names multiple independent failing checks.
    test('reports one excerpt per failing lane from a completion-mode aggregate runner', () => {
      const summary = summarizeVerificationOutput({
        stdout: [
          '> station@0.1.0 typecheck',
          '> node scripts/typecheck-aggregate.mjs',
          '=== typecheck:server ===',
          'OK',
          '=== typecheck:server-tests ===',
          'OK',
          '=== typecheck:ui ===',
          "src-ui/src/App.tsx(12,3): error TS2322: Type 'string' is not assignable to type 'number'.",
          '=== typecheck:scripts ===',
          'OK',
          '=== typecheck:cli ===',
          "packages/cli/src/index.ts(4,7): error TS2345: Argument of type 'number' is not assignable.",
          'FAIL typecheck:ui: src-ui/src/App.tsx(12,3): error TS2322',
          'FAIL typecheck:cli: packages/cli/src/index.ts(4,7): error TS2345',
          '2 of 12 lanes failed.',
        ].join('\n'),
        terminal: { status: 'failed', exitCode: 1 },
        ...measured,
        maxBytes: 4096,
      });
      expect(summary.causalExcerpts).toEqual([
        'FAIL typecheck:ui: src-ui/src/App.tsx(12,3): error TS2322',
        'FAIL typecheck:cli: packages/cli/src/index.ts(4,7): error TS2345',
      ]);
      expect(summary.firstCausalExcerpt).toBe(summary.causalExcerpts?.[0]);
    });

    test('deduplicates an identical excerpt observed twice', () => {
      const summary = summarizeVerificationOutput({
        stdout: [
          '> station@0.1.0 test:full:raw',
          ' FAIL  src-ui/src/__tests__/Flaky.test.tsx > renders',
          'AssertionError: one',
          ' FAIL  src-ui/src/__tests__/Flaky.test.tsx > renders',
          'AssertionError: one',
        ].join('\n'),
        terminal: { status: 'failed', exitCode: 1 },
        ...measured,
        maxBytes: 2048,
      });
      expect(summary.causalExcerpts).toEqual([
        ' FAIL  src-ui/src/__tests__/Flaky.test.tsx > renders',
      ]);
    });

    test('never emits causalExcerpts without firstCausalExcerpt, and never crosses the byte cap', () => {
      const stdout = [
        '> station@0.1.0 test:full:raw',
        ...Array.from(
          { length: 20 },
          (_, i) => ` FAIL  src/file-${i}.test.ts > case`,
        ),
      ].join('\n');
      for (const maxBytes of [160, 200, 400, 4096]) {
        const summary = summarizeVerificationOutput({
          stdout,
          terminal: { status: 'failed', exitCode: 1 },
          ...measured,
          maxBytes,
        });
        expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(
          maxBytes,
        );
        if (summary.causalExcerpts) {
          expect(summary.firstCausalExcerpt).toBeTruthy();
          expect(summary.causalExcerpts[0]).toBe(summary.firstCausalExcerpt);
        }
      }
    });

    test('omits causalExcerpts entirely when there is no causal excerpt at all (a clean pass)', () => {
      const summary = summarizeVerificationOutput({
        stdout: 'Tests 3 passed',
        terminal: { status: 'completed', exitCode: 0 },
        counts: { executed: 3, passed: 3, failed: 0, infrastructureErrors: 0 },
        cleanup: { status: 'passed', survivingOwnedChildren: 0 },
        maxBytes: 512,
      });
      expect(summary.firstCausalExcerpt).toBeUndefined();
      expect(summary.causalExcerpts).toBeUndefined();
    });
  });

  test('never reports failingStep on a passing (completed) terminal status, even when a step boundary is present', () => {
    const summary = summarizeVerificationOutput({
      stdout: [
        '> @kontourai/station-core@0.0.0 typecheck',
        '> tsc --noEmit',
        '',
        'Tests 3 passed',
      ].join('\n'),
      terminal: { status: 'completed' },
      ...measured,
      maxBytes: 2048,
    });
    expect(summary.failingStep).toBeUndefined();
  });

  test('leaves failingStep absent for a single, unchained command (no npm step boundary)', () => {
    const summary = summarizeVerificationOutput({
      stdout: 'AssertionError: expected truth\nTests 1 failed',
      terminal: { status: 'failed' },
      ...measured,
      maxBytes: 512,
    });
    expect(summary.failingStep).toBeUndefined();
  });

  test('fails only when the mandatory terminal truth cannot fit', () => {
    expect(() =>
      summarizeVerificationOutput({
        terminal: { status: 'x'.repeat(512) },
        ...measured,
        maxBytes: 64,
      }),
    ).toThrow('terminal truth');
    expect(() =>
      summarizeVerificationOutput({ terminal: { status: 'completed' } }),
    ).toThrow('measured counts');
  });

  test('persists redacted digest-addressed stdout and stderr privately', () => {
    const workspace = root();
    const nested = JSON.stringify(
      JSON.stringify({ password: 'persisted-secret', safe: 'keep' }),
    );
    const result = persistVerificationOutput({
      root: workspace,
      requestKey,
      stdout: `ok token=secret-value ${nested}`,
      stderr: `TypeError: boom ${nested}`,
    });
    expect(result.artifacts).toHaveLength(2);
    for (const artifact of result.artifacts) {
      const contents = readFileSync(join(workspace, artifact.path), 'utf8');
      expect(contents).not.toContain('secret-value');
      expect(contents).not.toContain('persisted-secret');
      expect(contents).toContain('keep');
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
      if (process.platform !== 'win32')
        expect(lstatSync(join(workspace, artifact.path)).mode & 0o777).toBe(
          0o600,
        );
    }
  });

  test('verifies local artifacts and projects exact bytes under a joiner key', () => {
    const source = root();
    const joiner = root();
    const persisted = persistVerificationOutput({
      root: source,
      requestKey,
      stdout: 'safe output',
      stderr: 'safe error',
    });
    expect(
      verifyVerificationArtifacts({
        root: source,
        artifacts: persisted.artifacts,
      }),
    ).toBe(true);
    const projected = projectVerificationArtifacts({
      sourceRoot: source,
      targetRoot: joiner,
      requestKey: otherRequestKey,
      artifacts: persisted.artifacts,
    });
    expect(projected).toHaveLength(2);
    expect(
      projected.every((artifact) => artifact.path.includes(otherRequestKey)),
    ).toBe(true);
    expect(
      verifyVerificationArtifacts({ root: joiner, artifacts: projected }),
    ).toBe(true);

    const original = join(source, persisted.artifacts[0].path);
    if (process.platform !== 'win32') {
      chmodSync(original, 0o644);
      expect(() =>
        verifyVerificationArtifacts({
          root: source,
          artifacts: persisted.artifacts,
        }),
      ).toThrow('not private');
      chmodSync(original, 0o600);
    }
    writeFileSync(original, 'tampered');
    expect(() =>
      verifyVerificationArtifacts({
        root: source,
        artifacts: persisted.artifacts,
      }),
    ).toThrow('digest');
  });

  test('descriptor-binds artifact reads and rejects identity changes', () => {
    const workspace = root();
    const persisted = persistVerificationOutput({
      root: workspace,
      requestKey,
      stdout: 'descriptor-bound output',
    });
    let statCalls = 0;
    expect(() =>
      readVerifiedVerificationArtifact({
        root: workspace,
        artifact: persisted.artifacts[0],
        statFile: (descriptor: number) => {
          const stat = fstatSync(descriptor);
          statCalls += 1;
          return statCalls === 2
            ? { ...stat, ctimeMs: stat.ctimeMs + 1 }
            : stat;
        },
      }),
    ).toThrow('changed while reading');
  });

  test('retains the bounded prefix with explicit truncation metadata instead of a marker', () => {
    const capture = captureBoundedOutput(['safe '.repeat(100)], {
      maxBytes: 128,
    });
    expect(capture.truncated).toBe(true);
    expect(capture.sourceBytes).toBe(500);
    expect(capture.text).not.toContain('[output omitted');
    expect(capture.text).toContain('safe');
    expect(Buffer.byteLength(capture.text)).toBeLessThanOrEqual(128);
    expect(capture.persistedBytes).toBe(Buffer.byteLength(capture.text));
    expect(capture.persistedBytes).toBeLessThanOrEqual(128);
  });

  test('persists the redacted bounded prefix with a matching digest and metadata', () => {
    const workspace = root();
    const secret = `token=${'secret-value'.repeat(50)}`;
    const stdout = `${'x'.repeat(200)}\n${secret}`;
    const result = persistVerificationOutput({
      root: workspace,
      requestKey,
      stdout,
      stderr: 'clean TypeError: boom',
      maxBytes: 128,
    });
    expect(result.truncated).toBe(true);
    const stdoutArtifact = result.artifacts.find((entry) =>
      entry.path.includes('stdout'),
    );
    expect(stdoutArtifact).toBeTruthy();
    const contents = readFileSync(
      join(workspace, stdoutArtifact!.path),
      'utf8',
    );
    // The artifact digest describes exactly the bytes on disk.
    expect(stdoutArtifact!.sha256).toBe(
      createHash('sha256').update(contents).digest('hex'),
    );
    // Secrets never enter persisted text.
    expect(contents).not.toContain('secret-value');
    // The retained prefix is real content, never an omission marker.
    expect(contents).toContain('x');
    expect(contents).not.toContain('[output omitted');
    expect(Buffer.byteLength(contents)).toBeLessThanOrEqual(128);
    const stdoutStream = result.streams.stdout;
    expect(stdoutStream.sourceBytes).toBe(Buffer.byteLength(stdout));
    expect(stdoutStream.truncated).toBe(true);
    expect(stdoutStream.persistedBytes).toBe(Buffer.byteLength(contents));
  });

  test('copies redacted attachments and rejects a lexical symlink escape', () => {
    const workspace = root();
    const attachments = join(workspace, 'attachments');
    mkdirSync(attachments);
    const source = join(attachments, 'report.txt');
    writeFileSync(
      source,
      `Authorization: Bearer attachment-secret ${JSON.stringify(
        JSON.stringify({ password: 'attachment-password', safe: 'keep' }),
      )}`,
    );
    const artifacts = persistPlaywrightAttachments({
      root: workspace,
      requestKey,
      attachmentRoot: attachments,
      attachments: [{ path: source }],
    });
    const persisted = readFileSync(join(workspace, artifacts[0].path), 'utf8');
    expect(persisted).not.toContain('attachment-secret');
    expect(persisted).not.toContain('attachment-password');
    expect(persisted).toContain('keep');
    const outside = join(workspace, 'outside.txt');
    writeFileSync(outside, 'outside');
    const link = join(attachments, 'link.txt');
    symlinkSync(outside, link);
    expect(() =>
      persistPlaywrightAttachments({
        root: workspace,
        requestKey,
        attachmentRoot: attachments,
        attachments: [{ path: link }],
      }),
    ).toThrow(/unsafe attachment|path escapes root|symbolic link/);
  });

  test('does not read binary or oversized attachments before rejecting them', () => {
    const workspace = root();
    const attachments = join(workspace, 'attachments');
    mkdirSync(attachments);
    const binary = join(attachments, 'trace.zip');
    const oversized = join(attachments, 'large.txt');
    writeFileSync(binary, 'binary');
    writeFileSync(oversized, 'x'.repeat(513 * 1024));
    const neverRead = () => {
      throw new Error('attachment was read');
    };
    expect(() =>
      persistPlaywrightAttachments({
        root: workspace,
        requestKey,
        attachmentRoot: attachments,
        attachments: [{ path: binary }],
        readFile: neverRead,
      }),
    ).toThrow('unsupported binary');
    expect(() =>
      persistPlaywrightAttachments({
        root: workspace,
        requestKey,
        attachmentRoot: attachments,
        attachments: [{ path: oversized }],
        readFile: neverRead,
      }),
    ).toThrow('attachment byte cap');
  });

  test('rejects invalid UTF-8 text attachments before persistence', () => {
    const workspace = root();
    const attachments = join(workspace, 'attachments');
    mkdirSync(attachments);
    const source = join(attachments, 'invalid.txt');
    writeFileSync(source, Buffer.from([0xc3, 0x28]));
    expect(() =>
      persistPlaywrightAttachments({
        root: workspace,
        requestKey,
        attachmentRoot: attachments,
        attachments: [{ path: source }],
      }),
    ).toThrow('not valid UTF-8');
    expect(() =>
      lstatSync(join(workspace, '.kontourai/verification-output', requestKey)),
    ).toThrow();
  });

  test('rejects redaction expansion beyond the retained attachment cap', () => {
    const workspace = root();
    const attachments = join(workspace, 'attachments');
    mkdirSync(attachments);
    const source = join(attachments, 'report.txt');
    writeFileSync(source, 'small input');
    expect(() =>
      persistPlaywrightAttachments({
        root: workspace,
        requestKey,
        attachmentRoot: attachments,
        attachments: [{ path: source }],
        redact: () => 'x'.repeat(MAX_REDACTED_ATTACHMENT_BYTES + 1),
      }),
    ).toThrow('redaction exceeds byte cap');
  });

  test('does not GC artifacts owned by active or unknown leases', () => {
    const workspace = root();
    const active = outputDirectory(workspace, requestKey);
    const unknown = outputDirectory(workspace, otherRequestKey);
    expect(
      gcVerificationArtifacts({
        root: workspace,
        activityResolver: (key) => (key === requestKey ? 'active' : 'unknown'),
        withMutationClaim: (_key, callback) => callback(),
        now: Date.now(),
        maxAgeMs: 1,
      }),
    ).toBe(0);
    expect(() => lstatSync(active)).not.toThrow();
    expect(() => lstatSync(unknown)).not.toThrow();
  });

  test('rechecks activity under a mutation claim before deleting', () => {
    const workspace = root();
    const retained = outputDirectory(workspace, requestKey);
    let calls = 0;
    expect(
      gcVerificationArtifacts({
        root: workspace,
        activityResolver: () => (calls++ === 0 ? 'inactive' : 'active'),
        withMutationClaim: (_key, callback) => callback(),
        now: Date.now(),
        maxAgeMs: 1,
      }),
    ).toBe(0);
    expect(() => lstatSync(retained)).not.toThrow();
  });

  test('removes only an inactive request after its claim and honors GC bounds', () => {
    const workspace = root();
    const first = outputDirectory(workspace, requestKey);
    const second = outputDirectory(workspace, otherRequestKey);
    const third = outputDirectory(workspace, thirdRequestKey);
    const claims: string[] = [];
    expect(
      gcVerificationArtifacts({
        root: workspace,
        ...claimedInactive(),
        withMutationClaim: (key, callback) => {
          claims.push(key);
          callback();
        },
        now: Date.now(),
        maxAgeMs: 1,
        maxScanned: 2,
        maxRemovals: 1,
      }),
    ).toBe(1);
    expect(claims).toHaveLength(1);
    const candidates = [
      [requestKey, first],
      [otherRequestKey, second],
      [thirdRequestKey, third],
    ] as const;
    const deleted = candidates.filter(([, path]) => !existsSync(path));
    expect(deleted).toHaveLength(1);
    expect(deleted[0][0]).toBe(claims[0]);
  });

  test('incrementally stops the directory iterator at the exact scan bound', () => {
    const workspace = root();
    mkdirSync(join(workspace, '.kontourai/verification-output'), {
      recursive: true,
    });
    let reads = 0;
    let closes = 0;
    const entries = [
      { name: 'junk-a' },
      { name: 'junk-b' },
      { name: requestKey },
    ];
    expect(
      gcVerificationArtifacts({
        root: workspace,
        ...claimedInactive(),
        now: Date.now(),
        maxAgeMs: 1,
        maxScanned: 2,
        openDirectory: () => ({
          readSync: () => {
            reads += 1;
            return entries.shift() ?? null;
          },
          closeSync: () => {
            closes += 1;
          },
        }),
      }),
    ).toBe(0);
    expect(reads).toBe(2);
    expect(closes).toBe(1);
  });

  test('retains external symlinked .kontourai and symlink candidates', () => {
    const workspace = root();
    const external = root();
    const externalOutput = outputDirectory(external, requestKey);
    symlinkSync(join(external, '.kontourai'), join(workspace, '.kontourai'));
    expect(() =>
      gcVerificationArtifacts({
        root: workspace,
        ...claimedInactive(),
        now: Date.now(),
        maxAgeMs: 1,
      }),
    ).toThrow('symbolic link');
    expect(() => lstatSync(externalOutput)).not.toThrow();

    const safeWorkspace = root();
    const outside = outputDirectory(root(), otherRequestKey);
    const output = join(safeWorkspace, '.kontourai/verification-output');
    mkdirSync(output, { recursive: true });
    symlinkSync(outside, join(output, requestKey));
    expect(
      gcVerificationArtifacts({
        root: safeWorkspace,
        ...claimedInactive(),
        now: Date.now(),
        maxAgeMs: 1,
      }),
    ).toBe(0);
    expect(() => lstatSync(outside)).not.toThrow();
  });

  test('rejects unsafe request keys and GC without both proofs', () => {
    const workspace = root();
    expect(() =>
      persistVerificationOutput({ root: workspace, requestKey: '../unsafe' }),
    ).toThrow('requestKey');
    expect(() => gcVerificationArtifacts({ root: workspace })).toThrow(
      'lease-derived',
    );
    expect(() =>
      gcVerificationArtifacts({
        root: workspace,
        activityResolver: () => 'inactive',
      }),
    ).toThrow('mutation claim');
  });

  describe('explicit orphan artifact GC', () => {
    test('preserves a valid committed canonical receipt and its output/phase closure', () => {
      const workspace = root();
      const key = writeCommittedReceipt(workspace);
      const output = writeOldGcDirectory(
        workspace,
        '.kontourai/verification-output',
        key,
      );
      const phase = writeOldGcDirectory(
        workspace,
        '.kontourai/verification-phase-records',
        key,
      );

      expect(
        sweepVerificationArtifactOrphans({
          root: workspace,
          coordinatorRoot: join(workspace, 'host'),
          now: 2 * 24 * 60 * 60_000,
        }),
      ).toMatchObject({ removed: 0, retained: 2, truncated: false });
      expect(existsSync(output)).toBe(true);
      expect(existsSync(phase)).toBe(true);
      expect(
        existsSync(
          join(
            workspace,
            '.kontourai/verification-receipts',
            `${key}.canonical.json`,
          ),
        ),
      ).toBe(true);
    });

    test('preserves active handoffs and host request leases without probing processes', () => {
      const workspace = root();
      const host = join(workspace, 'host');
      const handoffKey = requestKey;
      const leaseRequest = createVerificationRequest('ci-fast', gcProvenance);
      const leaseKey = leaseRequest.key;
      const handoffOutput = writeOldGcDirectory(
        workspace,
        '.kontourai/verification-output',
        handoffKey,
      );
      const leaseOutput = writeOldGcDirectory(
        workspace,
        '.kontourai/verification-output',
        leaseKey,
      );
      mkdirSync(join(host, 'submissions', handoffKey), { recursive: true });
      writeFileSync(
        join(host, 'submissions', handoffKey, 'handoff.json'),
        JSON.stringify({ request: { key: handoffKey }, state: 'coordinating' }),
      );
      mkdirSync(join(host, 'requests', executionEquivalenceKey(leaseRequest)), {
        recursive: true,
      });
      writeFileSync(
        join(
          host,
          'requests',
          executionEquivalenceKey(leaseRequest),
          'lease.json',
        ),
        JSON.stringify({
          owner: { nonce: 'live' },
          request: leaseRequest,
          state: 'running',
        }),
      );

      expect(
        sweepVerificationArtifactOrphans({
          root: workspace,
          coordinatorRoot: host,
          now: 2 * 24 * 60 * 60_000,
        }),
      ).toMatchObject({ removed: 0, retained: 2 });
      expect(existsSync(handoffOutput)).toBe(true);
      expect(existsSync(leaseOutput)).toBe(true);
    });

    test.each(['launching', 'awaiting_readiness', 'coordinating', 'unknown'])(
      'preserves every nonterminal submission handoff state: %s',
      (state) => {
        const workspace = root();
        const host = join(workspace, 'host');
        const output = writeOldGcDirectory(
          workspace,
          '.kontourai/verification-output',
          requestKey,
        );
        mkdirSync(join(host, 'submissions', requestKey), { recursive: true });
        writeFileSync(
          join(host, 'submissions', requestKey, 'handoff.json'),
          JSON.stringify({ request: { key: requestKey }, state }),
        );

        expect(
          sweepVerificationArtifactOrphans({
            root: workspace,
            coordinatorRoot: host,
            now: 2 * 24 * 60 * 60_000,
          }),
        ).toMatchObject({ removed: 0, retained: 1 });
        expect(existsSync(output)).toBe(true);
      },
    );

    test('removes only old orphan output, phase, pending, and quarantine records', () => {
      const workspace = root();
      const host = join(workspace, 'host');
      const key = requestKey;
      const output = writeOldGcDirectory(
        workspace,
        '.kontourai/verification-output',
        key,
      );
      const phase = writeOldGcDirectory(
        workspace,
        '.kontourai/verification-phase-records',
        key,
      );
      const receipts = join(workspace, '.kontourai/verification-receipts');
      mkdirSync(receipts, { recursive: true });
      const pending = join(receipts, `${key}.pending-owner-1.json`);
      const quarantine = join(receipts, `${key}.canonical.json.failed-owner`);
      writeFileSync(pending, '{}');
      writeFileSync(quarantine, '{}');
      utimesSync(pending, new Date(1), new Date(1));
      utimesSync(quarantine, new Date(1), new Date(1));

      expect(
        sweepVerificationArtifactOrphans({
          root: workspace,
          coordinatorRoot: host,
          now: 2 * 24 * 60 * 60_000,
        }),
      ).toMatchObject({ removed: 4, retained: 0, truncated: false });
      for (const path of [output, phase, pending, quarantine])
        expect(existsSync(path)).toBe(false);
    });

    test('deletes only an exact quarantine when a successor appears during the TOCTOU window', () => {
      const workspace = root();
      const key = requestKey;
      const output = writeOldGcDirectory(
        workspace,
        '.kontourai/verification-output',
        key,
      );
      expect(
        sweepVerificationArtifactOrphans({
          root: workspace,
          coordinatorRoot: join(workspace, 'host'),
          now: 2 * 24 * 60 * 60_000,
          gcHooks: {
            afterQuarantine: () => {
              mkdirSync(output, { recursive: true });
              writeFileSync(join(output, 'successor.txt'), 'new');
            },
          },
        }),
      ).toMatchObject({ removed: 1 });
      expect(readFileSync(join(output, 'successor.txt'), 'utf8')).toBe('new');
      expect(
        readdirSync(join(workspace, '.kontourai/verification-output')).filter(
          (entry) => entry.includes('.gc-'),
        ),
      ).toEqual([]);
    });

    test('retains corrupt state and safely processes only a bounded scan prefix', () => {
      const workspace = root();
      const key = requestKey;
      const output = writeOldGcDirectory(
        workspace,
        '.kontourai/verification-output',
        key,
      );
      mkdirSync(join(workspace, 'host', 'outputs', 'corrupt'), {
        recursive: true,
      });
      writeFileSync(
        join(workspace, 'host', 'outputs', 'corrupt', 'lease.json'),
        '{',
      );

      expect(
        sweepVerificationArtifactOrphans({
          root: workspace,
          coordinatorRoot: join(workspace, 'host'),
          now: 2 * 24 * 60 * 60_000,
        }),
      ).toMatchObject({ removed: 0, retained: 1 });
      expect(existsSync(output)).toBe(true);

      const second = writeOldGcDirectory(
        workspace,
        '.kontourai/verification-output',
        otherRequestKey,
      );
      const bounded = sweepVerificationArtifactOrphans({
        root: workspace,
        coordinatorRoot: join(workspace, 'different-host'),
        now: 2 * 24 * 60 * 60_000,
        maxScanned: 1,
      });
      expect(bounded).toMatchObject({ removed: 1, truncated: true });
      expect(Number(existsSync(output)) + Number(existsSync(second))).toBe(1);
    });

    test('honors the removal cap without treating retained records as deleted', () => {
      const workspace = root();
      const first = writeOldGcDirectory(
        workspace,
        '.kontourai/verification-output',
        requestKey,
      );
      const second = writeOldGcDirectory(
        workspace,
        '.kontourai/verification-output',
        otherRequestKey,
      );

      expect(
        sweepVerificationArtifactOrphans({
          root: workspace,
          coordinatorRoot: join(workspace, 'host'),
          now: 2 * 24 * 60 * 60_000,
          maxRemovals: 1,
        }),
      ).toMatchObject({ removed: 1, retained: 1, truncated: true });
      expect(Number(existsSync(first)) + Number(existsSync(second))).toBe(1);
    });

    test('dry-run explains exact eligible candidates without mutating them', () => {
      const workspace = root();
      const output = writeOldGcDirectory(
        workspace,
        '.kontourai/verification-output',
        requestKey,
      );

      expect(
        sweepVerificationArtifactOrphans({
          root: workspace,
          coordinatorRoot: join(workspace, 'host'),
          now: 2 * 24 * 60 * 60_000,
          dryRun: true,
        }),
      ).toMatchObject({
        mode: 'dry-run',
        removed: 0,
        wouldRemove: 1,
        retained: 1,
        candidates: [
          {
            path: `.kontourai/verification-output/${requestKey}`,
            reason:
              'expired orphan with no committed receipt or live lease/handoff',
          },
        ],
      });
      expect(existsSync(output)).toBe(true);
    });
  });
});

test('redacts a secret that crosses the persisted byte boundary', () => {
  const workspace = root();
  const result = persistVerificationOutput({
    root: workspace,
    requestKey,
    stdout: 'prefix AKIAIOSFODNN7EXAMPLE suffix',
    maxBytes: 15,
  });
  const artifact = result.artifacts.find((entry) =>
    entry.path.includes('stdout'),
  );
  const contents = readFileSync(join(workspace, artifact!.path), 'utf8');
  expect(contents).not.toContain('AKIAIOSFODNN7');
  expect(contents).toContain('[REDACT');
  expect(Buffer.byteLength(contents)).toBeLessThanOrEqual(15);
  expect(result.streams.stdout.truncated).toBe(true);
});

test('redacts a secret prefix cut by the owned-process capture boundary', () => {
  const workspace = root();
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const capture = captureOwnedProcessOutput({ child } as never, {
    maxBytes: 15,
  });
  child.stdout.emit('data', 'prefix AKIAIOSFODNN7EXAMPLE suffix');
  const raw = capture.finish();
  const result = persistVerificationOutput({
    root: workspace,
    requestKey,
    stdout: raw.stdout.text,
    maxBytes: 15,
  });
  const artifact = result.artifacts.find((entry) =>
    entry.path.includes('stdout'),
  );
  const contents = readFileSync(join(workspace, artifact!.path), 'utf8');
  expect(raw.stdout.truncated).toBe(true);
  expect(contents).not.toContain('AKIAIOSF');
  expect(contents).toContain('[REDACT');
});

test('redacts a private key cut by the owned-process capture boundary', () => {
  const workspace = root();
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const capture = captureOwnedProcessOutput({ child } as never, {
    maxBytes: 64,
  });
  child.stdout.emit(
    'data',
    `prefix ${privateKeyMarker('BEGIN', 'OPENSSH')}\nprivate-material-that-crosses-the-boundary`,
  );
  const raw = capture.finish();
  const result = persistVerificationOutput({
    root: workspace,
    requestKey,
    stdout: raw.stdout.text,
    maxBytes: 64,
  });
  const artifact = result.artifacts.find((entry) =>
    entry.path.includes('stdout'),
  );
  const contents = readFileSync(join(workspace, artifact!.path), 'utf8');
  expect(raw.stdout.truncated).toBe(true);
  expect(contents).not.toContain('private-material');
  expect(contents).toContain('[REDACTED]');
});

test('redacts private keys in persisted text attachments', () => {
  const workspace = root();
  const attachmentRoot = join(workspace, 'private-key-attachment');
  mkdirSync(attachmentRoot);
  const path = join(attachmentRoot, 'key.txt');
  writeFileSync(
    path,
    `${privateKeyMarker('BEGIN', 'RSA')}\nprivate-material\n${privateKeyMarker('END', 'RSA')}`,
  );
  const [artifact] = persistPlaywrightAttachments({
    root: workspace,
    requestKey,
    attachmentRoot,
    attachments: [{ path }],
  });
  const contents = readFileSync(join(workspace, artifact.path), 'utf8');
  expect(contents).toBe('[REDACTED]');
});
test('bounds attachment bytes again after redaction expansion', {
  timeout: 60_000,
}, () => {
  const workspace = root();
  const attachmentRoot = join(workspace, 'expanding-attachments');
  mkdirSync(attachmentRoot);
  const attachments = Array.from({ length: 32 }, (_, index) => {
    const path = join(attachmentRoot, `${index}.txt`);
    writeFileSync(path, 'token=x\n'.repeat(8_192));
    return { path };
  });
  expect(() =>
    persistPlaywrightAttachments({
      root: workspace,
      requestKey,
      attachmentRoot,
      attachments,
    }),
  ).toThrow('redaction exceeds total byte cap');
});
