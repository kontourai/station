/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  apply: vi.fn(),
  preview: vi.fn(),
  rollback: vi.fn(),
  review: vi.fn(),
  resetApply: vi.fn(),
  resetPreview: vi.fn(),
  resetRollback: vi.fn(),
  resetReview: vi.fn(),
}));
const preview = {
  id: 'preview-1',
  createdAt: 'now',
  expiresAt: 'later',
  excluded: { 'not-markdown': 1 },
  warnings: ['excluded:not-markdown'],
  entries: [
    {
      id: 'one',
      name: 'one.md',
      size: 32,
      digest: 'a'.repeat(64),
      skillName: 'one',
      collision: false,
      warnings: [],
    },
    {
      id: 'two',
      name: 'two.md',
      size: 64,
      digest: 'b'.repeat(64),
      skillName: 'two',
      collision: true,
      warnings: ['target-collision'],
    },
  ],
};

vi.mock('@kontourai/station-sdk/setup-imports-query', () => ({
  useSetupImportSourcesQuery: () => ({
    data: [{ id: 'codex-prompts', available: true }],
    isLoading: false,
    isError: false,
  }),
  useCreateSetupImportPreviewMutation: () => ({
    data: preview,
    isPending: false,
    isError: false,
    mutate: hooks.preview,
    reset: hooks.resetPreview,
  }),
  useApplySetupImportMutation: () => ({
    isPending: false,
    isError: false,
    mutate: hooks.apply,
    reset: hooks.resetApply,
  }),
  useReviewSetupImportTargetsMutation: () => ({
    data: undefined,
    isPending: false,
    isError: false,
    mutate: hooks.review,
    reset: hooks.resetReview,
  }),
  useRollbackSetupImportMutation: () => ({
    isPending: false,
    isError: false,
    mutate: hooks.rollback,
    reset: hooks.resetRollback,
  }),
}));

import { ExistingSetupImportStepper } from '../ExistingSetupImportStepper';

function expectResponsiveActionRow(button: HTMLElement) {
  const row = button.closest('.existing-setup-import__actions');
  expect(row?.className).toContain('existing-setup-import__actions');
  expect(row?.className).toContain('responsive-surface-actions');
}

describe('ExistingSetupImportStepper', () => {
  test('requires an explicit checkbox decision and a valid rename for collisions', () => {
    render(<ExistingSetupImportStepper />);

    expect(screen.getByText(/1 excluded/)).toBeTruthy();
    const apply = screen.getByRole('button', { name: 'Review targets' });
    expect((apply as HTMLButtonElement).disabled).toBe(false);
    expectResponsiveActionRow(apply);
    expectResponsiveActionRow(
      screen.getByRole('button', { name: 'Start over' }),
    );

    // These are native checkbox inputs, so keyboard users get the browser's
    // Space-toggle behavior rather than a mouse-only row handler.
    const collisionCheckbox = screen.getByLabelText('two.md');
    collisionCheckbox.focus();
    expect(document.activeElement).toBe(collisionCheckbox);

    fireEvent.keyDown(collisionCheckbox, { key: ' ' });
    fireEvent.click(collisionCheckbox);
    expect((apply as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(
      screen.getByLabelText('New Station Skill name for two.md'),
      {
        target: { value: 'two-renamed' },
      },
    );
    expect((apply as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(apply);

    expect(hooks.review).toHaveBeenCalledWith(
      {
        previewId: 'preview-1',
        items: [
          { id: 'one', action: 'import', targetName: 'one' },
          { id: 'two', action: 'import', targetName: 'two-renamed' },
        ],
      },
      expect.any(Object),
    );
  });

  test('keeps controls labelled and actions fluid at the phone breakpoint', () => {
    render(<ExistingSetupImportStepper compact />);

    expect(screen.getByLabelText('one.md')).toHaveProperty('type', 'checkbox');
    expect(screen.getByRole('status')).toBeTruthy();
    const styles = readFileSync(
      join(
        process.cwd(),
        'src-ui/src/components/setup/ExistingSetupImportStepper.css',
      ),
      'utf8',
    );
    expect(styles).toContain('@media (max-width: 640px)');
    expect(styles).toContain('.existing-setup-import__heading .button');
    expect(styles).not.toContain('.existing-setup-import__actions .button');
  });

  test('keeps every workflow action row on the responsive primitive through review, apply, rollback, and reset', () => {
    const receipt = {
      id: 'receipt-1',
      createdAt: 'now',
      previewId: 'preview-1',
      retryable: true,
      items: [
        {
          sourceId: 'one',
          reviewedTarget: 'one',
          state: 'compensated' as const,
          outcome: 'rolled-back' as const,
          reasonCode: 'rollback-applied',
          targetRevision: 'a'.repeat(64),
          rollback: { state: 'applied' as const, retryable: false },
        },
        {
          sourceId: 'two',
          reviewedTarget: 'two-renamed',
          state: 'failed' as const,
          outcome: 'failed' as const,
          reasonCode: 'target-conflict',
          repairCode: 'choose-different-target',
          rollback: { state: 'failed' as const, retryable: false },
        },
      ],
    };
    hooks.apply.mockImplementation((_input, options) =>
      options?.onSuccess?.(receipt),
    );
    hooks.review.mockImplementation((_input, options) =>
      options?.onSuccess?.({
        preview,
        witness: { id: 'witness-1', expiresAt: 'later', items: [] },
      }),
    );
    hooks.rollback.mockImplementation((_receiptId, options) =>
      options?.onSuccess?.({
        ...receipt,
        retryable: false,
        rolledBackAt: 'later',
      }),
    );
    render(<ExistingSetupImportStepper />);

    const review = screen.getByRole('button', { name: 'Review targets' });
    expectResponsiveActionRow(review);
    fireEvent.click(review);
    const apply = screen.getByRole('button', {
      name: 'Apply reviewed targets',
    });
    expectResponsiveActionRow(apply);
    fireEvent.click(apply);
    expect(screen.getByText(/one — rolled-back/)).toBeTruthy();
    expect(screen.getByText(/two — failed/)).toBeTruthy();
    expect(screen.getByText(/repair: choose-different-target/)).toBeTruthy();
    expect(
      screen.queryByText('Station did not publish an itemized outcome'),
    ).toBeNull();
    const rollback = screen.getByRole('button', {
      name: 'Roll back imported items',
    });
    expectResponsiveActionRow(rollback);
    fireEvent.click(rollback);
    expect(hooks.rollback).toHaveBeenCalledWith(
      'receipt-1',
      expect.any(Object),
    );

    const reset = screen.getByRole('button', {
      name: 'Import another preview',
    });
    expectResponsiveActionRow(reset);
    fireEvent.click(reset);
    expect(hooks.resetPreview).toHaveBeenCalled();
    expect(hooks.resetApply).toHaveBeenCalled();
    expect(hooks.resetRollback).toHaveBeenCalled();
  });
});
