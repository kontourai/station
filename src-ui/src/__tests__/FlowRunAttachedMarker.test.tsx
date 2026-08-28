/**
 * @vitest-environment jsdom
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { FlowGatedChip } from '../components/flow/FlowGatedChip';
import { FlowRunAttachedMarker } from '../components/flow/FlowRunAttachedMarker';

describe('FlowRunAttachedMarker', () => {
  test('hides the retired station-delivery implementation identifier', () => {
    render(
      <FlowRunAttachedMarker
        binding={{
          runId: 'session-thread-1',
          definitionId: 'station-delivery',
          cwd: '/tmp/project',
          resumed: false,
        }}
      />,
    );

    expect(
      screen.getByRole('region', { name: 'Flow run attached' }),
    ).toBeTruthy();
    expect(screen.getByText(/Flow-gated session/)).toBeTruthy();
    expect(screen.getByText('Legacy delivery checks')).toBeTruthy();
    expect(screen.queryByText(/station-delivery/)).toBeNull();
    expect(screen.queryByText(/session-thread-1/)).toBeNull();
    expect(screen.queryByText(/resumed/)).toBeNull();
  });

  test('shows resumed when an existing run was re-attached', () => {
    render(
      <FlowRunAttachedMarker
        binding={{
          runId: 'session-thread-1',
          definitionId: 'station-delivery',
          resumed: true,
        }}
      />,
    );

    expect(screen.getByText(/Flow-gated session \(resumed\)/)).toBeTruthy();
  });

  /**
   * archive#189: the marker used to imply the session was being gated. A run
   * whose first step declares no gate is attached and stuck, and the marker
   * has to say so where an operator reads it.
   */
  test('states the gap for a never-evaluated run on a gateless step', () => {
    render(
      <FlowRunAttachedMarker
        binding={{
          runId: 'session-thread-1',
          definitionId: 'station-delivery',
          resumed: false,
          currentStep: 'plan',
          freshness: {
            lastEvaluatedAt: null,
            blockedReason: 'ungated-step',
            gateOutcomeCount: 0,
            evidenceCount: 0,
          },
        }}
      />,
    );

    expect(
      screen.getByText(/never evaluated — no gate on step plan/),
    ).toBeTruthy();
    expect(screen.queryByText(/Flow-gated session/)).toBeNull();
    expect(screen.getByText(/Flow-attached session/)).toBeTruthy();
  });

  test('states the evaluation time once a gate has been evaluated', () => {
    render(
      <FlowRunAttachedMarker
        binding={{
          runId: 'session-thread-1',
          definitionId: 'station-delivery',
          resumed: false,
          currentStep: 'verify',
          freshness: {
            lastEvaluatedAt: '2026-07-31T09:00:00.000Z',
            gateOutcomeCount: 2,
            evidenceCount: 3,
          },
        }}
      />,
    );

    expect(screen.getByText(/last evaluated/)).toBeTruthy();
    expect(screen.getByText(/Flow-gated session/)).toBeTruthy();
  });

  /**
   * `gateOutcomeCount` is Flow's per-gate-id record, which it REPLACES on
   * re-evaluation. Rendering it as a number of evaluations ("evaluated 2x")
   * would state something the data cannot support.
   */
  test('names gate outcomes rather than a count of evaluations', () => {
    render(
      <FlowRunAttachedMarker
        binding={{
          runId: 'session-thread-1',
          definitionId: 'station-delivery',
          resumed: false,
          currentStep: 'implement',
          freshness: {
            lastEvaluatedAt: null,
            gateOutcomeCount: 2,
            evidenceCount: 1,
          },
        }}
      />,
    );

    expect(screen.getByText(/2 gate outcomes, time unrecorded/)).toBeTruthy();
    expect(screen.queryByText(/evaluated 2/)).toBeNull();
    expect(screen.queryByText(/never evaluated/)).toBeNull();
  });
});

describe('FlowGatedChip', () => {
  test('reports evaluation as unknown when the server sent no freshness', () => {
    render(
      <FlowGatedChip
        binding={{
          runId: 'session-thread-1',
          definitionId: 'station-delivery',
          resumed: true,
        }}
      />,
    );

    const chip = screen.getByText('Flow-attached, evaluation unknown');
    expect(chip.getAttribute('title')).toContain('Legacy delivery checks');
    expect(chip.getAttribute('title')).not.toContain('station-delivery');
    expect(chip.getAttribute('title')).not.toContain('session-thread-1');
    expect(chip.getAttribute('title')).toContain('resumed');
    // No freshness reported: the chip must not imply the run is being gated.
    expect(chip.getAttribute('title')).toContain('not reported');
  });

  test('reads Flow-gated once a gate has been evaluated', () => {
    render(
      <FlowGatedChip
        binding={{
          runId: 'session-thread-1',
          definitionId: 'station-delivery',
          resumed: false,
          currentStep: 'verify',
          freshness: {
            lastEvaluatedAt: '2026-07-31T09:00:00.000Z',
            gateOutcomeCount: 1,
            evidenceCount: 1,
          },
        }}
      />,
    );

    expect(screen.getByText('Flow-gated')).toBeTruthy();
  });

  /**
   * The chip's label answers "is there a gate", which is independent of "has
   * it run yet". A gated step with nothing evaluated is still genuinely
   * Flow-gated; the tooltip is where the not-yet-evaluated part is stated.
   */
  test('still reads Flow-gated on a gated step with nothing evaluated yet', () => {
    render(
      <FlowGatedChip
        binding={{
          runId: 'session-thread-1',
          definitionId: 'station-delivery',
          resumed: false,
          currentStep: 'implement',
          freshness: {
            lastEvaluatedAt: null,
            gateOutcomeCount: 0,
            evidenceCount: 0,
          },
        }}
      />,
    );

    const chip = screen.getByText('Flow-gated');
    expect(chip.getAttribute('title')).toContain('never evaluated');
    expect(chip.getAttribute('title')).not.toContain('no gate on step');
  });

  test('reads as attached-not-gated when the run sits on a gateless step', () => {
    render(
      <FlowGatedChip
        binding={{
          runId: 'session-thread-1',
          definitionId: 'station-delivery',
          resumed: false,
          currentStep: 'plan',
          freshness: {
            lastEvaluatedAt: null,
            blockedReason: 'ungated-step',
            gateOutcomeCount: 0,
            evidenceCount: 0,
          },
        }}
      />,
    );

    const chip = screen.getByText('Flow-attached, ungated');
    expect(chip.getAttribute('title')).toContain(
      'never evaluated — no gate on step plan',
    );
  });
});
