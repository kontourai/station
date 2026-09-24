// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MarkdownRenderer } from '../components/chat/MarkdownRenderer';
import { chatUrlTransform } from '../components/chat/markdown-images';
import { PreviewProvider } from '../contexts/PreviewContext';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const img = { tagName: 'img' } as Parameters<typeof chatUrlTransform>[2];
const a = { tagName: 'a' } as Parameters<typeof chatUrlTransform>[2];

describe('chatUrlTransform', () => {
  test('admits a raster data URL as an image source', () => {
    expect(chatUrlTransform(PNG, 'src', img)).toBe(PNG);
  });

  test('keeps the default policy everywhere else', () => {
    expect(chatUrlTransform(PNG, 'href', a)).toBe('');
    expect(
      chatUrlTransform('data:image/svg+xml;base64,PHN2Zz4=', 'src', img),
    ).toBe('');
    expect(chatUrlTransform('javascript:alert(1)', 'src', img)).toBe('');
    expect(chatUrlTransform('https://example.test/a.png', 'src', img)).toBe(
      'https://example.test/a.png',
    );
  });
});

describe('markdown images', () => {
  beforeEach(() => {
    // The image inspector sizes itself with ResizeObserver, which jsdom lacks.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  test('renders an inline data-URL image a model returned (previously blanked)', () => {
    render(<MarkdownRenderer>{`![chart](${PNG})`}</MarkdownRenderer>);

    expect(screen.getByAltText('chart').getAttribute('src')).toBe(PNG);
  });

  test('opens the image in the shared previewer', async () => {
    render(
      <PreviewProvider>
        <MarkdownRenderer>{`![chart](${PNG})`}</MarkdownRenderer>
      </PreviewProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Preview chart' }));

    expect(await screen.findByRole('dialog', { name: 'Preview' })).toBeTruthy();
    // The inspector loads lazily; once it has, the same bytes show enlarged.
    await waitFor(() =>
      expect(screen.getAllByAltText('chart')).toHaveLength(2),
    );
    for (const image of screen.getAllByAltText('chart')) {
      expect(image.getAttribute('src')).toBe(PNG);
    }
  });

  test('a linked image opens the preview without also following the link', async () => {
    render(
      <PreviewProvider>
        <MarkdownRenderer>{`[![chart](${PNG})](https://example.test)`}</MarkdownRenderer>
      </PreviewProvider>,
    );

    // fireEvent answers false when the default action (the anchor's
    // navigation) was prevented.
    const followed = fireEvent.click(
      screen.getByRole('button', { name: 'Preview chart' }),
    );
    expect(followed).toBe(false);
    expect(await screen.findByRole('dialog', { name: 'Preview' })).toBeTruthy();
  });

  test('stays a plain image where no previewer is mounted', () => {
    render(<MarkdownRenderer>{`![chart](${PNG})`}</MarkdownRenderer>);

    expect(screen.queryByRole('button')).toBeNull();
  });
});
