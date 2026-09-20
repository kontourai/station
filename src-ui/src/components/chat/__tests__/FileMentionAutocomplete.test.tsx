// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { FileMentionAutocomplete } from '../FileMentionAutocomplete';

vi.mock('@kontourai/station-sdk/coding-file-mentions-query', () => ({
  useCodingFileMentionCandidatesQuery: () => ({
    data: {
      entries: [
        {
          name: 'src',
          path: 'src',
          type: 'directory',
          children: [
            {
              name: 'ChatInputArea.tsx',
              path: 'src/ChatInputArea.tsx',
              type: 'file',
            },
            { name: 'other.ts', path: 'src/other.ts', type: 'file' },
          ],
        },
      ],
      partial: false,
    },
    isLoading: false,
    isError: false,
  }),
}));

describe('FileMentionAutocomplete', () => {
  test('filters the bounded project tree and supports pointer selection', () => {
    const onSelect = vi.fn();
    const keyboardController = createRef<
      ((key: 'ArrowDown' | 'ArrowUp' | 'Enter') => void) | null
    >();
    render(
      <FileMentionAutocomplete
        workingDirectory="/repo/station"
        requestScope={{
          apiBase: 'http://station.test',
          authorityKey: 'owner',
          isCurrent: () => true,
        }}
        query="chatinput"
        keyboardController={keyboardController}
        onSelect={onSelect}
      />,
    );

    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.click(screen.getByRole('option', { name: /ChatInputArea\.tsx/ }));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'src/ChatInputArea.tsx', type: 'file' }),
    );
  });

  test('moves through results by keyboard and selects the active row', () => {
    const onSelect = vi.fn();
    const keyboardController = createRef<
      ((key: 'ArrowDown' | 'ArrowUp' | 'Enter') => void) | null
    >();
    render(
      <FileMentionAutocomplete
        workingDirectory="/repo/station"
        requestScope={{
          apiBase: 'http://station.test',
          authorityKey: 'owner',
          isCurrent: () => true,
        }}
        query="src"
        keyboardController={keyboardController}
        onSelect={onSelect}
      />,
    );

    keyboardController.current?.('ArrowDown');
    keyboardController.current?.('Enter');
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'src/other.ts' }),
    );
  });
});
