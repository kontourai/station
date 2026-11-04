// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const { authenticatedFetch, finishThumbnail } = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(() => new Promise<Response>(() => {})),
  finishThumbnail: {
    current: undefined as
      | undefined
      | ((value: { blob: Blob; width: number; height: number }) => void),
  },
}));
vi.mock('@kontourai/station-sdk', () => ({ authenticatedFetch }));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../contexts/PreviewContext', () => ({
  usePreview: () => ({ openPreview: vi.fn() }),
}));
// The chip's thumbnail is made asynchronously; this suite decides when it
// finishes, so it can finish after the chip has moved on.
vi.mock('../components/chat/attachment-thumbnails', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../components/chat/attachment-thumbnails')
  >()),
  createAttachmentThumbnail: () =>
    new Promise((resolve) => {
      finishThumbnail.current = resolve;
    }),
}));

import {
  acquireAttachmentObjectUrl,
  attachmentThumbnailKey,
  peekAttachmentObjectUrl,
  releaseAttachmentObjectUrl,
  resetAttachmentObjectUrls,
} from '../components/chat/attachment-object-urls';
import { FilePartPreview } from '../components/chat/FilePartPreview';

// 300,000 decoded bytes: large enough that the chip makes a thumbnail.
const LARGE_PNG = `data:image/png;base64,${'A'.repeat(400_000)}`;
const THUMBNAIL_NAME = attachmentThumbnailKey(LARGE_PNG);
const inline = {
  type: 'file',
  url: LARGE_PNG,
  mediaType: 'image/png',
  name: 'large.png',
};
const finish = async () => {
  finishThumbnail.current?.({
    blob: new Blob([new Uint8Array(4)], { type: 'image/png' }),
    width: 80,
    height: 80,
  });
  // Let the thumbnail promise's continuation run.
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  finishThumbnail.current = undefined;
  Object.assign(URL, {
    createObjectURL: () => 'blob:thumbnail',
    revokeObjectURL: vi.fn(),
  });
});
afterEach(() => resetAttachmentObjectUrls());

test('a thumbnail that finishes after its chip unmounts stays cached for the row to scroll back to', async () => {
  const chip = render(<FilePartPreview part={inline} />);
  expect(finishThumbnail.current).toBeDefined();
  chip.unmount();
  await finish();
  expect(peekAttachmentObjectUrl(THUMBNAIL_NAME)).toBe('blob:thumbnail');
  // Another row showing the same bytes takes it and lets go: still cached.
  expect(acquireAttachmentObjectUrl(THUMBNAIL_NAME)).toBe('blob:thumbnail');
  releaseAttachmentObjectUrl(THUMBNAIL_NAME);
  expect(peekAttachmentObjectUrl(THUMBNAIL_NAME)).toBe('blob:thumbnail');
});

test('a thumbnail that finishes after its chip switched to the recorded reference does not stay keyed by the data URL', async () => {
  const chip = render(<FilePartPreview part={inline} />);
  expect(finishThumbnail.current).toBeDefined();
  chip.rerender(
    <FilePartPreview
      part={{
        type: 'file',
        blobRef: `sha256-${'a'.repeat(64)}`,
        mediaType: 'image/png',
        name: 'large.png',
      }}
    />,
  );
  await finish();
  expect(peekAttachmentObjectUrl(THUMBNAIL_NAME)).toBeUndefined();
});
