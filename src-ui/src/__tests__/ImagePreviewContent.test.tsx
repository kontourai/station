// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  releaseAttachmentObjectUrl,
  resetAttachmentObjectUrls,
  storeAttachmentObjectUrl,
} from '../components/chat/attachment-object-urls';
import ImagePreviewContent from '../components/ImagePreviewContent';

const revokeObjectURL = vi.fn();

beforeEach(() => {
  Object.assign(URL, { revokeObjectURL });
  revokeObjectURL.mockClear();
  // The image inspector sizes itself with ResizeObserver, which jsdom lacks.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  resetAttachmentObjectUrls();
  vi.unstubAllGlobals();
});

describe('ImagePreviewContent', () => {
  test('holds every gallery image, so prev/next never lands on a revoked sibling', () => {
    storeAttachmentObjectUrl('a', 'blob:a');
    storeAttachmentObjectUrl('b', 'blob:b');
    const items = [
      { url: 'blob:a', mediaType: 'image/png', name: 'a.png' },
      { url: 'blob:b', mediaType: 'image/png', name: 'b.png' },
    ];
    const { unmount } = render(
      <ImagePreviewContent
        current={items[0]}
        items={items}
        onSelect={() => {}}
      />,
    );

    // Both chips unmount (transcript scrolled away) and the cache overflows.
    releaseAttachmentObjectUrl('a');
    releaseAttachmentObjectUrl('b');
    for (let i = 0; i < 40; i += 1) {
      storeAttachmentObjectUrl(`other-${i}`, `blob:other-${i}`);
      releaseAttachmentObjectUrl(`other-${i}`);
    }
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:a');
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:b');

    // Closing ends the holds; the next two evictions take the oldest idle
    // entries, which are now these two.
    unmount();
    storeAttachmentObjectUrl('one-more', 'blob:one-more');
    storeAttachmentObjectUrl('two-more', 'blob:two-more');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:a');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:b');
  });
});
