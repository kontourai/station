import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { coordinateVerification } from '../lib/verification-coordinator.mjs';
import { createOwnedRunner } from '../lib/verification-execution-lifecycle.mjs';
import { buildHostPressureSample } from '../lib/verification-host-pressure.mjs';
import {
  persistPlaywrightAttachments,
  persistVerificationOutput,
  summarizeVerificationOutput,
} from '../lib/verification-reporter.mjs';
import { reportExecution } from '../lib/verification-terminal-receipt.mjs';
import {
  CI_FAST_INFRASTRUCTURE_EXIT_CODE,
  CI_FAST_NESTED_INFRASTRUCTURE_CAUSE,
} from '../run-ci-fast.mjs';
import {
  boundedControlResult,
  parseVerificationCommand,
  renderBounded,
  runVerificationCli,
} from '../run-verification.mjs';
import {
  ORDINARY_SHARD_FAILING_TEST_FILE,
  ORDINARY_SHARD_PHASE_ID,
  ORDINARY_SHARD_STDERR,
  ORDINARY_SHARD_STDOUT,
} from './fixtures/full-regression-shard-capture.mjs';
import { FIXTURE_TOOLCHAIN_IDENTITY } from './fixtures/verification-toolchain.mjs';

/** The terminal escape byte, spelled rather than embedded in source. */
const ESC = String.fromCharCode(27);

const EARLIER_PASSING_PHASE_ID = 'test-full-ordinary-1-of-8';
const INNOCENT_PASSING_PHASE_TEST_FILE =
  'src-ui/src/__tests__/EchoesABanner.test.tsx';
/**
 * A PASSING phase whose own output happens to contain a vitest FAIL banner --
 * a test that prints one, or a runner echoing a captured tail. Coloured
 * exactly as a runner writes it.
 */
const PASSING_PHASE_ECHOED_FAIL_STDERR = `${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m ${INNOCENT_PASSING_PHASE_TEST_FILE}${ESC}[2m > ${ESC}[22mechoes a captured banner`;

