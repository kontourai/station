// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { FileMentionAutocomplete } from '../FileMentionAutocomplete';

const mentionQuery = vi.hoisted(() => ({
  result: {
    data: {
      entries: [
        {
          name: 'src',
          path: 'src',
          type: 'directory' as const,
          children: [
            {
              name: 'ChatInputArea.tsx',
              path: 'src/ChatInputArea.tsx',
              type: 'file' as const,
            },
            { name: 'other.ts', path: 'src/other.ts', type: 'file' as const },
          ],
        },
      ],
      partial: false,
    },
    isLoading: false,
    isError: false,
  },
}));

vi.mock('@kontourai/station-sdk/coding-file-mentions-query', () => ({
  useCodingFileMentionCandidatesQuery: () => mentionQuery.result,
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

  test('retains keyboard navigation while matching suggestions are loading', () => {
    const onSelect = vi.fn();
    const keyboardController = createRef<
      ((key: 'ArrowDown' | 'ArrowUp' | 'Enter') => void) | null
    >();
    const ready = mentionQuery.result;
    mentionQuery.result = {
      data: undefined,
      isLoading: true,
      isError: false,
    } as unknown as typeof ready;
    const view = render(
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
    mentionQuery.result = ready;
    view.rerender(
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
    expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe(
      'true',
    );
    keyboardController.current?.('Enter');
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'src/other.ts' }),
    );
  });
});
