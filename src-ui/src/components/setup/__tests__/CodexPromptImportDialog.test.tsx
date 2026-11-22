/** @vitest-environment jsdom */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// The preview, review, apply and undo shapes are the SDK client's own
// projections of the server's records (see `setup-imports.routes.test.ts`
// for the same flow against the real module).
const preview = {
  id: 'preview-1',
  createdAt: '2026-11-22T00:00:00.000Z',
  expiresAt: '2026-11-22T00:15:00.000Z',
  excluded: { 'not-markdown': 1 },
  warnings: ['excluded:not-markdown'],
  entries: [
    {
      id: 'review',
      name: 'review-pr.md',
      size: 32,
      digest: 'a'.repeat(64),
      skillName: 'review-pr',
      collision: false,
      warnings: [],
    },
    {
      id: 'tests',
      name: 'write-tests.md',
      size: 40,
      digest: 'b'.repeat(64),
      skillName: 'write-tests',
      collision: false,
      warnings: [],
    },
    {
      id: 'changelog',
      name: 'changelog.md',
      size: 64,
      digest: 'c'.repeat(64),
      skillName: 'changelog',
      collision: true,
      warnings: ['target-collision'],
    },
  ],
};

function importedItem(sourceId: string, target: string) {
  return {
    sourceId,
    reviewedTarget: target,
    state: 'applied',
    outcome: 'imported',
    targetRevision: 'd'.repeat(64),
    rollback: { state: 'available', retryable: true },
  };
}
const receipt = {
  id: 'receipt-1',
  createdAt: '2026-11-22T00:01:00.000Z',
  previewId: 'preview-1',
  retryable: true,
  items: [
    importedItem('review', 'review-pr'),
    {
      sourceId: 'tests',
      reviewedTarget: 'write-tests',
      state: 'skipped',
      outcome: 'skipped',
      rollback: { state: 'failed', retryable: false },
    },
    importedItem('changelog', 'changelog-codex'),
  ],
};
const undone = {
  ...receipt,
  retryable: false,
  rolledBackAt: '2026-11-22T00:02:00.000Z',
  items: receipt.items.map((item) =>
    item.outcome === 'imported'
      ? {
          ...item,
          state: 'compensated',
          outcome: 'rolled-back',
          rollback: { state: 'applied', retryable: false },
        }
      : item,
  ),
};

type Callbacks<T> = { onSuccess?: (value: T) => void };
const hooks = vi.hoisted(() => ({
  preview: vi.fn(),
  review: vi.fn(),
  apply: vi.fn(),
  rollback: vi.fn(),
  previewData: undefined as unknown,
}));

vi.mock('@kontourai/station-sdk/setup-imports-query', () => ({
  useCreateSetupImportPreviewMutation: () => ({
    data: hooks.previewData,
    isPending: false,
    isError: false,
    mutate: hooks.preview,
  }),
  useReviewSetupImportTargetsMutation: () => ({
    isPending: false,
    isError: false,
    mutate: hooks.review,
  }),
  useApplySetupImportMutation: () => ({
    isPending: false,
    isError: false,
    mutate: hooks.apply,
  }),
  useRollbackSetupImportMutation: () => ({
    isPending: false,
    isError: false,
    mutate: hooks.rollback,
  }),
}));

import { CodexPromptImportDialog } from '../CodexPromptImportDialog';

function renderDialog() {
  render(<CodexPromptImportDialog open onClose={() => {}} />);
  return screen.getByRole('dialog');
}

