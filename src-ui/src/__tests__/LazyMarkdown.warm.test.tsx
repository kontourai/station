/**
 * @vitest-environment jsdom
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import {
  LazyMarkdown,
  preloadMarkdownRenderer,
} from '../components/chat/LazyMarkdown';

describe('LazyMarkdown once its renderer has loaded', () => {
  test('a row that mounted cold keeps its rendered nodes across a later render', async () => {
    const view = render(<LazyMarkdown>{'**cold** row'}</LazyMarkdown>);
    await waitFor(() =>
      expect(screen.getByText('cold').tagName).toBe('STRONG'),
    );
    const before = screen.getByText('cold');
    // The renderer is now loaded; a re-render must not swap the element type
    // under the row (that remounts it: highlighting and parsing start over).
    view.rerender(<LazyMarkdown>{'**cold** row, grown'}</LazyMarkdown>);
    expect(screen.getByText('cold')).toBe(before);
  });

  test('a row mounted after the preload paints parsed on its first commit', async () => {
    await act(async () => {
      preloadMarkdownRenderer();
    });
    render(<LazyMarkdown>{'**warm** row'}</LazyMarkdown>);
    // No waiting: the first commit is already the rendered Markdown.
    expect(screen.getByText('warm').tagName).toBe('STRONG');
  });
});