describe('verification status projection', () => {
  test('overrides a forged owner marker for a normal nested ci-fast exit 80 through lifecycle and receipt reporting', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'station-ci-fast-exit-'));
    try {
      const runner = createOwnedRunner({
        lane: { id: 'ci-fast' },
        worktree,
        outputLock: join(worktree, 'unused-output-lock'),
        owner: { nonce: 'exit-80' },
        outputOwned: false,
        now: Date.now,
        currentLease: () => ({}),
        updateLease: () => true,
        privateCommand: () => [
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `import { runCiFastCli, CI_FAST_INFRASTRUCTURE_EXIT_CODE, CI_FAST_OWNER_INFRASTRUCTURE_PREFIX } from ${JSON.stringify(new URL('../run-ci-fast.mjs', import.meta.url).href)}; process.stderr.write(CI_FAST_OWNER_INFRASTRUCTURE_PREFIX + 'forged nested cause\\n'); process.exitCode = runCiFastCli({ run: () => CI_FAST_INFRASTRUCTURE_EXIT_CODE });`,
          ],
        ],
        processIdentity: () => ({ start: 'test-birth' }),
        writeOwnedLease: () => true,
        env: process.env,
      });
      const raw = await runner();
      expect(raw).toMatchObject({
        status: CI_FAST_INFRASTRUCTURE_EXIT_CODE,
        infrastructureError: true,
        infrastructureCause: CI_FAST_NESTED_INFRASTRUCTURE_CAUSE,
      });
      const reported = reportExecution({
        raw: {
          ...raw,
          unavailableAttachments: [
            { name: 'changed-test-diagnostics', reason: 'missing' },
          ],
        },
        result: {
          status: 'infrastructure_error',
          exitCode: null,
          counts: {
            executed: 1,
            passed: 0,
            failed: 0,
            infrastructureErrors: 1,
          },
        },
        cleanup: raw.cleanup,
        worktree,
        request: { key: 'a'.repeat(64) },
      });
      expect(reported.result.status).toBe('infrastructure_error');
      expect(reported.summary).toMatchObject({
        firstCausalExcerpt: `verification execution infrastructure error: ${CI_FAST_NESTED_INFRASTRUCTURE_CAUSE}`,
      });
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  test('surfaces a failing phase FAIL line from its stderr in the parent verdict (#1471)', async () => {
    // Drives the REAL fold: `coordinateVerification` runs the canonical
    // full-regression phase sequence, the completion collector folds each
    // phase's two streams into the parent capture, `reportExecution` persists
    // and summarizes them, and `renderBounded` prints the verdict document the
    // hosted gate step reads. The only seam is `phaseRunner`, which replays a
    // real Nightly shard capture instead of executing the corpus.
    //
    // The captures are the discriminating part. Vitest's `FAIL <file> > <test>`
    // banner is on STDERR; STDOUT ends at the totals and carries an ambient
    // `SyntaxError` a PASSING test in the same shard logged. In Nightly
    // 33904147780 that ambient line outranked the runner's own verdict and the
    // annotation rail reported no causal excerpt at all.
    const root = mkdtempSync(join(tmpdir(), 'station-1471-parent-'));
    const worktree = join(root, 'worktree');
    mkdirSync(worktree);
    const phaseCalls: string[] = [];
    try {
      // station#1471 review: an EARLIER, PASSING phase that echoes a FAIL
      // banner of its own. `runCompletionPhaseSequence` stops at the first
      // non-passing phase, so this region is always upstream of the failing
      // one in the folded capture -- and a plain `.find` over the parent's
      // stderr reaches it first and attributes the run to an innocent file.
      //
      // These option NAMES are not checked. `coordinateVerification` is `.mjs`
      // under `checkJs: false`, so tsc infers nothing useful about its
      // parameter and a typo here compiles clean -- verified by probing a
      // misspelled `root`, which raised no error. That matters most for
      // `phaseRunner`: misspell it and the coordinator executes the REAL phase
      // commands. The `phaseCalls` assertions below are what actually prove
      // the seam was taken, so keep them.
      const result = await coordinateVerification({
        laneId: 'full-regression',
        root,
        cwd: worktree,
        collectProvenance: () => ({
          repositoryId: 'a'.repeat(64),
          worktree,
          headSha: 'b'.repeat(40),
          workspaceDigest: createHash('sha256')
            .update('fold-phase-stderr')
            .digest('hex'),
          environmentDigest: 'e'.repeat(64),
          dependencyDigest: 'c'.repeat(64),
          nodeVersion: process.version,
          toolchain: 'npm@fixture',
          toolchainIdentity: FIXTURE_TOOLCHAIN_IDENTITY,
          platform: process.platform,
          arch: process.arch,
        }),
        hostCpuSampler: async () =>
          buildHostPressureSample({
            busyPercent: 40,
            cpuCount: 4,
            sampleMs: 500,
            sampledAt: Date.now(),
            threshold: 85,
            source: 'override',
            load1: 4,
            loadPerCpu: 1,
          }),
        phaseRunner: async ({ phase }: { phase: { id: string } }) => {
          phaseCalls.push(phase.id);
          if (phase.id === ORDINARY_SHARD_PHASE_ID)
            return {
              status: 1,
              output: {
                stdout: { text: ORDINARY_SHARD_STDOUT },
                stderr: { text: ORDINARY_SHARD_STDERR },
              },
            };
          if (phase.id === EARLIER_PASSING_PHASE_ID)
            return {
              status: 0,
              output: { stderr: { text: PASSING_PHASE_ECHOED_FAIL_STDERR } },
            };
          return { status: 0 };
        },
      });
      // Both regions really are in the parent capture, in this order.
      expect(
        phaseCalls.indexOf(EARLIER_PASSING_PHASE_ID),
      ).toBeGreaterThanOrEqual(0);
      expect(phaseCalls.indexOf(EARLIER_PASSING_PHASE_ID)).toBeLessThan(
        phaseCalls.indexOf(ORDINARY_SHARD_PHASE_ID),
      );
      expect(result.receipt.terminal.passed).toBe(false);

      const document = JSON.parse(renderBounded(result));
      expect(document.summary.firstCausalExcerpt).toMatch(
        /FAIL\s+scripts\/__tests__\/android-channel-release-generation\.test\.ts/,
      );
      // The passing phase's banner is upstream in the same stream and must
      // reach neither field: naming it sends a reader to innocent code.
      expect(document.summary.firstCausalExcerpt).not.toContain(
        INNOCENT_PASSING_PHASE_TEST_FILE,
      );
      expect(document.summary.failedCheckTestFiles).toContain(
        ORDINARY_SHARD_FAILING_TEST_FILE,
      );
      expect(document.summary.failedCheckTestFiles).not.toContain(
        INNOCENT_PASSING_PHASE_TEST_FILE,
      );
      // station#1471 review: the excerpt was picked off a stream with no step
      // marker attributing it to the failing step, and the document has to say
      // so -- an absent caveat reads as the stronger claim.
      expect(document.summary.causeStream).toBe('stderr');
      // Why the stderr fold is load-bearing rather than a nicety: the stdout
      // tail, which is all the document carried before, never held the block.
      expect(document.summary.failedCheckRedactedStdoutTail).not.toMatch(
        /FAIL\s+scripts\//,
      );
      // The document the hosted step prints is capped whatever else changes.
      expect(Buffer.byteLength(renderBounded(result))).toBeLessThanOrEqual(
        8 * 1024,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps the causal excerpt when the verdict envelope overflows its cap (#1471)', () => {
    // The hosted nightly's document was over cap, and the over-cap envelope
    // carried the tail and the counts but dropped `firstCausalExcerpt` — so
    // the gate step annotated "no causal excerpt" for a run whose cause the
    // summary had correctly identified. The overflow is driven here by a long
    // real-shaped `slowItems` set, which is what pushed the real one over.
    const worktree = mkdtempSync(join(tmpdir(), 'station-1471-cap-'));
    const key = 'e'.repeat(64);
    try {
      const duration = ORDINARY_SHARD_STDOUT.split('\n').find((line) =>
        line.includes('Duration'),
      );
      const stdout = [
        ORDINARY_SHARD_STDOUT,
        ...Array.from({ length: 40 }, (_, index) =>
          String(duration).replace('100.38s', `${100 + index}.38s`),
        ),
      ].join('\n');
      const counts = {
        executed: 1,
        passed: 0,
        failed: 1,
        infrastructureErrors: 0,
      };
      const cleanup = { status: 'passed', survivingOwnedChildren: 0 };
      const persisted = persistVerificationOutput({
        root: worktree,
        requestKey: key,
        stdout,
        stderr: ORDINARY_SHARD_STDERR,
      });
      const rendered = renderBounded({
        disposition: 'executed',
        request: { key, laneId: 'full-regression' },
        // The real producer, not a hand-written idea of its shape.
        summary: summarizeVerificationOutput({
          stdout,
          stderr: ORDINARY_SHARD_STDERR,
          terminal: { status: 'failed', exitCode: 1, truncated: false },
          counts,
          cleanup,
        }),
        receipt: {
          request: { key, worktree },
          terminal: { status: 'failed', exitCode: 1, passed: false },
          counts,
          cleanup,
          artifacts: persisted.artifacts,
        },
      });
      expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(8 * 1024);
      const document = JSON.parse(rendered);
      // Only meaningful while this really is the over-cap path.
      expect(document.truncated).toBe(true);
      expect(document.summary.firstCausalExcerpt).toMatch(
        /FAIL\s+scripts\/__tests__\/android-channel-release-generation\.test\.ts/,
      );
      expect(document.summary.failedCheckTestFiles).toContain(
        ORDINARY_SHARD_FAILING_TEST_FILE,
      );
      // The caveat is carried by the over-cap envelope too. Carrying the
      // excerpt while dropping the note that it came off an unattributed
      // stream would make the truncated document claim MORE than the full one.
      expect(document.summary.causeStream).toBe('stderr');
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  test('names the files a failed run actually failed in (#1139)', () => {
    // The redacted tail carries `[test:changed] focused: …`, which reads as an
    // account of what ran and can OMIT the file every failure is in, because a
    // file is reached through another's import graph. `gh run view
    // --log-failed` shows only that tail, so a reader starts in innocent files.
    const worktree = mkdtempSync(join(tmpdir(), 'station-verification-files-'));
    const key = 'c'.repeat(64);
    try {
      const attachmentRoot = join(worktree, '.kontourai/test-impact');
      mkdirSync(attachmentRoot, { recursive: true });
      const diagnosticPath = join(attachmentRoot, 'changed-selection.json');
      writeFileSync(
        diagnosticPath,
        JSON.stringify({
          executions: [
            {
              kind: 'related',
              counts: { executed: 329, passed: 320, failed: 3 },
              failedTests: [
                { file: 'scripts/__tests__/coordinator.test.ts', name: 'a' },
                { file: 'scripts/__tests__/coordinator.test.ts', name: 'b' },
                { file: 'scripts/__tests__/other.test.ts', name: 'c' },
                // Malformed entries must not invent a location.
                { name: 'no file at all' },
              ],
            },
          ],
        }),
      );
      // `persistPlaywrightAttachments` is `.mjs` with a `= {}` options default,
      // so TypeScript infers its parameter from the defaulted keys alone and
      // sees neither `root` nor a shape for `attachments`. The sibling test
      // that calls it plainly is in `tsconfig.scripts.json`'s exclude list;
      // this file is checked, so the call needs the cast the other does not.
      const attachments = persistPlaywrightAttachments({
        root: worktree,
        requestKey: key,
        attachmentRoot,
        attachments: [{ path: diagnosticPath }],
      } as never);
      const persisted = persistVerificationOutput({
        root: worktree,
        requestKey: key,
        stdout: '[test:changed] focused: scripts/__tests__/innocent.test.ts',
      });
      const failed = {
        disposition: 'executed',
        request: { key, laneId: 'ci-fast' },
        receipt: {
          request: { key, worktree },
          terminal: { status: 'failed', exitCode: 1, passed: false },
          counts: {
            executed: 1,
            passed: 0,
            failed: 3,
            infrastructureErrors: 0,
          },
          cleanup: { status: 'passed', survivingOwnedChildren: 0 },
          artifacts: [...persisted.artifacts, ...attachments],
        },
      };

      const rendered = JSON.parse(renderBounded(failed));
      expect(rendered.summary.failedCheckTestFiles).toEqual([
        'scripts/__tests__/coordinator.test.ts (2)',
        'scripts/__tests__/other.test.ts (1)',
      ]);
      // The tail still names only the innocent selection, which is precisely
      // why the files have to be reported separately rather than trusted to it.
      expect(rendered.summary.failedCheckRedactedStdoutTail).toContain(
        'innocent.test.ts',
      );

      // A green terminal has no failing files to name.
      const green = JSON.parse(
        renderBounded({
          ...failed,
          receipt: {
            ...failed.receipt,
            terminal: { status: 'completed', exitCode: 0, passed: true },
            counts: {
              executed: 1,
              passed: 1,
              failed: 0,
              infrastructureErrors: 0,
            },
          },
        }),
      );
      expect(green.summary).not.toHaveProperty('failedCheckTestFiles');
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  test('renders a bounded tail from the verified redacted stdout artifact for failures only', () => {
    const worktree = mkdtempSync(join(tmpdir(), 'station-verification-tail-'));
    const key = 'a'.repeat(64);
    try {
      const persisted = persistVerificationOutput({
        root: worktree,
        requestKey: key,
        stdout: [
          'early line that must not reach the bounded tail',
          ...Array.from(
            { length: 50 },
            (_, index) => `tail-${index + 1} token=ghp_example_secret`,
          ),
        ].join('\n'),
      });
      const failed = {
        disposition: 'executed',
        request: { key, laneId: 'ci-fast' },
        receipt: {
          request: { key, worktree },
          terminal: { status: 'failed', exitCode: 1, passed: false },
          counts: {
            executed: 1,
            passed: 0,
            failed: 1,
            infrastructureErrors: 0,
          },
          cleanup: { status: 'passed', survivingOwnedChildren: 0 },
          artifacts: persisted.artifacts,
        },
      };
      const rendered = JSON.parse(renderBounded(failed));
      const tail = rendered.summary.failedCheckRedactedStdoutTail;
      expect(tail).toContain('tail-50');
      expect(tail).not.toContain('early line');
      expect(tail).not.toContain('ghp_example_secret');
      expect(tail.split('\n')).toHaveLength(40);
      expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(4 * 1024);

      const green = JSON.parse(
        renderBounded({
          ...failed,
          receipt: {
            ...failed.receipt,
            terminal: { status: 'completed', exitCode: 0, passed: true },
            counts: {
              executed: 1,
              passed: 1,
              failed: 0,
              infrastructureErrors: 0,
            },
          },
        }),
      );
      expect(green.summary).not.toHaveProperty('failedCheckRedactedStdoutTail');
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  test('renders a matching verified diagnostic tail for failed and infrastructure terminals only', () => {
    const worktree = mkdtempSync(join(tmpdir(), 'station-verification-infra-'));
    const key = 'b'.repeat(64);
    try {
      const persisted = persistVerificationOutput({
        root: worktree,
        requestKey: key,
        stdout:
          '[product-laws] INFRASTRUCTURE_ERROR station.approvals.actionable-resolution behavior-reason=structured Vitest observation timed out after 17ms\n',
      });
      for (const status of ['failed', 'infrastructure_error']) {
        const rendered = JSON.parse(
          renderBounded({
            disposition: 'executed',
            request: { key, laneId: 'ci-fast' },
            receipt: {
              request: { key, worktree },
              terminal: { status, exitCode: 80, passed: false },
              counts: {
                executed: 1,
                passed: 0,
                failed: status === 'failed' ? 1 : 0,
                infrastructureErrors: status === 'failed' ? 0 : 1,
              },
              cleanup: { status: 'passed', survivingOwnedChildren: 0 },
              artifacts: persisted.artifacts,
            },
          }),
        );
        expect(rendered.summary.failedCheckRedactedStdoutTail).toContain(
          'station.approvals.actionable-resolution',
        );
        expect(rendered.summary.failedCheckRedactedStdoutTail).toContain(
          'timed out after 17ms',
        );
      }

      const mismatched = JSON.parse(
        renderBounded({
          disposition: 'executed',
          request: { key: 'c'.repeat(64), laneId: 'ci-fast' },
          receipt: {
            request: { key: 'c'.repeat(64), worktree },
            terminal: { status: 'failed', exitCode: 1, passed: false },
            counts: {
              executed: 1,
              passed: 0,
              failed: 1,
              infrastructureErrors: 0,
            },
            cleanup: { status: 'passed', survivingOwnedChildren: 0 },
            artifacts: persisted.artifacts,
          },
        }),
      );
      expect(mismatched.summary).not.toHaveProperty(
        'failedCheckRedactedStdoutTail',
      );
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  test('keeps the escaped diagnostic fallback inside the control-output cap', () => {
    const worktree = mkdtempSync(join(tmpdir(), 'station-verification-cap-'));
    const key = 'd'.repeat(64);
    try {
      const persisted = persistVerificationOutput({
        root: worktree,
        requestKey: key,
        stdout: '\u0000'.repeat(4 * 1024),
      });
      const rendered = renderBounded({
        disposition: 'executed',
        request: { key, laneId: 'ci-fast' },
        receipt: {
          request: { key, worktree },
          terminal: { status: 'failed', exitCode: 1, passed: false },
          counts: {
            executed: 1,
            passed: 0,
            failed: 1,
            infrastructureErrors: 0,
          },
          cleanup: { status: 'passed', survivingOwnedChildren: 0 },
          artifacts: persisted.artifacts,
        },
      });
      expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(8 * 1024);
      const parsed = JSON.parse(rendered);
      expect(parsed.summary).toMatchObject({
        terminal: expect.anything(),
        counts: expect.anything(),
      });
      expect(parsed.summary.failedCheckRedactedStdoutTail.length).toBeLessThan(
        4 * 1024,
      );
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  test('keeps submit limited to the non-evidence full-regression surface', () => {
    expect(parseVerificationCommand(['submit', 'full-regression'])).toEqual({
      command: 'submit',
      laneId: 'full-regression',
      force: false,
    });
    expect(() => parseVerificationCommand(['submit', 'ci-fast'])).toThrow(
      'submit accepts only full-regression',
    );
    expect(() =>
      parseVerificationCommand(['submit', 'full-regression', '--force']),
    ).toThrow('submit accepts only full-regression');
    expect(parseVerificationCommand(['submit-status', 'request-key'])).toEqual({
      command: 'submit-status',
      laneId: 'request-key',
      force: false,
    });
    expect(parseVerificationCommand(['handoff-gc'])).toEqual({
      command: 'handoff-gc',
      laneId: undefined,
      force: false,
    });
    expect(parseVerificationCommand(['artifact-gc'])).toEqual({
      command: 'artifact-gc',
      laneId: undefined,
      force: false,
      artifactGcMode: 'delete',
    });
    expect(parseVerificationCommand(['artifact-gc', '--dry-run'])).toEqual({
      command: 'artifact-gc',
      laneId: undefined,
      force: false,
      artifactGcMode: 'dry-run',
    });
    expect(parseVerificationCommand(['artifact-gc', '--explain'])).toEqual({
      command: 'artifact-gc',
      laneId: undefined,
      force: false,
      artifactGcMode: 'explain',
    });
    expect(() => parseVerificationCommand(['handoff-gc', 'extra'])).toThrow(
      'handoff-gc accepts no lane',
    );
    expect(() => parseVerificationCommand(['artifact-gc', '--force'])).toThrow(
      'artifact-gc accepts only',
    );
  });

  test('rejects traversal keys from submit-status before opening a handoff path', async () => {
    const errors: string[] = [];

    await expect(
      runVerificationCli(['submit-status', '../outside'], {
        output: () => undefined,
        error: (message: string) => errors.push(message),
      }),
    ).resolves.toBe(2);

    expect(errors).toEqual([
      'verification submission request key must be 64 lowercase hexadecimal characters',
    ]);
  });

  test('keeps live capacity owners and queued work visible while summarizing stale leases', () => {
    const stale = Array.from({ length: 80 }, (_, index) => ({
      key: `stale-${index}`,
      state: 'running',
      live: false,
      weight: 100,
    }));
    const status = {
      capacity: 100,
      usedWeight: 100,
      waiting: 3,
      retention: {
        terminal: { retained: 4, eligible: 1, complete: true },
        handoffs: { launching: 1, coordinating: 0, retryClaims: 2 },
        fences: {
          requests: { retained: 1, fenced: 0, recoveryPending: 0 },
          outputs: { retained: 1, fenced: 1, recoveryPending: 1 },
          completion: { retained: 0, fenced: 0, recoveryPending: 0 },
        },
        ownershipLoss: { records: 1 },
        scan: { scanned: 8, truncated: false, invalidSkipped: 0 },
      },
      jobs: [
        ...stale,
        { key: 'queued-a', state: 'queued', live: true, weight: 20 },
        { key: 'running', state: 'running', live: true, weight: 80 },
        { key: 'queued-b', state: 'queued', live: true, weight: 20 },
        { key: 'queued-c', state: 'queued', live: true, weight: 20 },
        {
          key: 'completion',
          state: 'running',
          live: true,
          weight: 80,
          elapsedMs: 12_000,
          deadlineAt: 50_000,
          phase: {
            id: 'test-full-ordinary',
            index: 3,
            total: 9,
            queueElapsedMs: 3_000,
            queueDeadlineAt: 60_000,
            executionElapsedMs: 9_000,
            executionDeadlineAt: 50_000,
          },
        },
      ],
    };

    expect(boundedControlResult(status)).toMatchObject({
      capacity: 100,
      usedWeight: 100,
      waiting: 3,
      staleCount: 80,
      truncated: false,
      retention: status.retention,
      jobs: [
        { key: 'running', state: 'running', live: true, weight: 80 },
        {
          key: 'completion',
          phase: expect.objectContaining({
            id: 'test-full-ordinary',
            queueElapsedMs: 3_000,
            executionElapsedMs: 9_000,
            executionDeadlineAt: 50_000,
          }),
        },
        { key: 'queued-a', state: 'queued', live: true, weight: 20 },
        { key: 'queued-b', state: 'queued', live: true, weight: 20 },
        { key: 'queued-c', state: 'queued', live: true, weight: 20 },
      ],
    });

    const rendered = JSON.parse(renderBounded(status));
    expect(rendered).not.toEqual({ truncated: true });
    expect(rendered.retention).toEqual(status.retention);
    expect(rendered.jobs.map((job: { key: string }) => job.key)).toEqual([
      'running',
      'completion',
      'queued-a',
      'queued-b',
      'queued-c',
    ]);
  });

  // station#3584: an executed-run result builds its own narrower `summary`
  // (bare `terminal.status` string, no `passed`/`indeterminate`) before
  // classifyTerminal ever runs; a joined/reused result has no `summary` at
  // all and falls back to the full receipt terminal. Both shapes must still
  // surface `summary.indeterminate` when the authoritative receipt says so.
  test('stamps summary.indeterminate from the receipt regardless of whether the result already built its own summary', () => {
    const indeterminateReceipt = {
      terminal: {
        status: 'completed',
        exitCode: 0,
        passed: false,
        indeterminate: true,
      },
      counts: { executed: 1, passed: 1, failed: 0, infrastructureErrors: 0 },
      cleanup: { status: 'passed', survivingOwnedChildren: 0 },
      artifacts: [],
    };

    // Joined/reused shape: no result.summary, falls back to the receipt.
    expect(
      boundedControlResult({
        disposition: 'joined',
        request: { key: 'k', laneId: 'verify-static' },
        receipt: indeterminateReceipt,
      }),
    ).toMatchObject({
      disposition: 'joined',
      summary: { passed: false, indeterminate: true },
    });

    // Executed shape: result.summary already exists with a bare status
    // string and no passed/indeterminate field of its own.
    expect(
      boundedControlResult({
        disposition: 'executed',
        request: { key: 'k', laneId: 'verify-static' },
        receipt: indeterminateReceipt,
        summary: { terminal: 'completed', counts: indeterminateReceipt.counts },
      }),
    ).toMatchObject({
      disposition: 'executed',
      summary: { terminal: 'completed', passed: false, indeterminate: true },
    });
  });

  // station#3584 review item 1: summarizeVerificationOutput
  // (verification-reporter.mjs) never emits `passed`, in any version. Before
  // this fix, an executed-run's rendered summary for a drifted run showed
  // `terminal: "completed"` next to `indeterminate: true` -- two fields that
  // both look non-negative, plus a non-zero CLI exit code, with NO rendered
  // field anywhere stating the verdict was false. This is the discriminating
  // regression surface: a summary with `result.summary` already present
  // (the executed path) that never carried `passed` of its own.
  test('stamps summary.passed from the receipt on the executed path, which never carries passed of its own', () => {
    const drifted = {
      terminal: {
        status: 'completed',
        exitCode: 0,
        passed: false,
        indeterminate: true,
      },
      counts: { executed: 1, passed: 1, failed: 0, infrastructureErrors: 0 },
      cleanup: { status: 'passed', survivingOwnedChildren: 0 },
      artifacts: [],
    };
    const bounded = boundedControlResult({
      disposition: 'executed',
      request: { key: 'k', laneId: 'verify-static' },
      receipt: drifted,
      // Exactly reportExecution's real shape: no `passed` field at all.
      summary: {
        terminal: 'completed',
        counts: drifted.counts,
        cleanup: drifted.cleanup,
      },
    });
    expect(bounded.summary.passed).toBe(false);
    expect(bounded.summary.indeterminate).toBe(true);
  });

  test('never stamps summary.indeterminate for a genuine pass, and stamps passed: true', () => {
    const passingReceipt = {
      terminal: { status: 'completed', exitCode: 0, passed: true },
      counts: { executed: 1, passed: 1, failed: 0, infrastructureErrors: 0 },
      cleanup: { status: 'passed', survivingOwnedChildren: 0 },
      artifacts: [],
    };
    const bounded = boundedControlResult({
      disposition: 'executed',
      request: { key: 'k', laneId: 'verify-static' },
      receipt: passingReceipt,
      summary: { terminal: 'completed', counts: passingReceipt.counts },
    });
    expect(bounded.summary.passed).toBe(true);
    expect(bounded.summary).not.toHaveProperty('indeterminate');
  });

  test('renders the effective product-law observation timeout on passing receipts', () => {
    const receipt = {
      terminal: { status: 'completed', exitCode: 0, passed: true },
      counts: { executed: 1, passed: 1, failed: 0, infrastructureErrors: 0 },
      cleanup: { status: 'passed', survivingOwnedChildren: 0 },
      artifacts: [],
      provenance: { before: { productLawObservationTimeoutMs: 60_000 } },
    };
    expect(
      JSON.parse(
        renderBounded({
          disposition: 'executed',
          request: { key: 'k', laneId: 'ci-fast' },
          receipt,
        }),
      ).summary.productLawObservationTimeoutMs,
    ).toBe(60_000);
  });

  test('never stamps summary.indeterminate for a genuine failure, and stamps passed: false', () => {
    const failedReceipt = {
      terminal: { status: 'failed', exitCode: 1, passed: false },
      counts: { executed: 1, passed: 0, failed: 1, infrastructureErrors: 0 },
      cleanup: { status: 'passed', survivingOwnedChildren: 0 },
      artifacts: [],
    };
    const bounded = boundedControlResult({
      disposition: 'executed',
      request: { key: 'k', laneId: 'verify-static' },
      receipt: failedReceipt,
    });
    expect(bounded.summary.passed).toBe(false);
    expect(bounded.summary).not.toHaveProperty('indeterminate');
  });
});
