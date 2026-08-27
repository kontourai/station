/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ImportSkillsModal } from '../components/modals/ImportSkillsModal';

function file(name: string, content: string) {
  return new File([content], name, { type: 'text/markdown' });
}

function chooseFiles(files: File[]) {
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

describe('ImportSkillsModal', () => {
  test('sends the chosen .md files verbatim in one request', async () => {
    const onImport = vi.fn();
    render(
      <ImportSkillsModal
        isOpen
        pending={false}
        results={null}
        onImport={onImport}
        onCancel={vi.fn()}
      />,
    );

    chooseFiles([
      file('release-check.md', '---\nname: release-check\n---\nShip it'),
      file('notes.md', 'Just a body'),
      // Not markdown: never offered to an importer that only reads `.md`.
      file('picture.png', 'binary'),
    ]);

    await waitFor(() =>
      expect(screen.getByText('2 files to import')).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Import 2' }));

    expect(onImport).toHaveBeenCalledWith([
      {
        filename: 'release-check.md',
        content: '---\nname: release-check\n---\nShip it',
      },
      { filename: 'notes.md', content: 'Just a body' },
    ]);
  });

  // `POST /api/skills/import` answers 207 when some files landed and some did
  // not. A toast saying "imported 1" over a 207 hides which file failed and
  // why — the per-file rows ARE the answer.
  test('shows every per-file result, including the failures in a partial import', () => {
    render(
      <ImportSkillsModal
        isOpen
        pending={false}
        results={[
          {
            filename: 'release-check.md',
            success: true,
            name: 'release-check',
          },
          {
            filename: 'dupe.md',
            success: false,
            name: 'release-check',
            error: "Skill 'release-check' already exists",
          },
          { filename: 'empty.md', success: false, error: 'File has no body' },
        ]}
        onImport={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(
      screen.getByText('release-check.md — imported as release-check'),
    ).toBeTruthy();
    expect(
      screen.getByText("dupe.md — Skill 'release-check' already exists"),
    ).toBeTruthy();
    expect(screen.getByText('empty.md — File has no body')).toBeTruthy();
  });

  test('the primary action reports the request in flight', () => {
    render(
      <ImportSkillsModal
        isOpen
        pending
        results={null}
        onImport={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText('Importing…')).toBeTruthy();
  });
});
