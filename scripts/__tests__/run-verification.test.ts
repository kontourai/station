import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createOwnedRunner } from '../lib/verification-execution-lifecycle.mjs';
import { persistVerificationOutput } from '../lib/verification-reporter.mjs';
import { CI_FAST_INFRASTRUCTURE_EXIT_CODE } from '../run-ci-fast.mjs';
import {
  boundedControlResult,
  parseVerificationCommand,
  renderBounded,
  runVerificationCli,
} from '../run-verification.mjs';

describe('verification status projection', () => {
  test('classifies a real ci-fast exit 80 as infrastructure', async () => {
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
          ['-e', `process.exit(${CI_FAST_INFRASTRUCTURE_EXIT_CODE})`],
        ],
        processIdentity: () => ({ start: 'test-birth' }),
        writeOwnedLease: () => true,
        env: process.env,
      });
      await expect(runner()).resolves.toMatchObject({
        status: CI_FAST_INFRASTRUCTURE_EXIT_CODE,
        infrastructureError: true,
      });
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
