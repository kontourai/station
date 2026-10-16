// @vitest-environment jsdom

import { render, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { TranscriptVirtualizer } from '../components/chat/TranscriptVirtualizer';

const { scrollToIndex, instances, renderedOptions } = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  instances: [] as Array<Record<string, unknown>>,
  renderedOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: Record<string, unknown>) => {
    renderedOptions.push(options);
    const instance = {
      getVirtualItems: () => [
        { index: 0, key: 'message-0', start: 0, size: 88 },
      ],
      getTotalSize: () => 88,
      getVirtualItemForOffset: () => ({ index: 0, start: 0 }),
      measure: vi.fn(),
      measureElement: vi.fn(),
      scrollOffset: 0,
      scrollToIndex,
      scrollToOffset: vi.fn(),
    };
    instances.push(instance);
    return instance;
  },
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

  test('re-requests the tail when content grows without adding rows', async () => {
    scrollToIndex.mockClear();
    const scrollElement = createRef<HTMLDivElement>();
    const rows = Array.from({ length: 100 }, (_, index) => ({
      id: `message-${index}`,
      kind: 'message:user',
    }));
    const view = render(
      <div ref={scrollElement}>
        <TranscriptVirtualizer
          rows={rows}
          scrollElement={scrollElement}
          renderRow={(row) => <article>{row.id}</article>}
          followTail
          followTick="10:1"
        />
      </div>,
    );

    await waitFor(() => {
      expect(scrollToIndex).toHaveBeenCalledWith(99, { align: 'end' });
    });
    scrollToIndex.mockClear();
    // A projected live turn streams into its tail row: same row count, new
    // growth signal — the follow must re-fire, not wait for another row.
    view.rerender(
      <div ref={scrollElement}>
        <TranscriptVirtualizer
          rows={rows}
          scrollElement={scrollElement}
          renderRow={(row) => <article>{row.id}</article>}
          followTail
          followTick="20:1"
        />
      </div>,
    );
    await waitFor(() => {
      expect(scrollToIndex).toHaveBeenCalledWith(99, { align: 'end' });
    });
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

  // @tanstack/virtual-core (3.17.11) reads this hook from the INSTANCE; passed among
  // the options it is never called and TanStack's default compensation runs.
  test('installs keyed size compensation on the virtualizer instance', () => {
    instances.length = 0;
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
          renderRow={(row) => <article>{row.id}</article>}
          followTail
        />
      </div>,
    );
    const shouldAdjust = instances.at(-1)
      ?.shouldAdjustScrollPositionOnItemSizeChange as
      | ((
          item: { index: number; start: number; size: number; key: string },
          delta: number,
          instance: {
            scrollOffset: number;
            scrollAdjustments: number;
            itemSizeCache: Map<string, number>;
            scrollDirection: 'forward' | 'backward' | null;
          },
        ) => boolean)
      | undefined;
    expect(shouldAdjust, 'an instance hook').toBeTypeOf('function');
    // Following the tail, a row that starts above the viewport is compensated
    // and one below it is not.
    expect(
      shouldAdjust!({ index: 3, start: 200, size: 100, key: 'message-3' }, 40, {
        scrollOffset: 500,
        scrollAdjustments: 0,
        itemSizeCache: new Map(),
        scrollDirection: null,
      }),
    ).toBe(true);
    expect(
      shouldAdjust!({ index: 9, start: 900, size: 100, key: 'message-9' }, 40, {
        scrollOffset: 500,
        scrollAdjustments: 0,
        itemSizeCache: new Map(),
        scrollDirection: null,
      }),
    ).toBe(false);
    // A re-measured row that spans the fold (a streaming answer growing
    // below the reader) is not compensated; one entirely above it is.
    const measured = new Map([
      ['message-4', 100],
      ['message-2', 100],
    ]);
    expect(
      shouldAdjust!({ index: 4, start: 450, size: 100, key: 'message-4' }, 40, {
        scrollOffset: 500,
        scrollAdjustments: 0,
        itemSizeCache: measured,
        scrollDirection: 'forward',
      }),
    ).toBe(false);
    expect(
      shouldAdjust!({ index: 2, start: 300, size: 100, key: 'message-2' }, 40, {
        scrollOffset: 500,
        scrollAdjustments: 0,
        itemSizeCache: measured,
        scrollDirection: 'forward',
      }),
    ).toBe(true);
    // Not while the reader scrolls backward (TanStack's "items jump while
    // scrolling up" guard).
    expect(
      shouldAdjust!({ index: 2, start: 300, size: 100, key: 'message-2' }, 40, {
        scrollOffset: 500,
        scrollAdjustments: 0,
        itemSizeCache: measured,
        scrollDirection: 'backward',
      }),
    ).toBe(false);
    // Earlier measurements in the same batch already moved the fold.
    expect(
      shouldAdjust!({ index: 6, start: 600, size: 100, key: 'message-6' }, 40, {
        scrollOffset: 500,
        scrollAdjustments: 150,
        itemSizeCache: new Map(),
        scrollDirection: null,
      }),
    ).toBe(true);
  });

  test("mounting under a reader starts its first range at the reader's row", () => {
    // The handed-over row is then held by the keyed reconcile's observers.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const scrollElement = createRef<HTMLDivElement>();
    const rows = Array.from({ length: 60 }, (_, index) => ({
      id: `message-${index}`,
      kind: index % 2 === 0 ? 'message:user' : 'message:assistant',
    }));
    // The direct-layout transcript being replaced: scrolled, its first row
    // 68px below the content top (history controls).
    const view = render(
      <div ref={scrollElement}>
        <div data-chat-message-key="old-row" />
      </div>,
    );
    const container = scrollElement.current!;
    container.scrollTop = 500;
    container.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    container.querySelector<HTMLElement>(
      '[data-chat-message-key]',
    )!.getBoundingClientRect = () => ({ top: 68 - 500 }) as DOMRect;
    renderedOptions.length = 0;
    view.rerender(
      <div ref={scrollElement}>
        <TranscriptVirtualizer
          rows={rows}
          scrollElement={scrollElement}
          renderRow={(row) => <article>{row.id}</article>}
          initialAnchor={{ key: 'message-41', offset: -320 }}
        />
      </div>,
    );
    // TanStack evaluates `initialOffset` once, on the mounting render's first
    // range; later renders refine the margin from the mounted spacer.
    const initialOffset = renderedOptions[0]?.initialOffset as () => number;
    // TanStack's own coordinates: the history margin, then 21 user (88px)
    // and 20 assistant (176px) estimates before row 41, less the reader's
    // offset into the viewport. Not 0, which attached at the top of history.
    expect(initialOffset()).toBe(68 + 21 * 88 + 20 * 176 + 320);
    vi.unstubAllGlobals();
  });
});
