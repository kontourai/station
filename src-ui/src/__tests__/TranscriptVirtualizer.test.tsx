// @vitest-environment jsdom

import { render, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { TranscriptVirtualizer } from '../components/chat/TranscriptVirtualizer';

const { scrollToIndex } = vi.hoisted(() => ({ scrollToIndex: vi.fn() }));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => [{ index: 0, key: 'message-0', start: 0, size: 88 }],
    getTotalSize: () => 88,
    getVirtualItemForOffset: () => ({ index: 0, start: 0 }),
    measure: vi.fn(),
    measureElement: vi.fn(),
    scrollOffset: 0,
    scrollToIndex,
    scrollToOffset: vi.fn(),
  }),
}));

describe('TranscriptVirtualizer (station#1238)', () => {
  test('keeps a 10,000-row fixture bounded to the viewport window', () => {
    const scrollElement = createRef<HTMLDivElement>();
    const rows = Array.from({ length: 10_000 }, (_, index) => ({
      id: `message-${index}`,
      kind: index % 2 === 0 ? 'message:user' : 'message:assistant',
    }));
    const view = render(
      <div ref={scrollElement} style={{ height: 600, overflow: 'auto' }}>
        <TranscriptVirtualizer
          rows={rows}
          scrollElement={scrollElement}
          renderRow={(row) => <article>{row.id}</article>}
        />
      </div>,
    );

    expect(
      view.container.querySelectorAll('[data-transcript-row]').length,
    ).toBeLessThan(40);
    expect(
      view.container.querySelector('[data-transcript-row="message-0"]'),
    ).toBeTruthy();
  });

  test('reveals a routed row through the virtualizer index API', async () => {
    const scrollElement = createRef<HTMLDivElement>();
    const rows = Array.from({ length: 100 }, (_, index) => ({
      id: `message-${index}`,
      kind: 'message:user',
    }));
    render(
      <div ref={scrollElement}>
        <TranscriptVirtualizer
          rows={rows}
          scrollElement={scrollElement}
          revealRowId="message-73"
          renderRow={(row) => <article>{row.id}</article>}
        />
      </div>,
    );

    await waitFor(() => {
      expect(scrollToIndex).toHaveBeenCalledWith(73, { align: 'center' });
    });
  });
});
