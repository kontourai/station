/** @vitest-environment jsdom */
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../../../tests/helpers/css-cascade-fixture';

const hooks = vi.hoisted(() => ({
  apply: vi.fn(),
  preview: vi.fn(),
  rollback: vi.fn(),
  review: vi.fn(),
  resetApply: vi.fn(),
  resetPreview: vi.fn(),
  resetRollback: vi.fn(),
  resetReview: vi.fn(),
  refetchSources: vi.fn(),
  sourcesError: false,
  applyError: false,
  /** Set while a test renders the stepper before any preview exists. */
  noPreviewYet: false,
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
    isError: hooks.sourcesError,
    error: new Error('Could not check existing setup'),
    refetch: hooks.refetchSources,
  }),
  useCreateSetupImportPreviewMutation: () => ({
    data: hooks.noPreviewYet ? undefined : preview,
    isPending: false,
    isError: false,
    mutate: hooks.preview,
    reset: hooks.resetPreview,
  }),
  useApplySetupImportMutation: () => ({
    isPending: false,
    isError: hooks.applyError,
    error: new Error('Import response unavailable'),
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
  beforeEach(() => {
    hooks.sourcesError = false;
    hooks.applyError = false;
    hooks.review.mockReset();
    hooks.apply.mockReset();
  });

  test('offers a source-check retry instead of hiding a failed read', () => {
    hooks.sourcesError = true;
    render(<ExistingSetupImportStepper />);
    const failure = screen.getByRole('alert').textContent;
    expect(failure).toContain('Existing setup unavailable');
    expect(failure).toContain('Try again in a moment.');
    expect(failure).not.toContain('Could not check existing setup');
    fireEvent.click(screen.getByRole('button', { name: 'Retry setup check' }));
    expect(hooks.refetchSources).toHaveBeenCalledTimes(1);
  });

  test.each(['selection', 'rename'] as const)(
    'requires another review after changing the %s',
    (change) => {
      hooks.review.mockImplementation((_input, options) =>
        options.onSuccess({
          preview,
          witness: { id: 'witness-old', expiresAt: 'later', items: [] },
        }),
      );
      render(<ExistingSetupImportStepper />);
      fireEvent.click(screen.getByLabelText('two.md'));
      fireEvent.change(
        screen.getByLabelText('New Station Skill name for two.md'),
        { target: { value: 'two-renamed' } },
      );
      fireEvent.click(screen.getByRole('button', { name: 'Review targets' }));
      expect(
        screen.getByRole('button', { name: 'Apply reviewed targets' }),
      ).toBeTruthy();
      if (change === 'selection')
        fireEvent.click(screen.getByLabelText('one.md'));
      else
        fireEvent.change(
          screen.getByLabelText('New Station Skill name for two.md'),
          { target: { value: 'changed-name' } },
        );
      expect(
        screen.queryByRole('button', { name: 'Apply reviewed targets' }),
      ).toBeNull();
      expect(hooks.apply).not.toHaveBeenCalled();
    },
  );

  test('ignores a review response that arrives after choices change', () => {
    let resolveReview: (() => void) | undefined;
    hooks.review.mockImplementation((_input, options) => {
      resolveReview = () =>
        options.onSuccess({
          preview,
          witness: { id: 'witness-old', expiresAt: 'later', items: [] },
        });
    });
    render(<ExistingSetupImportStepper />);
    fireEvent.click(screen.getByRole('button', { name: 'Review targets' }));
    fireEvent.click(screen.getByLabelText('one.md'));
    expect(resolveReview).toBeTypeOf('function');
    act(() => resolveReview?.());
    expect(
      screen.queryByRole('button', { name: 'Apply reviewed targets' }),
    ).toBeNull();
    expect(hooks.apply).not.toHaveBeenCalled();
  });

  test('shows an apply failure without replaying it or discarding the choices', () => {
    hooks.review.mockImplementation((_input, options) =>
      options.onSuccess({
        preview,
        witness: { id: 'witness-1', expiresAt: 'later', items: [] },
      }),
    );
    const { rerender } = render(<ExistingSetupImportStepper />);
    fireEvent.click(screen.getByRole('button', { name: 'Review targets' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Apply reviewed targets' }),
    );
    hooks.applyError = true;
    rerender(<ExistingSetupImportStepper />);
    const failure = screen.getByRole('alert').textContent;
    expect(failure).toContain('Import outcome unavailable');
    expect(failure).toContain('Try again in a moment.');
    expect(failure).toContain(
      'Check installed Skills before starting another import.',
    );
    expect(failure).not.toContain('Import response unavailable');
    expect(screen.getByLabelText('one.md')).toHaveProperty('checked', true);
    expect(hooks.apply).toHaveBeenCalledTimes(1);
  });

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

  test('keeps review controls labelled', () => {
    render(<ExistingSetupImportStepper compact />);

    expect(screen.getByLabelText('one.md')).toHaveProperty('type', 'checkbox');
    expect(screen.getByRole('status')).toBeTruthy();
  });

  test('a receipt summary counts only what happened and sends an unknown outcome to Skills', () => {
    const receipt = {
      id: 'receipt-2',
      createdAt: 'now',
      previewId: 'preview-1',
      retryable: false,
      items: [
        {
          sourceId: 'one',
          reviewedTarget: 'one',
          state: 'applied' as const,
          outcome: 'imported' as const,
          rollback: { state: 'available' as const, retryable: false },
        },
        {
          sourceId: 'two',
          reviewedTarget: 'two',
          state: 'indeterminate' as const,
          outcome: 'indeterminate' as const,
          rollback: { state: 'indeterminate' as const, retryable: false },
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
    render(<ExistingSetupImportStepper />);
    fireEvent.click(screen.getByRole('button', { name: 'Review targets' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Apply reviewed targets' }),
    );
    expect(screen.getByRole('heading', { name: 'Import result' })).toBeTruthy();
    expect(
      screen.getByText('1 imported; 1 unknown, check Skills.'),
    ).toBeTruthy();
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
    // Only outcomes that happened are counted; zero counts are left out.
    expect(screen.getByText('1 failed; 1 rolled back.')).toBeTruthy();
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

const chromiumAvailable = chromiumIsInstalled(process.cwd());

/**
 * The phone breakpoint, measured in real Chromium over the cascade-resolved
 * `index.css` and the stepper's own sheet (jsdom does no layout). Before a
 * preview exists the heading carries the stepper's first action; at 640px and
 * below the heading stacks and that action takes the full width instead of
 * squeezing beside the copy. The later workflow rows are the responsive
 * primitive's, pinned above.
 */
describe.skipIf(!chromiumAvailable)(
  'ExistingSetupImportStepper at the phone breakpoint',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;

    beforeAll(async () => {
      browser = await chromium.launch();
    });

    afterAll(async () => {
      await browser?.close();
    });

    test('the heading action spans the stacked heading', async () => {
      hooks.noPreviewYet = true;
      let markup: string;
      try {
        const { container, unmount } = render(
          <ExistingSetupImportStepper compact />,
        );
        markup = container.innerHTML;
        unmount();
      } finally {
        hooks.noPreviewYet = false;
      }
      const css = [
        resolve('src-ui/src/index.css'),
        resolve('src-ui/src/components/setup/ExistingSetupImportStepper.css'),
      ]
        .map((path) => resolveCssImports(path))
        .join('\n');
      assertNoImportsSurvive(css);

      const page = await browser.newPage({
        viewport: { width: 390, height: 600 },
      });
      try {
        await page.setContent(`<!doctype html>
<html>
  <head><style>${css}</style></head>
  <body style="margin:0">${markup}</body>
</html>`);
        const measured = await page.evaluate(() => {
          const heading = document.querySelector<HTMLElement>(
            '.existing-setup-import__heading',
          );
          const action = heading?.querySelector('button');
          const copy = heading?.firstElementChild;
          if (!heading || !action || !copy)
            throw new Error('the heading action did not render');
          const style = getComputedStyle(heading);
          return {
            headingWidth:
              heading.getBoundingClientRect().width -
              Number.parseFloat(style.paddingLeft) -
              Number.parseFloat(style.paddingRight),
            actionWidth: action.getBoundingClientRect().width,
            actionTop: action.getBoundingClientRect().top,
            copyBottom: copy.getBoundingClientRect().bottom,
          };
        });
        expect(measured.actionTop).toBeGreaterThanOrEqual(measured.copyBottom);
        expect(measured.actionWidth).toBeCloseTo(measured.headingWidth, 0);
      } finally {
        await page.close();
      }
    });
  },
);

test.skipIf(chromiumAvailable)(
  'ExistingSetupImportStepper phone geometry — Chromium not installed, cannot verify',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the ' +
        'stepper heading geometry could not be checked. This is a missing ' +
        'precondition, not a passing check. Install it with ' +
        '`npm run install:playwright` and re-run.',
    );
  },
);
