/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { FlowGateVerdictCard } from '../components/flow/FlowGateVerdictCard';

describe('FlowGateVerdictCard', () => {
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

    expect(screen.getByText('Flow gates passed')).toBeTruthy();
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
