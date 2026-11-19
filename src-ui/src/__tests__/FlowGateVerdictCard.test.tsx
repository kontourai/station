/**
 * @vitest-environment jsdom
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import {
  PINNED_CONFIG,
  READINESS_DEFINITION,
  readinessBundle,
} from '../../../src-server/__test-utils__/readiness-bundle.js';
import { trackTempDirs } from '../../../src-server/__test-utils__/temp-dirs.js';
import { FlowRunService } from '../../../src-server/services/flow/flow-run-service.js';
import { evaluateFlowCompletionGate } from '../../../src-server/services/flow/orchestration-flow-gate.js';
import { FlowGateVerdictCard } from '../components/flow/FlowGateVerdictCard';

const makeWorkspace = trackTempDirs();

test.each([
  'policy_unresolved',
  'check_failed',
  'required_evidence_missing',
] as const)(
  'renders the actual %s evidence diagnostic from the Flow receipt',
  async (reason) => {
    const cwd = makeWorkspace('flow-card-receipt-');
    const definitions = join(cwd, '.flow', 'definitions');
    mkdirSync(definitions, { recursive: true });
    writeFileSync(
      join(definitions, 'pinned-readiness.json'),
      JSON.stringify(READINESS_DEFINITION),
    );
    writeFileSync(
      join(cwd, '.flow', 'config.json'),
      JSON.stringify(PINNED_CONFIG),
    );
    const flowRunService = new FlowRunService();
    const binding = { cwd, runId: 'r1', definitionId: 'pinned-readiness' };
    await flowRunService.startRun(cwd, {
      definition: binding.definitionId,
      runId: binding.runId,
    });
    const bundle = readinessBundle('veritas');
    if (reason === 'policy_unresolved') {
      bundle.policies = [];
      Reflect.deleteProperty(bundle.claims[0], 'verificationPolicyId');
    } else if (reason === 'check_failed') {
      bundle.evidence[0].passing = false;
    } else {
      bundle.evidence = [];
      bundle.events[0].evidenceIds = [];
    }
    writeFileSync(join(cwd, 'fixture-bundle.json'), JSON.stringify(bundle));
    await flowRunService.attachEvidence(cwd, binding.runId, {
      gate: 'readiness-gate',
      file: 'fixture-bundle.json',
      kind: 'trust.bundle',
      producer: 'veritas',
    });
    const verdict = await evaluateFlowCompletionGate({
      flowRunService,
      binding,
      provider: 'codex',
      threadId: 'thread',
    });
    expect(verdict.verdict).toBe('route-back');
    expect(verdict.diagnostics?.claims).toEqual([
      expect.objectContaining({
        expectationId: 'merge-readiness',
        specificReason: reason,
        surfaceGaps: expect.any(Array),
      }),
    ]);
    const { container } = render(<FlowGateVerdictCard verdict={verdict} />);
    expect(container.textContent).toContain(reason);
    expect(container.textContent).toContain('merge-readiness');
    expect(container.textContent).not.toContain('policy:readiness');
    expect(screen.queryByText('Flow gate passed')).toBeNull();
  },
);

describe('FlowGateVerdictCard', () => {
  test('historical empty-outcome fallback has no observed pass', () => {
    render(
      <FlowGateVerdictCard
        verdict={{
          runId: 'legacy',
          verdict: 'pass',
          summary: 'all gates passed',
        }}
      />,
    );
    expect(screen.getByText('No gate evaluation')).toBeTruthy();
    expect(screen.getByText('No gate outcome was recorded.')).toBeTruthy();
    expect(screen.queryByText('Flow gate passed')).toBeNull();
  });

  test('renders pass verdict with report paths and copy affordance', () => {
    const onCopy = vi.fn();
    render(
      <FlowGateVerdictCard
        verdict={{
          runId: 'session-thread-1',
          verdict: 'pass',
          summary: 'All gates satisfied.',
          reportPaths: {
            json: '.kontourai/flow/runs/session-thread-1/report.json',
            markdown: '.kontourai/flow/runs/session-thread-1/report.md',
          },
        }}
        onCopy={onCopy}
      />,
    );

    expect(screen.getByText('Flow gate passed')).toBeTruthy();
    expect(screen.getByText('All gates satisfied.')).toBeTruthy();
    expect(
      screen.getByText('.kontourai/flow/runs/session-thread-1/report.md'),
    ).toBeTruthy();
    expect(
      screen.getByText('.kontourai/flow/runs/session-thread-1/report.json'),
    ).toBeTruthy();

    const copyButtons = screen.getAllByRole('button', { name: /copy/i });
    expect(copyButtons.length).toBe(2);
    fireEvent.click(copyButtons[0]);
    expect(onCopy).toHaveBeenCalledWith(
      '.kontourai/flow/runs/session-thread-1/report.md',
    );
  });

  test('renders route-back verdict with guidance, attempts, and target step', () => {
    render(
      <FlowGateVerdictCard
        verdict={{
          runId: 'session-thread-1',
          verdict: 'route-back',
          gateId: 'verify',
          summary: 'Verification gate failed.',
          nextAction: 'Fix the failing unit tests, then request completion.',
          routeBackTo: 'implement',
          attempt: 2,
          maxAttempts: 3,
        }}
      />,
    );

    expect(screen.getByText('Flow gate routed work back')).toBeTruthy();
    expect(
      screen.getByText('Fix the failing unit tests, then request completion.'),
    ).toBeTruthy();
    expect(screen.getByText('attempt 2 of 3')).toBeTruthy();
    expect(screen.getByText('implement')).toBeTruthy();
    expect(screen.getByText('Gate: verify')).toBeTruthy();
  });

  test('renders block verdict with exception requirement', () => {
    render(
      <FlowGateVerdictCard
        verdict={{
          runId: 'session-thread-1',
          verdict: 'block',
          summary: 'Attempt budget exhausted.',
          exceptionRequired: true,
        }}
      />,
    );

    expect(screen.getByText('Flow gate blocked completion')).toBeTruthy();
    expect(screen.getByText('Attempt budget exhausted.')).toBeTruthy();
    expect(
      screen.getByText('A human-accepted exception is required to proceed.'),
    ).toBeTruthy();
  });

  test('renders wait verdict with missing expectations', () => {
    render(
      <FlowGateVerdictCard
        verdict={{
          runId: 'session-thread-1',
          verdict: 'wait',
          summary: 'Evidence still outstanding.',
          missing: ['tests-pass', 'lint-clean'],
        }}
      />,
    );

    expect(screen.getByText('Flow gate waiting on expectations')).toBeTruthy();
    expect(screen.getByText('Missing expectations:')).toBeTruthy();
    expect(screen.getByText('tests-pass')).toBeTruthy();
    expect(screen.getByText('lint-clean')).toBeTruthy();
  });
});