describe('CodexPromptImportDialog', () => {
  beforeEach(() => {
    hooks.preview.mockReset();
    hooks.previewData = preview;
    hooks.review.mockReset();
    hooks.apply.mockReset();
    hooks.rollback.mockReset();
    hooks.review.mockImplementation(
      (_input, options: Callbacks<{ witness: { id: string } }>) =>
        options.onSuccess?.({ witness: { id: 'witness-1' } }),
    );
    hooks.apply.mockImplementation((_input, options: Callbacks<unknown>) =>
      options.onSuccess?.(receipt),
    );
    hooks.rollback.mockImplementation((_id, options: Callbacks<unknown>) =>
      options.onSuccess?.(undone),
    );
  });

  test('looks for Codex prompts on open and starts with nothing selected', () => {
    const dialog = renderDialog();
    expect(hooks.preview).toHaveBeenCalledWith('codex-prompts');
    expect(
      within(dialog).getByRole('heading', {
        name: 'Import your Codex prompts as skills',
      }),
    ).toBeTruthy();
    for (const box of within(dialog).getAllByRole('checkbox'))
      expect((box as HTMLInputElement).checked).toBe(false);
    expect(within(dialog).getByText('0 of 3 selected')).toBeTruthy();
    const importButton = within(dialog).getByRole('button', {
      name: 'Import 0 skills',
    }) as HTMLButtonElement;
    expect(importButton.disabled).toBe(true);
    expect(within(dialog).getByText(/undo the whole import/)).toBeTruthy();
  });

  test('solves a name conflict inline: typing a new name picks the prompt', () => {
    const dialog = renderDialog();
    expect(within(dialog).getByText('Needs a name')).toBeTruthy();
    expect(
      within(dialog).getByText(/You already have a skill called “changelog”/),
    ).toBeTruthy();
    const rename = within(dialog).getByRole('textbox', {
      name: 'New name for changelog',
    }) as HTMLInputElement;
    expect(rename.value).toBe('changelog-codex');

    fireEvent.change(rename, { target: { value: '' } });
    expect(
      within(dialog).getByText('Type a name, or untick to skip this prompt.'),
    ).toBeTruthy();
    expect(
      (
        within(dialog).getByRole('checkbox', {
          name: 'changelog',
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      (
        within(dialog).getByRole('button', {
          name: 'Import 1 skill',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    fireEvent.change(rename, { target: { value: 'changelog-from-codex' } });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Import 1 skill' }),
    );
    expect(hooks.review).toHaveBeenCalledWith(
      {
        previewId: 'preview-1',
        items: [
          { id: 'review', action: 'skip' },
          { id: 'tests', action: 'skip' },
          {
            id: 'changelog',
            action: 'import',
            targetName: 'changelog-from-codex',
          },
        ],
      },
      expect.anything(),
    );
  });

  test('imports the picked prompts in one action, then undoes the whole import', () => {
    const dialog = renderDialog();
    fireEvent.click(
      within(dialog).getByRole('checkbox', { name: 'review-pr' }),
    );
    fireEvent.click(
      within(dialog).getByRole('checkbox', { name: 'changelog' }),
    );
    expect(within(dialog).getByText('2 of 3 selected')).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Import 2 skills' }),
    );

    expect(hooks.review.mock.calls[0]![0].items).toEqual([
      { id: 'review', action: 'import', targetName: 'review-pr' },
      { id: 'tests', action: 'skip' },
      { id: 'changelog', action: 'import', targetName: 'changelog-codex' },
    ]);
    expect(hooks.apply).toHaveBeenCalledWith(
      { previewId: 'preview-1', witnessId: 'witness-1' },
      expect.anything(),
    );

    const result = screen.getByRole('dialog');
    expect(within(result).getByText('Imported 2 skills.')).toBeTruthy();
    expect(within(result).getAllByText('Imported')).toHaveLength(2);
    expect(within(result).queryByText('write-tests')).toBeNull();

    fireEvent.click(
      within(result).getByRole('button', { name: 'Undo import' }),
    );
    expect(hooks.rollback).toHaveBeenCalledWith('receipt-1', expect.anything());
    expect(
      within(screen.getByRole('dialog')).getByText(
        'Import undone. 2 skills removed.',
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('dialog')).queryByRole('button', {
        name: 'Undo import',
      }),
    ).toBeNull();
  });

  test('two picked prompts cannot take the same name', () => {
    const dialog = renderDialog();
    fireEvent.click(
      within(dialog).getByRole('checkbox', { name: 'review-pr' }),
    );
    fireEvent.change(
      within(dialog).getByRole('textbox', { name: 'New name for changelog' }),
      { target: { value: 'review-pr' } },
    );
    expect(
      within(dialog).getAllByText('Another selected prompt uses this name.'),
    ).toHaveLength(2);
    expect(
      (
        within(dialog).getByRole('button', {
          name: 'Import 2 skills',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  test('with no prompts to import there is nothing to commit, only Close', () => {
    hooks.previewData = { ...preview, entries: [], excluded: {}, warnings: [] };
    const dialog = renderDialog();
    expect(
      within(dialog).getByText(
        'Codex has no saved prompts Station can import.',
      ),
    ).toBeTruthy();
    expect(
      within(dialog).queryByRole('button', { name: /^Import/ }),
    ).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeTruthy();
  });
});
